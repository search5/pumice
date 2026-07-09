import { CapacitorAdapter, DataAdapter, FileSystemAdapter, Plugin, Notice, TFile, TFolder } from "obsidian";
import { SyncSettingTab } from "./settingsTab";
import { DEFAULT_SETTINGS, type SyncPluginSettings } from "./settings";
import { loadToken, hasToken } from "./tokenStore";
import { SyncClient } from "./syncClient";
import { PublishModal } from "./publishModal";
import { SyncHistoryModal } from "./syncHistoryModal";
import { LocalSnapshotStore } from "./localSnapshotStore";
import { ContentHashCache } from "./contentHashCache";
import { t } from "./i18n";

// The "Vault Sync" ribbon button has no core equivalent, so there's no translation key for it —
// we just hardcode English/Korean and pick based on Obsidian's UI language (document.documentElement.lang).
function vaultSyncRibbonLabel(): string {
  return document.documentElement.lang.toLowerCase().startsWith("ko") ? "Vault 동기화" : "Vault Sync";
}

// DataAdapter's public interface has no getFullPath — it only exists on the concrete desktop
// (FileSystemAdapter) and mobile (CapacitorAdapter) implementations (both @public), so we narrow
// via instanceof. Supporting only desktop would break sync entirely on mobile, so both are handled.
function getAdapterFullPath(adapter: DataAdapter, normalizedPath: string | undefined): string {
  if (!normalizedPath) {
    throw new Error("경로를 확인할 수 없습니다.");
  }
  if (adapter instanceof FileSystemAdapter || adapter instanceof CapacitorAdapter) {
    return adapter.getFullPath(normalizedPath);
  }
  throw new Error("지원되지 않는 플랫폼입니다.");
}

// Dynamic Node.js fs fallback (for desktop debug logging)
let fs: any = null;
try {
  if (typeof require !== "undefined") {
    fs = require("fs");
  }
} catch (e) {}

// Slash-based path utilities
const pathUtil = {
  join(...parts: string[]): string {
    return parts.map(p => p.trim().replace(/^\/+|\/+$/g, "")).filter(p => p.length > 0).join("/");
  },
  basename(filePath: string, ext?: string): string {
    const parts = filePath.split("/");
    let base = parts.pop() || "";
    if (ext && base.endsWith(ext)) {
      base = base.substring(0, base.length - ext.length);
    }
    return base;
  }
};

// Set by setPluginLogPath() once the plugin has loaded
let _pluginLogPath: string | null = null;

function setPluginLogPath(pluginDir: string) {
  _pluginLogPath = pathUtil.join(pluginDir, "sync-debug.log");
}

function fileLog(message: string) {
  if (!_pluginLogPath || !fs) return;
  try {
    const time = new Date().toISOString();
    fs.appendFileSync(_pluginLogPath, `[${time}] ${message}\n`, "utf8");
  } catch (e) {}
}


export default class SyncPlugin extends Plugin {
  declare settings: SyncPluginSettings;
  hasStoredToken = false;
  deletedFiles: Record<string, number> = {};
  snapshotStore!: LocalSnapshotStore;
  contentHashCache!: ContentHashCache;
  private autoSyncTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private ribbonReplaceTimers: number[] = [];

  async onload(): Promise<void> {
    await this.loadSettings();
    setPluginLogPath(getAdapterFullPath(this.app.vault.adapter, this.manifest.dir));
    this.hasStoredToken = await hasToken();
    this.addSettingTab(new SyncSettingTab(this.app, this));

    // Local snapshots: instead of reading core File Recovery's undocumented IndexedDB schema, we keep
    // our own DB and subscribe to vault events ourselves (localSnapshotStore.ts). This feature is
    // completely unaffected if core changes its storage format or File Recovery gets disabled.
    this.snapshotStore = new LocalSnapshotStore(this.app, () => ({
      intervalMinutes: this.settings.localSnapshotIntervalMinutes,
      keepDays: this.settings.localSnapshotKeepDays,
    }));
    await this.snapshotStore.init();

    // Lets the Publish diff scan skip re-hashing files whose content hasn't changed since the last
    // scan (see contentHashCache.ts) — important once a vault has more than a few hundred files.
    this.contentHashCache = new ContentHashCache();
    await this.contentHashCache.init();

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile) void this.snapshotStore.onFileChanged(file);
      })
    );
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (file) void this.snapshotStore.onFileChanged(file);
      })
    );
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(
        this.app.vault.on("create", (file) => {
          if (file instanceof TFile) void this.snapshotStore.onFileChanged(file);
        })
      );
    });
    this.registerInterval(window.setInterval(() => void this.snapshotStore.resave(), 60_000));
    this.registerInterval(window.setInterval(() => void this.snapshotStore.cleanup(), 3_600_000));

    this.addCommand({
      id: "sync-now",
      name: "지금 동기화",
      callback: () => this.syncNow(),
    });

    this.addCommand({
      id: "publish-changes",
      name: t("plugins.publish.action-publish-changes", "Publish changes"),
      callback: () => new PublishModal(this.app, this).open(),
    });

    this.addRibbonIcon("refresh-cw", vaultSyncRibbonLabel(), () => this.syncNow());
    this.addRibbonIcon("paper-plane", t("plugins.publish.action-publish-changes", "Publish changes"), () =>
      new PublishModal(this.app, this).open()
    );

    // 1. Add our own ribbon button for opening version history
    const ourRibbonEl = this.addRibbonIcon("history", t("plugins.sync.menu-opt-view-version-history", "Open version history"), () => {
      const activeFile = this.app.workspace.getActiveFile();
      if (!activeFile) {
        new Notice(t("interface.empty-state.no-file-open", "No file is open."));
        return;
      }
      new SyncHistoryModal(this.app, this, activeFile).open();
    });
    ourRibbonEl.setAttribute("data-grpc-sync-history-ribbon", "1");

    // 2. Find core's original version-history ribbon button and replace it with ours
    const replaceCoreRibbonButton = () => {
      const ribbonContainer = document.querySelector(".side-dock-ribbon, .ribbon-bar");
      if (!ribbonContainer) return;

      const buttons = ribbonContainer.querySelectorAll(".side-dock-ribbon-action, .clickable-icon");
      let coreButton: HTMLElement | null = null;

      const coreLabel = t("plugins.sync.menu-opt-view-version-history", "Open version history");
      buttons.forEach((btn) => {
        const label = btn.getAttribute("aria-label") || "";
        const isOur = btn.getAttribute("data-grpc-sync-history-ribbon") === "1";

        if (!isOur && (label === coreLabel || label.toLowerCase().includes("version history"))) {
          coreButton = btn as HTMLElement;
        }
      });

      if (coreButton && (coreButton as HTMLElement).parentNode) {
        (coreButton as HTMLElement).parentNode!.insertBefore(ourRibbonEl, coreButton);
        (coreButton as HTMLElement).remove();
      }
    };

    this.app.workspace.onLayoutReady(() => {
      replaceCoreRibbonButton();
      for (const delay of [100, 500, 1000, 2000, 4000]) {
        this.ribbonReplaceTimers.push(window.setTimeout(replaceCoreRibbonButton, delay));
      }
    });

    // Register file-change event listeners (tombstone tracking + smart debounced live sync)
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        this.deletedFiles[file.path] = Date.now();
        this.savePluginData();
        this.triggerDebouncedSync();
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        // Skip tombstone creation when an Obsidian auto-created note (Untitled/무제) gets renamed
        // right away, so we don't spuriously mark it as deleted.
        const baseName = pathUtil.basename(oldPath, ".md");
        const isUntitled = /^(Untitled|무제)(\s+\d+)?$/i.test(baseName);
        if (!isUntitled) {
          this.deletedFiles[oldPath] = Date.now();
        }
        delete this.deletedFiles[file.path];
        this.savePluginData();
        this.triggerDebouncedSync();
      })
    );

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        delete this.deletedFiles[file.path];
        this.savePluginData();
        this.triggerDebouncedSync();
      })
    );

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        this.triggerDebouncedSync();
      })
    );

    if (this.settings.syncOnStartup) {
      this.app.workspace.onLayoutReady(() => this.syncNow());
    }

    if (this.settings.autoSync) {
      this.startAutoSync();
    }

    // Folder context menu — toggles publish "included folder" status. Core Publish itself has no
    // folder right-click menu at all (reverse-engineered from obsidian.asar: the file-menu handler
    // is gated to TFile instances only, and there's no files-menu registration either) — we reuse
    // the exact mechanism core actually uses (the included-folders setting, the same
    // publishIncludeFolders that SiteFiltersSection manages), just exposed through our own
    // quick-toggle entry point instead of requiring a trip through the settings modal.
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFolder)) return;
        const includeFolders = this.settings.publishIncludeFolders
          .split("\n").map((p) => p.trim()).filter(Boolean);
        const isIncluded = includeFolders.includes(file.path);
        menu.addItem((item) => {
          item
            .setTitle(t("plugins.publish.option-included-folders", "Included folders"))
            .setIcon("paper-plane")
            .setSection("action")
            .setChecked(isIncluded)
            .onClick(async () => {
              const next = isIncluded
                ? includeFolders.filter((p) => p !== file.path)
                : [...includeFolders, file.path];
              this.settings.publishIncludeFolders = next.join("\n");
              await this.saveSettings();
              new Notice(isIncluded ? "게시 포함 폴더에서 제외했습니다." : "게시 포함 폴더로 추가했습니다.");
            });
        });
      })
    );

    // File context menu — publish current file (matches original Obsidian behavior: opens the modal)
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file, source) => {
        if (!("extension" in file)) return; // exclude TFolder
        const publishFileLabel = t("plugins.publish.action-publish-file", "Publish current file");
        menu.addItem((item) => {
          item
            .setTitle(publishFileLabel)
            .setIcon("paper-plane")
            .setSection("action")
            .onClick(() => {
              new PublishModal(this.app, this, file as TFile).open();
            });
        });

        // Add our own item at the same three spots where core Sync adds "Open version history"
        // (confirmed via obsidian.asar/app.js: "tab-header" | "more-options" |
        // "file-explorer-context-menu"). Just specifying .setSection("view"), same as core, is
        // enough — Menu.sort() renders items within the same section in the order they were added
        // (core loads first and adds first, so ours always ends up after core's), so there's no
        // need for private APIs like searching Menu.items or repositioning MenuItem.dom.
        if (source === "more-options" || source === "file-explorer-context-menu" || source === "tab-header") {
          const historyLabel = t("plugins.sync.menu-opt-view-version-history", "Open version history");
          menu.addItem((item) => {
            item
              .setTitle(historyLabel)
              .setIcon("history")
              .setSection("view")
              .onClick(() => {
                new SyncHistoryModal(this.app, this, file as TFile).open();
              });
          });
        }

        // Rather than hunting through the DOM to remove the duplicate with core's real "Publish"
        // menu item, we just have the user disable "Publish" under Obsidian's core plugin settings
        // (Settings → Core plugins → disable Publish). That way core never adds the item in the
        // first place, so no cleanup logic is needed.
      })
    );
  }

  async getSyncClient(): Promise<SyncClient> {
    const token = await this.getToken();
    const pluginDir = getAdapterFullPath(this.app.vault.adapter, this.manifest.dir);
    return new SyncClient(
      this.app.vault,
      pluginDir,
      token,
      this.settings,
      this.deletedFiles,
      async (deleted) => {
        this.deletedFiles = deleted;
        await this.savePluginData();
      }
    );
  }

  onunload(): void {
    this.stopAutoSync();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    for (const id of this.ribbonReplaceTimers) window.clearTimeout(id);
    this.ribbonReplaceTimers = [];
    this.snapshotStore?.close();
    this.contentHashCache?.close();
  }

  async loadSettings(): Promise<void> {
    const data = await this.loadData() || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || data);
    this.deletedFiles = data.deletedFiles || {};
  }

  async saveSettings(): Promise<void> {
    await this.savePluginData();
    this.restartAutoSync();
  }

  async savePluginData(): Promise<void> {
    await this.saveData({
      settings: this.settings,
      deletedFiles: this.deletedFiles,
    });
  }

  /** Injected as gRPC metadata. Exists in memory only. */
  async getToken(): Promise<string> {
    return loadToken();
  }

  async testConnection(): Promise<void> {
    const token = await this.getToken();
    if (!token) {
      throw new Error("동기화 토큰이 설정되지 않았습니다.");
    }

    const pluginDir = getAdapterFullPath(this.app.vault.adapter, this.manifest.dir);
    const client = new SyncClient(
      this.app.vault,
      pluginDir,
      token,
      this.settings,
      this.deletedFiles,
      async (deleted) => {
        this.deletedFiles = deleted;
        await this.savePluginData();
      }
    );
    await client.testConnection();
  }

  async syncNow(): Promise<void> {
    const token = await this.getToken();
    if (!token) {
      new Notice("동기화 토큰이 설정되지 않았습니다.");
      return;
    }

    new Notice("동기화를 시작합니다...");

    try {
      const pluginDir = getAdapterFullPath(this.app.vault.adapter, this.manifest.dir);
      const client = new SyncClient(
        this.app.vault,
        pluginDir,
        token,
        this.settings,
        this.deletedFiles,
        async (deleted) => {
          this.deletedFiles = deleted;
          await this.savePluginData();
        }
      );

      const result = await client.sync();
      new Notice(
        `동기화 완료: 업로드 ${result.uploaded}개, 다운로드 ${result.downloaded}개, 삭제 ${result.deleted}개`
      );
    } catch (e) {
      console.error("Sync failed:", e);
      new Notice(`동기화 실패: ${e.message || e}`);
    }
  }

  private startAutoSync(): void {
    if (this.autoSyncTimer) return;
    const ms = this.settings.syncIntervalSeconds * 1000;
    this.autoSyncTimer = setInterval(() => this.syncNow(), ms);
  }

  private stopAutoSync(): void {
    if (this.autoSyncTimer) {
      clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
  }

  private restartAutoSync(): void {
    this.stopAutoSync();
    if (this.settings.autoSync) {
      this.startAutoSync();
    }
  }

  triggerDebouncedSync(): void {
    if (!this.settings.autoSync) return;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.syncNow();
    }, 3000); // run after a 3-second debounce delay
  }

}
