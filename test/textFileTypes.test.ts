import { describe, expect, it } from "vitest";
import {
  MARKDOWN_EXTENSIONS,
  PLAINTEXT_EXTENSIONS,
  HISTORY_DIFFABLE_PLAINTEXT_EXTENSIONS,
  isTextFilePath,
} from "../src/textFileTypes";

describe("PLAINTEXT_EXTENSIONS / isTextFilePath (merge-eligibility, unaffected by history-diff scope)", () => {
  it("still includes canvas -- the 'merge' conflictResolution mode is a pumice-only feature with no real Sync equivalent to match", () => {
    expect(PLAINTEXT_EXTENSIONS).toContain("canvas");
  });

  it("isTextFilePath treats a .canvas path as text (mergeable)", () => {
    expect(isTextFilePath("Untitled.canvas")).toBe(true);
  });

  it("isTextFilePath treats markdown/plaintext extensions as text, others as not", () => {
    expect(isTextFilePath("note.md")).toBe(true);
    expect(isTextFilePath("data.json")).toBe(true);
    expect(isTextFilePath("photo.png")).toBe(false);
  });
});

// See 15_history_diff_옵시디언_정렬.md -- real Obsidian core Sync's own History modal (confirmed
// via obsidian.asar analysis) only offers a real line-mode diff for md/json/css/js/base; .canvas
// gets its own non-diff renderer instead. HISTORY_DIFFABLE_PLAINTEXT_EXTENSIONS is the subset
// syncHistoryModal.ts uses to decide diff/plain-text-preview eligibility -- deliberately narrower
// than PLAINTEXT_EXTENSIONS above.
describe("HISTORY_DIFFABLE_PLAINTEXT_EXTENSIONS (matches real Obsidian core Sync's History diff scope)", () => {
  it("excludes canvas, unlike PLAINTEXT_EXTENSIONS", () => {
    expect(HISTORY_DIFFABLE_PLAINTEXT_EXTENSIONS).not.toContain("canvas");
  });

  it("still includes json/css/js/base", () => {
    expect(HISTORY_DIFFABLE_PLAINTEXT_EXTENSIONS).toEqual(
      expect.arrayContaining(["json", "css", "js", "base"])
    );
  });

  it("is exactly PLAINTEXT_EXTENSIONS minus canvas -- no other divergence", () => {
    expect(HISTORY_DIFFABLE_PLAINTEXT_EXTENSIONS).toEqual(
      PLAINTEXT_EXTENSIONS.filter((ext) => ext !== "canvas")
    );
  });
});
