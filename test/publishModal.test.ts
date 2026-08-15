import { describe, expect, it } from "vitest";
import { classifyExistingFile, isNewFileEligible, parsePublishFlag, scanSingleFile } from "../src/publishEligibility";

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

// classifyExistingFile -- decides what happens to a file that's already published on the
// server, given its current frontmatter and whether its local content differs from the
// server's copy. This is the core decision table for the general "Publish changes" scan.
describe("classifyExistingFile", () => {
  it("re-publishes an explicitly-eligible file whose content changed", () => {
    const type = classifyExistingFile({ publishFlag: true, contentChanged: true, isFocused: false });
    expect(type).toBe("changed");
  });

  it("cancels (to-delete) a file whose content changed but is no longer eligible (publish:false)", () => {
    const type = classifyExistingFile({ publishFlag: false, contentChanged: true, isFocused: false });
    expect(type).toBe("to-delete");
  });

  it("cancels (to-delete) a file whose content changed and has no publish field at all", () => {
    const type = classifyExistingFile({ publishFlag: null, contentChanged: true, isFocused: false });
    expect(type).toBe("to-delete");
  });

  it("cancels (to-delete) an already-published file switched to publish:false, even with unchanged content", () => {
    // This is the "true -> false" case the bug report was originally about: turning publish off
    // must cancel the server copy even if the note's actual content didn't change at all.
    const type = classifyExistingFile({ publishFlag: false, contentChanged: false, isFocused: false });
    expect(type).toBe("to-delete");
  });

  it("shows an unchanged eligible file as unchanged", () => {
    const type = classifyExistingFile({ publishFlag: true, contentChanged: false, isFocused: false });
    expect(type).toBe("unchanged");
  });

  it("excludes an unchanged file with no publish field from the list entirely", () => {
    const type = classifyExistingFile({ publishFlag: null, contentChanged: false, isFocused: false });
    expect(type).toBeNull();
  });

  it("a focused (explicitly targeted) file is always shown as changed even without publish:true", () => {
    const type = classifyExistingFile({ publishFlag: null, contentChanged: true, isFocused: true });
    expect(type).toBe("changed");
  });

  it("a focused file with unchanged content is shown as unchanged rather than excluded", () => {
    const type = classifyExistingFile({ publishFlag: null, contentChanged: false, isFocused: true });
    expect(type).toBe("unchanged");
  });

  it("a focused file explicitly set to publish:false is NOT force-cancelled (focus overrides)", () => {
    const type = classifyExistingFile({ publishFlag: false, contentChanged: false, isFocused: true });
    expect(type).toBe("unchanged");
  });
});

// isNewFileEligible -- whether a file NOT yet on the server should appear as a "new" publish
// candidate. Only an explicit publish:true field counts -- no folder-based fallback (an
// included folder no longer silently grants eligibility to a file with no publish field).
describe("isNewFileEligible", () => {
  it("is eligible when publish is explicitly true", () => {
    expect(isNewFileEligible(true)).toBe(true);
  });

  it("is not eligible when publish is explicitly false", () => {
    expect(isNewFileEligible(false)).toBe(false);
  });

  it("is not eligible when there is no publish field at all", () => {
    expect(isNewFileEligible(null)).toBe(false);
  });
});

// scanSingleFile -- the "Publish current file" context-menu action. Deliberately avoids a
// server round-trip (see the caller in PublishModal), so it never knows whether the file is
// already published -- publish:false always produces a to-delete attempt, trusting the
// server's own remove endpoint to be a harmless no-op if there was nothing to remove.
describe("scanSingleFile", () => {
  it("produces a 'changed' diff (publish) when the flag is true", () => {
    const diffs = scanSingleFile("notes/example.md", true);
    expect(diffs).toEqual([{ path: "notes/example.md", serverHash: "", type: "changed", checked: true }]);
  });

  it("produces a 'to-delete' diff (unpublish) when the flag is false", () => {
    const diffs = scanSingleFile("notes/example.md", false);
    expect(diffs).toEqual([{ path: "notes/example.md", serverHash: "", type: "to-delete", checked: true }]);
  });
});
