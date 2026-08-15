// Pure decision logic for the "Publish changes" feature -- deliberately free of any
// Obsidian API (App/Vault/TFile/...) so it's unit-testable without a real Obsidian
// environment, same reasoning as pluginSync.ts. Consumed by publishModal.ts, which supplies
// the Obsidian-specific inputs (frontmatter reads, content hashing, the server file list).

export type DiffType = "new" | "changed" | "unchanged" | "to-delete" | "deleted";

export interface SingleFileDiffItem {
  path: string;
  serverHash: string;
  type: DiffType;
  checked: boolean;
}

export interface ExistingFileClassification {
  publishFlag: boolean | null;
  contentChanged: boolean;
  isFocused: boolean;
}

/**
 * Parses a raw `publish` frontmatter value the same way real Obsidian Publish does (confirmed
 * via obsidian.asar analysis -- see 17_옵시디언_퍼블리시_프론트매터_속성.md): a string is
 * lowercased and matched against true/false/yes/no; anything else (including a non-matching
 * string, or a non-string/non-boolean value like a number) falls back to plain JS truthiness,
 * same as real Obsidian's `return !!n`. null/undefined (the field isn't set at all) is the one
 * case treated specially -- it returns null rather than false, since callers need to tell
 * "explicitly turned off" apart from "not mentioned at all" (the latter falls back to folder
 * include/exclude settings, see isNewFileEligible above).
 */
export function parsePublishFlag(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (lower === "false" || lower === "no") return false;
    if (lower === "true" || lower === "yes") return true;
  }
  return Boolean(value);
}

/**
 * Decides what to do with a file that's already published on the server, given its current
 * `publish` frontmatter and whether its local content differs from the server's copy.
 * Eligibility is driven purely by an explicit `publish: true` -- there's no folder-based
 * fallback here (see isNewFileEligible for the same rule applied to not-yet-published files).
 *
 * Returns null when the file should not appear in the diff list at all (nothing to do: not
 * eligible, not changed, not explicitly turned off, not the focused file).
 */
export function classifyExistingFile({ publishFlag, contentChanged, isFocused }: ExistingFileClassification): DiffType | null {
  const eligible = publishFlag === true;

  if (contentChanged) {
    return eligible || isFocused ? "changed" : "to-delete";
  }
  if (publishFlag === false && !isFocused) {
    // Turning publish off must cancel the server copy even when the note's content itself
    // didn't change -- this is the case a bug report was filed about: flipping true -> false
    // and re-publishing has to actually unpublish, not silently do nothing.
    return "to-delete";
  }
  if (eligible || isFocused) {
    return "unchanged";
  }
  return null;
}

/**
 * Whether a file NOT yet on the server should appear as a "new" publish candidate. Only an
 * explicit `publish: true` counts -- a file with no publish field at all is never treated as
 * eligible just because it happens to sit under a configured "included folder"; that setting
 * no longer grants eligibility on its own.
 */
export function isNewFileEligible(publishFlag: boolean | null): boolean {
  return publishFlag === true;
}

/**
 * "Publish current file" (the file context-menu action) -- a single explicit action on one
 * file. Deliberately skips fetching the server's file list (unlike the general scan) since the
 * user already told us what they want; publish:false always produces a to-delete attempt
 * rather than first checking whether the file is actually on the server, trusting the server's
 * own remove endpoint to be a harmless no-op if there was nothing to remove.
 */
export function scanSingleFile(path: string, publishFlag: boolean): SingleFileDiffItem[] {
  return [{ path, serverHash: "", type: publishFlag ? "changed" : "to-delete", checked: true }];
}
