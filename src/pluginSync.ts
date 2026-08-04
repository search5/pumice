// Pure helpers for syncing .obsidian/plugins/** -- deliberately free of any Vault/Adapter/gRPC
// dependency so they're unit-testable without a real Obsidian environment. See
// #7_플러그인_동기화_구현_계획.md for the design this implements.

/**
 * Filters the raw (unfiltered) recursive listing of .obsidian/plugins/** down to what should
 * actually be scanned/synced as content: respects the existing ignorePatterns gate (isIgnored),
 * and separately gates each plugin's data.json behind the syncPluginData toggle since it's the
 * one file in a plugin folder likely to hold secrets (API tokens etc.).
 */
export function filterSyncablePluginPaths(
  rawPaths: string[],
  opts: { isIgnored: (path: string) => boolean; syncPluginData: boolean }
): string[] {
  return rawPaths
    .filter((p) => !opts.isIgnored(p))
    .filter((p) => opts.syncPluginData || !p.endsWith("/data.json"));
}

/**
 * Detects plugin paths that existed in the previous scan snapshot but are missing from the
 * current raw (unfiltered by ignorePatterns) listing -- i.e. genuinely deleted from disk.
 *
 * Deliberately diffs against the RAW current listing, not filterSyncablePluginPaths()'s filtered
 * output: if a still-installed plugin gets newly added to ignorePatterns, it must never look like
 * a deletion just because it dropped out of the filtered set -- only actual disappearance from
 * disk counts. isIgnored() here is only a noise filter (skip synthesizing a tombstone for a path
 * that's currently ignored anyway, since the server likely never had it), not the source of truth
 * for what counts as "removed".
 */
export function detectRemovedPluginPaths(
  currentRawPaths: string[],
  previousSnapshot: Record<string, number>,
  isIgnored: (path: string) => boolean
): string[] {
  const currentSet = new Set(currentRawPaths);
  return Object.keys(previousSnapshot).filter(
    (prevPath) => !currentSet.has(prevPath) && !isIgnored(prevPath)
  );
}

/** Builds the next snapshot to persist as "what we saw on disk this scan" -- always the raw
 * (unfiltered) listing, for the same reason detectRemovedPluginPaths() diffs against raw paths. */
export function buildPluginSnapshot(rawPaths: string[], nowMs: number): Record<string, number> {
  const snapshot: Record<string, number> = {};
  for (const p of rawPaths) snapshot[p] = nowMs;
  return snapshot;
}
