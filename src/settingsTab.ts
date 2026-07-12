import { App, PluginSettingTab, Setting, ButtonComponent, Notice } from "obsidian";
import type SyncPlugin from "./main";
import { deleteToken, saveE2eePassword } from "./tokenStore";
import type { ConflictResolution } from "./settings";
import { t } from "./i18n";

export class SyncSettingTab extends PluginSettingTab {
  plugin: SyncPlugin;

  constructor(app: App, plugin: SyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.renderConnectionSection(containerEl);
    this.renderSyncTargetSection(containerEl);
    this.renderAutoSyncSection(containerEl);
    this.renderConflictSection(containerEl);
    this.renderE2EESection(containerEl);
    this.renderLocalSnapshotSection(containerEl);
    this.renderActionsSection(containerEl);
  }

  private renderConnectionSection(containerEl: HTMLElement): void {
    // Per Obsidian's guidelines: don't put a heading at the very top of a settings tab (the tab
    // itself already has a title) — only the first section skips one, later sections below use
    // setHeading() to separate them.

    // The vault's folder name is used as-is as the server-side vault identifier everywhere (see
    // syncClient.ts) — there's no separate vault ID setting, and the server doesn't warn on a
    // mismatch, it just silently treats a differently-named folder as an unrelated vault. This is
    // the one place that's surfaced to the user, so a typo or a renamed folder is caught here
    // instead of showing up later as "why isn't this syncing with my other device."
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: t(
        "settings.note-vault-name-identifies-vault",
        "This vault is identified to the server by its folder name (\"{{vaultName}}\") — every device syncing this same vault must use a folder with the exact same name.",
        { vaultName: this.app.vault.getName() }
      ),
    });

    new Setting(containerEl)
      .setName(t("settings.option-user-name", "User name"))
      .setDesc(t("settings.option-user-name-desc", "Username shown in sync history"))
      .addText((text) =>
        text
          .setPlaceholder("Obsidian User")
          .setValue(this.plugin.settings.userName)
          .onChange(async (value) => {
            this.plugin.settings.userName = value.trim() || "Obsidian User";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("settings.option-device-name", "Device name"))
      .setDesc(t("settings.option-device-name-desc", "Device name shown in sync history"))
      .addText((text) =>
        text
          .setPlaceholder("Obsidian Client")
          .setValue(this.plugin.settings.deviceName)
          .onChange(async (value) => {
            this.plugin.settings.deviceName = value.trim() || "Obsidian Client";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("settings.option-server-host", "Server address"))
      .setDesc(t("settings.option-server-host-desc", "Hostname or IP of the gRPC server"))
      .addText((text) =>
        text
          .setPlaceholder("localhost")
          .setValue(this.plugin.settings.serverHost)
          .onChange(async (value) => {
            this.plugin.settings.serverHost = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("settings.option-server-port", "Server port"))
      .setDesc(t("settings.option-server-port-desc", "Combined sync and HTTP server port (default: 8080)"))
      .addText((text) =>
        text
          .setPlaceholder("8080")
          .setValue(String(this.plugin.settings.serverPort))
          .onChange(async (value) => {
            const port = parseInt(value, 10);
            if (!isNaN(port) && port > 0 && port < 65536) {
              this.plugin.settings.serverPort = port;
              await this.plugin.saveSettings();
            }
          })
      );

    this.renderTokenSetting(containerEl);

    new Setting(containerEl)
      .setName(t("settings.option-use-tls", "Use TLS"))
      .setDesc(t("settings.option-use-tls-desc", "Use TLS/SSL when communicating with the server (recommended for remote servers)"))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.useTls)
          .onChange(async (value) => {
            this.plugin.settings.useTls = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("settings.action-test-connection", "Test connection"))
      .setDesc(t("settings.option-test-connection-desc", "Pings the server to check the connection"))
      .addButton((btn) =>
        btn
          .setButtonText(t("settings.action-test-connection", "Test connection"))
          .setCta()
          .onClick(async () => {
            await this.testConnection(btn);
          })
      );
  }

  private renderTokenSetting(containerEl: HTMLElement): void {
    const hasToken = this.plugin.hasStoredToken;

    const desc = hasToken
      ? t("settings.desc-token-set", "A token is set — stored in Obsidian's secure storage")
      : t("settings.desc-login", "Opens the server's login page in your browser and issues this device its own token automatically");

    const setting = new Setting(containerEl)
      .setName(t("settings.option-auth-token", "Authentication"))
      .setDesc(desc);

    if (hasToken) {
      setting.addButton((btn) =>
        btn
          .setButtonText(t("dialogue.button-delete", "Delete"))
          .setWarning()
          .onClick(async () => {
            await deleteToken(this.app);
            this.plugin.hasStoredToken = false;
            new Notice(t("settings.msg-token-deleted", "Token deleted"));
            this.display();
          })
      );
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

  private renderSyncTargetSection(containerEl: HTMLElement): void {
    new Setting(containerEl).setName(t("settings.heading-sync-target", "Sync target")).setHeading();

    new Setting(containerEl)
      .setName(t("settings.option-sync-files", "Sync files"))
      .setDesc(t("settings.option-sync-files-desc", "Syncs files and folders in the vault"))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncFiles)
          .onChange(async (value) => {
            this.plugin.settings.syncFiles = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("settings.option-sync-bookmarks", "Sync bookmarks"))
      .setDesc(t("settings.option-sync-bookmarks-desc", "Syncs Obsidian bookmarks"))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncBookmarks)
          .onChange(async (value) => {
            this.plugin.settings.syncBookmarks = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("settings.option-ignore-patterns", "Ignore patterns"))
      .setDesc(t("settings.option-ignore-patterns-desc", "Paths to exclude from sync (one per line, glob supported)"))
      .addTextArea((area) =>
        area
          .setPlaceholder(`${this.app.vault.configDir}/workspace\n*.tmp`)
          .setValue(this.plugin.settings.ignorePatterns)
          .onChange(async (value) => {
            this.plugin.settings.ignorePatterns = value;
            await this.plugin.saveSettings();
          })
      );
  }

  private renderAutoSyncSection(containerEl: HTMLElement): void {
    new Setting(containerEl).setName(t("settings.heading-auto-sync", "Auto sync")).setHeading();

    new Setting(containerEl)
      .setName(t("settings.option-enable-auto-sync", "Enable auto sync"))
      .setDesc(t("settings.option-enable-auto-sync-desc", "Runs sync automatically on a schedule"))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoSync)
          .onChange(async (value) => {
            this.plugin.settings.autoSync = value;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.autoSync) {
      new Setting(containerEl)
        .setName(t("settings.option-sync-interval", "Sync interval (seconds)"))
        .setDesc(t("settings.option-sync-interval-desc", "How often auto sync runs (minimum 10 seconds)"))
        .addSlider((slider) =>
          slider
            .setLimits(10, 3600, 10)
            .setValue(this.plugin.settings.syncIntervalSeconds)
            .setDynamicTooltip()
            .onChange(async (value) => {
              this.plugin.settings.syncIntervalSeconds = value;
              await this.plugin.saveSettings();
            })
        );
    }

    new Setting(containerEl)
      .setName(t("settings.option-sync-on-startup", "Sync on startup"))
      .setDesc(t("settings.option-sync-on-startup-desc", "Runs sync automatically when Obsidian starts"))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncOnStartup)
          .onChange(async (value) => {
            this.plugin.settings.syncOnStartup = value;
            await this.plugin.saveSettings();
          })
      );
  }

  private renderConflictSection(containerEl: HTMLElement): void {
    new Setting(containerEl).setName(t("settings.heading-conflict-resolution", "Conflict resolution")).setHeading();

    new Setting(containerEl)
      .setName(t("settings.option-conflict-resolution", "Conflict resolution method"))
      .setDesc(t("settings.option-conflict-resolution-desc", "How to handle conflicts between client and server files"))
      .addDropdown((drop) =>
        drop
          .addOptions({
            manual: t("settings.option-conflict-manual", "Manual (choose yourself)"),
            "server-wins": t("settings.option-conflict-server-wins", "Server wins"),
            "client-wins": t("settings.option-conflict-client-wins", "Client wins"),
          } satisfies Record<ConflictResolution, string>)
          .setValue(this.plugin.settings.conflictResolution)
          .onChange(async (value) => {
            this.plugin.settings.conflictResolution = value as ConflictResolution;
            await this.plugin.saveSettings();
          })
      );
  }

  private renderE2EESection(containerEl: HTMLElement): void {
    new Setting(containerEl).setName(t("settings.heading-security", "Security (E2EE encryption)")).setHeading();

    new Setting(containerEl)
      .setName(t("settings.option-e2ee", "End-to-end encryption (E2EE)"))
      .setDesc(t("settings.option-e2ee-desc", "Encrypts files with a symmetric key (AES-256-GCM) on your local device before sending them to the server."))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableE2EE || false)
          .onChange(async (value) => {
            this.plugin.settings.enableE2EE = value;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.enableE2EE) {
      new Setting(containerEl)
        .setName(t("settings.option-e2ee-password", "Sync encryption password"))
        .setDesc(t("settings.option-e2ee-password-desc", "Every device syncing this vault must use the same password for decryption to work."))
        .addText((text) => {
          text
            .setPlaceholder(t("settings.placeholder-enter-password", "Enter password"))
            .setValue(this.plugin.e2eePassword || "")
            .onChange(async (value) => {
              this.plugin.e2eePassword = value;
              await saveE2eePassword(this.app, value);
            });
          text.inputEl.type = "password";
          text.inputEl.autocomplete = "off";
          return text;
        });
    }
  }

  private renderLocalSnapshotSection(containerEl: HTMLElement): void {
    new Setting(containerEl).setName(t("settings.heading-local-snapshots", "Local snapshots")).setHeading();

    new Setting(containerEl)
      .setName(t("settings.option-snapshot-interval", "Save interval (minutes)"))
      .setDesc(t("settings.option-snapshot-interval-desc", "Saves another local snapshot if the file changes after this much time has passed"))
      .addText((text) =>
        text
          .setPlaceholder("5")
          .setValue(String(this.plugin.settings.localSnapshotIntervalMinutes))
          .onChange(async (value) => {
            const minutes = parseFloat(value);
            if (!isNaN(minutes) && minutes >= 0) {
              this.plugin.settings.localSnapshotIntervalMinutes = minutes;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName(t("settings.option-snapshot-keep-days", "Retention period (days)"))
      .setDesc(t("settings.option-snapshot-keep-days-desc", "Local snapshots older than this are cleaned up automatically"))
      .addText((text) =>
        text
          .setPlaceholder("7")
          .setValue(String(this.plugin.settings.localSnapshotKeepDays))
          .onChange(async (value) => {
            const days = parseFloat(value);
            if (!isNaN(days) && days >= 1) {
              this.plugin.settings.localSnapshotKeepDays = days;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName(t("settings.option-clear-snapshots", "Clear local snapshots"))
      .setDesc(t("settings.option-clear-snapshots-desc", "Deletes every local snapshot saved so far"))
      .addButton((btn) =>
        btn
          .setButtonText(t("settings.button-clear-snapshots", "Clear saved snapshots"))
          .setWarning()
          .onClick(async () => {
            await this.plugin.snapshotStore.clearAll();
            new Notice(t("settings.msg-snapshots-cleared", "All local snapshots cleared"));
          })
      );
  }

  private renderActionsSection(containerEl: HTMLElement): void {
    new Setting(containerEl).setName(t("settings.heading-actions", "Run sync")).setHeading();

    new Setting(containerEl)
      .setName(t("settings.option-sync-now", "Sync now"))
      .setDesc(t("settings.option-sync-now-desc", "Runs a full sync immediately"))
      .addButton((btn) =>
        btn
          .setButtonText(t("settings.button-sync-now", "Start sync"))
          .setCta()
          .onClick(async () => {
            await this.plugin.syncNow();
          })
      );
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
