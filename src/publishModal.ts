import { AbstractInputSuggest, App, Modal, Notice, Setting, TFile, TFolder, normalizePath, setIcon } from "obsidian";
import SyncPlugin from "./main";
import { SyncClient } from "./syncClient";
import { t } from "./i18n";

// ─── Types ─────────────────────────────────────────────────────────────────

type DiffType = "new" | "changed" | "unchanged" | "to-delete" | "deleted";

interface DiffItem {
  path: string;
  serverHash: string;
  type: DiffType;
  checked: boolean;
}

// ─── Utilities ─────────────────────────────────────────────────────────────

function getPublishFlag(app: App, file: TFile): boolean | null {
  const cache = app.metadataCache.getFileCache(file);
  const publish = cache?.frontmatter?.publish;
  if (publish === true  || publish === "true"  || publish === "yes") return true;
  if (publish === false || publish === "false" || publish === "no")  return false;
  return null;
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

// Runs `fn` over `items` with at most `limit` in flight at once, preserving result order (result[i]
// corresponds to items[i] regardless of completion order). Reading+hashing every file one at a time
// is fine on desktop's native fs, but on mobile each vault read crosses the Capacitor bridge, so
// doing them serially turns an O(files) round-trip cost into a very visible delay — this lets those
// round-trips overlap instead.
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

const HASH_CONCURRENCY = 8;

// ─── Delta computation ──────────────────────────────────────────────────────
// Same rule as core Publish: "excluded folders" take priority over "included folders". If an
// individual file has a publish frontmatter value, that overrides the folder settings (an explicit
// override); otherwise, whether it's under an included folder decides auto-selection.
async function scanForChanges(
  app: App,
  client: SyncClient,
  includeFolders: string[],
  excludeFolders: string[],
  focusFile?: TFile
): Promise<DiffItem[]> {
  const serverFiles = await client.listFiles();
  const serverMap = new Map<string, string>();
  for (const f of serverFiles) serverMap.set(f.path, f.hash);

  const diffs: DiffItem[] = [];
  const processedPaths = new Set<string>();

  const isEligible = (path: string, publishFlag: boolean | null): boolean => {
    if (publishFlag === true) return true;
    if (publishFlag === false) return false;
    return isUnderFolder(path, includeFolders);
  };

  // Files that exist on both sides need their content hashed to tell whether they've changed — the
  // expensive I/O part — so that's collected here first and run concurrently below, separately from
  // the cheap synchronous classification (excluded/deleted) done in this pass.
  interface Candidate {
    path: string;
    serverHash: string;
    localFile: TFile;
    publishFlag: boolean | null;
    eligible: boolean;
    isFocused: boolean;
  }
  const candidates: Candidate[] = [];

  for (const [serverPath, serverHash] of serverMap) {
    processedPaths.add(serverPath);
    if (isUnderFolder(serverPath, excludeFolders)) continue;

    const abstract = app.vault.getAbstractFileByPath(serverPath);
    const localFile = abstract instanceof TFile ? abstract : null;

    if (!localFile) {
      diffs.push({ path: serverPath, serverHash, type: "deleted", checked: true });
      continue;
    }

    const publishFlag = getPublishFlag(app, localFile);
    candidates.push({
      path: serverPath,
      serverHash,
      localFile,
      publishFlag,
      eligible: isEligible(serverPath, publishFlag),
      isFocused: focusFile?.path === serverPath,
    });
  }

  const candidateDiffs = await mapWithConcurrency(candidates, HASH_CONCURRENCY, async (c): Promise<DiffItem | null> => {
    const data = await app.vault.readBinary(c.localFile);
    const localHash = await computeHash(data);

    if (localHash !== c.serverHash) {
      return {
        path: c.path,
        serverHash: c.serverHash,
        type: c.eligible || c.isFocused ? "changed" : "to-delete",
        checked: true,
      };
    }
    if (c.publishFlag === false && !c.isFocused) {
      return { path: c.path, serverHash: c.serverHash, type: "to-delete", checked: true };
    }
    if (c.eligible || c.isFocused) {
      return { path: c.path, serverHash: c.serverHash, type: "unchanged", checked: false };
    }
    return null;
  });
  for (const d of candidateDiffs) if (d) diffs.push(d);

  for (const localFile of app.vault.getFiles()) {
    if (processedPaths.has(localFile.path)) continue;
    if (isUnderFolder(localFile.path, excludeFolders)) continue;
    const isFocused = focusFile?.path === localFile.path;
    const eligible = isEligible(localFile.path, getPublishFlag(app, localFile));
    if (eligible || isFocused) {
      diffs.push({ path: localFile.path, serverHash: "", type: "new", checked: true });
    }
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
  show() { (this.el as any).show(); }
  hide() { (this.el as any).hide(); }
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

    this.checkboxEl = innerEl.createEl("input", { type: "checkbox" }) as HTMLInputElement;
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
    (this.el as any).toggle(match);
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

    this.checkboxEl = selfEl.createEl("input", { type: "checkbox" }) as HTMLInputElement;
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
    (this.el as any).toggle(anyVisible);
    // If a match is inside a collapsed folder it won't be visible, so auto-expand on a match.
    if (query && anyVisible && this.collapsed) this.toggleCollapse();
    return anyVisible;
  }

  private toggleCollapse() {
    this.collapsed = !this.collapsed;
    this.el.toggleClass("is-collapsed", this.collapsed);
    (this.childrenEl as any).toggle(!this.collapsed);
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
      (this.childrenEl as any).hide();
    }

    this.updateChecked();
    if (this.focusedNode) setTimeout(() => this.focusedNode!.scrollIntoView(), 100);
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
    (this.outerEl as any).toggle(anyVisible);
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
    (this.childrenEl as any).toggle(!this.collapsed);
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
      siteLink.setText(modal.app.vault.getName());
      siteLink.setAttribute("target", "_blank");

      // Icon group (excluding "switch site")
      infoEl.createDiv("publish-changes-switch-site", iconsEl => {
        // "Site options" (Change site options) button — temporarily hidden since it isn't built yet.
        // Uncomment once it's finished.
        /*
        iconsEl.createSpan("clickable-icon", el => {
          setIcon(el, "lucide-settings");
          el.setAttribute("aria-label", t("plugins.publish.tooltip-open-site-options", "Site options"));
          el.addEventListener("click", () => modal.openSection(modal.siteOptionsSection));
        });
        */
        iconsEl.createSpan("clickable-icon", el => {
          setIcon(el, "lucide-filter");
          el.setAttribute("aria-label", t("plugins.publish.tooltip-manage-publish-filters", "Publish filters"));
          el.addEventListener("click", () => modal.openSection(modal.siteFiltersSection));
        });
      });

      // Search filter input
      const searchContainer = infoEl.createDiv("search-input-container");
      this.searchInput = searchContainer.createEl("input", {
        type: "text",
        placeholder: t("setting.hotkeys.prompt-filter", "Search files..."),
      }) as HTMLInputElement;
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
    (this.noChangesEl as any).hide();

    this.sectionsContainer = this.el.createDiv("publish-sections-container");

    // Buttons
    const buttonContainer = this.el.createDiv("modal-button-container");
    buttonContainer.createEl("button", { cls: "mod-cta", text: t("plugins.publish.button-publish", "Publish") })
      .addEventListener("click", () => modal.startUpload());
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
      (this.noChangesEl as any).hide();
    } else {
      (this.noChangesEl as any).show();
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
      el.createDiv({ cls: "setting-item-description", text: `현재 사이트: ${modal.siteUrl}` });
    });
    slugSetting.createDiv("setting-item-control", el => {
      this.slugInput = el.createEl("input", {
        type: "text",
        placeholder: t("plugins.publish.option-site-id-placeholder", "my-site"),
      }) as HTMLInputElement;
      this.slugInput.addClass("setting-input");
      const saveBtn = el.createEl("button", { cls: "mod-cta", text: t("dialogue.button-save", "Save") });
      saveBtn.addEventListener("click", () => this.saveSlug());
    });

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
      }) as HTMLInputElement;
      nameInput.addClass("setting-input");
      const pwInput = el.createEl("input", {
        type: "password",
        placeholder: t("plugins.publish.option-password-placeholder", "Password"),
      }) as HTMLInputElement;
      pwInput.addClass("setting-input");
      const addBtn = el.createEl("button", { text: t("plugins.publish.action-add-password", "Add") });
      addBtn.addEventListener("click", async () => {
        if (!nameInput.value || !pwInput.value) return;
        try {
          const client = await modal.plugin.getSyncClient();
          await client.addPassword(nameInput.value, pwInput.value);
          nameInput.value = "";
          pwInput.value = "";
          await this.loadPasswords();
          new Notice(t("plugins.publish.msg-added-new-password", "Password added."));
        } catch (e: any) {
          new Notice(`오류: ${e.message}`);
        }
      });
    });

    // Sharing management — not a finished feature on our side yet, so it's kept hidden from the UI
    // for now (commented out, but the code is kept).
    /*
    new Setting(this.el).setName(t("plugins.publish.label-manage-sharing", "Manage sharing", { name: modal.app.vault.getName() })).setHeading();
    this.shareListEl = this.el.createDiv("setting-item-list");

    const inviteSetting = this.el.createDiv("setting-item");
    inviteSetting.createDiv("setting-item-info", el => {
      el.createDiv({ cls: "setting-item-name", text: t("plugins.publish.option-invite-user", "Share invite") });
    });
    inviteSetting.createDiv("setting-item-control", el => {
      const emailInput = el.createEl("input", {
        type: "email",
        placeholder: t("plugins.publish.placeholder-invite-user", "Email"),
      }) as HTMLInputElement;
      emailInput.addClass("setting-input");
      const inviteBtn = el.createEl("button", { text: t("plugins.publish.option-invite-user", "Invite") });
      inviteBtn.addEventListener("click", async () => {
        if (!emailInput.value) return;
        try {
          const client = await modal.plugin.getSyncClient();
          await client.inviteShare(emailInput.value);
          emailInput.value = "";
          await this.loadShares();
        } catch (e: any) {
          new Notice(`오류: ${e.message}`);
        }
      });
    });
    */
  }

  async load() {
    try {
      const client = await this.modal.plugin.getSyncClient();
      const slugs = await client.getSlugs();
      const vaultName = this.modal.app.vault.getName();
      this.slugInput.value = slugs[vaultName] ?? vaultName;
    } catch { /* ignore */ }
    await this.loadPasswords();
    // await this.loadShares(); // not called while the sharing-management UI stays hidden
  }

  private async saveSlug() {
    try {
      const client = await this.modal.plugin.getSyncClient();
      await client.setSlug(this.slugInput.value.trim());
      new Notice(t("plugins.publish.msg-updated-options", "Slug saved."));
    } catch (e: any) {
      new Notice(`오류: ${e.message}`);
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
        delBtn.addEventListener("click", async () => {
          await client.deletePassword(p.name);
          await this.loadPasswords();
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
            text: s.accepted ? "수락됨" : t("plugins.publish.label-invite-pending", "Pending"),
          });
        });
        const delBtn = row.createEl("button", {
          cls: "mod-warning",
          text: t("plugins.publish.tooltip-remove-user", "Remove"),
        });
        delBtn.addEventListener("click", async () => {
          await client.removeShare(s.uid);
          await this.loadShares();
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
    return (this.plugin.settings[this.settingsKey] as string)
      .split("\n").map(p => p.trim()).filter(Boolean);
  }

  private async saveFolders(folders: string[]) {
    (this.plugin.settings as any)[this.settingsKey] = folders.join("\n");
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
        if (e.key === "Enter") this.addFolder();
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
      delBtn.addEventListener("click", async () => {
        await this.saveFolders(this.getFolders().filter(x => x !== f));
        this.renderList();
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
      const folders = ((this.modal.plugin.settings as any)[key] as string)
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

  async startUpload(diffs: DiffItem[], client: SyncClient, focusFile?: TFile) {
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
    (successEl as any).hide();

    const buttonContainer = this.el.createDiv("modal-button-container");
    const doneBtn = buttonContainer.createEl("button", {
      cls: "mod-cta mod-warning",
      text: t("plugins.publish.button-stop", "Cancel"),
    }) as HTMLButtonElement;
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

    (this.el as any).show();

    for (const diff of checkedDiffs) {
      const info = pathToInfo.get(diff.path);
      if (!info) continue;
      info.flairEl.setText(t("plugins.publish.label-status-uploading", "Uploading..."));
      try {
        if (diff.type === "deleted" || diff.type === "to-delete") {
          await client.unpublishFile(diff.path);
          info.flairEl.setText(t("plugins.publish.label-status-deleted", "Deleted"));
        } else {
          await client.publishFile(diff.path);
          info.flairEl.setText(t("plugins.publish.label-status-published", "Published"));
        }
      } catch (e: any) {
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
    (successEl as any).show();
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
  siteUrl: string;

  constructor(readonly app: App, readonly plugin: SyncPlugin, private focusFile?: TFile) {
    super(app);
    // grpc-publish-modal: reusing the same classes as core Publish (tree-item, setting-item, etc.)
    // meant core's stylesheet applied to our modal too, making it "look just like core" — so all the
    // CSS that gives this its own look is scoped under this class, to avoid leaking into other core
    // UI like the file explorer.
    this.modalEl.addClass("mod-publish", "mod-lg", "mod-scrollable-content", "grpc-publish-modal");
    this.siteUrl = this.buildSiteUrl(plugin.settings.userName || "default_user");
  }

  private buildSiteUrl(username: string): string {
    const { settings } = this.plugin;
    const protocol = settings.useTls ? "https" : "http";
    const host = settings.serverHost === "localhost" ? "127.0.0.1" : settings.serverHost;
    const port = settings.serverPort;
    return `${protocol}://${host}:${port}/publish/${encodeURIComponent(username)}/${this.app.vault.getName()}/`;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(t("plugins.publish.action-publish-changes", "Publish changes"));

    contentEl.createDiv("message-container", el => {
      this.errorMessageEl = el.createDiv("message mod-error");
      (this.errorMessageEl as any).hide();
    });

    this.loaderEl = contentEl.createEl("div", { cls: "loading-spinner" });
    (this.loaderEl as any).show();

    let client: SyncClient | null = null;
    try {
      client = await this.plugin.getSyncClient();
      const realUsername = await client.getAuthenticatedUsername();
      if (realUsername) this.siteUrl = this.buildSiteUrl(realUsername);
    } catch {
      // If looking up the server's username fails (offline, etc.), just keep the local
      // settings-based guess built in the constructor.
    }

    this.reviewChangesSection  = new ReviewChangesSection(this);
    this.siteOptionsSection    = new SiteOptionsSection(this);
    this.siteFiltersSection    = new SiteFiltersSection(this);
    this.uploadProgressSection = new UploadProgressSection(this);

    try {
      if (!client) client = await this.plugin.getSyncClient();
      const includeFolders = this.plugin.settings.publishIncludeFolders
        .split("\n").map(p => p.trim()).filter(Boolean);
      const excludeFolders = this.plugin.settings.publishExcludeFolders
        .split("\n").map(p => p.trim()).filter(Boolean);
      const diffs = await scanForChanges(this.app, client, includeFolders, excludeFolders, this.focusFile);
      this.reviewChangesSection.setDiffs(diffs, this.focusFile);
    } catch (e: any) {
      this.showError(`변경사항 로드 실패: ${e?.message ?? String(e)}`);
    }

    (this.loaderEl as any).hide();
    this.openSection(this.reviewChangesSection);
  }

  openSection(section: ModalSection) {
    this.currentSection?.hide();
    this.currentSection = section;
    section.show();
    if (section instanceof SiteOptionsSection) section.load();
  }

  showError(msg: string) {
    this.errorMessageEl.setText(msg);
    (this.errorMessageEl as any).show();
  }

  async startUpload() {
    const diffs = this.reviewChangesSection.getDiffs();
    if (!diffs.some(d => d.checked)) {
      new Notice(t("plugins.publish.msg-select-at-least-one-file", "No files selected."));
      return;
    }
    const client = await this.plugin.getSyncClient();
    this.openSection(this.uploadProgressSection);
    await this.uploadProgressSection.startUpload(diffs, client, this.focusFile);
  }

  onClose() { this.contentEl.empty(); }
}
