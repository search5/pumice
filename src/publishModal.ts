import { AbstractInputSuggest, App, DropdownComponent, Modal, Notice, Setting, TextComponent, TFile, TFolder, ToggleComponent, normalizePath, setIcon } from "obsidian";
import SyncPlugin from "./main";
import { SyncClient, type PublishSiteOptions, type RemoteSite } from "./syncClient";
import { ContentHashCache } from "./contentHashCache";
import { mapWithConcurrency } from "./concurrency";
import { t } from "./i18n";
import { errorMessage } from "./errorMessage";
import { deriveTopLevelNames, mergeOrdering, moveEntry, type SidebarEntry, toggleHidden, toSiteOptionsPatch } from "./navigationOrdering";
import { buildRemoteSiteUrl, type SharedSite } from "./siteCollaboration";
import {
  classifyExistingFile, classifyNewFile, DiffType, isPublishSupportedFile, parseAliases,
  parseDescription, parseImagePath, parsePermalink, parsePublishFlag, resolvePublishFlag,
  scanSingleFile,
} from "./publishEligibility";

// ─── Types ─────────────────────────────────────────────────────────────────

interface DiffItem {
  path: string;
  serverHash: string;
  type: DiffType;
  checked: boolean;
}

// ─── Utilities ─────────────────────────────────────────────────────────────

// Exported for main.ts's file-menu "Publish current file" registration and the modal's own
// single-file branch below, so both consult the exact same folder-fallback logic -- a
// divergence between two separately-reimplemented copies is exactly the shape of bug an
// earlier commit (adb3397) had to fix once already.
export function getPublishFlag(app: App, file: TFile, includeFolders: string[], excludeFolders: string[]): boolean | null {
  const cache = app.metadataCache.getFileCache(file);
  const explicit = parsePublishFlag(cache?.frontmatter?.publish);
  return resolvePublishFlag(explicit, isUnderFolder(file.path, excludeFolders), isUnderFolder(file.path, includeFolders));
}

// permalink has no folder fallback (it's a pure frontmatter override, unlike the publish flag),
// so unlike getPublishFlag there's no include/exclude folder logic here.
export function getPublishPermalink(app: App, file: TFile): string | null {
  const cache = app.metadataCache.getFileCache(file);
  return parsePermalink(cache?.frontmatter?.permalink);
}

export function getPublishDescription(app: App, file: TFile): string | null {
  const cache = app.metadataCache.getFileCache(file);
  return parseDescription(cache?.frontmatter?.description);
}

// Deliberately doesn't also read `cover` -- real Obsidian treats it as an identical alias for
// `image`, but this session scoped that alias out of pumice's first pass (see
// 20_description_image_지원.md).
export function getPublishImage(app: App, file: TFile): string | null {
  const cache = app.metadataCache.getFileCache(file);
  return parseImagePath(cache?.frontmatter?.image);
}

// Used server-side to redirect visitors from a note's old/removed URL to wherever it lives now
// -- see 22_aliases_리다이렉트_및_파비콘_자동감지.md. Real Obsidian requires the alias to be the
// full vault-relative path of the old location (a bare filename won't redirect), but that's a
// user-authoring requirement documented in Permalinks.md, not something this parser enforces.
export function getPublishAliases(app: App, file: TFile): string[] | null {
  const cache = app.metadataCache.getFileCache(file);
  return parseAliases(cache?.frontmatter?.aliases);
}

async function computeHash(data: ArrayBuffer): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new Uint8Array(data));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// Whether a file sits under any folder in a given list (or is that folder itself) — reused for both
// include and exclude folders.
function isUnderFolder(path: string, folders: string[]): boolean {
  return folders.some(f => f && (path === f || path.startsWith(f + "/")));
}

const HASH_CONCURRENCY = 8;

// ─── Delta computation ──────────────────────────────────────────────────────
// Matches real Obsidian Publish's own scanForChanges exactly (see
// 18_publish_게재_자격_실제_옵시디언과_동일화.md): a file is only ever dropped from
// consideration by an explicit (or folder-fallback-resolved) publishFlag === false --
// getPublishFlag() itself handles the exclude-then-include folder fallback now, so there's no
// separate hard pre-filter here the way there used to be (that hard filter incorrectly skipped
// an excluded-folder file even when its own frontmatter explicitly said publish: true, which
// real Obsidian never does -- frontmatter always wins).
async function scanForChanges(
  app: App,
  client: SyncClient,
  includeFolders: string[],
  excludeFolders: string[],
  hashCache: ContentHashCache,
  remoteSite?: RemoteSite
): Promise<DiffItem[]> {
  const serverFiles = await client.listFiles(remoteSite);
  const serverMap = new Map<string, string>();
  for (const f of serverFiles) serverMap.set(f.path, f.hash);

  const diffs: DiffItem[] = [];
  const processedPaths = new Set<string>();

  // Files that exist on both sides need their content hashed to tell whether they've changed — the
  // expensive I/O part — so that's collected here first and run concurrently below, separately from
  // the cheap synchronous classification (excluded/deleted) done in this pass.
  interface Candidate {
    path: string;
    serverHash: string;
    localFile: TFile;
    publishFlag: boolean | null;
  }
  const candidates: Candidate[] = [];

  for (const [serverPath, serverHash] of serverMap) {
    processedPaths.add(serverPath);

    const abstract = app.vault.getAbstractFileByPath(serverPath);
    const localFile = abstract instanceof TFile ? abstract : null;

    const publishFlag = localFile ? getPublishFlag(app, localFile, includeFolders, excludeFolders) : false;
    if (!localFile || publishFlag === false) {
      diffs.push({ path: serverPath, serverHash, type: "deleted", checked: false });
      continue;
    }

    candidates.push({ path: serverPath, serverHash, localFile, publishFlag });
  }

  const candidateDiffs = await mapWithConcurrency(candidates, HASH_CONCURRENCY, async (c): Promise<DiffItem> => {
    const localHash = await hashCache.getHash(c.localFile, async () => {
      const data = await app.vault.readBinary(c.localFile);
      return computeHash(data);
    });

    const { type, checked } = classifyExistingFile({
      publishFlag: c.publishFlag,
      contentChanged: localHash !== c.serverHash,
    });
    return { path: c.path, serverHash: c.serverHash, type, checked };
  });
  diffs.push(...candidateDiffs);

  // isFileSupported-equivalent gate only applies to this "not yet on the server" pass -- a file
  // already on the server already passed this check the first time it was uploaded.
  const allLocalFiles = app.vault.getFiles();
  for (const localFile of allLocalFiles) {
    if (processedPaths.has(localFile.path)) continue;
    if (!isPublishSupportedFile(localFile.extension, localFile.name)) continue;
    const c = classifyNewFile(getPublishFlag(app, localFile, includeFolders, excludeFolders));
    if (c) diffs.push({ path: localFile.path, serverHash: "", type: "new", checked: c.checked });
  }

  return diffs;
}

// ─── Section base ────────────────────────────────────────────────────────────

abstract class ModalSection {
  readonly el: HTMLElement;
  constructor(protected modal: PublishModal) {
    this.el = modal.contentEl.createDiv();
    this.el.hide();
  }
  show() { this.el.show(); }
  hide() { this.el.hide(); }
}

// ─── Publish file tree (folder/file nodes) ───────────────────────────────────
// Core Publish shows the diff list as a folder tree rather than a flat list (reverse-engineered from
// obsidian.asar: a tree-node base class plus a file leaf node, with folders always sorted ahead of
// files). A folder's checkbox toggles all descendant files at once, and whenever a file's checked
// state changes, its ancestor folders' checked/indeterminate display updates upward.

type TreeChild = PublishFileNode | PublishFolderNode;

// A (diff, remaining-unpeeled-path) pair used to recursively peel off one folder segment at a time.
// The diff object itself is never cloned — a checked-state change has to point at the exact same
// reference held by ReviewChangesSection.pathToDiffMap so it's reflected at upload time.
interface TreeEntry {
  diff: DiffItem;
  rest: string;
}

function groupByFirstSegment(entries: TreeEntry[]): { files: TreeEntry[]; folders: Map<string, TreeEntry[]> } {
  const files: TreeEntry[] = [];
  const folders = new Map<string, TreeEntry[]>();
  for (const entry of entries) {
    const idx = entry.rest.indexOf("/");
    if (idx === -1) {
      files.push(entry);
      continue;
    }
    const seg = entry.rest.slice(0, idx);
    const arr = folders.get(seg) ?? [];
    arr.push({ diff: entry.diff, rest: entry.rest.slice(idx + 1) });
    folders.set(seg, arr);
  }
  return { files, folders };
}

function renderTreeLevel(
  container: HTMLElement,
  entries: TreeEntry[],
  notifyChange: () => void,
  folderParent: PublishFolderNode | null,
  focusPath: string | undefined,
  result: { focusedNode: PublishFileNode | null }
): TreeChild[] {
  const { files, folders } = groupByFirstSegment(entries);
  const nodes: TreeChild[] = [];

  for (const name of Array.from(folders.keys()).sort((a, b) => a.localeCompare(b))) {
    const folderNode = new PublishFolderNode(container, name, notifyChange, folderParent);
    const children = renderTreeLevel(
      folderNode.childrenEl, folders.get(name)!, notifyChange, folderNode, focusPath, result
    );
    for (const child of children) folderNode.addChild(child);
    folderNode.refreshCheckboxState();
    nodes.push(folderNode);
  }

  for (const entry of files.sort((a, b) => a.diff.path.localeCompare(b.diff.path))) {
    const isFocused = focusPath === entry.diff.path;
    const fileNode = new PublishFileNode(container, entry.diff, notifyChange, folderParent, isFocused);
    if (isFocused) result.focusedNode = fileNode;
    nodes.push(fileNode);
  }

  return nodes;
}

class PublishFileNode {
  readonly el: HTMLElement;
  private checkboxEl: HTMLInputElement;

  constructor(
    parent: HTMLElement,
    readonly diff: DiffItem,
    private notifyChange: () => void,
    private folderParent: PublishFolderNode | null,
    highlight: boolean
  ) {
    const flairLabel: Record<DiffType, string> = {
      new: t("plugins.publish.label-status-to-publish", "Publish"),
      changed: t("plugins.publish.label-status-to-publish", "Publish"),
      unchanged: t("plugins.publish.label-status-published", "Published"),
      "to-delete": t("plugins.publish.label-status-to-delete", "To delete"),
      deleted: t("plugins.publish.label-status-deleted", "Deleted"),
    };

    this.el = parent.createDiv("tree-item");
    this.el.addClass(`mod-${diff.type}`);
    if (highlight) this.el.addClass("is-highlighted");

    const innerEl = this.el.createDiv("tree-item-self");

    this.checkboxEl = innerEl.createEl("input", { type: "checkbox" });
    this.checkboxEl.addClass("file-tree-item-checkbox");
    this.checkboxEl.checked = diff.checked;
    this.checkboxEl.addEventListener("change", () => {
      diff.checked = this.checkboxEl.checked;
      this.folderParent?.refreshCheckboxState();
      this.notifyChange();
    });

    const iconEl = innerEl.createDiv("file-tree-item-icon");
    setIcon(iconEl, "lucide-file");

    const filename = diff.path.split("/").pop() ?? diff.path;
    innerEl.createDiv({ cls: "file-tree-item-title", text: filename });
    innerEl.createDiv("tree-item-flair-outer")
      .createSpan({ cls: "tree-item-flair", text: flairLabel[diff.type] });
  }

  setChecked(v: boolean) {
    this.checkboxEl.checked = v;
    this.diff.checked = v;
  }

  filter(query: string): boolean {
    const q = query.toLowerCase();
    const match = !query || this.diff.checked || this.diff.path.toLowerCase().includes(q);
    this.el.toggle(match);
    return match;
  }

  scrollIntoView() {
    this.el.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

class PublishFolderNode {
  readonly el: HTMLElement;
  readonly childrenEl: HTMLElement;
  private checkboxEl: HTMLInputElement;
  private collapsed = false;
  private children: TreeChild[] = [];

  constructor(
    parent: HTMLElement,
    readonly name: string,
    private notifyChange: () => void,
    private folderParent: PublishFolderNode | null
  ) {
    this.el = parent.createDiv("tree-item publish-folder-item");
    const selfEl = this.el.createDiv("tree-item-self mod-collapsible");

    const collapseIconEl = selfEl.createDiv("tree-item-icon collapse-icon");
    setIcon(collapseIconEl, "right-triangle");

    this.checkboxEl = selfEl.createEl("input", { type: "checkbox" });
    this.checkboxEl.addClass("file-tree-item-checkbox");
    this.checkboxEl.addEventListener("click", (e) => e.stopPropagation());
    this.checkboxEl.addEventListener("change", () => this.setCheckedRecursive(this.checkboxEl.checked));

    const iconEl = selfEl.createDiv("file-tree-item-icon");
    setIcon(iconEl, "lucide-folder-closed");
    selfEl.createDiv({ cls: "file-tree-item-title", text: name });

    selfEl.addEventListener("click", () => this.toggleCollapse());

    this.childrenEl = this.el.createDiv("tree-item-children");
  }

  addChild(child: TreeChild) {
    this.children.push(child);
  }

  private setCheckedRecursive(checked: boolean) {
    for (const child of this.children) {
      if (child instanceof PublishFileNode) child.setChecked(checked);
      else child.setCheckedRecursive(checked);
    }
    this.refreshCheckboxState();
    this.notifyChange();
  }

  private collectDiffs(): DiffItem[] {
    let out: DiffItem[] = [];
    for (const child of this.children) {
      if (child instanceof PublishFileNode) out.push(child.diff);
      else out = out.concat(child.collectDiffs());
    }
    return out;
  }

  refreshCheckboxState() {
    const diffs = this.collectDiffs();
    const checkedCount = diffs.filter((d) => d.checked).length;
    this.checkboxEl.checked = diffs.length > 0 && checkedCount === diffs.length;
    this.checkboxEl.indeterminate = checkedCount > 0 && checkedCount < diffs.length;
    this.folderParent?.refreshCheckboxState();
  }

  filter(query: string): boolean {
    let anyVisible = false;
    for (const child of this.children) {
      if (child.filter(query)) anyVisible = true;
    }
    this.el.toggle(anyVisible);
    // If a match is inside a collapsed folder it won't be visible, so auto-expand on a match.
    if (query && anyVisible && this.collapsed) this.toggleCollapse();
    return anyVisible;
  }

  private toggleCollapse() {
    this.collapsed = !this.collapsed;
    this.el.toggleClass("is-collapsed", this.collapsed);
    this.childrenEl.toggle(!this.collapsed);
  }
}

// ─── FileSection ─────────────────────────────────────────────────────────────

class FileSection {
  readonly outerEl: HTMLElement;
  private childrenEl: HTMLElement;
  private selectedCountEl: HTMLSpanElement;
  private roots: TreeChild[] = [];
  private focusedNode: PublishFileNode | null = null;
  private collapsed: boolean;

  constructor(
    parent: HTMLElement,
    title: string,
    readonly diffs: DiffItem[],
    private onCheckedChange: () => void,
    private focusPath?: string,
    startCollapsed = false
  ) {
    this.collapsed = startCollapsed;
    this.outerEl = parent.createDiv("file-tree publish-section");

    const header = this.outerEl.createDiv("publish-section-header");
    const collapseIcon = header.createDiv(
      "publish-section-header-toggle-collapsed-button collapse-icon"
    );
    setIcon(collapseIcon, "right-triangle");
    header.createDiv({ cls: "publish-section-header-text", text: title });

    const selectedEl = header.createDiv("publish-section-header-selected");
    this.selectedCountEl = selectedEl.createSpan({
      cls: "publish-section-header-selected-count", text: "0",
    });
    selectedEl.createSpan({ text: t("plugins.publish.label-file-selected", " selected") });

    const selectAllEl = header.createDiv({
      cls: "publish-section-header-action button",
      text: t("plugins.publish.button-select-all-files", "Select all"),
    });
    const deselectAllEl = header.createDiv({
      cls: "publish-section-header-action",
      text: t("plugins.publish.button-deselect-all-files", "Deselect all"),
    });
    selectAllEl.addEventListener("click", e => { e.stopPropagation(); this.selectAll(true); });
    deselectAllEl.addEventListener("click", e => { e.stopPropagation(); this.selectAll(false); });
    header.addEventListener("click", () => this.toggleCollapse());

    this.childrenEl = this.outerEl.createDiv("publish-change-list");

    this.rebuildTree();

    if (startCollapsed) {
      this.outerEl.addClass("is-collapsed");
      this.childrenEl.hide();
    }

    this.updateChecked();
    if (this.focusedNode) window.setTimeout(() => this.focusedNode!.scrollIntoView(), 100);
  }

  private rebuildTree() {
    this.childrenEl.empty();
    const entries: TreeEntry[] = this.diffs.map((diff) => ({ diff, rest: diff.path }));
    const result: { focusedNode: PublishFileNode | null } = { focusedNode: null };
    this.roots = renderTreeLevel(this.childrenEl, entries, () => this.updateChecked(), null, this.focusPath, result);
    this.focusedNode = result.focusedNode;
  }

  updateChecked() {
    const count = this.diffs.filter(d => d.checked).length;
    this.selectedCountEl.setText(String(count));
    this.onCheckedChange();
  }

  filter(query: string) {
    let anyVisible = false;
    for (const node of this.roots) {
      if (node.filter(query)) anyVisible = true;
    }
    this.outerEl.toggle(anyVisible);
  }

  // Entry point used when something outside this class (e.g. "include linked files") wants to check
  // a specific set of paths — rebuilds the tree to bring all folder/file checkboxes in sync at once.
  checkPaths(paths: Set<string>): number {
    let count = 0;
    for (const d of this.diffs) {
      if (paths.has(d.path) && !d.checked) {
        d.checked = true;
        count++;
      }
    }
    if (count > 0) {
      this.rebuildTree();
      this.updateChecked();
    }
    return count;
  }

  private selectAll(checked: boolean) {
    for (const d of this.diffs) d.checked = checked;
    this.rebuildTree();
    this.updateChecked();
  }

  private toggleCollapse() {
    this.collapsed = !this.collapsed;
    this.outerEl.toggleClass("is-collapsed", this.collapsed);
    this.childrenEl.toggle(!this.collapsed);
  }
}

// ─── ReviewChangesSection ────────────────────────────────────────────────────

class ReviewChangesSection extends ModalSection {
  private noChangesEl: HTMLElement;
  private sectionsContainer: HTMLElement;
  private searchInput: HTMLInputElement;
  private sections: FileSection[] = [];
  private pathToDiffMap: Map<string, DiffItem> = new Map();
  private sectionNewRef: FileSection | null = null;

  constructor(modal: PublishModal) {
    super(modal);

    // info header — same structure as the original
    this.el.createDiv("publish-changes-info", infoEl => {
      infoEl.createDiv({
        cls: "publish-changes-info-publishing-to",
        text: t("plugins.publish.label-publishing-to", "Publishing to"),
      });
      const siteLink = infoEl.createEl("a", "publish-changes-current-site-name");
      siteLink.href = modal.siteUrl;
      siteLink.setText(modal.remoteSite?.siteName ?? modal.app.vault.getName());
      siteLink.setAttribute("target", "_blank");

      // Icon group (excluding "switch site") -- Site options/Publish filters both target
      // owner-only endpoints (real Obsidian's own Site collaboration permission table has no
      // "Configure site options" for collaborators, see 36_실제_아키텍처_전환_
      // Site_collaboration.md), so hidden entirely in collaborator mode rather than shown and
      // erroring.
      if (!modal.remoteSite) {
        infoEl.createDiv("publish-changes-switch-site", iconsEl => {
          iconsEl.createSpan("clickable-icon", el => {
            setIcon(el, "lucide-settings");
            el.setAttribute("aria-label", t("plugins.publish.tooltip-open-site-options", "Site options"));
            el.addEventListener("click", () => modal.openSection(modal.siteOptionsSection));
          });
          iconsEl.createSpan("clickable-icon", el => {
            setIcon(el, "lucide-filter");
            el.setAttribute("aria-label", t("plugins.publish.tooltip-manage-publish-filters", "Publish filters"));
            el.addEventListener("click", () => modal.openSection(modal.siteFiltersSection));
          });
        });
      }

      // Search filter input
      const searchContainer = infoEl.createDiv("search-input-container");
      this.searchInput = searchContainer.createEl("input", {
        type: "text",
        placeholder: t("setting.hotkeys.prompt-filter", "Search files..."),
      });
      this.searchInput.addClass("search-input");
      this.searchInput.addEventListener("input", () => {
        const q = this.searchInput.value;
        for (const sec of this.sections) sec.filter(q);
      });
    });

    // "Include linked files" button
    const addLinkedBtn = this.el.createEl("button", {
      cls: "publish-changes-add-linked-btn",
      text: t("plugins.publish.button-add-linked", "Include linked files"),
    });
    addLinkedBtn.addEventListener("click", () => this.addLinkedFiles());

    // No changes detected
    this.noChangesEl = this.el.createDiv({
      cls: "publish-no-changes u-muted",
      text: t("plugins.publish.label-no-changes-detected", "No changes detected."),
    });
    this.noChangesEl.hide();

    this.sectionsContainer = this.el.createDiv("publish-sections-container");

    // Buttons
    const buttonContainer = this.el.createDiv("modal-button-container");
    buttonContainer.createEl("button", { cls: "mod-cta", text: t("plugins.publish.button-publish", "Publish") })
      .addEventListener("click", () => void modal.startUpload());
    buttonContainer.createEl("button", { text: t("dialogue.button-cancel", "Cancel") })
      .addEventListener("click", () => modal.close());
  }

  setDiffs(diffs: DiffItem[], focusFile?: TFile) {
    this.sections = [];
    this.sectionNewRef = null;
    this.pathToDiffMap.clear();
    this.sectionsContainer.empty();
    this.searchInput.value = "";

    for (const d of diffs) this.pathToDiffMap.set(d.path, d);

    // Original section order: changed files → already-published files (unchanged/to-delete/deleted) → new files
    const changed   = diffs.filter(d => d.type === "changed");
    const unchanged = diffs.filter(d => d.type === "unchanged" || d.type === "to-delete" || d.type === "deleted");
    const newFiles  = diffs.filter(d => d.type === "new");

    const focusPath = focusFile?.path;
    const hasChanges = diffs.length > 0;
    if (hasChanges) {
      this.noChangesEl.hide();
    } else {
      this.noChangesEl.show();
    }

    if (changed.length > 0) {
      const title = t("plugins.publish.label-changed-files-to-be-published", "Changed files");
      const s = new FileSection(this.sectionsContainer, title, changed, () => {}, focusPath);
      this.sections.push(s);
    }
    if (unchanged.length > 0) {
      const title = t("plugins.publish.label-unchanged-files-already-published", "Already published files");
      const s = new FileSection(this.sectionsContainer, title, unchanged, () => {}, focusPath, true);
      this.sections.push(s);
    }
    if (newFiles.length > 0) {
      const title = t("plugins.publish.label-new-files-to-be-published", "New files");
      const s = new FileSection(this.sectionsContainer, title, newFiles, () => {}, focusPath);
      this.sections.push(s);
      this.sectionNewRef = s;
    }
  }

  getDiffs(): DiffItem[] {
    return Array.from(this.pathToDiffMap.values());
  }

  private addLinkedFiles() {
    const mc = this.modal.app.metadataCache;
    const checkedPaths: string[] = [];
    for (const [path, diff] of this.pathToDiffMap) {
      if (diff.checked && diff.type !== "deleted") checkedPaths.push(path);
    }

    const linkedPaths = new Set<string>();
    for (const path of checkedPaths) {
      const cache = mc.getCache(path);
      for (const link of cache?.links ?? []) {
        const f = mc.getFirstLinkpathDest(link.link, path);
        if (f) linkedPaths.add(f.path);
      }
      for (const embed of cache?.embeds ?? []) {
        const f = mc.getFirstLinkpathDest(embed.link, path);
        if (f) linkedPaths.add(f.path);
      }
    }

    const added = this.sectionNewRef?.checkPaths(linkedPaths) ?? 0;

    // Core doesn't show a separate "none" message even when there are zero linked files — it always
    // just shows this one count message.
    new Notice(
      t("plugins.publish.msg-added-linked-files", "{{count}} linked files were added.", { count: added })
    );
  }
}

// ─── SiteOptionsSection ──────────────────────────────────────────────────────

class SiteOptionsSection extends ModalSection {
  private slugInput!: HTMLInputElement;
  private passwordListEl!: HTMLElement;
  private shareListEl!: HTMLElement;

  // First batch of real Obsidian's "Change site options" dialog (~20 settings total, see
  // 24_사이트_옵션_다이얼로그_실제_옵시디언과_비교.md) -- the rest need real new site features
  // (graph/search/outline/backlinks/sliding window/navigation sidebar/custom domain/
  // collaboration), not just a stored value, so they're deferred (see 25_사이트_옵션_1차_구현.md).
  private siteNameText!: TextComponent;
  private indexFileText!: TextComponent;
  private logoText!: TextComponent;
  private noindexToggle!: ToggleComponent;
  private hideTitleToggle!: ToggleComponent;
  private readableLineLengthToggle!: ToggleComponent;
  private strictLineBreaksToggle!: ToggleComponent;
  private googleAnalyticsText!: TextComponent;
  private showSearchToggle!: ToggleComponent;
  private slidingWindowModeToggle!: ToggleComponent;
  private showNavigationToggle!: ToggleComponent;
  private defaultThemeDropdown!: DropdownComponent;
  private showThemeToggleToggle!: ToggleComponent;
  // Real Obsidian accumulates changed fields locally and only sends them on "Save site
  // settings" (confirmed via obsidian.asar's Gee.show(), which builds a local `l={}` object
  // from each field's onChange and posts it as one apiOptions(l) call) -- matched here rather
  // than auto-saving per field.
  private pendingOptionChanges: Partial<PublishSiteOptions> = {};

  constructor(modal: PublishModal) {
    super(modal);

    // Header
    const header = this.el.createDiv("nav-header");
    const backBtn = header.createDiv("nav-action-button clickable-icon");
    setIcon(backBtn, "lucide-arrow-left");
    backBtn.setAttribute("aria-label", t("plugins.publish.button-go-back", "Back"));
    backBtn.addEventListener("click", () => modal.openSection(modal.reviewChangesSection));
    header.createDiv({ cls: "nav-buttons-sizer" });
    new Setting(this.el).setName(t("plugins.publish.label-site-options", "Site options")).setHeading();

    // Slug setting
    const slugSetting = this.el.createDiv("setting-item");
    slugSetting.createDiv("setting-item-info", el => {
      el.createDiv({ cls: "setting-item-name", text: t("plugins.publish.option-site-id", "Site slug") });
      el.createDiv({ cls: "setting-item-description", text: t("plugins.publish.label-current-site", "Current site: {{url}}", { url: modal.siteUrl }) });
    });
    slugSetting.createDiv("setting-item-control", el => {
      this.slugInput = el.createEl("input", {
        type: "text",
        placeholder: t("plugins.publish.option-site-id-placeholder", "my-site"),
      });
      this.slugInput.addClass("setting-input");
      const saveBtn = el.createEl("button", { cls: "mod-cta", text: t("dialogue.button-save", "Save") });
      saveBtn.addEventListener("click", () => void this.saveSlug());
    });

    // Custom domain (see 26_커스텀_도메인_지원.md) -- separate modal rather than an inline
    // field like the slug above, since it needs a domain string + a redirect toggle + setup
    // guidance (matches real Obsidian's own separate "configureCustomDomainSection" sub-dialog).
    const customDomainSetting = this.el.createDiv("setting-item");
    customDomainSetting.createDiv("setting-item-info", el => {
      el.createDiv({ cls: "setting-item-name", text: t("plugins.publish.option-custom-domain", "Custom domain") });
      el.createDiv({ cls: "setting-item-description", text: t("plugins.publish.option-custom-domain-desc", "Use your own domain for this site.") });
    });
    customDomainSetting.createDiv("setting-item-control", el => {
      const btn = el.createEl("button", { text: t("interface.button-manage", "Configure") });
      btn.addEventListener("click", () => new CustomDomainModal(modal.app, modal.plugin).open());
    });

    // General (matches real Obsidian's "General" group in the Change site options dialog)
    new Setting(this.el).setName(t("plugins.publish.label-site-general", "General")).setHeading();
    new Setting(this.el)
      .setName(t("plugins.publish.option-site-name", "Site name"))
      .setDesc(t("plugins.publish.option-site-name-desc", "Shown in your site's header and browser tab title."))
      .addText(text => {
        this.siteNameText = text;
        text.onChange(v => { this.pendingOptionChanges.siteName = v; });
      });
    new Setting(this.el)
      .setName(t("plugins.publish.option-home-page", "Home page"))
      .setDesc(t("plugins.publish.option-home-page-desc", "The published note shown when visitors first arrive at your site."))
      .addText(text => {
        this.indexFileText = text;
        text.onChange(v => { this.pendingOptionChanges.indexFile = v; });
      });
    new Setting(this.el)
      .setName(t("plugins.publish.option-logo", "Logo"))
      .setDesc(t("plugins.publish.option-logo-desc", "A published image shown next to your site name."))
      .addText(text => {
        this.logoText = text;
        text.onChange(v => { this.pendingOptionChanges.logo = v; });
      });
    new Setting(this.el)
      .setName(t("plugins.publish.option-noindex", "Hide from search engines"))
      .setDesc(t("plugins.publish.option-noindex-desc", "Ask search engines not to index your site."))
      .addToggle(toggle => {
        this.noindexToggle = toggle;
        toggle.onChange(v => { this.pendingOptionChanges.noindex = v; });
      });

    // Appearance (matches real Obsidian's "Appearance" group -- see
    // 33_실제_아키텍처_전환_테마_전환.md)
    new Setting(this.el).setName(t("plugins.publish.label-site-appearance", "Appearance")).setHeading();
    new Setting(this.el)
      .setName(t("plugins.publish.option-default-theme", "Theme"))
      .addDropdown(dropdown => {
        this.defaultThemeDropdown = dropdown;
        dropdown.addOption("light", t("plugins.publish.option-theme-light", "Light"));
        dropdown.addOption("dark", t("plugins.publish.option-theme-dark", "Dark"));
        dropdown.addOption("system", t("plugins.publish.option-theme-system", "Same as system"));
        dropdown.onChange(v => { this.pendingOptionChanges.defaultTheme = v as "light" | "dark" | "system"; });
      });
    new Setting(this.el)
      .setName(t("plugins.publish.option-show-theme-toggle", "Show theme toggle"))
      .setDesc(t("plugins.publish.option-show-theme-toggle-desc", "Let visitors switch between light and dark themselves."))
      .addToggle(toggle => {
        this.showThemeToggleToggle = toggle;
        toggle.onChange(v => { this.pendingOptionChanges.showThemeToggle = v; });
      });

    // Reading experience
    new Setting(this.el).setName(t("plugins.publish.label-site-reading-experience", "Reading experience")).setHeading();
    new Setting(this.el)
      .setName(t("plugins.publish.option-hide-title", "Hide title"))
      .setDesc(t("plugins.publish.option-hide-title-desc", "Hide the note title shown above its content."))
      .addToggle(toggle => {
        this.hideTitleToggle = toggle;
        toggle.onChange(v => { this.pendingOptionChanges.hideTitle = v; });
      });
    new Setting(this.el)
      .setName(t("plugins.publish.option-readable-line-length", "Readable line length"))
      .setDesc(t("plugins.publish.option-readable-line-length-desc", "Constrain content to a comfortable reading width."))
      .addToggle(toggle => {
        this.readableLineLengthToggle = toggle;
        toggle.onChange(v => { this.pendingOptionChanges.readableLineLength = v; });
      });
    new Setting(this.el)
      .setName(t("plugins.publish.option-strict-line-breaks", "Strict line breaks"))
      .setDesc(t("plugins.publish.option-strict-line-breaks-desc", "Turn single line breaks in your notes into line breaks on the published page."))
      .addToggle(toggle => {
        this.strictLineBreaksToggle = toggle;
        toggle.onChange(v => { this.pendingOptionChanges.strictLineBreaks = v; });
      });
    new Setting(this.el)
      .setName(t("plugins.publish.option-sliding-window-mode", "Sliding window mode"))
      .setDesc(t("plugins.publish.option-sliding-window-mode-desc", "Open linked notes as new panes sliding in from the right, instead of navigating away."))
      .addToggle(toggle => {
        this.slidingWindowModeToggle = toggle;
        toggle.onChange(v => { this.pendingOptionChanges.slidingWindowMode = v; });
      });

    // Components (matches real Obsidian's "Components" group)
    new Setting(this.el).setName(t("plugins.publish.label-site-components", "Components")).setHeading();
    new Setting(this.el)
      .setName(t("plugins.publish.option-show-navigation", "Show navigation"))
      .setDesc(t("plugins.publish.option-show-navigation-desc", "Show a sidebar listing your published notes and folders."))
      .addToggle(toggle => {
        this.showNavigationToggle = toggle;
        toggle.onChange(v => { this.pendingOptionChanges.showNavigation = v; });
      });
    const customizeSidebarSetting = this.el.createDiv("setting-item");
    customizeSidebarSetting.createDiv("setting-item-info", el => {
      el.createDiv({ cls: "setting-item-name", text: t("plugins.publish.option-customize-navigation", "Customize navigation") });
    });
    customizeSidebarSetting.createDiv("setting-item-control", el => {
      const btn = el.createEl("button", { text: t("plugins.publish.button-customize-sidebar", "Customize sidebar") });
      btn.addEventListener("click", () => new CustomizeSidebarModal(modal.app, modal.plugin).open());
    });
    new Setting(this.el)
      .setName(t("plugins.publish.option-show-search", "Enable search"))
      .setDesc(t("plugins.publish.option-show-search-desc", "Show a search box for visitors to find notes on your site."))
      .addToggle(toggle => {
        this.showSearchToggle = toggle;
        toggle.onChange(v => { this.pendingOptionChanges.showSearch = v; });
      });

    // Misc (matches real Obsidian's "Misc" group -- Password is above, in its own section)
    new Setting(this.el).setName(t("plugins.publish.label-site-misc", "Misc")).setHeading();
    new Setting(this.el)
      .setName(t("plugins.publish.option-google-analytics", "Google Analytics tracking code"))
      .addText(text => {
        this.googleAnalyticsText = text;
        text.onChange(v => { this.pendingOptionChanges.googleAnalytics = v; });
      });
    new Setting(this.el).addButton(btn =>
      btn.setButtonText(t("plugins.publish.button-save-site-settings", "Save site settings")).setCta()
        .onClick(() => void this.saveSiteOptions())
    );

    // Password management
    new Setting(this.el).setName(t("plugins.publish.label-manage-passwords", "Manage passwords")).setHeading();
    this.passwordListEl = this.el.createDiv("setting-item-list");

    const addPwSetting = this.el.createDiv("setting-item");
    addPwSetting.createDiv("setting-item-info", el => {
      el.createDiv({ cls: "setting-item-name", text: t("plugins.publish.label-add-password", "Add password") });
    });
    addPwSetting.createDiv("setting-item-control", el => {
      const nameInput = el.createEl("input", {
        type: "text",
        placeholder: t("plugins.publish.option-nickname-name", "Name"),
      });
      nameInput.addClass("setting-input");
      const pwInput = el.createEl("input", {
        type: "password",
        placeholder: t("plugins.publish.option-password-placeholder", "Password"),
      });
      pwInput.addClass("setting-input");
      const addBtn = el.createEl("button", { text: t("plugins.publish.action-add-password", "Add") });
      addBtn.addEventListener("click", () => {
        void (async () => {
          if (!nameInput.value || !pwInput.value) return;
          try {
            const client = await modal.plugin.getSyncClient();
            await client.addPassword(nameInput.value, pwInput.value);
            nameInput.value = "";
            pwInput.value = "";
            await this.loadPasswords();
            new Notice(t("plugins.publish.msg-added-new-password", "Password added."));
          } catch (e: unknown) {
            new Notice(t("plugins.publish.msg-generic-error", "Error: {{error}}", { error: errorMessage(e) }));
          }
        })();
      });
    });

    // Site collaboration (see 36_실제_아키텍처_전환_Site_collaboration.md) -- lets the owner
    // invite other accounts to publish/unpublish on this site (not full vault-sync access, see
    // that doc's confirmed real Obsidian permission table). Was previously commented out here as
    // an unfinished feature; loadShares()/getShares()/removeShare() already worked correctly,
    // only this invite block had real bugs (fixed below: the heading now actually uses its
    // {{vaultName}} interpolation, the label/button no longer share one locale key, and the
    // error handler matches this class's own errorMessage()/msg-generic-error convention instead
    // of a raw untranslated string).
    new Setting(this.el).setName(t("plugins.publish.label-manage-sharing", "Manage sharing for \"{{vaultName}}\"", { vaultName: modal.app.vault.getName() })).setHeading();
    this.shareListEl = this.el.createDiv("setting-item-list");

    const inviteSetting = this.el.createDiv("setting-item");
    inviteSetting.createDiv("setting-item-info", el => {
      el.createDiv({ cls: "setting-item-name", text: t("plugins.publish.label-share-invite", "Share invite") });
    });
    inviteSetting.createDiv("setting-item-control", el => {
      const emailInput = el.createEl("input", {
        type: "email",
        placeholder: t("plugins.publish.placeholder-share-invite-email", "Email"),
      });
      emailInput.addClass("setting-input");
      const inviteBtn = el.createEl("button", { text: t("plugins.publish.button-share-invite", "Invite") });
      inviteBtn.addEventListener("click", () => { void (async () => {
        if (!emailInput.value) return;
        try {
          const client = await modal.plugin.getSyncClient();
          await client.inviteShare(emailInput.value);
          emailInput.value = "";
          await this.loadShares();
        } catch (e: unknown) {
          new Notice(t("plugins.publish.msg-generic-error", "Error: {{error}}", { error: errorMessage(e) }));
        }
      })(); });
    });
  }

  async load() {
    try {
      const client = await this.modal.plugin.getSyncClient();
      const slugs = await client.getSlugs();
      const vaultName = this.modal.app.vault.getName();
      this.slugInput.value = slugs[vaultName] ?? vaultName;
    } catch { /* ignore */ }
    await this.loadSiteOptions();
    await this.loadPasswords();
    await this.loadShares();
  }

  private async loadSiteOptions() {
    try {
      const client = await this.modal.plugin.getSyncClient();
      const options = await client.getSiteOptions();
      this.siteNameText.setValue(options.siteName);
      this.indexFileText.setValue(options.indexFile);
      this.logoText.setValue(options.logo);
      this.noindexToggle.setValue(options.noindex);
      this.defaultThemeDropdown.setValue(options.defaultTheme);
      this.showThemeToggleToggle.setValue(options.showThemeToggle);
      this.showSearchToggle.setValue(options.showSearch);
      this.showNavigationToggle.setValue(options.showNavigation);
      this.hideTitleToggle.setValue(options.hideTitle);
      this.readableLineLengthToggle.setValue(options.readableLineLength);
      this.strictLineBreaksToggle.setValue(options.strictLineBreaks);
      this.slidingWindowModeToggle.setValue(options.slidingWindowMode);
      this.googleAnalyticsText.setValue(options.googleAnalytics);
      this.pendingOptionChanges = {};
    } catch { /* ignore */ }
  }

  private async saveSiteOptions() {
    try {
      const client = await this.modal.plugin.getSyncClient();
      await client.setSiteOptions(this.pendingOptionChanges);
      this.pendingOptionChanges = {};
      new Notice(t("plugins.publish.msg-site-settings-saved", "Site settings saved."));
    } catch (e: unknown) {
      new Notice(t("plugins.publish.msg-generic-error", "Error: {{error}}", { error: errorMessage(e) }));
    }
  }

  private async saveSlug() {
    try {
      const client = await this.modal.plugin.getSyncClient();
      await client.setSlug(this.slugInput.value.trim());
      new Notice(t("plugins.publish.msg-updated-options", "Slug saved."));
    } catch (e: unknown) {
      new Notice(t("plugins.publish.msg-generic-error", "Error: {{error}}", { error: errorMessage(e) }));
    }
  }

  private async loadPasswords() {
    this.passwordListEl.empty();
    try {
      const client = await this.modal.plugin.getSyncClient();
      const pass = await client.getPasswords();
      if (!pass?.length) {
        this.passwordListEl.createDiv({
          cls: "u-muted",
          text: t("plugins.publish.label-no-password", "No passwords registered"),
        });
        return;
      }
      for (const p of pass) {
        const row = this.passwordListEl.createDiv("setting-item");
        row.createDiv({ cls: "setting-item-info", text: p.name });
        const delBtn = row.createEl("button", { cls: "mod-warning", text: t("dialogue.button-delete", "Delete") });
        delBtn.addEventListener("click", () => {
          void (async () => {
            await client.deletePassword(p.name);
            await this.loadPasswords();
          })();
        });
      }
    } catch { /* ignore */ }
  }

  private async loadShares() {
    this.shareListEl.empty();
    try {
      const client = await this.modal.plugin.getSyncClient();
      const shares = await client.getShares();
      if (!shares?.length) {
        this.shareListEl.createDiv({
          cls: "u-muted",
          text: t("plugins.publish.label-not-sharing", "Not shared with anyone"),
        });
        return;
      }
      for (const s of shares) {
        const row = this.shareListEl.createDiv("setting-item");
        row.createDiv({ cls: "setting-item-info" }, el => {
          el.createDiv({ cls: "setting-item-name", text: s.email });
          el.createDiv({
            cls: "setting-item-description",
            text: s.accepted ? t("plugins.publish.label-invite-accepted", "Accepted") : t("plugins.publish.label-invite-pending", "Pending"),
          });
        });
        const delBtn = row.createEl("button", {
          cls: "mod-warning",
          text: t("plugins.publish.tooltip-remove-user", "Remove"),
        });
        delBtn.addEventListener("click", () => {
          void (async () => {
            await client.removeShare(s.uid);
            await this.loadShares();
          })();
        });
      }
    } catch { /* ignore */ }
  }
}

// ─── Folder autocomplete (same approach core uses in its "included/excluded folders" management modal) ───

class FolderSuggest extends AbstractInputSuggest<TFolder> {
  constructor(app: App, private inputEl: HTMLInputElement) {
    super(app, inputEl);
  }
  protected getSuggestions(query: string): TFolder[] {
    const q = query.toLowerCase();
    return this.app.vault.getAllFolders(true).filter(f => f.path.toLowerCase().contains(q));
  }
  renderSuggestion(folder: TFolder, el: HTMLElement) {
    el.setText(folder.path === "/" ? "/" : folder.path);
  }
  selectSuggestion(folder: TFolder) {
    this.inputEl.value = folder.path;
    this.inputEl.trigger("input");
    this.close();
  }
}

// ─── Include/exclude folder management modal (core's l9/c9 — "Manage included/excluded folders") ───

class ManageFoldersModal extends Modal {
  private listEl!: HTMLElement;
  private folderInput!: HTMLInputElement;

  constructor(
    app: App,
    private plugin: SyncPlugin,
    private settingsKey: "publishIncludeFolders" | "publishExcludeFolders",
    private titleText: string,
    private addLabel: string,
    private addDesc: string,
    private onCloseCallback?: () => void
  ) {
    super(app);
  }

  private getFolders(): string[] {
    return this.plugin.settings[this.settingsKey]
      .split("\n").map(p => p.trim()).filter(Boolean);
  }

  private async saveFolders(folders: string[]) {
    this.plugin.settings[this.settingsKey] = folders.join("\n");
    await this.plugin.saveSettings();
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(this.titleText);

    new Setting(contentEl).setName(this.addLabel).setDesc(this.addDesc).addText(text => {
      this.folderInput = text.inputEl;
      new FolderSuggest(this.app, this.folderInput);
      text.inputEl.addEventListener("keydown", e => {
        if (e.key === "Enter") void this.addFolder();
      });
    }).addButton(btn => btn.setButtonText(t("interface.button-add", "Add")).onClick(() => this.addFolder()));

    this.listEl = contentEl.createDiv("setting-item-list");
    this.renderList();

    new Setting(contentEl).addButton(btn =>
      btn.setButtonText(t("dialogue.button-done", "Done")).setCta().onClick(() => this.close())
    );
  }

  private renderList() {
    this.listEl.empty();
    const folders = this.getFolders();
    for (const f of folders) {
      const row = this.listEl.createDiv("setting-item");
      row.createDiv({ cls: "setting-item-info", text: f });
      const delBtn = row.createEl("button", { cls: "mod-warning", text: t("dialogue.button-delete", "Delete") });
      delBtn.addEventListener("click", () => {
        void (async () => {
          await this.saveFolders(this.getFolders().filter(x => x !== f));
          this.renderList();
        })();
      });
    }
  }

  private async addFolder() {
    const raw = this.folderInput.value.trim();
    if (!raw) return;
    // The suggester fills this in with a real folder's exact path already, but the user can also
    // type a not-yet-created folder freehand — normalizePath() cleans up separators/trailing
    // slashes so it stores and compares consistently either way.
    const val = normalizePath(raw);
    const folders = this.getFolders();
    if (!folders.includes(val)) {
      await this.saveFolders([...folders, val]);
      this.renderList();
    }
    this.folderInput.value = "";
  }

  onClose() {
    this.contentEl.empty();
    this.onCloseCallback?.();
  }
}

// ─── CustomDomainModal ────────────────────────────────────────────────────────
// See 26_커스텀_도메인_지원.md -- real Obsidian doesn't provision TLS certificates itself
// (confirmed via Custom domains.md: CloudFlare or your own reverse proxy handles that), so this
// modal is purely "which hostname does this vault answer to" bookkeeping, not a cert wizard.

class CustomDomainModal extends Modal {
  private urlInput!: HTMLInputElement;
  private redirectToggle!: ToggleComponent;

  constructor(app: App, private plugin: SyncPlugin) {
    super(app);
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(t("plugins.publish.label-custom-domain", "Custom domain"));

    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: t(
        "plugins.publish.msg-custom-domain-help",
        "Point your domain's CNAME at this server and enable Full SSL/TLS at your provider (e.g. CloudFlare) before saving here."
      ),
    });

    new Setting(contentEl)
      .setName(t("plugins.publish.option-custom-domain-url", "Domain"))
      .addText(text => { this.urlInput = text.inputEl; });
    new Setting(contentEl)
      .setName(t("plugins.publish.option-custom-domain-redirect", "Redirect to your custom domain"))
      .addToggle(toggle => { this.redirectToggle = toggle; });

    try {
      const client = await this.plugin.getSyncClient();
      const current = await client.getCustomDomain();
      this.urlInput.value = current.url;
      this.redirectToggle.setValue(current.redirect);
    } catch { /* ignore */ }

    new Setting(contentEl).addButton(btn =>
      btn.setButtonText(t("dialogue.button-save", "Save")).setCta().onClick(() => void this.save())
    );
  }

  private async save() {
    try {
      const client = await this.plugin.getSyncClient();
      await client.setCustomDomain(this.urlInput.value.trim(), this.redirectToggle.getValue());
      new Notice(t("plugins.publish.msg-custom-domain-saved", "Custom domain saved."));
      this.close();
    } catch (e: unknown) {
      new Notice(t("plugins.publish.msg-generic-error", "Error: {{error}}", { error: errorMessage(e) }));
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ─── CustomizeSidebarModal ───────────────────────────────────────────────────
// Real Obsidian's own "Customize navigation → Customize sidebar" sub-dialog (drag-reorder +
// hide top-level items, see 24_사이트_옵션_다이얼로그_실제_옵시디언과_비교.md). Uses up/down
// move buttons instead of real drag-and-drop -- pointer/touch drag handling has real
// cross-platform complexity this session can't visually verify without a browser, and buttons
// give the exact same end result (see 34_실제_아키텍처_전환_Customize_sidebar.md). The ordering/
// hiding logic itself lives in navigationOrdering.ts (unit tested there), matching
// pumice-server's own _build_navigation_tree fallback exactly so what's edited here is what the
// site actually renders.
class CustomizeSidebarModal extends Modal {
  private entries: SidebarEntry[] = [];
  private listEl!: HTMLElement;

  constructor(app: App, private plugin: SyncPlugin) {
    super(app);
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(t("plugins.publish.option-customize-navigation", "Customize navigation"));

    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: t(
        "plugins.publish.msg-customize-sidebar-help",
        "Reorder or hide top-level notes and folders shown in your site's navigation sidebar."
      ),
    });

    this.listEl = contentEl.createDiv("pumice-customize-sidebar-list");

    try {
      const client = await this.plugin.getSyncClient();
      const [files, options] = await Promise.all([client.getPublishedFiles(), client.getSiteOptions()]);
      const topLevelNames = deriveTopLevelNames(files);
      this.entries = mergeOrdering(topLevelNames, options.navigationOrdering, options.navigationHiddenItems);
    } catch { /* ignore */ }

    this.render();

    new Setting(contentEl).addButton(btn =>
      btn.setButtonText(t("dialogue.button-save", "Save")).setCta().onClick(() => void this.save())
    );
  }

  private render() {
    this.listEl.empty();
    this.entries.forEach((entry, index) => {
      const row = this.listEl.createDiv("setting-item");
      row.createDiv("setting-item-info", el => {
        el.createDiv({ cls: "setting-item-name", text: entry.name });
      });
      row.createDiv("setting-item-control", el => {
        const hiddenCheckbox = el.createEl("input", { type: "checkbox" });
        hiddenCheckbox.checked = entry.hidden;
        hiddenCheckbox.setAttribute("aria-label", t("plugins.publish.label-hide-nav-item", "Hide"));
        hiddenCheckbox.addEventListener("change", () => {
          this.entries = toggleHidden(this.entries, index);
        });

        const upBtn = el.createEl("button", { cls: "clickable-icon" });
        setIcon(upBtn, "lucide-arrow-up");
        upBtn.setAttribute("aria-label", t("plugins.publish.label-move-up", "Move up"));
        upBtn.addEventListener("click", () => {
          this.entries = moveEntry(this.entries, index, -1);
          this.render();
        });

        const downBtn = el.createEl("button", { cls: "clickable-icon" });
        setIcon(downBtn, "lucide-arrow-down");
        downBtn.setAttribute("aria-label", t("plugins.publish.label-move-down", "Move down"));
        downBtn.addEventListener("click", () => {
          this.entries = moveEntry(this.entries, index, 1);
          this.render();
        });
      });
    });
  }

  private async save() {
    try {
      const client = await this.plugin.getSyncClient();
      await client.setSiteOptions(toSiteOptionsPatch(this.entries));
      new Notice(t("plugins.publish.msg-customize-sidebar-saved", "Sidebar order saved."));
      this.close();
    } catch (e: unknown) {
      new Notice(t("plugins.publish.msg-generic-error", "Error: {{error}}", { error: errorMessage(e) }));
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ─── SiteFiltersSection ──────────────────────────────────────────────────────
// Core's actual structure (app.js's SiteOptionsSection): not a list of pattern strings, but two
// Setting rows — "included folders" / "excluded folders" — each with a "manage" button that opens a
// separate modal. We matched it the same way, picking real folders instead of text patterns (folder
// autocomplete implemented via AbstractInputSuggest).

class SiteFiltersSection extends ModalSection {
  private settingsContainerEl!: HTMLElement;

  constructor(modal: PublishModal) {
    super(modal);

    const header = this.el.createDiv("nav-header");
    const backBtn = header.createDiv("nav-action-button clickable-icon");
    setIcon(backBtn, "lucide-arrow-left");
    backBtn.setAttribute("aria-label", t("plugins.publish.button-go-back", "Back"));
    backBtn.addEventListener("click", () => modal.openSection(modal.reviewChangesSection));

    this.settingsContainerEl = this.el.createDiv("publish-site-settings-container");
    this.render();
  }

  // Re-renders both Setting rows after the management modal closes, so an added/removed folder is
  // reflected in the current list.
  private render() {
    this.settingsContainerEl.empty();

    new Setting(this.settingsContainerEl)
      .setName(t("plugins.publish.option-included-folders", "Included folders"))
      .setDesc(
        this.buildFolderListDesc(
          t(
            "plugins.publish.option-included-folders-desc",
            "Files under included folders are automatically selected when reviewing publish changes."
          ),
          t("plugins.publish.option-currently-included-folders", " Currently included folders:"),
          "publishIncludeFolders"
        )
      )
      .addButton(btn =>
        btn.setButtonText(t("interface.button-manage", "Manage")).onClick(() => {
          new ManageFoldersModal(
            this.modal.app,
            this.modal.plugin,
            "publishIncludeFolders",
            t("plugins.publish.label-manage-included-folders", "Manage included folders"),
            t("plugins.publish.label-add-included-folder", "Include folder"),
            t(
              "plugins.publish.label-add-included-folder-desc",
              "You can include both existing folders and folders you haven't created yet."
            ),
            () => this.render()
          ).open();
        })
      );

    new Setting(this.settingsContainerEl)
      .setName(t("plugins.publish.option-excluded-folders", "Excluded folders"))
      .setDesc(
        this.buildFolderListDesc(
          t(
            "plugins.publish.option-excluded-folders-desc",
            "Files under excluded folders won't appear in the publish changes list. This setting takes priority over included folders above."
          ),
          t("plugins.sync.option-currently-excluded-folders", " Currently excluded folders:"),
          "publishExcludeFolders"
        )
      )
      .addButton(btn =>
        btn.setButtonText(t("interface.button-manage", "Manage")).onClick(() => {
          new ManageFoldersModal(
            this.modal.app,
            this.modal.plugin,
            "publishExcludeFolders",
            t("plugins.publish.label-manage-excluded-folders", "Manage excluded folders"),
            // The Publish namespace has no dedicated "add excluded folder" key, so we reuse the Sync
            // plugin's key for the same concept.
            t("plugins.sync.label-add-excluded-folder", "Exclude folder"),
            t(
              "plugins.sync.label-add-excluded-folder-desc",
              "You can exclude both existing folders and folders you haven't created yet."
            ),
            () => this.render()
          ).open();
        })
      );
  }

  private buildFolderListDesc(
    descText: string,
    currentlyText: string,
    key: "publishIncludeFolders" | "publishExcludeFolders"
  ): DocumentFragment {
    return createFragment(el => {
      el.appendText(descText);
      const folders = this.modal.plugin.settings[key]
        .split("\n").map((p: string) => p.trim()).filter(Boolean);
      if (folders.length > 0) {
        el.appendText(currentlyText);
        const ul = el.createEl("ul");
        for (const f of folders) ul.createEl("li", { text: f });
      }
    });
  }
}

// ─── UploadProgressSection ───────────────────────────────────────────────────

class UploadProgressSection extends ModalSection {
  constructor(modal: PublishModal) { super(modal); }

  async startUpload(diffs: DiffItem[], client: SyncClient, focusFile?: TFile, remoteSite?: RemoteSite) {
    this.el.empty();

    const changesContainer = this.el.createDiv("list-item-parent upload-progress-container");
    // Core doesn't show a banner like "publishing complete" once the upload finishes — just one line
    // about caching and one line reading "You can visit the site here: {link}" (the actual structure
    // of app.js's UploadProgressSection).
    const successEl = this.el.createDiv();
    successEl.createEl("p", { text: t("plugins.publish.label-clear-cache", "It may take a few minutes for changes to appear on the site. If you don't see the latest changes, try clearing your browser cache.") });
    let siteLinkEl!: HTMLAnchorElement;
    successEl.createEl("p", { text: t("plugins.publish.label-visit-site", "You can visit the site here: ") }, (el) => {
      siteLinkEl = el.createEl("a");
      siteLinkEl.setAttribute("target", "_blank");
    });
    successEl.hide();

    const buttonContainer = this.el.createDiv("modal-button-container");
    const doneBtn = buttonContainer.createEl("button", {
      cls: "mod-cta mod-warning",
      text: t("plugins.publish.button-stop", "Cancel"),
    });
    doneBtn.addEventListener("click", () => this.modal.close());

    const checkedDiffs = diffs.filter(d => d.checked);
    type ItemInfo = { el: HTMLElement; flairEl: HTMLElement };
    const pathToInfo = new Map<string, ItemInfo>();

    for (const diff of checkedDiffs) {
      const filename = diff.path.split("/").pop() ?? diff.path;
      const isDelete = diff.type === "deleted" || diff.type === "to-delete";
      const itemEl = changesContainer.createDiv("publish-upload-item list-item");
      const left = itemEl.createDiv("list-item-part");
      setIcon(left, "lucide-file");
      itemEl.createDiv({ cls: "list-item-part mod-extended publish-upload-item-title", text: filename });
      const right = itemEl.createDiv("list-item-part");
      const flairEl = right.createSpan({
        cls: "flair",
        text: isDelete
          ? t("plugins.publish.label-status-to-delete", "To delete")
          : t("plugins.publish.label-status-to-publish", "Publish"),
      });
      pathToInfo.set(diff.path, { el: itemEl, flairEl });
    }

    this.el.show();

    for (const diff of checkedDiffs) {
      const info = pathToInfo.get(diff.path);
      if (!info) continue;
      info.flairEl.setText(t("plugins.publish.label-status-uploading", "Uploading..."));
      try {
        if (diff.type === "deleted" || diff.type === "to-delete") {
          await client.unpublishFile(diff.path, remoteSite);
          info.flairEl.setText(t("plugins.publish.label-status-deleted", "Deleted"));
        } else {
          const file = this.modal.app.vault.getAbstractFileByPath(diff.path);
          // Re-read permalink/description/image fresh at upload time rather than threading them
          // through the diff scan -- unlike the publish flag, none of them affect what's
          // shown/checked in the review list, so there's no reason to carry them that far.
          const meta = file instanceof TFile ? {
            permalink: getPublishPermalink(this.modal.app, file),
            description: getPublishDescription(this.modal.app, file),
            image: getPublishImage(this.modal.app, file),
            aliases: getPublishAliases(this.modal.app, file),
          } : undefined;
          const hash = await client.publishFile(diff.path, meta, remoteSite);
          // Uploading a file means we just hashed it anyway — seed the shared hash cache with that
          // value so the next Publish scan doesn't re-read and re-hash this same content.
          if (file instanceof TFile) this.modal.plugin.contentHashCache.set(file, hash);
          info.flairEl.setText(t("plugins.publish.label-status-published", "Published"));
        }
      } catch {
        info.flairEl.setText(t("plugins.publish.label-status-failed", "Failed"));
        info.el.addClass("mod-error");
      }
      info.el.scrollIntoView({ behavior: "smooth", block: "center" });
      info.el.addClass("mod-completed");
    }

    doneBtn.setText(t("plugins.publish.button-done", "Done"));
    doneBtn.removeClass("mod-warning");

    // Link .md files using their "pretty path" with the extension stripped — the server
    // (publish_view) falls back to rendering the same-named .md file when it receives a path with no
    // extension (see web.py), so this still opens correctly. Other extensions (images, etc.) are left
    // as-is since the real extension is needed to determine the content type.
    const focusPath = focusFile?.extension === "md" ? focusFile.path.replace(/\.md$/, "") : focusFile?.path;
    const viewUrl = focusPath ? `${this.modal.siteUrl}${focusPath}` : this.modal.siteUrl;
    siteLinkEl.setText(viewUrl);
    siteLinkEl.setAttribute("href", viewUrl);
    successEl.show();
  }
}

// ─── PublishModal ─────────────────────────────────────────────────────────────

export class PublishModal extends Modal {
  private loaderEl!: HTMLElement;
  private errorMessageEl!: HTMLElement;

  reviewChangesSection!: ReviewChangesSection;
  siteOptionsSection!: SiteOptionsSection;
  siteFiltersSection!: SiteFiltersSection;
  private uploadProgressSection!: UploadProgressSection;
  private currentSection: ModalSection | null = null;

  // At construction time we haven't actually asked the server yet, so this starts out as a guess
  // built from the local userName setting (a free-text display label) — onOpen() then asks the
  // server for the real username tied to the token and updates this if it differs. If the two
  // differ, the upload still succeeds (saved under the server-recognized name's directory) but the
  // "view site" link would point at the wrong (empty) directory named after the local setting.
  // Not applicable when remoteSite is set (a Site collaboration target, see
  // 36_실제_아키텍처_전환_Site_collaboration.md) -- there, owner+vaultId are already known exactly,
  // nothing to guess or refresh.
  siteUrl: string;

  constructor(readonly app: App, readonly plugin: SyncPlugin, private focusFile?: TFile, readonly remoteSite?: SharedSite) {
    super(app);
    // grpc-publish-modal: reusing the same classes as core Publish (tree-item, setting-item, etc.)
    // meant core's stylesheet applied to our modal too, making it "look just like core" — so all the
    // CSS that gives this its own look is scoped under this class, to avoid leaking into other core
    // UI like the file explorer.
    this.modalEl.addClass("mod-publish", "mod-lg", "mod-scrollable-content", "grpc-publish-modal");
    this.siteUrl = this.remoteSite
      ? this.computeSiteUrl(this.remoteSite.owner, this.remoteSite.vaultId)
      : this.computeSiteUrl(plugin.settings.userName || "default_user", this.app.vault.getName());
  }

  private computeSiteUrl(owner: string, vaultId: string): string {
    const { settings } = this.plugin;
    const protocol = settings.useTls ? "https" : "http";
    return buildRemoteSiteUrl(protocol, settings.serverHost, settings.serverPort, { owner, vaultId });
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(t("plugins.publish.action-publish-changes", "Publish changes"));

    // Vault sharing (see 14_vault_sharing_설계.md) is still separate from -- and takes priority
    // over -- Site collaboration (remoteSite, 36_실제_아키텍처_전환_Site_collaboration.md): a
    // shared/mirrored vault via full sync doesn't also support collaborator-publishing to a
    // third site in this pass, so this guard fires regardless of remoteSite.
    if (this.plugin.settings.sharedVaultOwner) {
      contentEl.createEl("p", {
        cls: "setting-item-description",
        text: t(
          "plugins.publish.msg-not-available-for-shared-vault",
          "Publish isn't available for a shared vault yet -- only the vault owner ({{owner}}) can manage Publish for it.",
          { owner: this.plugin.settings.sharedVaultOwner }
        ),
      });
      return;
    }

    contentEl.createDiv("message-container", el => {
      this.errorMessageEl = el.createDiv("message mod-error");
      this.errorMessageEl.hide();
    });

    this.loaderEl = contentEl.createDiv({ cls: "loading-spinner" });
    this.loaderEl.show();

    let client: SyncClient | null = null;
    try {
      client = await this.plugin.getSyncClient();
      if (!this.remoteSite) {
        const realUsername = await client.getAuthenticatedUsername();
        if (realUsername) this.siteUrl = this.computeSiteUrl(realUsername, this.app.vault.getName());
      }
    } catch {
      // If looking up the server's username fails (offline, etc.), just keep the local
      // settings-based guess built in the constructor.
    }

    this.reviewChangesSection  = new ReviewChangesSection(this);
    this.siteOptionsSection    = new SiteOptionsSection(this);
    this.siteFiltersSection    = new SiteFiltersSection(this);
    this.uploadProgressSection = new UploadProgressSection(this);

    try {
      // "Publish current file" (this.focusFile set, opened from the file context menu) is a single
      // explicit action on one file — it doesn't need the server's whole file list or a vault-wide
      // walk the way the general "Publish changes" entry point (no focus file) does.
      const includeFolders = this.plugin.settings.publishIncludeFolders.split("\n").map(p => p.trim()).filter(Boolean);
      const excludeFolders = this.plugin.settings.publishExcludeFolders.split("\n").map(p => p.trim()).filter(Boolean);

      if (this.focusFile) {
        // true/false/null all have well-defined behavior now (matches real Obsidian's own
        // single-file action, which never blocks on an undetermined flag either) -- the
        // server's remove endpoint is a harmless no-op if the file was never actually
        // published, so there's no need to fetch the server's file list first just to check.
        const publishFlag = getPublishFlag(this.app, this.focusFile, includeFolders, excludeFolders);
        this.reviewChangesSection.setDiffs(scanSingleFile(this.focusFile.path, publishFlag), this.focusFile);
      } else {
        const diffs = await scanForChanges(
          this.app, client ?? (client = await this.plugin.getSyncClient()),
          includeFolders, excludeFolders,
          this.plugin.contentHashCache, this.remoteSite
        );
        this.reviewChangesSection.setDiffs(diffs, this.focusFile);
      }
    } catch (e: unknown) {
      this.showError(
        t("plugins.publish.msg-load-changes-failed", "Failed to load changes: {{error}}", {
          error: errorMessage(e),
        })
      );
    }

    this.loaderEl.hide();
    this.openSection(this.reviewChangesSection);
  }

  openSection(section: ModalSection) {
    this.currentSection?.hide();
    this.currentSection = section;
    section.show();
    if (section instanceof SiteOptionsSection) void section.load();
  }

  showError(msg: string) {
    this.errorMessageEl.setText(msg);
    this.errorMessageEl.show();
  }

  async startUpload() {
    const diffs = this.reviewChangesSection.getDiffs();
    if (!diffs.some(d => d.checked)) {
      new Notice(t("plugins.publish.msg-select-at-least-one-file", "No files selected."));
      return;
    }
    const client = await this.plugin.getSyncClient();
    this.openSection(this.uploadProgressSection);
    await this.uploadProgressSection.startUpload(diffs, client, this.focusFile, this.remoteSite);
  }

  onClose() { this.contentEl.empty(); }
}
