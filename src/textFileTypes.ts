// Shared text-file classification -- used by syncHistoryModal.ts (deciding whether a version
// preview can render as text/markdown vs falling back to "no preview") and syncClient.ts (deciding
// whether a conflicting file is eligible for the "merge" conflictResolution mode's 3-way text
// merge, since diffing/merging only makes sense for text content).
export const MARKDOWN_EXTENSIONS = ["md"];
export const PLAINTEXT_EXTENSIONS = ["json", "css", "js", "base", "canvas"];

export function isTextFilePath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MARKDOWN_EXTENSIONS.includes(ext) || PLAINTEXT_EXTENSIONS.includes(ext);
}
