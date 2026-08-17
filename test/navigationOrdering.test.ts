import { describe, expect, it } from "vitest";
import {
  deriveTopLevelNames,
  mergeOrdering,
  moveEntry,
  toggleHidden,
  topLevelName,
  toSiteOptionsPatch,
} from "../src/navigationOrdering";

describe("topLevelName", () => {
  it("returns the file name itself for a top-level file", () => {
    expect(topLevelName("Home.md")).toBe("Home.md");
  });

  it("returns the first path segment for a nested file", () => {
    expect(topLevelName("Notes/Deep/A.md")).toBe("Notes");
  });
});

describe("deriveTopLevelNames", () => {
  it("deduplicates nested files under the same top-level folder", () => {
    const names = deriveTopLevelNames(["Home.md", "Notes/A.md", "Notes/B.md", "publish.js"]);
    expect(names.sort()).toEqual(["Home.md", "Notes", "publish.js"].sort());
  });
});

// mergeOrdering -- must match pumice-server's own _build_navigation_tree ordering fallback
// (web.py): saved ordering wins for entries still present, everything else is appended
// alphabetically, and hidden entries stay in the list (not dropped).
describe("mergeOrdering", () => {
  it("puts saved ordering first, in that order", () => {
    const entries = mergeOrdering(["A", "B", "C"], ["C", "A"], []);
    expect(entries.map(e => e.name)).toEqual(["C", "A", "B"]);
  });

  it("appends anything not in the saved ordering alphabetically", () => {
    const entries = mergeOrdering(["Zeta", "Alpha", "B"], ["B"], []);
    expect(entries.map(e => e.name)).toEqual(["B", "Alpha", "Zeta"]);
  });

  it("falls back to fully alphabetical when there's no saved ordering at all", () => {
    const entries = mergeOrdering(["Zeta", "Alpha"], [], []);
    expect(entries.map(e => e.name)).toEqual(["Alpha", "Zeta"]);
  });

  it("drops saved-ordering entries that no longer exist as top-level names", () => {
    const entries = mergeOrdering(["A"], ["Deleted", "A"], []);
    expect(entries.map(e => e.name)).toEqual(["A"]);
  });

  it("marks hidden entries but keeps them in the list", () => {
    const entries = mergeOrdering(["A", "B"], ["A", "B"], ["B"]);
    expect(entries).toEqual([{ name: "A", hidden: false }, { name: "B", hidden: true }]);
  });
});

describe("moveEntry", () => {
  const entries = [{ name: "A", hidden: false }, { name: "B", hidden: false }, { name: "C", hidden: false }];

  it("swaps an entry with its upward neighbor", () => {
    expect(moveEntry(entries, 1, -1).map(e => e.name)).toEqual(["B", "A", "C"]);
  });

  it("swaps an entry with its downward neighbor", () => {
    expect(moveEntry(entries, 1, 1).map(e => e.name)).toEqual(["A", "C", "B"]);
  });

  it("is a no-op at the top boundary", () => {
    expect(moveEntry(entries, 0, -1)).toBe(entries);
  });

  it("is a no-op at the bottom boundary", () => {
    expect(moveEntry(entries, 2, 1)).toBe(entries);
  });
});

describe("toggleHidden", () => {
  it("flips only the targeted entry's hidden flag", () => {
    const entries = [{ name: "A", hidden: false }, { name: "B", hidden: false }];
    const result = toggleHidden(entries, 1);
    expect(result).toEqual([{ name: "A", hidden: false }, { name: "B", hidden: true }]);
  });
});

describe("toSiteOptionsPatch", () => {
  it("splits entries into an ordering list and a hidden-only list", () => {
    const entries = [{ name: "A", hidden: false }, { name: "B", hidden: true }, { name: "C", hidden: false }];
    expect(toSiteOptionsPatch(entries)).toEqual({
      navigationOrdering: ["A", "B", "C"],
      navigationHiddenItems: ["B"],
    });
  });
});
