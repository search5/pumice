// Shared text-file classification -- used by syncHistoryModal.ts (deciding whether a version
// preview can render as text/markdown vs falling back to "no preview") and syncClient.ts (deciding
// whether a conflicting file is eligible for the always-on 3-way text merge downloadFileBatch()
// attempts before falling back to conflictResolution -- see
// 16_conflict_resolution_텍스트_상시병합.md -- since diffing/merging only makes sense for text
// content).
export const MARKDOWN_EXTENSIONS = ["md"];
export const PLAINTEXT_EXTENSIONS = ["json", "css", "js", "base", "canvas"];

// Subset syncHistoryModal.ts actually diffs/plain-text-previews -- excludes "canvas", matching
// real Obsidian core Sync's own History modal exactly (confirmed via obsidian.asar analysis: md/
// json/css/js/base get a real line-mode diff-match-patch diff or plain-text preview; .canvas gets
// its own dedicated non-diff renderer instead, which pumice doesn't build -- it falls back to the
// existing "can't preview" message instead of pretending to match that unbuilt renderer). The
// always-on 3-way text merge above is a pumice-only feature with no real Sync equivalent to
// match, so PLAINTEXT_EXTENSIONS/isTextFilePath are deliberately left untouched -- .canvas stays
// mergeable as plain JSON text there. See 15_history_diff_옵시디언_정렬.md.
export const HISTORY_DIFFABLE_PLAINTEXT_EXTENSIONS = PLAINTEXT_EXTENSIONS.filter((ext) => ext !== "canvas");

export function isTextFilePath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MARKDOWN_EXTENSIONS.includes(ext) || PLAINTEXT_EXTENSIONS.includes(ext);
}
