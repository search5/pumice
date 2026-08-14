import { CapacitorAdapter, DataAdapter, FileSystemAdapter, Plugin, Notice, TFile, TFolder, setIcon } from "obsidian";
import { SyncSettingTab } from "./settingsTab";
import { getDefaultSettings, type SyncPluginSettings } from "./settings";
import { loadToken, hasToken, saveToken, loadE2eePassword, saveE2eePassword } from "./tokenStore";
import { SyncClient, type SyncProgressPhase } from "./syncClient";
import { WsSyncTransport, HEARTBEAT_CHECK_INTERVAL_MS, type PushedFileChangeMeta } from "./wsTransport";
import { WsSyncTransportAdapter } from "./wsSyncTransportAdapter";
import type { SyncTransport } from "./syncTransport";
import { PublishModal } from "./publishModal";
import { SyncHistoryModal } from "./syncHistoryModal";
import { LocalSnapshotStore } from "./localSnapshotStore";
import { ContentHashCache } from "./contentHashCache";
import { LastSyncedHashStore } from "./lastSyncedHashStore";
import { SyncDiagnosticsLog } from "./syncDiagnosticsLog";
import { SyncDiagnosticsModal } from "./syncDiagnosticsModal";
import { t } from "./i18n";
import { errorMessage } from "./errorMessage";
import { applyJitter, LIVE_SYNC_SAFETY_NET_INTERVAL_MS, nextBackoffMs } from "./liveUpdates";
import { describeLiveStatus, type LiveConnectionState } from "./liveStatus";

// Plugin.loadData() returns Promise<any> -- narrowing it to this shape right at the read site
// (matching what savePluginData() below actually writes) keeps the `any` from flowing into
// this.settings/this.deletedFiles. `settings` also covers the pre-wrapper format, where the
// loaded object *was* the flat settings (see the `data.settings || data` fallback below).
interface PersistedPluginData {
  settings?: Partial<SyncPluginSettings>;
  deletedFiles?: Record<string, number>;
  lastKnownPluginPaths?: Record<string, number>;
  lastKnownChangeId?: number;
}

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
  // Snapshot of .obsidian/plugins/** paths seen on the last successful sync (raw, unfiltered by
  // ignorePatterns) -- diffed against the current listing each sync to detect plugin removals,
  // since vault.on("delete", ...) never fires for config-dir paths. See #7_플러그인_동기화_구현_계획.md.
  lastKnownPluginPaths: Record<string, number> = {};
  // Version catch-up baseline (PR2/PR3 of #14_옵시디언싱크_정렬_구현계획.md) -- the
  // vault_change_log change_id this device last caught up to on the server, sent back in every
  // init so a reconnect only needs to replay what changed since then (via a catch-up `push`
  // burst) instead of a full delta_req scan. 0 means "no baseline yet" (brand-new device or
  // first sync ever), which the server takes as a signal to skip the catch-up burst entirely.
  // A single scalar, unlike lastSyncedHashStore/contentHashCache (per-path, IndexedDB-backed) --
  // this is one number per vault, so it rides along with the plugin's existing data.json
  // persistence (savePluginData()) rather than warranting a whole separate store.
  lastKnownChangeId = 0;
  snapshotStore!: LocalSnapshotStore;
  contentHashCache!: ContentHashCache;
  lastSyncedHashStore!: LastSyncedHashStore;
  syncDiagnosticsLog!: SyncDiagnosticsLog;
  settingTab!: SyncSettingTab;
  // Explicit `number`, not ReturnType<typeof window.setInterval/setTimeout>: with @types/node
  // present (for esbuild.config.mjs), that resolves to Node's Timeout instead of the browser's
  // number -- but window.setInterval/setTimeout always return a number in the Electron/browser
  // renderer context a plugin actually runs in.
  private debounceTimer: number | null = null;
  private ribbonReplaceTimers: number[] = [];
  // Paths the in-progress sync is currently writing to the vault itself -- shared with SyncClient
  // (see syncClient.ts's writeSelfPath) so the vault event listeners below can tell "sync just
  // wrote this" apart from a genuine local edit and skip re-arming the debounced sync for it.
  // Without this, every downloaded file (or applied server-side deletion) looked identical to the
  // user having just edited it, so a sync that pulled anything down always queued a pointless
  // extra sync 3 seconds later.
  private selfWritePaths: Set<string> = new Set();
  // Prevents overlapping syncNow() calls (manual click racing the debounce timer or the
  // safety-net's periodic sync, or two manual clicks in a row) from each computing their own
  // independent Delta and stepping on each other -- a request to sync while one is already
  // running is queued instead, and runs once the current one finishes.
  private isSyncing = false;
  private syncQueuedWhileRunning = false;
  // Set once in onunload() so an in-flight runLiveUpdateLoop() notices (between reads/retries)
  // and stops re-looping, instead of holding the plugin process open forever.
  private unloading = false;
  // Guards against starting a second concurrent loop (e.g. the setting gets toggled on twice in
  // a row) -- see startLiveUpdatesIfNeeded().
  private liveUpdatesLoopRunning = false;
  // Read by settingsTab.ts (via describeLiveStatus()) to render the connection-status line next
  // to the "Live updates" toggle -- the settings tab is the only status surface guaranteed to be
  // visible on mobile, since Obsidian mobile has no status bar by default (see statusBarItemEl).
  liveConnectionState: LiveConnectionState = "disabled";
  // Desktop-only in practice: Obsidian mobile ships a status bar element but keeps it hidden
  // unless the user opts in (Settings > Appearance > "Show status bar"), so this is a bonus for
  // desktop users rather than the primary indicator -- see liveConnectionState above for that.
  private statusBarItemEl: HTMLElement | null = null;
  // Single persistent WS connection, shared by every syncNow()/testConnection() call and by the
  // live-push loop -- reused across calls instead of a fresh connection (and auth round trip)
  // per sync, matching #11_websocket_동기화_프로토콜_설계.md's whole premise. Null whenever no
  // connection currently exists (never connected yet, or it dropped -- see wsTransport's
  // onClose); getTransport() connects on demand and caches the result here.
  private wsTransport: WsSyncTransport | null = null;
  private wsHeartbeatTimer: number | null = null;
  // Coalesces concurrent getTransport() callers (e.g. the live-update loop reconnecting while a
  // manual sync is also trying to connect) onto the same in-flight connect() instead of racing
  // multiple sockets.
  private wsConnecting: Promise<WsSyncTransport> | null = null;
  // Lets runLiveUpdateLoop await "this connection dropped" instead of polling -- resolved by
  // the onClose handler set up alongside wsTransport in getTransport().
  private wsClosedPromise: Promise<void> | null = null;
  private wsClosedResolve: (() => void) | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.hasStoredToken = await hasToken(this.app);
    this.syncDiagnosticsLog = new SyncDiagnosticsLog(this.app);
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
      // Connect-once-configured (see startLiveUpdatesIfNeeded's own comment) -- starts the
      // persistent connection immediately rather than waiting for the next syncNow()/app restart.
      this.startLiveUpdatesIfNeeded();
      // The settings tab may already be open (that's usually how the user got to the "Log in"
      // button in the first place) and won't otherwise know the token changed underneath it --
      // refresh it so it reflects the new state instead of still showing the login prompt.
      // update() rebuilds the declarative definitions returned by getSettingDefinitions().
      this.settingTab.update();
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

    // Tracks the last content hash both this device and the server agreed on per path -- the
    // "base" version the "merge" conflictResolution mode diffs local/remote changes against.
    this.lastSyncedHashStore = new LastSyncedHashStore();
    await this.lastSyncedHashStore.init();

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

    this.addCommand({
      id: "open-sync-diagnostics-log",
      name: t("plugins.sync.action-open-diagnostics-log", "Open sync diagnostics log"),
      callback: () => new SyncDiagnosticsModal(this.app, this).open(),
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
        // A sync applying a server-side deletion (fileManager.trashFile/adapter.remove in
        // syncClient.ts) fires this same event -- without this check it looked identical to the
        // user deleting the file themselves, re-adding a tombstone for a deletion sync had just
        // finished reconciling and queuing a needless follow-up sync.
        if (this.selfWritePaths.has(file.path)) {
          this.logDebug(`Ignoring self-triggered "delete" event for ${file.path} (sync is applying this itself)`);
          return;
        }
        this.deletedFiles[file.path] = Date.now();
        void this.savePluginData();
        this.triggerDebouncedSync();
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (this.selfWritePaths.has(file.path) || this.selfWritePaths.has(oldPath)) {
          this.logDebug(`Ignoring self-triggered "rename" event for ${oldPath} -> ${file.path} (sync is applying this itself)`);
          return;
        }
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
        // Same reasoning as "delete" above -- a downloaded file that's new to this device fires
        // "create", not "modify".
        if (this.selfWritePaths.has(file.path)) {
          this.logDebug(`Ignoring self-triggered "create" event for ${file.path} (sync is applying this itself)`);
          return;
        }
        delete this.deletedFiles[file.path];
        void this.savePluginData();
        this.triggerDebouncedSync();
      })
    );

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        // Same reasoning as "delete" above -- an existing file a sync just overwrote with the
        // server's content fires "modify" exactly like a real local edit would.
        if (this.selfWritePaths.has(file.path)) {
          this.logDebug(`Ignoring self-triggered "modify" event for ${file.path} (sync is applying this itself)`);
          return;
        }
        this.triggerDebouncedSync();
      })
    );

    this.statusBarItemEl = this.addStatusBarItem();
    this.startLiveUpdatesIfNeeded();

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

  private buildWsUrl(): string {
    const protocol = this.settings.useTls ? "wss" : "ws";
    return `${protocol}://${this.settings.serverHost}:${this.settings.serverPort}/ws`;
  }

  // Connects (or reuses) the single shared WS transport -- see wsTransport field comment. Throws
  // if there's no stored token, same as every prior call site that needed one did.
  private async getTransport(): Promise<SyncTransport> {
    if (this.wsTransport) return new WsSyncTransportAdapter(this.wsTransport);
    if (this.wsConnecting) return new WsSyncTransportAdapter(await this.wsConnecting);

    const token = await this.getToken();
    if (!token) {
      throw new Error(t("settings.msg-no-token", "No sync token is set."));
    }

    this.wsConnecting = (async () => {
      const ws = new WsSyncTransport((url) => new WebSocket(url));
      // Registered *before* connect() resolves, not after -- a catch-up push burst (PR2 of
      // #14_옵시디언싱크_정렬_구현계획.md) can arrive on the wire immediately once init_ok is
      // sent, and registering these callbacks only once `await ws.connect(...)` returns left a
      // real gap where an early push/ready could be silently dropped (found while designing
      // PR3 -- not previously exploitable in practice since a live push landing in that exact
      // window was rare, but the catch-up burst makes it routine).
      ws.onChangePush((file) => void this.applyPushedChange(file));
      ws.onReady((payload) => {
        this.lastKnownChangeId = payload.latestChangeId;
        void this.savePluginData();
      });
      ws.onClose(() => {
        if (this.wsTransport === ws) this.wsTransport = null;
        if (this.wsHeartbeatTimer !== null) {
          window.clearInterval(this.wsHeartbeatTimer);
          this.wsHeartbeatTimer = null;
        }
        this.setLiveConnectionState(this.hasStoredToken ? "reconnecting" : "disabled");
        this.wsClosedResolve?.();
        this.wsClosedResolve = null;
      });
      this.wsClosedPromise = new Promise((resolve) => (this.wsClosedResolve = resolve));
      // Started *before* awaiting connect(), not after -- otherwise a server that never answers
      // init (a dropped frame, an overloaded/stuck server) hangs this call forever with no way to
      // detect it: checkHeartbeat()'s 60s checkRequestTimeouts() is the only timeout mechanism
      // this transport has at all, and connect()'s init request needs that same protection every
      // other request already gets. Safe to start this early because checkHeartbeat() itself
      // knows not to send an idle ping before init succeeds (see wsTransport.ts's `authenticated`
      // flag) -- a real bug found 2026-08-15 investigating a "Test connection does nothing" report;
      // see llm-wiki/11-*.md.
      this.wsHeartbeatTimer = window.setInterval(() => ws.checkHeartbeat(), HEARTBEAT_CHECK_INTERVAL_MS);
      await ws.connect(this.buildWsUrl(), {
        token,
        vaultId: this.app.vault.getName(),
        deviceName: this.settings.deviceName || "",
        userName: this.settings.userName || "",
        clientVersion: this.manifest.version,
        lastKnownChangeId: this.lastKnownChangeId,
      });
      this.wsTransport = ws;
      this.setLiveConnectionState("connected");
      return ws;
    })();

    try {
      return new WsSyncTransportAdapter(await this.wsConnecting);
    } finally {
      this.wsConnecting = null;
    }
  }

  // Public: settingsTab.ts calls this directly when the stored token is deleted, so a logout
  // drops the persistent connection immediately instead of leaving it open (still authenticated
  // under the now-deleted token, from the server's perspective) until it happens to drop on its
  // own -- runLiveUpdateLoop()'s own hasStoredToken check would eventually notice too, but only
  // at its next reconnect/safety-net cycle, not right away.
  disconnectTransport(): void {
    this.wsTransport?.close();
    this.wsTransport = null;
    if (this.wsHeartbeatTimer !== null) {
      window.clearInterval(this.wsHeartbeatTimer);
      this.wsHeartbeatTimer = null;
    }
  }

  async getSyncClient(): Promise<SyncClient> {
    const token = await this.getToken();
    const pluginDir = getAdapterFullPath(this.app.vault.adapter, this.manifest.dir);
    const transport = await this.getTransport();
    return new SyncClient(
      transport,
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
      undefined,
      undefined,
      this.selfWritePaths,
      (level, message) => this.syncDiagnosticsLog.log(level, message),
      this.lastSyncedHashStore,
      this.lastKnownPluginPaths,
      async (paths) => {
        this.lastKnownPluginPaths = paths;
        await this.savePluginData();
      }
    );
  }

  onunload(): void {
    this.unloading = true;
    this.disconnectTransport();
    if (this.debounceTimer) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    for (const id of this.ribbonReplaceTimers) window.clearTimeout(id);
    this.ribbonReplaceTimers = [];
    this.snapshotStore?.close();
    this.contentHashCache?.close();
    this.lastSyncedHashStore?.close();
  }

  async loadSettings(): Promise<void> {
    const data = ((await this.loadData()) as PersistedPluginData | null) || {};
    this.settings = Object.assign({}, getDefaultSettings(this.app.vault.configDir), data.settings || data);
    this.deletedFiles = data.deletedFiles || {};
    this.lastKnownPluginPaths = data.lastKnownPluginPaths || {};
    this.lastKnownChangeId = data.lastKnownChangeId || 0;

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
    // A no-op whenever a live-update loop is already up (startLiveUpdatesIfNeeded()'s own
    // guard) -- this only matters right after a token is saved/deleted while the plugin is
    // already running, since hasStoredToken can change without a fresh onload().
    this.startLiveUpdatesIfNeeded();
  }

  async savePluginData(): Promise<void> {
    await this.saveData({
      settings: this.settings,
      deletedFiles: this.deletedFiles,
      lastKnownPluginPaths: this.lastKnownPluginPaths,
      lastKnownChangeId: this.lastKnownChangeId,
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
    const transport = await this.getTransport();
    const client = new SyncClient(
      transport,
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
    // A sync already in flight (manual click racing the debounce timer / safety-net's periodic
    // sync, or two triggers in quick succession) is not started a second time in parallel --
    // each one would compute its own independent Delta and step on the other's writes. Instead
    // this request is queued and runs once, right after the current one finishes, so concurrent
    // client/server changes still converge without the user needing to notice and retry manually.
    if (this.isSyncing) {
      this.logDebug("Sync already in progress -- queuing this request to run once it finishes");
      this.syncQueuedWhileRunning = true;
      return;
    }
    this.isSyncing = true;
    try {
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
        const transport = await this.getTransport();
        const client = new SyncClient(
          transport,
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
          },
          this.selfWritePaths,
          (level, message) => this.syncDiagnosticsLog.log(level, message),
          this.lastSyncedHashStore,
          this.lastKnownPluginPaths,
          async (paths) => {
            this.lastKnownPluginPaths = paths;
            await this.savePluginData();
          }
        );

        const result = await client.sync();
        progressNotice.hide();
        new Notice(
          result.failed > 0
            ? t(
                "settings.msg-sync-complete-with-failed",
                "Sync complete: {{uploaded}} uploaded, {{downloaded}} downloaded, {{deleted}} deleted, {{failed}} failed after retrying",
                { uploaded: result.uploaded, downloaded: result.downloaded, deleted: result.deleted, failed: result.failed }
              )
            : t("settings.msg-sync-complete", "Sync complete: {{uploaded}} uploaded, {{downloaded}} downloaded, {{deleted}} deleted", {
                uploaded: result.uploaded,
                downloaded: result.downloaded,
                deleted: result.deleted,
              })
        );
        await this.reloadUpdatedPlugins(result.updatedPluginIds);
      } catch (e: unknown) {
        progressNotice.hide();
        console.error("Sync failed:", e);
        new Notice(t("settings.msg-sync-failed", "Sync failed: {{error}}", { error: errorMessage(e) }));
      }
    } finally {
      this.isSyncing = false;
      if (this.syncQueuedWhileRunning) {
        this.syncQueuedWhileRunning = false;
        this.logDebug("Running the sync that was queued while the previous one was in progress");
        void this.syncNow();
      }
    }
  }

  // 2026-08 push-metadata fidelity follow-up (see #11_websocket_동기화_프로토콜_설계.md and
  // llm-wiki/03-*.md): applies exactly the one file a `push` notification named, instead of
  // running a full syncNow()/Delta for every remote change no matter how much actually changed
  // (matching real Obsidian Sync's per-file push). Shares syncNow()'s isSyncing/
  // syncQueuedWhileRunning mutex -- if a full sync is already running, this is skipped rather
  // than risking two independent SyncClient instances writing the same path at once (writeSelfPath's
  // selfWritePaths set is shared plugin-wide); the in-flight (or queued-right-after) full sync's
  // own Delta will pick this exact file up anyway, since the server just told every connected
  // device it changed.
  private async applyPushedChange(file: PushedFileChangeMeta): Promise<void> {
    if (this.isSyncing) {
      this.logDebug(`Sync already in progress -- skipping direct apply of pushed change for ${file.path} (the in-flight/queued sync will pick it up)`);
      return;
    }
    const token = await this.getToken();
    if (!token) return;

    this.isSyncing = true;
    try {
      const pluginDir = getAdapterFullPath(this.app.vault.adapter, this.manifest.dir);
      const transport = await this.getTransport();
      const client = new SyncClient(
        transport,
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
        undefined,
        undefined,
        this.selfWritePaths,
        (level, message) => this.syncDiagnosticsLog.log(level, message),
        this.lastSyncedHashStore
      );
      await client.applyPushedFileChange({
        path: file.path,
        modified_at_ms: file.modifiedAtMs,
        size_bytes: file.sizeBytes,
        content_hash: file.contentHash,
        is_deleted: file.isDeleted,
      });
    } catch (e: unknown) {
      console.error(`Failed to apply pushed change for ${file.path}:`, e);
    } finally {
      this.isSyncing = false;
      if (this.syncQueuedWhileRunning) {
        this.syncQueuedWhileRunning = false;
        this.logDebug("Running the sync that was queued while a pushed change was being applied");
        void this.syncNow();
      }
    }
  }

  // Connect-once-configured, matching real Obsidian core Sync (confirmed via obsidian.asar
  // analysis, #14_옵시디언싱크_정렬_구현계획.md): there's no separate opt-in flag for a
  // persistent connection, no user-configurable sync interval, and no "sync on startup" toggle
  // either -- as soon as a token exists, the plugin keeps one open for as long as it stays
  // loaded, and waitForCloseOrSafetyNet()'s own periodic full sync (below) is what core's fixed
  // 30s requestSync interval already covers, replacing the old opt-in autoSync timer entirely.
  // The manual "Sync now" button/ribbon icon stays as a force-trigger -- not replaced by this.
  private startLiveUpdatesIfNeeded(): void {
    if (this.liveUpdatesLoopRunning || !this.hasStoredToken) {
      if (!this.hasStoredToken) this.setLiveConnectionState("disabled");
      return;
    }
    this.liveUpdatesLoopRunning = true;
    void this.runLiveUpdateLoop().finally(() => {
      this.liveUpdatesLoopRunning = false;
      this.setLiveConnectionState("disabled");
    });
  }

  // Renders liveConnectionState to the status bar (see the field's own comment for why the
  // settings tab, not this, is the primary indicator) and refreshes the settings tab in case
  // it's currently open -- update() is Obsidian's own no-op-when-not-displayed rebuild, the same
  // mechanism the "Log in" flow above already relies on to reflect state changes made elsewhere.
  private setLiveConnectionState(state: LiveConnectionState): void {
    this.liveConnectionState = state;
    this.renderLiveStatusBar();
    this.settingTab.update();
  }

  private renderLiveStatusBar(): void {
    if (!this.statusBarItemEl) return;
    this.statusBarItemEl.empty();
    if (!this.hasStoredToken) return;
    const { icon, labelKey, labelFallback } = describeLiveStatus(this.liveConnectionState);
    this.statusBarItemEl.addClass("pumice-live-status");
    setIcon(this.statusBarItemEl.createSpan(), icon);
    this.statusBarItemEl.createSpan({ text: t(labelKey, labelFallback) });
  }

  // Keeps the shared WS transport (see wsTransport field) connected for as long as a token stays
  // configured, reconnecting with exponential backoff (+ jitter, see below) on any error.
  // getTransport() itself does the actual connect + wires onChangePush()/starts the heartbeat --
  // this loop's job is noticing a drop (via wsClosedPromise) and re-establishing it, and
  // separately forcing a periodic sync as a safety net against a lost push notification (see
  // waitForCloseOrSafetyNet()). Formerly a GET /watch SSE connection (see
  // #10_실시간_변경_알림_구현_계획.md); replaced by the same WS connection
  // syncNow()/testConnection() already use, per #11_websocket_동기화_프로토콜_설계.md.
  private async runLiveUpdateLoop(): Promise<void> {
    const INITIAL_BACKOFF_MS = 1000;
    const MAX_BACKOFF_MS = 60000;
    let backoffMs = INITIAL_BACKOFF_MS;

    while (this.hasStoredToken && !this.unloading) {
      try {
        this.setLiveConnectionState("connecting");
        await this.getTransport();
        backoffMs = INITIAL_BACKOFF_MS;

        await this.waitForCloseOrSafetyNet();
      } catch (e: unknown) {
        this.setLiveConnectionState("reconnecting");
        // Obsidian core's own reconnect backoff applies ±50% jitter to each attempt's delay
        // (see #14_옵시디언싱크_정렬_구현계획.md) so many clients dropped by the same event (a
        // server restart) don't all retry in lockstep -- backoffMs itself stays a clean
        // doubling sequence; only the actual delay used here is jittered.
        const delayMs = applyJitter(backoffMs);
        this.logDebug(`Live update connection error, retrying in ${Math.round(delayMs)}ms: ${errorMessage(e)}`);
        await new Promise((resolve) => window.setTimeout(resolve, delayMs));
        backoffMs = nextBackoffMs(backoffMs, MAX_BACKOFF_MS);
      }
    }
  }

  // Waits until the current live connection drops, but doesn't just sleep -- every
  // LIVE_SYNC_SAFETY_NET_INTERVAL_MS while it stays up, forces a full sync regardless of
  // whether a push notification actually arrived. Mirrors Obsidian core's own Sync client
  // (`window.setInterval(this.requestSync.bind(this), 3e4)`, confirmed via obsidian.asar
  // v1.13.6 -- see #14_옵시디언싱크_정렬_구현계획.md): without this, a lost/dropped push would go
  // unnoticed until the next manual sync -- this *is* pumice's periodic-resync mechanism now
  // (the old opt-in autoSync timer was removed, see settings.ts). Runs a full syncNow() rather
  // than a cheaper incremental catch-up because pumice has no version-journal endpoint yet (see
  // #14's "저널 기반" section) -- this'll get cheaper once that lands.
  private async waitForCloseOrSafetyNet(): Promise<void> {
    while (this.wsClosedPromise) {
      const closedPromise = this.wsClosedPromise;
      const timedOut = Symbol("safety-net-timeout");
      const winner = await Promise.race([
        closedPromise.then(() => "closed" as const),
        new Promise<typeof timedOut>((resolve) => window.setTimeout(() => resolve(timedOut), LIVE_SYNC_SAFETY_NET_INTERVAL_MS)),
      ]);
      if (winner === "closed") return;
      this.logDebug("Live sync safety net: forcing a sync regardless of push activity");
      void this.syncNow();
    }
  }

  // Mirrors a debug message to both the live console (for watching in real time) and
  // syncDiagnosticsLog (for checking afterward -- see SyncDiagnosticsModal).
  private logDebug(message: string): void {
    console.debug(message);
    this.syncDiagnosticsLog.log("debug", message);
  }

  // Hot-reloads community plugins whose code changed as a result of this sync, instead of leaving
  // them stale until the user happens to restart Obsidian -- app.plugins.disablePlugin()/
  // enablePlugin() aren't in obsidian.d.ts's public surface, but this is the exact pair BRAT
  // (obsidian42-brat) uses for its own reloadPlugin(), which is as close to a de facto standard
  // as this ecosystem has for "make freshly-written plugin code take effect without a restart."
  // Deliberately scoped to plugins already in enabledPlugins: a plugin that just appeared from
  // another device but was never enabled on this one is left for the user to review and enable
  // themselves via Community Plugins, same as installing any other plugin -- this only refreshes
  // code the user already chose to run here, it never turns anything on for the first time.
  // See #11_플러그인_핫리로드_구현_계획.md.
  private async reloadUpdatedPlugins(pluginIds: string[]): Promise<void> {
    if (pluginIds.length === 0) return;
    const pluginsApi = (
      this.app as unknown as {
        plugins: { enabledPlugins: Set<string>; disablePlugin(id: string): Promise<void>; enablePlugin(id: string): Promise<void> };
      }
    ).plugins;

    const reloaded: string[] = [];
    for (const id of pluginIds) {
      if (!pluginsApi.enabledPlugins.has(id)) continue;
      try {
        await pluginsApi.disablePlugin(id);
        await pluginsApi.enablePlugin(id);
        reloaded.push(id);
      } catch (e: unknown) {
        this.logDebug(`Failed to hot-reload plugin "${id}" after sync: ${errorMessage(e)}`);
      }
    }

    if (reloaded.length > 0) {
      new Notice(
        t("plugins.sync.msg-plugins-reloaded", "Reloaded {{count}} updated plugin(s): {{ids}}", {
          count: reloaded.length,
          ids: reloaded.join(", "),
        })
      );
    }
  }

  triggerDebouncedSync(): void {
    // Guards on a token being configured at all, not a removed "autoSync" opt-in flag -- prompt
    // upload of local edits is always on now (matching real Obsidian core, see
    // startLiveUpdatesIfNeeded's own comment), this just avoids spamming a "No sync token is
    // set" notice on every edit before the user has ever logged in.
    if (!this.hasStoredToken) return;

    if (this.debounceTimer) {
      window.clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = window.setTimeout(() => {
      void this.syncNow();
    }, 3000); // run after a 3-second debounce delay
  }

}
