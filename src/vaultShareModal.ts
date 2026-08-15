// Vault sync sharing (see 14_vault_sharing_설계.md) -- owner-only "Manage sharing" modal, opened
// from settingsTab.ts. Distinct from publishModal.ts's own (currently dormant) share section,
// which invites viewers to a *published site*, not collaborators on the vault's own sync data.
// Visual/UX pattern borrowed from that dormant code, but this one is actually wired up.

import { App, ButtonComponent, Modal, Notice } from "obsidian";
import type SyncPlugin from "./main";
import { t } from "./i18n";
import { errorMessage } from "./errorMessage";

export class VaultShareModal extends Modal {
  private plugin: SyncPlugin;
  private listEl!: HTMLElement;
  private emailInput!: HTMLInputElement;
  private inviteButton!: ButtonComponent;

  constructor(app: App, plugin: SyncPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.render();
    void this.loadShares();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("pumice-vault-share-modal");

    contentEl.createEl("h2", {
      text: t("settings.vault-share-title", "Manage sharing for \"{{vaultName}}\"", { vaultName: this.app.vault.getName() }),
    });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: t(
        "settings.vault-share-desc",
        "Anyone invited here gets the same full read/write sync access you have -- there's no separate view-only role. If this vault uses end-to-end encryption, share the encryption password with them separately; it's never sent automatically."
      ),
    });

    const inviteRow = contentEl.createDiv({ cls: "setting-item" });
    inviteRow.createDiv({ cls: "setting-item-info" }, (el) => {
      el.createDiv({ cls: "setting-item-name", text: t("settings.vault-share-invite", "Invite by email") });
    });
    inviteRow.createDiv({ cls: "setting-item-control" }, (el) => {
      this.emailInput = el.createEl("input", {
        type: "email",
        placeholder: t("settings.vault-share-email-placeholder", "Email"),
      });
      this.emailInput.addEventListener("keydown", (evt) => {
        if (!evt.isComposing && evt.key === "Enter") void this.invite();
      });
      this.inviteButton = new ButtonComponent(el)
        .setButtonText(t("settings.vault-share-invite-button", "Invite"))
        .setCta()
        .onClick(() => void this.invite());
    });

    this.listEl = contentEl.createDiv({ cls: "setting-item-list" });
  }

  private async invite(): Promise<void> {
    const email = this.emailInput.value.trim();
    if (!email) return;
    this.emailInput.disabled = true;
    this.inviteButton.setDisabled(true);
    try {
      const client = await this.plugin.getSyncClient();
      await client.inviteVaultShare(email);
      this.emailInput.value = "";
      await this.loadShares();
    } catch (e: unknown) {
      new Notice(t("settings.vault-share-invite-failed", "Invite failed: {{error}}", { error: errorMessage(e) }));
    } finally {
      this.emailInput.disabled = false;
      this.inviteButton.setDisabled(false);
      this.emailInput.focus();
    }
  }

  private async loadShares(): Promise<void> {
    this.listEl.empty();
    try {
      const client = await this.plugin.getSyncClient();
      const shares = await client.listVaultShares();
      if (!shares.length) {
        this.listEl.createDiv({ cls: "u-muted", text: t("settings.vault-share-none", "Not shared with anyone") });
        return;
      }
      for (const share of shares) {
        const row = this.listEl.createDiv({ cls: "setting-item" });
        row.createDiv({ cls: "setting-item-info" }, (el) => {
          el.createDiv({ cls: "setting-item-name", text: share.email });
          el.createDiv({
            cls: "setting-item-description",
            text: share.accepted
              ? t("settings.vault-share-accepted", "Accepted")
              : t("settings.vault-share-pending", "Invite pending"),
          });
        });
        row.createDiv({ cls: "setting-item-control" }, (el) => {
          new ButtonComponent(el)
            .setButtonText(t("settings.vault-share-remove", "Remove"))
            .setDestructive()
            .onClick(() => {
              void (async () => {
                try {
                  await client.removeVaultShare(share.uid);
                  await this.loadShares();
                } catch (e: unknown) {
                  new Notice(t("settings.vault-share-remove-failed", "Remove failed: {{error}}", { error: errorMessage(e) }));
                }
              })();
            });
        });
      }
    } catch (e: unknown) {
      this.listEl.createDiv({
        cls: "mod-warning",
        text: t("settings.vault-share-load-failed", "Failed to load shares: {{error}}", { error: errorMessage(e) }),
      });
    }
  }
}
