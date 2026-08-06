// Pure helper for hot-reloading community plugins after a sync pulls down updated code --
// no "obsidian" import, kept testable in isolation. See #11_플러그인_핫리로드_구현_계획.md.

/**
 * Extracts the set of plugin ids referenced by a list of synced file paths (from a sync's
 * downloaded/deleted file list), e.g. ".obsidian/plugins/dataview/main.js" -> "dataview".
 * Non-plugin paths, and a bare plugins-root path with no id segment, are ignored. Sorted for a
 * stable, predictable order (e.g. for display in a Notice).
 */
export function derivePluginIdsFromPaths(paths: string[], configDir: string): string[] {
  const prefix = `${configDir}/plugins/`;
  const ids = new Set<string>();
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slashIndex = rest.indexOf("/");
    if (slashIndex <= 0) continue;
    ids.add(rest.slice(0, slashIndex));
  }
  return [...ids].sort();
}
