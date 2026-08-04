import { App, ButtonComponent, Modal, Notice, moment } from "obsidian";
import type SyncPlugin from "./main";
import type { SyncLogEntry } from "./syncDiagnosticsLog";
import { t } from "./i18n";
import { errorMessage } from "./errorMessage";

function formatLine(entry: SyncLogEntry): string {
  return `[${moment(entry.ts).format("YYYY-MM-DD HH:mm:ss")}] ${entry.level.toUpperCase()} ${entry.message}`;
}

export class SyncDiagnosticsModal extends Modal {
  private plugin: SyncPlugin;

  constructor(app: App, plugin: SyncPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("grpc-sync-diagnostics-modal");

    contentEl.createEl("h2", { text: t("plugins.sync.diagnostics-title", "Sync diagnostics log") });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: t(
        "plugins.sync.diagnostics-desc",
        "Records skipped self-triggered events, in-sync retries, and queued syncs as they happen, so you can check afterward whether they actually occurred."
      ),
    });

    const entries = this.plugin.syncDiagnosticsLog.getEntries();

    const buttonRow = contentEl.createDiv({ cls: "grpc-sync-diagnostics-actions" });
    new ButtonComponent(buttonRow)
      .setButtonText(t("plugins.sync.action-copy-log", "Copy to clipboard"))
      .onClick(async () => {
        try {
          await navigator.clipboard.writeText(entries.map(formatLine).join("\n"));
          new Notice(t("interface.copied_generic", "Copied to clipboard"));
        } catch (e: unknown) {
          new Notice(t("plugins.sync.msg-copy-failed", "Copy failed: {{error}}", { error: errorMessage(e) }));
        }
      });
    const clearButton = new ButtonComponent(buttonRow).setButtonText(t("plugins.sync.action-clear-log", "Clear log"));
    clearButton.setDestructive();
    clearButton.onClick(() => {
      this.plugin.syncDiagnosticsLog.clear();
      this.render();
    });

    const listEl = contentEl.createDiv({ cls: "grpc-sync-diagnostics-list" });
    if (entries.length === 0) {
      listEl.createEl("p", {
        cls: "setting-item-description",
        text: t("plugins.sync.msg-log-empty", "No log entries yet."),
      });
      return;
    }

    // Newest first -- entries themselves are stored oldest-first (append order).
    for (const entry of [...entries].reverse()) {
      const row = listEl.createDiv({ cls: `grpc-sync-diagnostics-row grpc-sync-diagnostics-row-${entry.level}` });
      row.createSpan({ cls: "grpc-sync-diagnostics-time", text: moment(entry.ts).format("YYYY-MM-DD HH:mm:ss") });
      row.createSpan({ cls: "grpc-sync-diagnostics-level", text: entry.level.toUpperCase() });
      row.createSpan({ cls: "grpc-sync-diagnostics-message", text: entry.message });
    }
  }
}
