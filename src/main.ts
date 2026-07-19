import { CapacitorAdapter, DataAdapter, FileSystemAdapter, Plugin, Notice, TFile, TFolder } from "obsidian";
import { SyncSettingTab } from "./settingsTab";
import { getDefaultSettings, type SyncPluginSettings } from "./settings";
import { loadToken, hasToken, saveToken, loadE2eePassword, saveE2eePassword } from "./tokenStore";
import { SyncClient, type SyncProgressPhase } from "./syncClient";
import { PublishModal } from "./publishModal";
import { SyncHistoryModal } from "./syncHistoryModal";
import { LocalSnapshotStore } from "./localSnapshotStore";
import { ContentHashCache } from "./contentHashCache";
import { t } from "./i18n";
import { errorMessage } from "./errorMessage";

// The "Vault Sync" ribbon button has no core equivalent, so there's no core translation key for
// it either -- plugins.sync.label-vault-sync-ribbon is our own.
function vaultSyncRibbonLabel(): string {
  return t("plugins.sync.label-vault-sync-ribbon", "Vault Sync");
}

// DataAdapter's public interface has no getFullPath — it only exists on the concrete desktop
// (FileSystemAdapter) and mobile (CapacitorAdapter) implementations (both @public), so we narrow
// via instanceof. Supporting only desktop would break sync entirely on mobile, so both are handled.
function getAdapterFullPath(adapter: DataAdapter, normalizedPath: string | undefined): string {
  if (!normalizedPath) {
    throw new Error(t("settings.error-path-unresolved", "Could not resolve the path."));
  }
  if (adapter instanceof FileSystemAdapter || adapter instanceof CapacitorAdapter) {
    return adapter.getFullPath(normalizedPath);
  }
  throw new Error(t("settings.error-unsupported-platform", "Unsupported platform."));
}

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


export default class SyncPlugin extends Plugin {
  declare settings: SyncPluginSettings;
  hasStoredToken = false;
  /** E2EE sync password, cached in memory from app.secretStorage -- never persisted to data.json. */
  e2eePassword = "";
  deletedFiles: Record<string, number> = {};
  snapshotStore!: LocalSnapshotStore;
  contentHashCache!: ContentHashCache;
  settingTab!: SyncSettingTab;
  // Explicit `number`, not ReturnType<typeof window.setInterval/setTimeout>: with @types/node
  // present (for esbuild.config.mjs), that resolves to Node's Timeout instead of the browser's
  // number -- but window.setInterval/setTimeout always return a number in the Electron/browser
  // renderer context a plugin actually runs in.
  private autoSyncTimer: number | null = null;
  private debounceTimer: number | null = null;
  private ribbonReplaceTimers: number[] = [];

  async onload(): Promise<void> {
    await this.loadSettings();
    this.hasStoredToken = await hasToken(this.app);
    this.settingTab = new SyncSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    // Callback target for the "Log in" button in settings: opens the server's /login page in the
    // system browser, and once the user authenticates there, it redirects back here with a
    // freshly issued device token instead of making the user copy/paste one by hand.
    this.registerObsidianProtocolHandler("pumice-auth", async (params) => {
      const token = params.token;
      if (!token) {
        new Notice(t("settings.msg-login-callback-missing-token", "Login callback is missing a token."));
        return;
      }
      await saveToken(this.app, token);
      this.hasStoredToken = true;
      new Notice(
        params.username
          ? t("settings.msg-login-success-named", "Logged in as {{username}} — token saved.", { username: params.username })
          : t("settings.msg-login-success", "Logged in — token saved.")
      );
      // The settings tab may already be open (that's usually how the user got to the "Log in"
      // button in the first place) and won't otherwise know the token changed underneath it --
      // re-render so it reflects the new state instead of still showing the login prompt.
      this.settingTab.display();
    });

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
      name: t("settings.option-sync-now", "Sync now"),
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
      const ribbonContainer = activeDocument.querySelector(".side-dock-ribbon, .ribbon-bar");
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
        void this.savePluginData();
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
        void this.savePluginData();
        this.triggerDebouncedSync();
      })
    );

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        delete this.deletedFiles[file.path];
        void this.savePluginData();
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
              new Notice(
                isIncluded
                  ? t("plugins.publish.msg-folder-excluded", "Removed from included folders.")
                  : t("plugins.publish.msg-folder-included", "Added to included folders.")
              );
            });
        });
      })
    );

    // File context menu — publish current file (matches original Obsidian behavior: opens the modal)
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file, source) => {
        if (!(file instanceof TFile)) return; // exclude TFolder
        const publishFileLabel = t("plugins.publish.action-publish-file", "Publish current file");
        menu.addItem((item) => {
          item
            .setTitle(publishFileLabel)
            .setIcon("paper-plane")
            .setSection("action")
            .onClick(() => {
              new PublishModal(this.app, this, file).open();
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
                new SyncHistoryModal(this.app, this, file).open();
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
      this.app.fileManager,
      pluginDir,
      token,
      { ...this.settings, e2eePassword: this.e2eePassword },
      this.deletedFiles,
      async (deleted) => {
        this.deletedFiles = deleted;
        await this.savePluginData();
      },
      this.contentHashCache
    );
  }

  onunload(): void {
    this.stopAutoSync();
    if (this.debounceTimer) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    for (const id of this.ribbonReplaceTimers) window.clearTimeout(id);
    this.ribbonReplaceTimers = [];
    this.snapshotStore?.close();
    this.contentHashCache?.close();
  }

  async loadSettings(): Promise<void> {
    const data = await this.loadData() || {};
    this.settings = Object.assign({}, getDefaultSettings(this.app.vault.configDir), data.settings || data);
    this.deletedFiles = data.deletedFiles || {};

    // One-time migration: e2eePassword used to be persisted in plaintext here. Move any leftover
    // value into secretStorage (same treatment as the auth token in tokenStore.ts) and never write
    // it back to data.json. It's no longer part of SyncPluginSettings, hence the widened cast --
    // this is specifically reading a field that used to exist, not an arbitrary any-typed access.
    const settingsWithLegacyPassword = this.settings as SyncPluginSettings & { e2eePassword?: string };
    const legacyPassword = settingsWithLegacyPassword.e2eePassword;
    delete settingsWithLegacyPassword.e2eePassword;
    if (legacyPassword) {
      await saveE2eePassword(this.app, legacyPassword);
      await this.savePluginData();
    }
    this.e2eePassword = await loadE2eePassword(this.app);
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
    return loadToken(this.app);
  }

  async testConnection(): Promise<void> {
    const token = await this.getToken();
    if (!token) {
      throw new Error(t("settings.msg-no-token", "No sync token is set."));
    }

    const pluginDir = getAdapterFullPath(this.app.vault.adapter, this.manifest.dir);
    const client = new SyncClient(
      this.app.vault,
      this.app.fileManager,
      pluginDir,
      token,
      { ...this.settings, e2eePassword: this.e2eePassword },
      this.deletedFiles,
      async (deleted) => {
        this.deletedFiles = deleted;
        await this.savePluginData();
      },
      this.contentHashCache
    );
    await client.testConnection();
  }

  async syncNow(): Promise<void> {
    const token = await this.getToken();
    if (!token) {
      new Notice(t("settings.msg-no-token", "No sync token is set."));
      return;
    }

    const phaseLabel: Record<SyncProgressPhase, string> = {
      scan: t("plugins.sync.label-phase-scan", "scan"),
      upload: t("plugins.sync.label-phase-upload", "upload"),
      download: t("plugins.sync.label-phase-download", "download"),
    };
    // duration=0 keeps this Notice open until hide() is called below, so it can be updated in
    // place as progress comes in instead of the old fire-and-forget start/end Notice pair.
    const progressNotice = new Notice(t("settings.msg-sync-starting", "Starting sync..."), 0);

    try {
      const pluginDir = getAdapterFullPath(this.app.vault.adapter, this.manifest.dir);
      const client = new SyncClient(
        this.app.vault,
        this.app.fileManager,
        pluginDir,
        token,
        { ...this.settings, e2eePassword: this.e2eePassword },
        this.deletedFiles,
        async (deleted) => {
          this.deletedFiles = deleted;
          await this.savePluginData();
        },
        this.contentHashCache,
        ({ phase, done, total }) => {
          progressNotice.setMessage(t("plugins.sync.msg-sync-progress", "Syncing ({{phase}} {{done}}/{{total}})", { phase: phaseLabel[phase], done, total }));
        },
        ({ delayMs, retriesLeft }) => {
          // Reuses the same progressNotice instead of popping up a separate toast on top of it.
          progressNotice.setMessage(t("plugins.sync.msg-retry-in-progress", "Sync failed, retrying in {{delay}}ms... ({{retries}} retries left)", { delay: delayMs, retries: retriesLeft }));
        }
      );

      const result = await client.sync();
      progressNotice.hide();
      new Notice(
        t("settings.msg-sync-complete", "Sync complete: {{uploaded}} uploaded, {{downloaded}} downloaded, {{deleted}} deleted", {
          uploaded: result.uploaded,
          downloaded: result.downloaded,
          deleted: result.deleted,
        })
      );
    } catch (e: unknown) {
      progressNotice.hide();
      console.error("Sync failed:", e);
      new Notice(t("settings.msg-sync-failed", "Sync failed: {{error}}", { error: errorMessage(e) }));
    }
  }

  private startAutoSync(): void {
    if (this.autoSyncTimer) return;
    const ms = this.settings.syncIntervalSeconds * 1000;
    this.autoSyncTimer = window.setInterval(() => this.syncNow(), ms);
  }

  private stopAutoSync(): void {
    if (this.autoSyncTimer) {
      window.clearInterval(this.autoSyncTimer);
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
      window.clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = window.setTimeout(() => {
      void this.syncNow();
    }, 3000); // run after a 3-second debounce delay
  }

}
