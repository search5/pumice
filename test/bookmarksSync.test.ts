import { describe, expect, it } from "vitest";
import { isBookmarksPath, resolveEffectiveConflictResolution } from "../src/bookmarksSync";

describe("isBookmarksPath", () => {
  it("matches the bookmarks.json path under the vault's config dir", () => {
    expect(isBookmarksPath(".obsidian/bookmarks.json", ".obsidian")).toBe(true);
  });

  it("respects a custom (renamed) config dir", () => {
    expect(isBookmarksPath("config/bookmarks.json", "config")).toBe(true);
    expect(isBookmarksPath(".obsidian/bookmarks.json", "config")).toBe(false);
  });

  it("does not match a same-named file outside the config dir", () => {
    expect(isBookmarksPath("notes/bookmarks.json", ".obsidian")).toBe(false);
  });

  it("does not match a same-named file nested deeper under the config dir", () => {
    expect(isBookmarksPath(".obsidian/plugins/foo/bookmarks.json", ".obsidian")).toBe(false);
  });
});

describe("resolveEffectiveConflictResolution", () => {
  const configDir = ".obsidian";
  const bookmarksPath = ".obsidian/bookmarks.json";
  const notePath = "notes/a.md";

  it.each(["manual", "server-wins", "client-wins", "merge"] as const)(
    "forces merge for bookmarks.json regardless of the configured resolution (%s)",
    (configured) => {
      expect(resolveEffectiveConflictResolution(bookmarksPath, configDir, configured)).toBe("merge");
    }
  );

  it.each(["manual", "server-wins", "client-wins", "merge"] as const)(
    "passes through the configured resolution unchanged for a regular file (%s)",
    (configured) => {
      expect(resolveEffectiveConflictResolution(notePath, configDir, configured)).toBe(configured);
    }
  );
});
