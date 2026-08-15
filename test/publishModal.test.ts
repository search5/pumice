import { describe, expect, it } from "vitest";
import {
  classifyExistingFile,
  classifyNewFile,
  isPublishSupportedFile,
  parsePublishFlag,
  resolvePublishFlag,
  scanSingleFile,
} from "../src/publishEligibility";

// parsePublishFlag -- matches real Obsidian Publish's own frontmatter.publish parsing exactly
// (confirmed via obsidian.asar analysis, see 17_옵시디언_퍼블리시_프론트매터_속성.md): a string
// value is lowercased before matching true/false/yes/no, and null/undefined (field not present
// at all) is distinct from every other value (the caller's cue to fall back to folder
// include/exclude settings) -- everything else falls back to plain JS truthiness, same as real
// Obsidian's `return !!n`.
describe("parsePublishFlag", () => {
  it("recognizes boolean true/false directly", () => {
    expect(parsePublishFlag(true)).toBe(true);
    expect(parsePublishFlag(false)).toBe(false);
  });

  it("is case-insensitive for the true/false/yes/no strings", () => {
    expect(parsePublishFlag("true")).toBe(true);
    expect(parsePublishFlag("True")).toBe(true);
    expect(parsePublishFlag("TRUE")).toBe(true);
    expect(parsePublishFlag("yes")).toBe(true);
    expect(parsePublishFlag("Yes")).toBe(true);
    expect(parsePublishFlag("false")).toBe(false);
    expect(parsePublishFlag("False")).toBe(false);
    expect(parsePublishFlag("FALSE")).toBe(false);
    expect(parsePublishFlag("no")).toBe(false);
    expect(parsePublishFlag("No")).toBe(false);
  });

  it("returns null when the field is missing entirely -- distinct from any other value", () => {
    expect(parsePublishFlag(null)).toBeNull();
    expect(parsePublishFlag(undefined)).toBeNull();
  });

  it("falls back to plain truthiness for anything that isn't true/false/yes/no, matching real Obsidian's own fallback", () => {
    expect(parsePublishFlag("banana")).toBe(true);
    expect(parsePublishFlag("")).toBe(false);
    expect(parsePublishFlag(1)).toBe(true);
    expect(parsePublishFlag(0)).toBe(false);
  });
});

// resolvePublishFlag -- real Obsidian's getPublishFlag folder-fallback: explicit frontmatter
// always wins outright; only consulted when frontmatter has no publish field at all (including
// every file type that can't have frontmatter in the first place, e.g. images/canvas/pdf).
// Excluded folder is checked before included folder in the fallback (see 18_publish_게재_자격_
// 실제_옵시디언과_동일화.md).
describe("resolvePublishFlag", () => {
  it("an explicit frontmatter value always wins, regardless of folder membership", () => {
    expect(resolvePublishFlag(true, true, false)).toBe(true); // even under an excluded folder
    expect(resolvePublishFlag(false, false, true)).toBe(false); // even under an included folder
  });

  it("falls back to the excluded folder when there's no explicit value", () => {
    expect(resolvePublishFlag(null, true, false)).toBe(false);
  });

  it("falls back to the included folder when there's no explicit value and not excluded", () => {
    expect(resolvePublishFlag(null, false, true)).toBe(true);
  });

  it("excluded wins over included when a file is somehow under both", () => {
    expect(resolvePublishFlag(null, true, true)).toBe(false);
  });

  it("is undetermined (null) when there's no explicit value and no folder match either", () => {
    expect(resolvePublishFlag(null, false, false)).toBeNull();
  });
});

// isPublishSupportedFile -- real Obsidian's isFileSupported: an extension whitelist, OR one of
// a handful of special site-asset filenames regardless of extension.
describe("isPublishSupportedFile", () => {
  it("accepts every extension in the real whitelist", () => {
    for (const ext of ["md", "canvas", "png", "jpg", "pdf", "mp4", "mp3", "webp"]) {
      expect(isPublishSupportedFile(ext, `file.${ext}`)).toBe(true);
    }
  });

  it("rejects an unsupported extension", () => {
    expect(isPublishSupportedFile("txt", "notes.txt")).toBe(false);
    expect(isPublishSupportedFile("zip", "archive.zip")).toBe(false);
  });

  it("accepts a special site-asset filename even though its extension isn't in the whitelist", () => {
    expect(isPublishSupportedFile("ico", "favicon.ico")).toBe(true);
    expect(isPublishSupportedFile("css", "obsidian.css")).toBe(true);
    expect(isPublishSupportedFile("css", "publish.css")).toBe(true);
    expect(isPublishSupportedFile("js", "publish.js")).toBe(true);
  });

  it("does not treat an arbitrary .css/.js file as a special asset just because the extension matches", () => {
    expect(isPublishSupportedFile("css", "styles.css")).toBe(false);
    expect(isPublishSupportedFile("js", "script.js")).toBe(false);
  });
});

// classifyExistingFile -- decides what happens to a file that's already published on the
// server, given its current effective publish flag and whether its local content differs from
// the server's copy. Matches real Obsidian's scanForChanges exactly: a file is only ever
// dropped from the review list when it's explicitly excluded (publishFlag === false); a
// content-changed file always shows as "changed" (never silently reclassified as removal)
// regardless of whether the flag is true or merely undetermined (null) -- this is the exact
// live bug this rewrite fixes (previously: null + contentChanged produced an auto-checked
// "to-delete").
describe("classifyExistingFile", () => {
  it("re-publishes an explicitly-eligible file whose content changed, pre-checked", () => {
    expect(classifyExistingFile({ publishFlag: true, contentChanged: true }))
      .toEqual({ type: "changed", checked: true });
  });

  it("still shows a changed file as 'changed' (not a removal) when the flag is merely undetermined -- the bug this rewrite fixes", () => {
    expect(classifyExistingFile({ publishFlag: null, contentChanged: true }))
      .toEqual({ type: "changed", checked: false });
  });

  it("shows an unchanged eligible file as unchanged, unchecked", () => {
    expect(classifyExistingFile({ publishFlag: true, contentChanged: false }))
      .toEqual({ type: "unchanged", checked: false });
  });

  it("shows an unchanged file with an undetermined flag as unchanged too -- never omitted from the list", () => {
    expect(classifyExistingFile({ publishFlag: null, contentChanged: false }))
      .toEqual({ type: "unchanged", checked: false });
  });

  it("marks an explicitly-excluded file to-delete, unchecked by default -- matches real Obsidian exactly (the review modal is pumice's own safety net, so this doesn't need an auto-check)", () => {
    expect(classifyExistingFile({ publishFlag: false, contentChanged: true }))
      .toEqual({ type: "to-delete", checked: false });
    expect(classifyExistingFile({ publishFlag: false, contentChanged: false }))
      .toEqual({ type: "to-delete", checked: false });
  });
});

// classifyNewFile (was isNewFileEligible) -- whether a file NOT yet on the server should appear
// as a "new" publish candidate, and whether it starts pre-checked. Restores real Obsidian's
// folder fallback: an undetermined flag (no frontmatter, e.g. any non-.md file, and not
// explicitly excluded) still gets listed, just unchecked -- this is what makes non-text files
// publishable via folder inclusion or manual checking again.
describe("classifyNewFile", () => {
  it("lists and pre-checks an explicitly eligible file", () => {
    expect(classifyNewFile(true)).toEqual({ checked: true });
  });

  it("excludes an explicitly-ineligible file from the list entirely", () => {
    expect(classifyNewFile(false)).toBeNull();
  });

  it("still lists a file with an undetermined flag, just unchecked -- restores folder-fallback eligibility for non-text files", () => {
    expect(classifyNewFile(null)).toEqual({ checked: false });
  });
});

// scanSingleFile -- the "Publish current file" context-menu action. Deliberately avoids a
// server round-trip (see the caller in PublishModal), so it never knows whether the file is
// already published -- publish:false always produces a to-delete attempt, trusting the
// server's own remove endpoint to be a harmless no-op if there was nothing to remove. Now
// accepts a null flag too (previously intercepted upstream by an error) -- matches real
// Obsidian, which never blocks the single-file action on an undetermined flag.
describe("scanSingleFile", () => {
  it("produces a 'new' diff (publish) when the flag is true", () => {
    const diffs = scanSingleFile("notes/example.md", true);
    expect(diffs).toEqual([{ path: "notes/example.md", serverHash: "", type: "new", checked: true }]);
  });

  it("produces a 'new' diff (publish) when the flag is undetermined -- never blocked", () => {
    const diffs = scanSingleFile("notes/example.png", null);
    expect(diffs).toEqual([{ path: "notes/example.png", serverHash: "", type: "new", checked: true }]);
  });

  it("produces a 'to-delete' diff (unpublish) when the flag is false", () => {
    const diffs = scanSingleFile("notes/example.md", false);
    expect(diffs).toEqual([{ path: "notes/example.md", serverHash: "", type: "to-delete", checked: true }]);
  });
});
