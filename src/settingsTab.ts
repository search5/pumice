import { App, PluginSettingTab, Setting, ButtonComponent, Notice, setIcon } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import type SyncPlugin from "./main";
import { deleteToken, saveE2eePassword } from "./tokenStore";
import type { ConflictResolution } from "./settings";
import { SyncDiagnosticsModal } from "./syncDiagnosticsModal";
import { VaultShareModal } from "./vaultShareModal";
import { describeLiveStatus } from "./liveStatus";
import { t } from "./i18n";
import { shouldStopTabPropagation } from "./settingsTabKeyboard";

export class SyncSettingTab extends PluginSettingTab {
  plugin: SyncPlugin;

  constructor(app: App, plugin: SyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;

    // Restores native Tab-to-next-field navigation inside this settings tab -- see
    // settingsTabKeyboard.ts for why this is needed (Obsidian's own core Settings modal
    // otherwise intercepts Tab on an ancestor container and repurposes it as row-jump
    // navigation). Bubble-phase listener on our own containerEl fires before Obsidian's
    // listener on the shared ancestor container, so stopping propagation here keeps the event
    // from ever reaching it -- preventDefault() is deliberately never called, so the browser's
    // native focus-move behavior still applies.
    this.containerEl.addEventListener("keydown", (evt) => {
      if (shouldStopTabPropagation(evt.key)) {
        evt.stopPropagation();
      }
    });
  }

  // Declarative settings API (Obsidian 1.13.0+, this plugin's minAppVersion floor) — display()
  // is deprecated and never called by Obsidian as long as this returns a non-empty array, so it's
  // omitted entirely rather than kept around as dead code.
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        type: "group",
        items: [
          {
            // Same vault-identity note as in display() above — no control/action, just informational
            // text, so setting.settingEl is emptied and rebuilt as a bare paragraph instead of the
            // usual name/control row layout.
            name: t(
              "settings.note-vault-name-identifies-vault",
              "This vault is identified to the server by its folder name (\"{{vaultName}}\") — every device syncing this same vault must use a folder with the exact same name.",
              { vaultName: this.app.vault.getName() }
            ),
            render: (setting) => {
              setting.settingEl.empty();
              setting.settingEl.createEl("p", {
                cls: "setting-item-description",
                text: t(
                  "settings.note-vault-name-identifies-vault",
                  "This vault is identified to the server by its folder name (\"{{vaultName}}\") — every device syncing this same vault must use a folder with the exact same name.",
                  { vaultName: this.app.vault.getName() }
                ),
              });
            },
          },
          {
            name: t("settings.option-user-name", "User name"),
            desc: t("settings.option-user-name-desc", "Username shown in sync history"),
            control: { type: "text", key: "userName", placeholder: "Obsidian user" },
          },
          {
            name: t("settings.option-device-name", "Device name"),
            desc: t("settings.option-device-name-desc", "Device name shown in sync history"),
            control: { type: "text", key: "deviceName", placeholder: "Obsidian client" },
          },
          {
            name: t("settings.option-server-host", "Server address"),
            desc: t("settings.option-server-host-desc", "Hostname or IP of the Pumice server"),
            control: { type: "text", key: "serverHost", placeholder: "Localhost" },
          },
          {
            name: t("settings.option-server-port", "Server port"),
            desc: t("settings.option-server-port-desc", "Combined sync and HTTP server port (default: 8080)"),
            control: { type: "number", key: "serverPort", placeholder: "8080", min: 1, max: 65535 },
          },
          {
            name: t("settings.option-auth-token", "Authentication"),
            render: (setting) => this.renderTokenSetting(setting, () => this.update()),
          },
          {
            name: t("settings.option-use-tls", "Use TLS"),
            desc: t("settings.option-use-tls-desc", "Use TLS/SSL when communicating with the server (recommended for remote servers)"),
            control: { type: "toggle", key: "useTls" },
          },
          {
            name: t("settings.action-test-connection", "Test connection"),
            desc: t("settings.option-test-connection-desc", "Pings the server to check the connection"),
            render: (setting) => {
              setting.addButton((btn) =>
                btn
                  .setButtonText(t("settings.action-test-connection", "Test connection"))
                  .setCta()
                  .onClick(async () => {
                    await this.testConnection(btn);
                  })
              );
            },
          },
          {
            // No control -- a status line, not a setting. The plugin keeps a persistent
            // connection open as soon as a token is configured, matching real Obsidian core Sync
            // (see startLiveUpdatesIfNeeded's own comment in main.ts). This is the primary place
            // to check the connection state: unlike the status bar (main.ts's statusBarItemEl),
            // Obsidian mobile has no status bar visible by default, but the settings tab renders
            // the same everywhere. Refreshed via settingTab.update() whenever main.ts's
            // liveConnectionState changes (see setLiveConnectionState()).
            name: t("settings.status-live-connection", "Connection status"),
            visible: () => this.plugin.hasStoredToken,
            render: (setting) => {
              setting.settingEl.empty();
              const { icon, labelKey, labelFallback } = describeLiveStatus(this.plugin.liveConnectionState);
              const el = setting.settingEl.createEl("p", { cls: "setting-item-description pumice-live-status" });
              setIcon(el.createSpan(), icon);
              el.createSpan({ text: t(labelKey, labelFallback) });
            },
          },
        ],
      },
      {
        type: "group",
        heading: t("settings.heading-sync-target", "Sync target"),
        items: [
          {
            name: t("settings.option-sync-files", "Sync files"),
            desc: t("settings.option-sync-files-desc", "Syncs files and folders in the vault"),
            control: { type: "toggle", key: "syncFiles" },
          },
          {
            name: t("settings.option-sync-bookmarks", "Sync bookmarks"),
            desc: t("settings.option-sync-bookmarks-desc", "Syncs Obsidian bookmarks"),
            control: { type: "toggle", key: "syncBookmarks" },
          },
          {
            name: t("settings.option-sync-plugins", "Sync installed plugins"),
            desc: t(
              "settings.option-sync-plugins-desc",
              "Syncs installed community plugins (code, manifest, and the enabled list). This syncs executable code, not just content -- only enable it if you trust this sync server. Restart Obsidian after syncing to apply plugin changes."
            ),
            control: { type: "toggle", key: "syncPlugins" },
          },
          {
            name: t("settings.option-sync-plugin-data", "Include plugin settings (data.json)"),
            desc: t(
              "settings.option-sync-plugin-data-desc",
              "Also syncs each plugin's data.json, which may contain API keys or tokens in plaintext. Consider enabling end-to-end encryption if you turn this on."
            ),
            control: { type: "toggle", key: "syncPluginData" },
            // Re-evaluated automatically after syncPlugins' own toggle control changes (both are
            // plain `control` items, not `render` callbacks -- see obsidian.d.ts's
            // PluginSettingTab#refreshDomState doc: the framework re-evaluates `visible` predicates
            // itself after any standard control-type setting changes).
            visible: () => this.plugin.settings.syncPlugins,
          },
          {
            name: t("settings.option-ignore-patterns", "Ignore patterns"),
            desc: t("settings.option-ignore-patterns-desc", "Paths to exclude from sync (one per line, glob supported)"),
            control: {
              type: "textarea",
              key: "ignorePatterns",
              placeholder: `${this.app.vault.configDir}/workspace\n*.tmp`,
            },
          },
        ],
      },
      {
        type: "group",
        heading: t("settings.heading-conflict-resolution", "Conflict resolution"),
        items: [
          {
            name: t("settings.option-conflict-resolution", "Conflict resolution method"),
            desc: t("settings.option-conflict-resolution-desc", "How to handle conflicts between client and server files. Whichever side doesn't win is always kept as a .sync-conflict backup copy, never silently discarded."),
            control: {
              type: "dropdown",
              key: "conflictResolution",
              options: {
                manual: t("settings.option-conflict-manual", "Manual (choose yourself)"),
                "server-wins": t("settings.option-conflict-server-wins", "Server wins"),
                "client-wins": t("settings.option-conflict-client-wins", "Client wins"),
                merge: t("settings.option-conflict-merge", "Auto-merge (mark real conflicts inline)"),
              } satisfies Record<ConflictResolution, string>,
            },
          },
        ],
      },
      {
        type: "group",
        heading: t("settings.heading-security", "Security (E2EE encryption)"),
        items: [
          {
            name: t("settings.option-e2ee", "End-to-end encryption (E2EE)"),
            desc: t("settings.option-e2ee-desc", "Encrypts files with a symmetric key (AES-256-GCM) on your local device before sending them to the server."),
            control: { type: "toggle", key: "enableE2EE" },
          },
          {
            name: t("settings.option-e2ee-password", "Sync encryption password"),
            desc: t("settings.option-e2ee-password-desc", "Every device syncing this vault must use the same password for decryption to work."),
            visible: () => this.plugin.settings.enableE2EE || false,
            render: (setting) => {
              setting.addText((text) => {
                text
                  .setPlaceholder(t("settings.placeholder-enter-password", "Enter password"))
                  .setValue(this.plugin.e2eePassword || "")
                  .onChange(async (value) => {
                    this.plugin.e2eePassword = value;
                    await saveE2eePassword(this.app, value);
                  });
                text.inputEl.type = "password";
                text.inputEl.autocomplete = "off";
              });
            },
          },
        ],
      },
      {
        type: "group",
        heading: t("settings.heading-vault-sharing", "Vault sharing"),
        items: [
          {
            name: t("settings.option-manage-sharing", "Manage sharing…"),
            desc: t("settings.option-manage-sharing-desc", "Invite other accounts to sync this vault -- they get the same full read/write access you have."),
            visible: () => !this.plugin.settings.sharedVaultOwner,
            action: () => {
              new VaultShareModal(this.app, this.plugin).open();
            },
          },
          {
            name: t("settings.option-shared-vault-owner", "Sync someone else's vault"),
            desc: t("settings.option-shared-vault-owner-desc", "The account name of the vault owner who invited you. Leave empty if you own this vault yourself."),
            control: { type: "text", key: "sharedVaultOwner", placeholder: t("settings.placeholder-shared-vault-owner", "Owner's account name") },
          },
          {
            name: t("settings.option-leave-shared-vault", "Leave this shared vault"),
            desc: t("settings.option-leave-shared-vault-desc", "Removes your access -- ask the owner to re-invite you if you need it back."),
            visible: () => Boolean(this.plugin.settings.sharedVaultOwner),
            action: () => {
              void (async () => {
                const owner = this.plugin.settings.sharedVaultOwner;
                if (!owner) return;
                try {
                  const client = await this.plugin.getSyncClient();
                  await client.leaveSharedVault(owner);
                  this.plugin.settings.sharedVaultOwner = "";
                  await this.plugin.saveSettings();
                  this.update();
                  new Notice(t("settings.msg-left-shared-vault", "Left the shared vault."));
                } catch (e: unknown) {
                  new Notice(t("settings.msg-leave-shared-vault-failed", "Failed to leave: {{error}}", {
                    error: e instanceof Error ? e.message : String(e),
                  }));
                }
              })();
            },
          },
        ],
      },
      {
        type: "group",
        heading: t("settings.heading-local-snapshots", "Local snapshots"),
        items: [
          {
            name: t("settings.option-snapshot-interval", "Save interval (minutes)"),
            desc: t("settings.option-snapshot-interval-desc", "Saves another local snapshot if the file changes after this much time has passed"),
            control: { type: "number", key: "localSnapshotIntervalMinutes", placeholder: "5", min: 0, step: "any" },
          },
          {
            name: t("settings.option-snapshot-keep-days", "Retention period (days)"),
            desc: t("settings.option-snapshot-keep-days-desc", "Local snapshots older than this are cleaned up automatically"),
            control: { type: "number", key: "localSnapshotKeepDays", placeholder: "7", min: 1, step: "any" },
          },
          {
            name: t("settings.option-clear-snapshots", "Clear local snapshots"),
            desc: t("settings.option-clear-snapshots-desc", "Deletes every local snapshot saved so far"),
            // Wrapped so the action itself stays void-returning (as SettingDefinitionAction expects)
            // while still catching whatever clearAll() throws, instead of an unhandled rejection.
            action: () => {
              void (async () => {
                try {
                  await this.plugin.snapshotStore.clearAll();
                  new Notice(t("settings.msg-snapshots-cleared", "All local snapshots cleared"));
                } catch (e: unknown) {
                  new Notice(t("settings.msg-clear-snapshots-failed", "Failed to clear local snapshots: {{error}}", {
                    error: e instanceof Error ? e.message : String(e),
                  }));
                }
              })();
            },
          },
        ],
      },
      {
        type: "group",
        heading: t("settings.heading-actions", "Run sync"),
        items: [
          {
            name: t("settings.option-sync-now", "Sync now"),
            desc: t("settings.option-sync-now-desc", "Runs a full sync immediately"),
            // syncNow() already catches and Notice()s its own failures (see main.ts) -- void is
            // enough here, just to keep the action itself void-returning as expected.
            action: () => {
              void this.plugin.syncNow();
            },
          },
          {
            name: t("settings.option-diagnostics-log", "Diagnostics log"),
            desc: t("settings.option-diagnostics-log-desc", "View retries, skipped self-triggered events, and queued syncs recorded during past syncs"),
            action: () => {
              new SyncDiagnosticsModal(this.app, this.plugin).open();
            },
          },
        ],
      },
    ];
  }

  // The default PluginSettingTab.setControlValue would write straight to `this.plugin.settings`
  // and call saveData() with just that object -- but this plugin's actual persisted shape is
  // `{ settings, deletedFiles }` (see main.ts's savePluginData()), so that default would silently
  // drop deletedFiles on every declarative-control change. Routing through the plugin's own
  // saveSettings() (used by every hand-written onChange below too) also restarts auto-sync when a
  // relevant setting changes, which the default has no way to know to do.
  getControlValue(key: string): unknown {
    return (this.plugin.settings as unknown as Record<string, unknown>)[key];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    if (key === "userName" || key === "deviceName") {
      const fallback = key === "userName" ? "Obsidian User" : "Obsidian Client";
      value = typeof value === "string" ? value.trim() || fallback : fallback;
    } else if (key === "serverHost" && typeof value === "string") {
      value = value.trim();
    }
    (this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
    await this.plugin.saveSettings();
  }

  private renderTokenSetting(setting: Setting, onTokenChanged: () => void): void {
    const hasToken = this.plugin.hasStoredToken;

    const desc = hasToken
      ? t("settings.desc-token-set", "A token is set — stored in Obsidian's secure storage")
      : t("settings.desc-login", "Opens the server's login page in your browser and issues this device its own token automatically");

    setting
      .setName(t("settings.option-auth-token", "Authentication"))
      .setDesc(desc);

    if (hasToken) {
      setting.addButton((btn) => {
        btn.setButtonText(t("dialogue.button-delete", "Delete"));
        btn.setDestructive();
        btn.onClick(async () => {
          await deleteToken(this.app);
          this.plugin.hasStoredToken = false;
          // Drops the persistent connection right away instead of leaving it open (still
          // authenticated under the now-deleted token) until it happens to drop on its own.
          this.plugin.disconnectTransport();
          new Notice(t("settings.msg-token-deleted", "Token deleted"));
          onTokenChanged();
        });
      });
    } else {
      setting.addButton((btn) =>
        btn
          .setButtonText(t("settings.action-login", "Log in"))
          .setCta()
          .onClick(() => this.startDeviceLogin())
      );
    }
  }

  // Opens the server's /login page in the system browser with a redirect back to this plugin's
  // obsidian:// protocol handler (registered in main.ts) -- login there hands back a device
  // token automatically instead of the user having to copy/paste one.
  private startDeviceLogin(): void {
    const { serverHost, serverPort, useTls, deviceName } = this.plugin.settings;
    if (!serverHost) {
      new Notice(t("settings.msg-login-no-server", "Set the server address first."));
      return;
    }
    const protocol = useTls ? "https" : "http";
    const url = new URL(`${protocol}://${serverHost}:${serverPort}/login`);
    url.searchParams.set("redirect", "obsidian://pumice-auth");
    url.searchParams.set("device_name", deviceName || "Obsidian Client");
    window.open(url.toString(), "_blank");
  }

  private async testConnection(btn: ButtonComponent): Promise<void> {
    btn.setButtonText(t("settings.label-checking", "Checking...")).setDisabled(true);
    try {
      await this.plugin.testConnection();
      new Notice(t("settings.msg-connection-success", "Server connection successful"));
    } catch (e: unknown) {
      new Notice(t("settings.msg-connection-failed", "Server connection failed: {{error}}", {
        error: e instanceof Error ? e.message : String(e),
      }));
    } finally {
      btn.setButtonText(t("settings.action-test-connection", "Test connection")).setDisabled(false);
    }
  }
}
