import { App, ButtonComponent, MarkdownRenderer, Modal, Notice, Platform, TFile, moment, setIcon, setTooltip } from "obsidian";
import SyncPlugin from "./main";
import { t } from "./i18n";
import { renderDiff } from "./diffView";
import { enableSwipeNavigation } from "./swipeNavigation";
import { hasLocalSnapshots, LocalSnapshotModal } from "./fileRecoveryModal";

interface HistoryVersion {
  history_id: number;
  modified_at_ms: number;
  size_bytes: number;
  content_hash: string;
  device_name: string;
  user_name: string;
  deleted?: boolean;
  related_path?: string | null;
}

const AVATAR_COLOR_COUNT = 8;
const ITEMS_PER_PAGE = 20;
const DIFF_TOGGLE_STORAGE_KEY = "history-show-diff";

// Same grouping rule as core Sync's version history (per obsidian.asar/app.js) — revisions merge
// only when they share the same device+user as the group anchor (the most recent item in the
// group) and land within 1 hour of it.
const GROUP_TIME_WINDOW_MS = 36e5;

const MARKDOWN_EXTENSIONS = ["md"];
const PLAINTEXT_EXTENSIONS = ["json", "css", "js", "base", "canvas"];
const IMAGE_EXTENSIONS = ["bmp", "png", "jpg", "jpeg", "gif", "svg", "webp", "avif"];

function dirnameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

function basenameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

function humanFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

// Assumes items are sorted newest-first. Deleted/renamed items always get their own standalone
// group; otherwise, consecutive items merge with the group's first item (the anchor) when they
// share the same day + same device/user + land within 1 hour of the anchor.
function groupHistoryItems(items: HistoryVersion[]): HistoryVersion[][] {
  const groups: HistoryVersion[][] = [];
  let current: HistoryVersion[] = [];

  for (const item of items) {
    if (item.deleted && item.related_path) continue;

    if (current.length === 0) {
      current.push(item);
      continue;
    }

    const anchor = current[0];
    const breaksGroup =
      item.deleted || !!item.related_path || !moment(anchor.modified_at_ms).isSame(item.modified_at_ms, "day");
    const withinGroup =
      !breaksGroup &&
      anchor.device_name === item.device_name &&
      anchor.user_name === item.user_name &&
      anchor.modified_at_ms - item.modified_at_ms < GROUP_TIME_WINDOW_MS;

    if (withinGroup) {
      current.push(item);
    } else {
      groups.push(current);
      current = [item];
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

// Version history modal: desktop and mobile use different layouts (branching on Platform.isMobile).
// - Desktop: wide sidebar (list) + body (diff/preview) shown side by side, arrow keys move between revisions.
// - Mobile: tap a list card → slide to a full-screen preview, swipe left/right to move between revisions.
// Data loading/content rendering (renderContentPane, renderVersionContent) is shared by both layouts.
export class SyncHistoryModal extends Modal {
  private isDesktop = !Platform.isMobile;

  // Grouped revisions. groups[g][0] is the anchor (most recent item) of group g — position is
  // tracked with a dual index (group index + index within the group), so navigation can cross
  // group boundaries without ever flattening back into a single array.
  private groups: HistoryVersion[][] = [];
  private renderedGroupCount = 0;
  private currentGroupIndex = 0;
  private currentItemIndex = 0;
  private activeItem: HistoryVersion | null = null;
  private activeOlderItem: HistoryVersion | null = null;
  private contentCache: Map<number, ArrayBuffer> = new Map();
  private currentToggleHandler: (() => Promise<void>) | null = null;
  private diffOn = !!localStorage.getItem(DIFF_TOGGLE_STORAGE_KEY);

  private listEl!: HTMLElement;
  private loadMoreButtonEl!: HTMLButtonElement;
  private previewBodyEl!: HTMLElement;
  private previewEl!: HTMLElement;
  private diffEl!: HTMLElement;
  private copyButton!: ButtonComponent;
  private restoreButton!: ButtonComponent;

  // Desktop only — the header is built once and reused, so only its text gets updated whenever the
  // revision changes. One card per group (groupCardEls), plus a collapsible sub-list that only
  // exists when a group has 2+ items (groupSubListEls/groupToggleEls/groupSubItemEls; indices line
  // up with itemIndex within the group, and index 0 is always empty — the anchor is shown as the
  // card itself rather than as a sub-list row).
  private groupCardEls: HTMLElement[] = [];
  private groupSubListEls: (HTMLElement | null)[] = [];
  private groupToggleEls: (HTMLElement | null)[] = [];
  private groupSubItemEls: HTMLElement[][] = [];
  private activeCardEl: HTMLElement | null = null;
  private activeSubItemEl: HTMLElement | null = null;
  private timestampEl!: HTMLElement;

  // Mobile only
  private mobileLayoutEl!: HTMLElement;
  private swipeCleanup: (() => void) | null = null;

  constructor(
    readonly app: App,
    readonly plugin: SyncPlugin,
    private file: TFile
  ) {
    super(app);
    this.modalEl.addClass(this.isDesktop ? "grpc-history-modal-desktop" : "grpc-history-modal-mobile");
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(this.file.path);

    if (this.isDesktop) this.buildDesktopLayout();
    else this.buildMobileLayout();

    await this.fetchMore();

    if (this.isDesktop && this.groups.length > 0) {
      this.selectPosition(0, 0);
    }

    // Doesn't depend on the core File Recovery plugin or its internal storage at all — this shows
    // our own local snapshot store (localSnapshotStore.ts), managed directly by our plugin, in our
    // own modal.
    if (await hasLocalSnapshots(this.plugin, this.file)) {
      this.listEl.createEl(
        "button",
        { prepend: true, cls: "grpc-history-button", text: t("plugins.file-recovery.action-open", "Open saved snapshots") },
        (el) => {
          el.addEventListener("click", () => new LocalSnapshotModal(this.app, this.plugin, this.file).open());
        }
      );
    }
  }

  onClose() {
    this.swipeCleanup?.();
    this.contentEl.empty();
  }

  private buildDesktopLayout(): void {
    const layoutEl = this.contentEl.createDiv("grpc-desktop-layout");

    const sidebarEl = layoutEl.createDiv("grpc-desktop-sidebar");
    this.listEl = sidebarEl.createDiv("grpc-history-list");
    this.loadMoreButtonEl = createEl("button", {
      cls: "grpc-history-load-more",
      text: t("plugins.sync.label-load-more", "Load more"),
    });
    this.loadMoreButtonEl.addEventListener("click", () => this.fetchMore());

    const contentPaneEl = layoutEl.createDiv("grpc-desktop-content");
    const headerEl = contentPaneEl.createDiv("grpc-desktop-content-header");
    const titleGroupEl = headerEl.createDiv("grpc-desktop-content-title-group");
    titleGroupEl.createDiv({
      cls: "grpc-preview-filename",
      text: this.file.extension === "md" ? this.file.basename : this.file.path,
    });
    this.timestampEl = titleGroupEl.createDiv({ cls: "grpc-preview-timestamp u-muted" });
    this.buildDiffToggleBtn(headerEl);

    this.previewBodyEl = contentPaneEl.createDiv("grpc-preview-body");
    this.previewEl = this.previewBodyEl.createDiv("grpc-history-preview");
    this.diffEl = this.previewBodyEl.createDiv("grpc-history-diff");

    const actionBarEl = contentPaneEl.createDiv("grpc-preview-actionbar");
    this.copyButton = new ButtonComponent(actionBarEl)
      .setButtonText(t("interface.label-copy-short", "Copy"))
      .onClick(() => this.copyActiveContent());
    this.restoreButton = new ButtonComponent(actionBarEl)
      .setButtonText(t("plugins.sync.label-restore-this-version", "Restore this version"))
      .setCta()
      .onClick(() => this.restoreActiveVersion());

    // Register arrow keys via Modal's built-in Scope (public API) — desktop only.
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
    this.listEl = listScreenEl.createDiv("grpc-history-list");
    this.loadMoreButtonEl = createEl("button", {
      cls: "grpc-history-load-more",
      text: t("plugins.sync.label-load-more", "Load more"),
    });
    this.loadMoreButtonEl.addEventListener("click", () => this.fetchMore());

    const previewScreenEl = this.mobileLayoutEl.createDiv("grpc-history-preview-screen grpc-mobile-screen");
    this.previewBodyEl = previewScreenEl.createDiv("grpc-preview-body");
    this.previewEl = this.previewBodyEl.createDiv("grpc-history-preview");
    this.diffEl = this.previewBodyEl.createDiv("grpc-history-diff");

    const actionBarEl = previewScreenEl.createDiv("grpc-preview-actionbar");
    this.copyButton = new ButtonComponent(actionBarEl)
      .setButtonText(t("interface.label-copy-short", "Copy"))
      .onClick(() => this.copyActiveContent());
    this.restoreButton = new ButtonComponent(actionBarEl)
      .setButtonText(t("plugins.sync.label-restore-this-version", "Restore this version"))
      .setCta()
      .onClick(() => this.restoreActiveVersion());

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
      if (this.diffOn) localStorage.setItem(DIFF_TOGGLE_STORAGE_KEY, "true");
      else localStorage.removeItem(DIFF_TOGGLE_STORAGE_KEY);
      diffBtn.toggleClass("is-active", this.diffOn);
      void this.currentToggleHandler?.();
    });
    return diffBtn;
  }

  private async fetchMore() {
    this.loadMoreButtonEl.detach();

    if (this.groups.length === 0) {
      try {
        const client = await this.plugin.getSyncClient();
        const versions: HistoryVersion[] = await client.getFileHistory(this.file.path);
        versions.sort((a, b) => b.modified_at_ms - a.modified_at_ms);
        this.groups = groupHistoryItems(versions);
      } catch (e: any) {
        console.error("Failed to load history:", e);
        new Notice(t("plugins.sync.label-unable-to-retrieve", "Unable to retrieve version history"));
        this.listEl.append(this.loadMoreButtonEl);
        return;
      }
    }

    const nextGroups = this.groups.slice(this.renderedGroupCount, this.renderedGroupCount + ITEMS_PER_PAGE);
    const startIndex = this.renderedGroupCount;
    nextGroups.forEach((group, i) => this.renderGroup(group, startIndex + i));
    this.renderedGroupCount += nextGroups.length;

    this.listEl.append(this.loadMoreButtonEl);
  }

  private avatarColorClass(name: string): string {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    return `grpc-avatar-color-${(hash % AVATAR_COLOR_COUNT) + 1}`;
  }

  private createHistoryItemAvatar(containerEl: HTMLElement, item: HistoryVersion) {
    const isCurrentUser = !item.user_name;
    const label = item.user_name || item.device_name || "?";
    const initials = label
      .split(" ")
      .map((part) => part.charAt(0))
      .slice(0, 2)
      .join("");
    const colorClass = isCurrentUser ? "grpc-avatar-current-user" : this.avatarColorClass(label);

    const avatarEl = containerEl.createDiv({
      cls: `grpc-history-avatar ${colorClass}`,
      text: initials,
    });

    let tooltip = item.user_name || "";
    if (item.device_name) tooltip += (tooltip.length > 0 ? "\n" : "") + item.device_name;
    if (!item.related_path && !item.deleted && item.size_bytes !== 0) {
      tooltip += (tooltip.length > 0 ? ", " : "") + humanFileSize(item.size_bytes);
    }
    if (tooltip) setTooltip(avatarEl, tooltip, { placement: "bottom" });
  }

  // Determines one of three cases: the file was moved (same filename, different folder), renamed
  // (different filename), or neither applies cleanly.
  private describeRename(relatedPath: string, currentPath: string): { moved: boolean; from: string; to: string } {
    const relDir = dirnameOf(relatedPath);
    const relBase = basenameOf(relatedPath);
    const curDir = dirnameOf(currentPath);
    const curBase = basenameOf(currentPath);

    if (relBase === curBase) {
      return { moved: true, from: relDir || "/", to: curDir || "/" };
    }
    if (relDir === curDir) {
      return { moved: false, from: relBase, to: curBase };
    }
    return { moved: false, from: relatedPath, to: currentPath };
  }

  private formatTimestamp(ts: number): string {
    return ts + 86400000 < Date.now() ? moment(ts).format("llll") : moment(ts).fromNow();
  }

  // Description shown on a group's card — judged from the group's anchor (most recent item). A
  // group with multiple revisions is labeled "N revisions", same as core (key:
  // plugins.sync.label-revision, value confirmed from obsidian.asar/i18n/{mapping,ko}.txt — passing
  // {{revisions}} works grammatically fine for both singular and plural, so it's always included as
  // a param).
  private describeGroup(group: HistoryVersion[]): string {
    const anchor = group[0];
    if (anchor.related_path) {
      const { moved, from } = this.describeRename(anchor.related_path, this.file.path);
      return moved
        ? t("plugins.sync.label-file-moved-from", "Moved from “{{from}}”", { from })
        : t("plugins.sync.label-file-renamed-from", "Renamed from \"{{from}}\".", { from });
    }
    if (anchor.deleted) {
      return anchor.user_name
        ? t("plugins.sync.label-file-deleted", "This file was deleted")
        : t("plugins.sync.label-file-deleted-via", "Deleted from {{device}}", { device: anchor.device_name });
    }
    if (anchor.size_bytes === 0) return t("plugins.sync.label-empty-file", "Empty");

    const revisionLabel = t("plugins.sync.label-revision", "{{revisions}} revision(s)", {
      count: group.length,
      revisions: group.length,
    });
    if (anchor.user_name) return revisionLabel;
    return revisionLabel + " " + t("plugins.sync.label-via-device", "via {{device}}", { device: anchor.device_name });
  }

  // One card per group. The group's anchor (most recent item) is shown as the card body, and if a
  // group has 2+ items, clicking the "N revisions" label expands a collapsible sub-list showing just
  // the remaining revisions' timestamps — the same grouping/expand behavior as core Sync's version
  // history UI.
  private renderGroup(group: HistoryVersion[], groupIndex: number): void {
    const anchor = group[0];
    const cardEl = this.listEl.createDiv("grpc-history-card");
    this.createHistoryItemAvatar(cardEl, anchor);

    const detailsEl = cardEl.createDiv("grpc-history-item-details");
    detailsEl.createDiv({ text: this.formatTimestamp(anchor.modified_at_ms) });
    const desc = this.describeGroup(group);
    const descEl = desc ? detailsEl.createDiv({ cls: "u-small u-muted", text: desc }) : null;

    this.groupSubItemEls[groupIndex] = [];
    this.groupSubListEls[groupIndex] = null;
    this.groupToggleEls[groupIndex] = null;

    if (group.length > 1 && descEl) {
      descEl.addClass("grpc-history-group-toggle");
      setIcon(descEl.createSpan("grpc-history-group-toggle-icon"), "chevron-right");

      // subListEl is attached as a sibling of listEl rather than a child of cardEl — cardEl
      // (.grpc-history-card) is a horizontal flex row for the avatar/body/mobile chevron, so
      // anything placed inside it wouldn't stack vertically.
      const subListEl = this.listEl.createDiv("grpc-history-group-sublist");
      subListEl.hide();
      group.forEach((item, itemIndex) => {
        if (itemIndex === 0) return;
        const subEl = subListEl.createDiv({
          cls: "grpc-history-group-item",
          text: moment(item.modified_at_ms).format("LT"),
        });
        subEl.addEventListener("click", (evt) => {
          evt.stopPropagation();
          this.selectPosition(groupIndex, itemIndex);
          if (!this.isDesktop) this.mobileLayoutEl.addClass("is-preview");
        });
        this.groupSubItemEls[groupIndex][itemIndex] = subEl;
      });

      descEl.addEventListener("click", (evt) => {
        evt.stopPropagation();
        const expanded = descEl.hasClass("is-expanded");
        descEl.toggleClass("is-expanded", !expanded);
        subListEl.toggle(!expanded);
      });

      this.groupSubListEls[groupIndex] = subListEl;
      this.groupToggleEls[groupIndex] = descEl;
    }

    if (this.isDesktop) {
      this.groupCardEls[groupIndex] = cardEl;
      cardEl.addEventListener("click", () => this.selectPosition(groupIndex, 0));
    } else {
      setIcon(cardEl.createSpan("grpc-history-card-chevron"), "chevron-right");
      cardEl.addEventListener("click", () => {
        this.selectPosition(groupIndex, 0);
        this.mobileLayoutEl.addClass("is-preview");
      });
    }
  }

  private slideToList(): void {
    this.mobileLayoutEl.removeClass("is-preview");
    this.titleEl.empty();
    this.titleEl.setText(this.file.path);
  }

  // delta is always called as a single step of -1 (previous/newer) or +1 (next/older) — from arrow
  // keys or swipes. When it needs to cross a group boundary, it moves to the last/first item of the
  // adjacent group.
  private navigateBy(delta: number): void {
    let g = this.currentGroupIndex;
    let i = this.currentItemIndex + delta;

    if (i < 0) {
      g -= 1;
      if (g < 0) return;
      i = this.groups[g].length - 1;
    } else if (i >= this.groups[g].length) {
      g += 1;
      if (g >= this.groups.length) return;
      i = 0;
    }
    this.selectPosition(g, i);
  }

  // If a group's card is still collapsed, the sub-item inside it isn't visible on screen — force it open.
  private expandGroup(groupIndex: number): void {
    const subListEl = this.groupSubListEls[groupIndex];
    const toggleEl = this.groupToggleEls[groupIndex];
    if (!subListEl || !toggleEl) return;
    toggleEl.addClass("is-expanded");
    subListEl.show();
  }

  private selectPosition(groupIndex: number, itemIndex: number): void {
    this.currentGroupIndex = groupIndex;
    this.currentItemIndex = itemIndex;
    const item = this.groups[groupIndex][itemIndex];

    if (this.isDesktop) {
      this.activeCardEl?.removeClass("is-active");
      this.activeSubItemEl?.removeClass("is-active");
      this.activeCardEl = null;
      this.activeSubItemEl = null;

      if (itemIndex === 0) {
        const cardEl = this.groupCardEls[groupIndex] ?? null;
        cardEl?.addClass("is-active");
        this.activeCardEl = cardEl;
      } else {
        const subEl = this.groupSubItemEls[groupIndex]?.[itemIndex] ?? null;
        subEl?.addClass("is-active");
        this.activeSubItemEl = subEl;
        this.expandGroup(groupIndex);
      }
      this.timestampEl.setText(this.formatTimestamp(item.modified_at_ms));
    } else {
      if (itemIndex !== 0) this.expandGroup(groupIndex);
      this.renderMobileHeader();
    }
    void this.renderContentPane();
  }

  // Split into a controls row (back/prev-next/diff toggle) and a separate filename row — cramming
  // everything onto one line caused the filename to get truncated too aggressively (e.g. "Te...") on
  // narrow mobile screens and become unreadable.
  private renderMobileHeader(): void {
    this.titleEl.empty();
    const headerEl = this.titleEl.createDiv("grpc-preview-header");

    const controlsEl = headerEl.createDiv("grpc-preview-controls-row");

    const backBtn = controlsEl.createSpan("grpc-preview-nav-btn");
    setIcon(backBtn, "arrow-left");
    backBtn.addEventListener("click", () => this.slideToList());

    const totalCount = this.groups.reduce((n, g) => n + g.length, 0);
    const flatPosition = this.groups.slice(0, this.currentGroupIndex).reduce((n, g) => n + g.length, 0) + this.currentItemIndex;

    const navGroupEl = controlsEl.createDiv("grpc-preview-nav-group");
    const prevBtn = navGroupEl.createSpan("grpc-preview-nav-btn");
    setIcon(prevBtn, "chevron-left");
    prevBtn.toggleClass("is-disabled", flatPosition <= 0);
    prevBtn.addEventListener("click", () => this.navigateBy(-1));

    navGroupEl.createSpan({ cls: "u-small u-muted", text: `${flatPosition + 1}/${totalCount}` });

    const nextBtn = navGroupEl.createSpan("grpc-preview-nav-btn");
    setIcon(nextBtn, "chevron-right");
    nextBtn.toggleClass("is-disabled", flatPosition >= totalCount - 1);
    nextBtn.addEventListener("click", () => this.navigateBy(1));

    this.buildDiffToggleBtn(controlsEl);

    headerEl.createDiv({
      cls: "grpc-preview-filename",
      text: this.file.extension === "md" ? this.file.basename : this.file.path,
    });
    headerEl.createDiv({
      cls: "grpc-preview-timestamp u-muted",
      text: this.formatTimestamp(this.groups[this.currentGroupIndex][this.currentItemIndex].modified_at_ms),
    });
  }

  private async renderContentPane(): Promise<void> {
    const group = this.groups[this.currentGroupIndex];
    const version = group[this.currentItemIndex];
    this.activeItem = version;
    // The "next (older) version" used for the diff comparison — if one remains within the group,
    // use that; if this is the group's last item, use the next group's anchor (most recent item);
    // if this is the very last item of the very last group, there is none.
    if (this.currentItemIndex < group.length - 1) {
      this.activeOlderItem = group[this.currentItemIndex + 1];
    } else {
      const nextGroup = this.groups[this.currentGroupIndex + 1];
      this.activeOlderItem = nextGroup ? nextGroup[0] : null;
    }
    this.currentToggleHandler = null;

    this.previewEl.empty();
    this.previewEl.removeClass("markdown-rendered");
    this.previewEl.show();
    this.diffEl.empty();
    this.diffEl.hide();

    if (version.related_path) {
      const { moved, from, to } = this.describeRename(version.related_path, this.file.path);
      const text = moved
        ? t("plugins.sync.label-file-moved-from-to", "Moved from “{{from}}” to “{{to}}”", { from, to })
        : t("plugins.sync.label-file-renamed-from-to", "Renamed from “{{from}}” to “{{to}}”", { from, to });
      this.previewEl.createDiv({ cls: "grpc-history-desc", text });
      this.copyButton.setDisabled(true);
      this.restoreButton.setDisabled(true);
      return;
    }
    if (version.deleted) {
      this.previewEl.createDiv({
        cls: "grpc-history-desc",
        text: t("plugins.sync.label-file-deleted", "This file was deleted"),
      });
      this.copyButton.setDisabled(true);
      this.restoreButton.setDisabled(true);
      return;
    }

    this.copyButton.setDisabled(false);
    this.restoreButton.setDisabled(false);

    this.previewBodyEl.addClass("is-loading");
    try {
      await this.renderVersionContent(version);
    } finally {
      this.previewBodyEl.removeClass("is-loading");
    }
  }

  private async getRawContentForVersion(historyId: number): Promise<ArrayBuffer> {
    const cached = this.contentCache.get(historyId);
    if (cached !== undefined) return cached;

    const client = await this.plugin.getSyncClient();
    const arrayBuffer = await client.downloadHistoryVersion(this.file.path, historyId);
    this.contentCache.set(historyId, arrayBuffer);
    return arrayBuffer;
  }

  private async getTextContentForVersion(historyId: number): Promise<string> {
    const buf = await this.getRawContentForVersion(historyId);
    return new TextDecoder("utf-8").decode(buf);
  }

  private async renderVersionContent(version: HistoryVersion) {
    const ext = this.file.extension;
    const isMarkdown = MARKDOWN_EXTENSIONS.includes(ext);
    const isText = isMarkdown || PLAINTEXT_EXTENSIONS.includes(ext);

    try {
      if (isText) {
        const content = await this.getTextContentForVersion(version.history_id);

        let previewRendered = false;
        const renderPreviewOnce = async () => {
          if (previewRendered) return;
          previewRendered = true;
          if (isMarkdown) {
            this.previewEl.addClass("markdown-rendered");
            await MarkdownRenderer.render(this.app, content, this.previewEl, this.file.path, this.plugin);
          } else {
            this.previewEl.createEl("pre").setText(content);
          }
        };

        const renderDiffView = async () => {
          const older = this.activeOlderItem;
          const olderContent = older && !older.deleted ? await this.getTextContentForVersion(older.history_id) : "";
          this.diffEl.empty();
          renderDiff(this.diffEl, olderContent, content);
        };

        const applyToggleState = async () => {
          this.previewEl.toggle(!this.diffOn);
          this.diffEl.toggle(this.diffOn);
          if (this.diffOn) await renderDiffView();
          else await renderPreviewOnce();
        };

        this.currentToggleHandler = applyToggleState;
        await applyToggleState();
      } else if (IMAGE_EXTENSIONS.includes(ext)) {
        const buf = await this.getRawContentForVersion(version.history_id);
        const blob = new Blob([buf], { type: `image/${ext}` });
        const url = URL.createObjectURL(blob);
        const imgEl = this.previewEl.createEl("img", { attr: { src: url } });
        imgEl.addEventListener("load", () => URL.revokeObjectURL(url), { once: true });
      } else {
        this.previewEl.createDiv({
          text: t("plugins.sync.label-preview-unsupported-file-type", "Can't preview {{type}} files.", {
            type: ext,
          }),
        });
      }
    } catch (e: any) {
      this.previewEl.createDiv({ text: `미리보기 실패: ${e?.message ?? String(e)}` });
    }
  }

  private async copyActiveContent() {
    if (!this.activeItem || this.activeItem.deleted || this.activeItem.related_path) return;
    try {
      const content = await this.getTextContentForVersion(this.activeItem.history_id);
      await navigator.clipboard.writeText(content);
      new Notice(t("interface.copied_generic", "Copied to clipboard"));
    } catch (e: any) {
      new Notice(`복사 실패: ${e?.message ?? String(e)}`);
    }
  }

  private async restoreActiveVersion() {
    if (!this.activeItem || this.activeItem.deleted || this.activeItem.related_path) return;
    const version = this.activeItem;

    if (this.groups[0]?.[0] === version) {
      new Notice(t("plugins.sync.msg-already-latest-version", "This version is already the latest."));
      return;
    }

    try {
      const restoredPath = await this.plugin
        .getSyncClient()
        .then((client) => client.restoreHistoryVersion(version.history_id, this.file.path));
      new Notice(
        t("plugins.sync.msg-restored-version", "Successfully restored the version from {{time}}.", {
          time: moment(version.modified_at_ms).fromNow(),
        })
      );
      void restoredPath;
      this.close();
    } catch (e: any) {
      new Notice(`버전 복원 실패: ${e?.message ?? String(e)}`);
    }
  }
}
