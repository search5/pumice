// Site collaboration (see 36_실제_아키텍처_전환_Site_collaboration.md) -- lets a collaborator pick
// which Publish site they've been accepted onto, then opens the normal PublishModal against that
// remote site instead of the caller's own vault. This picker screen is pumice's own design, not
// confirmed real-Obsidian behavior -- the official docs describe the collaboration permission
// model but not the client UI for switching which site you're publishing to. Visual pattern
// borrowed from vaultShareModal.ts (a standalone modal, not one of publishModal.ts's
// SiteOptionsSection-nested sub-modals like CustomDomainModal).

import { App, ButtonComponent, Modal } from "obsidian";
import type SyncPlugin from "./main";
import { t } from "./i18n";
import { errorMessage } from "./errorMessage";
import { sortSharedSites, type SharedSite } from "./siteCollaboration";
import { PublishModal } from "./publishModal";

export class SharedSitePickerModal extends Modal {
  private plugin: SyncPlugin;
  private listEl!: HTMLElement;

  constructor(app: App, plugin: SyncPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.render();
    void this.loadSites();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: t("plugins.publish.action-publish-shared-site", "Publish a shared site…") });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: t("plugins.publish.label-shared-sites-desc", "Choose a site you've been added to as a collaborator."),
    });

    this.listEl = contentEl.createDiv({ cls: "setting-item-list" });
  }

  private async loadSites(): Promise<void> {
    this.listEl.empty();
    try {
      const client = await this.plugin.getSyncClient();
      const sites = sortSharedSites(await client.getMyShares());
      if (!sites.length) {
        this.listEl.createDiv({
          cls: "u-muted",
          text: t("plugins.publish.label-no-shared-sites", "You haven't been added as a collaborator on any site yet."),
        });
        return;
      }
      for (const site of sites) this.renderRow(site);
    } catch (e: unknown) {
      this.listEl.createDiv({
        cls: "mod-warning",
        text: t("plugins.publish.msg-load-shared-sites-failed", "Failed to load shared sites: {{error}}", { error: errorMessage(e) }),
      });
    }
  }

  private renderRow(site: SharedSite): void {
    const row = this.listEl.createDiv({ cls: "setting-item" });
    row.createDiv({ cls: "setting-item-info" }, (el) => {
      el.createDiv({ cls: "setting-item-name", text: site.siteName });
      el.createDiv({
        cls: "setting-item-description",
        text: t("plugins.publish.label-owned-by", "Owned by {{owner}}", { owner: site.owner }),
      });
    });
    row.createDiv({ cls: "setting-item-control" }, (el) => {
      new ButtonComponent(el)
        .setButtonText(t("plugins.publish.button-publish", "Publish"))
        .setCta()
        .onClick(() => {
          this.close();
          new PublishModal(this.app, this.plugin, undefined, site).open();
        });
    });
  }
}
