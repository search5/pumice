// Pure logic for the "Customize sidebar" drag/reorder UI (별도 대형 기능, see
// 34_실제_아키텍처_전환_Customize_sidebar.md) -- deliberately free of any Obsidian API, same
// reasoning as publishEligibility.ts. Mirrors pumice-server's own _build_navigation_tree
// top-level grouping/ordering fallback (web.py) so the list a site owner edits here reflects
// the same entries and default order the site will actually render.

export function topLevelName(path: string): string {
  const slash = path.indexOf("/");
  return slash === -1 ? path : path.slice(0, slash);
}

export function deriveTopLevelNames(paths: string[]): string[] {
  const seen = new Set<string>();
  for (const path of paths) seen.add(topLevelName(path));
  return Array.from(seen);
}

export interface SidebarEntry {
  name: string;
  hidden: boolean;
}

// Same merge semantics as _build_navigation_tree's ordering fallback (web.py): entries already
// in the saved ordering keep that relative order, anything else (a newly published top-level
// file/folder, or no saved ordering at all yet) is appended alphabetically. Unlike the server's
// own rendering-time filter, hidden entries are NOT dropped here -- the editor needs to keep
// showing them (with their hidden checkbox) so the owner can find and un-hide them.
export function mergeOrdering(topLevelNames: string[], savedOrdering: string[], hiddenItems: string[]): SidebarEntry[] {
  const known = new Set(topLevelNames);
  const hiddenSet = new Set(hiddenItems);
  const ordered = savedOrdering.filter(name => known.has(name));
  const orderedSet = new Set(ordered);
  const remaining = topLevelNames.filter(name => !orderedSet.has(name)).sort();
  return [...ordered, ...remaining].map(name => ({ name, hidden: hiddenSet.has(name) }));
}

// Swaps the entry at `index` with its neighbor in `direction` (-1 = up, +1 = down). A no-op
// (returns the same array reference) at either end, so callers can call this unconditionally
// without bounds-checking first.
export function moveEntry(entries: SidebarEntry[], index: number, direction: -1 | 1): SidebarEntry[] {
  const target = index + direction;
  if (target < 0 || target >= entries.length) return entries;
  const next = entries.slice();
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function toggleHidden(entries: SidebarEntry[], index: number): SidebarEntry[] {
  return entries.map((e, i) => (i === index ? { ...e, hidden: !e.hidden } : e));
}

export function toSiteOptionsPatch(entries: SidebarEntry[]): { navigationOrdering: string[]; navigationHiddenItems: string[] } {
  return {
    navigationOrdering: entries.map(e => e.name),
    navigationHiddenItems: entries.filter(e => e.hidden).map(e => e.name),
  };
}
