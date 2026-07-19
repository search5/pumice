import { AbstractInputSuggest, App, ButtonComponent, Modal, Notice, Platform, Setting, TFile, moment, setIcon, setTooltip } from "obsidian";
import type SyncPlugin from "./main";
import type { LocalSnapshot } from "./localSnapshotStore";
import { t } from "./i18n";
import { renderDiff } from "./diffView";
import { enableSwipeNavigation } from "./swipeNavigation";
import { errorMessage } from "./errorMessage";

const DIFF_TOGGLE_STORAGE_KEY = "history-show-diff";

function dirnameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

function basenameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

function extensionOf(path: string): string {
  const base = basenameOf(path);
  const idx = base.lastIndexOf(".");
  return idx === -1 ? "" : base.slice(idx + 1);
}

function humanFileSize(chars: number): string {
  if (chars < 1024) return `${chars} B`;
  const units = ["KB", "MB", "GB"];
  let value = chars / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

export async function hasLocalSnapshots(plugin: SyncPlugin, file: TFile): Promise<boolean> {
  if (!["md", "canvas", "base"].includes(file.extension)) return false;
  return plugin.snapshotStore.hasSnapshots(file.path);
}

// File path autocomplete attached to the search box (switches between files across the whole vault
// that have local snapshot history).
class FileHistorySuggest extends AbstractInputSuggest<string> {
  constructor(
    app: App,
    inputEl: HTMLInputElement,
    private paths: string[],
    private onPick: (path: string) => void
  ) {
    super(app, inputEl);
  }
  protected getSuggestions(query: string): string[] {
    const q = query.toLowerCase();
    return this.paths.filter((p) => p.toLowerCase().contains(q));
  }
  renderSuggestion(path: string, el: HTMLElement) {
    el.setText(path);
  }
  selectSuggestion(path: string) {
    this.setValue(path);
    this.close();
    this.onPick(path);
  }
}

// Modal for opening saved snapshots: desktop and mobile use different layouts (the same branching
// pattern as SyncHistoryModal). Desktop shows the sidebar and body together (arrow-key navigation);
// mobile slides from the list to a full-screen preview.
export class LocalSnapshotModal extends Modal {
  private isDesktop = !Platform.isMobile;

  private searchInputEl!: HTMLInputElement;
  private listEl!: HTMLElement;

  private previewBodyEl!: HTMLElement;
  private textareaEl!: HTMLTextAreaElement;
  private diffEl!: HTMLElement;
  private copyButton!: ButtonComponent;
  private restoreButton!: ButtonComponent;
  private swipeCleanup: (() => void) | null = null;

  private diffOn = false;
  private currentIndex = 0;
  private currentPath = "";

  private allPaths: string[] = [];
  private snapshots: LocalSnapshot[] = [];
  private activeSnapshot: LocalSnapshot | null = null;
  private activeOlderSnapshot: LocalSnapshot | null = null;

  // Desktop only — the header is built once and reused, so only its text gets updated whenever the
  // file/revision changes.
  private cardEls: HTMLElement[] = [];
  private activeCardEl: HTMLElement | null = null;
  private filenameEl!: HTMLElement;
  private timestampEl!: HTMLElement;

  // Mobile only
  private mobileLayoutEl!: HTMLElement;

  constructor(
    app: App,
    private plugin: SyncPlugin,
    private initialFile: TFile
  ) {
    super(app);
    this.modalEl.addClass(this.isDesktop ? "grpc-history-modal-desktop" : "grpc-history-modal-mobile");
    this.diffOn = !!this.app.loadLocalStorage(DIFF_TOGGLE_STORAGE_KEY);
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(t("plugins.file-recovery.name", "File Recovery"));

    if (this.isDesktop) this.buildDesktopLayout();
    else this.buildMobileLayout();

    contentEl.addClass("is-loading");
    try {
      this.allPaths = await this.plugin.snapshotStore.getAllPathsWithHistory();
      if (this.allPaths.length === 0) {
        this.showNoHistory();
        return;
      }
    } finally {
      contentEl.removeClass("is-loading");
    }

    new FileHistorySuggest(this.app, this.searchInputEl, this.allPaths, (path) => void this.switchToPath(path));

    if (this.allPaths.includes(this.initialFile.path)) {
      await this.switchToPath(this.initialFile.path);
    } else {
      this.searchInputEl.focus();
    }
  }

  onClose() {
    this.swipeCleanup?.();
    this.contentEl.empty();
  }

  private buildDesktopLayout(): void {
    const layoutEl = this.contentEl.createDiv("grpc-desktop-layout");

    const sidebarEl = layoutEl.createDiv("grpc-desktop-sidebar");
    const searchSetting = new Setting(sidebarEl);
    searchSetting.infoEl.hide();
    searchSetting.addSearch((search) => {
      search.setPlaceholder(t("plugins.file-recovery.placeholder-choose-file", "Choose a file..."));
      this.searchInputEl = search.inputEl;
    });
    this.listEl = sidebarEl.createDiv("grpc-history-list");

    const contentPaneEl = layoutEl.createDiv("grpc-desktop-content");
    const headerEl = contentPaneEl.createDiv("grpc-desktop-content-header");
    const titleGroupEl = headerEl.createDiv("grpc-desktop-content-title-group");
    this.filenameEl = titleGroupEl.createDiv({ cls: "grpc-preview-filename", text: t("plugins.file-recovery.name", "File Recovery") });
    this.timestampEl = titleGroupEl.createDiv({ cls: "grpc-preview-timestamp u-muted" });
    this.buildDiffToggleBtn(headerEl);

    this.previewBodyEl = contentPaneEl.createDiv("grpc-preview-body");
    this.textareaEl = this.previewBodyEl.createEl("textarea", {
      cls: "grpc-history-text",
      attr: { readonly: "true", spellcheck: "false" },
    });
    this.diffEl = this.previewBodyEl.createDiv("grpc-history-diff");

    const actionBarEl = contentPaneEl.createDiv("grpc-preview-actionbar");
    this.copyButton = new ButtonComponent(actionBarEl)
      .setButtonText(t("interface.label-copy-short", "Copy"))
      .onClick(() => void this.copyActiveSnapshot());
    this.restoreButton = new ButtonComponent(actionBarEl)
      .setButtonText(t("plugins.sync.label-restore-this-version", "Restore this version"))
      .setCta()
      .onClick(() => void this.restoreActiveSnapshot());

    this.scope.register(null, "ArrowUp", () => {
      this.navigateBy(-1);
      return false;
    });
    this.scope.register(null, "ArrowDown", () => {
      this.navigateBy(1);
      return false;
    });
  }

  private buildMobileLayout(): void {
    this.mobileLayoutEl = this.contentEl.createDiv("grpc-mobile-layout");

    const listScreenEl = this.mobileLayoutEl.createDiv("grpc-history-list-screen grpc-mobile-screen");
    const searchContainerEl = listScreenEl.createDiv("grpc-history-search-container");
    const searchSetting = new Setting(searchContainerEl);
    searchSetting.infoEl.hide();
    searchSetting.addSearch((search) => {
      search.setPlaceholder(t("plugins.file-recovery.placeholder-choose-file", "Choose a file..."));
      this.searchInputEl = search.inputEl;
    });
    this.listEl = listScreenEl.createDiv("grpc-history-list");

    const previewScreenEl = this.mobileLayoutEl.createDiv("grpc-history-preview-screen grpc-mobile-screen");
    this.previewBodyEl = previewScreenEl.createDiv("grpc-preview-body");
    this.textareaEl = this.previewBodyEl.createEl("textarea", {
      cls: "grpc-history-text",
      attr: { readonly: "true", spellcheck: "false" },
    });
    this.diffEl = this.previewBodyEl.createDiv("grpc-history-diff");

    const actionBarEl = previewScreenEl.createDiv("grpc-preview-actionbar");
    this.copyButton = new ButtonComponent(actionBarEl)
      .setButtonText(t("interface.label-copy-short", "Copy"))
      .onClick(() => void this.copyActiveSnapshot());
    this.restoreButton = new ButtonComponent(actionBarEl)
      .setButtonText(t("plugins.sync.label-restore-this-version", "Restore this version"))
      .setCta()
      .onClick(() => void this.restoreActiveSnapshot());

    this.swipeCleanup = enableSwipeNavigation(this.previewBodyEl, {
      onPrev: () => this.navigateBy(-1),
      onNext: () => this.navigateBy(1),
    });
  }

  private buildDiffToggleBtn(containerEl: HTMLElement): HTMLElement {
    const diffBtn = containerEl.createSpan("grpc-diff-icon-btn");
    setIcon(diffBtn, "git-compare");
    diffBtn.toggleClass("is-active", this.diffOn);
    setTooltip(diffBtn, t("plugins.sync.label-show-diff", "Show diff"));
    diffBtn.addEventListener("click", () => {
      this.diffOn = !this.diffOn;
      this.app.saveLocalStorage(DIFF_TOGGLE_STORAGE_KEY, this.diffOn ? true : null);
      diffBtn.toggleClass("is-active", this.diffOn);
      this.applyToggleState();
    });
    return diffBtn;
  }

  private showNoHistory() {
    this.contentEl.createEl("p", {
      cls: "grpc-history-empty-state",
      text: t("plugins.file-recovery.label-no-history-found", "No history to display."),
    });
  }

  private async switchToPath(path: string) {
    this.currentPath = path;
    this.searchInputEl.value = basenameOf(path);
    this.searchInputEl.blur();

    this.listEl.empty();
    this.cardEls = [];
    this.activeCardEl = null;
    this.activeSnapshot = null;
    this.snapshots = await this.plugin.snapshotStore.getSnapshotsForPath(path);

    this.snapshots.forEach((snapshot, index) => this.renderCard(snapshot, index));

    if (this.isDesktop) {
      this.filenameEl.setText(basenameOf(path));
      if (this.snapshots.length > 0) this.selectIndex(0);
    } else {
      this.slideToList();
    }
  }

  private renderCard(snapshot: LocalSnapshot, index: number): void {
    const cardEl = this.listEl.createDiv("grpc-history-card");
    const detailsEl = cardEl.createDiv({ cls: "grpc-history-item-details", text: moment(snapshot.ts).format("llll") });
    detailsEl.createDiv({ cls: "u-small u-muted", text: humanFileSize(snapshot.data.length) });

    if (this.isDesktop) {
      this.cardEls[index] = cardEl;
      cardEl.addEventListener("click", () => this.selectIndex(index));
    } else {
      setIcon(cardEl.createSpan("grpc-history-card-chevron"), "chevron-right");
      cardEl.addEventListener("click", () => {
        this.selectIndex(index);
        this.mobileLayoutEl.addClass("is-preview");
      });
    }
  }

  private slideToList(): void {
    this.mobileLayoutEl?.removeClass("is-preview");
    this.titleEl.empty();
    this.titleEl.setText(t("plugins.file-recovery.name", "File Recovery"));
  }

  private navigateBy(delta: number): void {
    const next = this.currentIndex + delta;
    if (next < 0 || next >= this.snapshots.length) return;
    this.selectIndex(next);
  }

  private selectIndex(index: number): void {
    this.currentIndex = index;
    if (this.isDesktop) {
      this.activeCardEl?.removeClass("is-active");
      const cardEl = this.cardEls[index] ?? null;
      cardEl?.addClass("is-active");
      this.activeCardEl = cardEl;
      this.timestampEl.setText(moment(this.snapshots[index].ts).format("llll"));
    } else {
      this.renderMobileHeader();
    }
    this.renderContentPane();
  }

  // Split into a controls row (back/prev-next/diff toggle) and a separate filename row — cramming
  // everything onto one line caused the filename to get truncated too aggressively and become
  // unreadable on narrow mobile screens.
  private renderMobileHeader(): void {
    this.titleEl.empty();
    const headerEl = this.titleEl.createDiv("grpc-preview-header");

    const controlsEl = headerEl.createDiv("grpc-preview-controls-row");

    const backBtn = controlsEl.createSpan("grpc-preview-nav-btn");
    setIcon(backBtn, "arrow-left");
    backBtn.addEventListener("click", () => this.slideToList());

    const navGroupEl = controlsEl.createDiv("grpc-preview-nav-group");
    const prevBtn = navGroupEl.createSpan("grpc-preview-nav-btn");
    setIcon(prevBtn, "chevron-left");
    prevBtn.toggleClass("is-disabled", this.currentIndex <= 0);
    prevBtn.addEventListener("click", () => this.navigateBy(-1));

    navGroupEl.createSpan({ cls: "u-small u-muted", text: `${this.currentIndex + 1}/${this.snapshots.length}` });

    const nextBtn = navGroupEl.createSpan("grpc-preview-nav-btn");
    setIcon(nextBtn, "chevron-right");
    nextBtn.toggleClass("is-disabled", this.currentIndex >= this.snapshots.length - 1);
    nextBtn.addEventListener("click", () => this.navigateBy(1));

    this.buildDiffToggleBtn(controlsEl);

    headerEl.createDiv({ cls: "grpc-preview-filename", text: basenameOf(this.currentPath) });
    headerEl.createDiv({
      cls: "grpc-preview-timestamp u-muted",
      text: moment(this.snapshots[this.currentIndex].ts).format("llll"),
    });
  }

  private renderContentPane(): void {
    const snapshot = this.snapshots[this.currentIndex];
    this.activeSnapshot = snapshot;
    this.activeOlderSnapshot = this.currentIndex < this.snapshots.length - 1 ? this.snapshots[this.currentIndex + 1] : null;

    this.textareaEl.setAttr("data-ext", extensionOf(snapshot.path));
    this.applyToggleState();
  }

  private applyToggleState() {
    if (!this.activeSnapshot) return;
    this.textareaEl.toggle(!this.diffOn);
    this.diffEl.toggle(this.diffOn);
    if (this.diffOn) {
      const oldText = this.activeOlderSnapshot?.data ?? "";
      this.diffEl.empty();
      renderDiff(this.diffEl, oldText, this.activeSnapshot.data);
    } else {
      this.textareaEl.value = this.activeSnapshot.data;
    }
  }

  private async copyActiveSnapshot() {
    if (!this.activeSnapshot) return;
    try {
      await navigator.clipboard.writeText(this.activeSnapshot.data);
      new Notice(t("interface.copied_generic", "Copied to clipboard"));
    } catch (e: unknown) {
      new Notice(t("plugins.sync.msg-copy-failed", "Copy failed: {{error}}", { error: errorMessage(e) }));
    }
  }

  private async restoreActiveSnapshot() {
    if (!this.activeSnapshot) return;
    const snapshot = this.activeSnapshot;
    try {
      // Restoring must work even if the file was already deleted (no TFile) — overwrite it via
      // vault.process() if it exists, otherwise recreate it with vault.create(). Both are public
      // Vault API calls, so no Adapter is needed. vault.process() is preferred over vault.modify()
      // per Obsidian's guidelines (its read-modify-write cycle is safer against concurrent edits);
      // the callback ignores the current content and always returns the snapshot's.
      const folder = dirnameOf(snapshot.path);
      if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
        await this.app.vault.createFolder(folder);
      }
      const file = this.app.vault.getAbstractFileByPath(snapshot.path);
      if (file instanceof TFile) {
        await this.app.vault.process(file, () => snapshot.data);
      } else {
        await this.app.vault.create(snapshot.path, snapshot.data);
      }
      // Immediately record a fresh snapshot right after restoring — possible without any private
      // API since we own the store directly.
      await this.plugin.snapshotStore.forceAdd(snapshot.path, snapshot.data);
      new Notice(
        t("plugins.sync.msg-restored-version", "Successfully restored the version from {{time}}.", {
          time: moment(snapshot.ts).fromNow(),
        })
      );
      // Refresh the list and show the snapshot we just restored (the most recent one) again.
      this.listEl.empty();
      this.cardEls = [];
      this.activeCardEl = null;
      this.snapshots = await this.plugin.snapshotStore.getSnapshotsForPath(snapshot.path);
      this.snapshots.forEach((s, index) => this.renderCard(s, index));
      this.selectIndex(0);
      if (!this.isDesktop) this.mobileLayoutEl.addClass("is-preview");
    } catch (e: unknown) {
      new Notice(t("plugins.sync.msg-restore-failed", "Failed to restore version: {{error}}", { error: errorMessage(e) }));
    }
  }
}
