import type { ConflictResolution } from "./settings";

// bookmarks.json is machine-managed state (Obsidian's own bookmark list), not user-authored
// content -- there's no "resolve conflict markers by hand" or "pick a side" use case for it the
// way there is for a note. Two devices that each added different bookmarks should always end up
// with both, regardless of the user's global conflictResolution preference.

export function isBookmarksPath(path: string, configDir: string): boolean {
  return path === `${configDir}/bookmarks.json`;
}

/** The conflictResolution mode to actually apply for a given path -- forces "merge" for
 * bookmarks.json no matter what the user configured, passes everything else through unchanged. */
export function resolveEffectiveConflictResolution(
  path: string,
  configDir: string,
  configuredResolution: ConflictResolution
): ConflictResolution {
  return isBookmarksPath(path, configDir) ? "merge" : configuredResolution;
}
