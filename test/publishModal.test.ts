import { describe, expect, it } from "vitest";
import {
  classifyExistingFile,
  classifyNewFile,
  isPublishSupportedFile,
  parseAliases,
  parseDescription,
  parseImagePath,
  parsePermalink,
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

// parsePermalink -- matches real Obsidian Publish's Site.getPublicHref exactly (confirmed via
// obsidian.asar analysis, see 19_permalink_지원.md): only a truthy string overrides the
// default path-based URL. A single leading "/" is stripped; everything else (empty string,
// null/undefined, non-string values) is treated as "not set".
describe("parsePermalink", () => {
  it("strips a single leading slash", () => {
    expect(parsePermalink("/notes/a")).toBe("notes/a");
  });

  it("leaves a value with no leading slash untouched", () => {
    expect(parsePermalink("notes/a")).toBe("notes/a");
  });

  it("strips only one leading slash, not all of them", () => {
    expect(parsePermalink("//x")).toBe("/x");
  });

  it("treats an empty string as 'not set', same as real Obsidian's truthy check", () => {
    expect(parsePermalink("")).toBeNull();
  });

  it("returns null when the field is missing entirely", () => {
    expect(parsePermalink(null)).toBeNull();
    expect(parsePermalink(undefined)).toBeNull();
  });

  it("ignores non-string values entirely, unlike parsePublishFlag's truthy fallback", () => {
    expect(parsePermalink(1)).toBeNull();
    expect(parsePermalink(true)).toBeNull();
    expect(parsePermalink(["a", "b"])).toBeNull();
  });

  it("handles the site-root edge case where the value is just a slash", () => {
    expect(parsePermalink("/")).toBe("");
  });
});

// parseDescription / parseImagePath -- unlike parsePermalink, real Obsidian's Social media link
// previews doc doesn't describe any transformation of these values (no leading-slash stripping,
// no truthy coercion beyond "is it a string") -- confirmed via obsidian.md/help since this logic
// lives in Publish's site-side renderer, not the desktop app.js this session otherwise reverses
// (see 20_description_image_지원.md). Both just pass a non-empty string through unchanged.
describe("parseDescription", () => {
  it("returns a non-empty string unchanged", () => {
    expect(parseDescription("A custom description.")).toBe("A custom description.");
  });

  it("returns null for an empty string, null, or undefined", () => {
    expect(parseDescription("")).toBeNull();
    expect(parseDescription(null)).toBeNull();
    expect(parseDescription(undefined)).toBeNull();
  });

  it("returns null for a non-string value", () => {
    expect(parseDescription(1)).toBeNull();
    expect(parseDescription(true)).toBeNull();
    expect(parseDescription(["a"])).toBeNull();
  });
});

describe("parseImagePath", () => {
  it("returns a non-empty string unchanged, whether it's a vault path or an external URL", () => {
    expect(parseImagePath("Attachments/cover.png")).toBe("Attachments/cover.png");
    expect(parseImagePath("https://example.com/cover.png")).toBe("https://example.com/cover.png");
  });

  it("returns null for an empty string, null, or undefined", () => {
    expect(parseImagePath("")).toBeNull();
    expect(parseImagePath(null)).toBeNull();
    expect(parseImagePath(undefined)).toBeNull();
  });

  it("returns null for a non-string value", () => {
    expect(parseImagePath(1)).toBeNull();
    expect(parseImagePath(false)).toBeNull();
  });
});

// parseAliases -- real Obsidian's Publish redirects old/removed note URLs by registering each
// alias (case-insensitively) into a lookup map, consulted as the last-resort fallback after both
// permalink and literal-path routing miss (confirmed via obsidian.asar: Site.getLinkpathDest's
// `this.aliases[e.toLowerCase()]` fallback -- see 22_aliases_리다이렉트_및_파비콘_자동감지.md).
// A single string is normalized to a one-element array (frontmatter YAML sometimes has a bare
// string for a List-type property); empty/whitespace-only entries are dropped.
describe("parseAliases", () => {
  it("returns a string array unchanged (after trimming each entry)", () => {
    expect(parseAliases(["Guides/Making friends", " Developing friendships "]))
      .toEqual(["Guides/Making friends", "Developing friendships"]);
  });

  it("normalizes a bare string into a one-element array", () => {
    expect(parseAliases("Guides/Making friends")).toEqual(["Guides/Making friends"]);
  });

  it("drops empty/whitespace-only entries", () => {
    expect(parseAliases(["a", "", "  ", "b"])).toEqual(["a", "b"]);
  });

  it("returns null for an empty array, empty string, null, or undefined", () => {
    expect(parseAliases([])).toBeNull();
    expect(parseAliases("")).toBeNull();
    expect(parseAliases(null)).toBeNull();
    expect(parseAliases(undefined)).toBeNull();
  });

  it("returns null for a non-string, non-array value", () => {
    expect(parseAliases(1)).toBeNull();
    expect(parseAliases(true)).toBeNull();
  });

  it("drops non-string entries within an array", () => {
    expect(parseAliases(["a", 1, null, "b"])).toEqual(["a", "b"]);
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
