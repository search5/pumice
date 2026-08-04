import { describe, expect, it } from "vitest";
import { buildPluginSnapshot, detectRemovedPluginPaths, filterSyncablePluginPaths } from "../src/pluginSync";

const noIgnore = () => false;

describe("filterSyncablePluginPaths", () => {
  it("passes through everything when nothing is ignored and syncPluginData is on", () => {
    const paths = [".obsidian/plugins/foo/main.js", ".obsidian/plugins/foo/data.json"];
    const result = filterSyncablePluginPaths(paths, { isIgnored: noIgnore, syncPluginData: true });
    expect(result).toEqual(paths);
  });

  it("drops data.json files when syncPluginData is off, keeping everything else", () => {
    const paths = [
      ".obsidian/plugins/foo/main.js",
      ".obsidian/plugins/foo/manifest.json",
      ".obsidian/plugins/foo/data.json",
    ];
    const result = filterSyncablePluginPaths(paths, { isIgnored: noIgnore, syncPluginData: false });
    expect(result).toEqual([".obsidian/plugins/foo/main.js", ".obsidian/plugins/foo/manifest.json"]);
  });

  it("does not drop a file that merely ends with data.json as part of a longer name", () => {
    // e.g. some-plugin/legacy-data.json should not be treated as *the* data.json
    const paths = [".obsidian/plugins/foo/legacy-data.json"];
    const result = filterSyncablePluginPaths(paths, { isIgnored: noIgnore, syncPluginData: false });
    // it DOES end with "/data.json"? No -- "legacy-data.json" does not end with "/data.json"
    // (there's no slash right before "data.json"), so it must be kept.
    expect(result).toEqual(paths);
  });

  it("respects isIgnored (e.g. pumice's own plugin folder)", () => {
    const paths = [".obsidian/plugins/pumice/main.js", ".obsidian/plugins/foo/main.js"];
    const isIgnored = (p: string) => p.startsWith(".obsidian/plugins/pumice");
    const result = filterSyncablePluginPaths(paths, { isIgnored, syncPluginData: true });
    expect(result).toEqual([".obsidian/plugins/foo/main.js"]);
  });
});

describe("detectRemovedPluginPaths", () => {
  it("returns nothing when the previous snapshot is empty (first-run bootstrap)", () => {
    const removed = detectRemovedPluginPaths(
      [".obsidian/plugins/foo/main.js"],
      {},
      noIgnore
    );
    expect(removed).toEqual([]);
  });

  it("detects a path present in the previous snapshot but absent from the current raw listing", () => {
    const previous = { ".obsidian/plugins/foo/main.js": 1000, ".obsidian/plugins/bar/main.js": 1000 };
    const removed = detectRemovedPluginPaths(
      [".obsidian/plugins/bar/main.js"], // foo/main.js is gone
      previous,
      noIgnore
    );
    expect(removed).toEqual([".obsidian/plugins/foo/main.js"]);
  });

  it("does not report anything as removed when nothing actually disappeared", () => {
    const previous = { ".obsidian/plugins/foo/main.js": 1000 };
    const removed = detectRemovedPluginPaths(
      [".obsidian/plugins/foo/main.js"],
      previous,
      noIgnore
    );
    expect(removed).toEqual([]);
  });

  it("does NOT report a path as removed just because it's newly ignorePatterns-excluded (false-positive guard)", () => {
    // The plugin is still installed (still present in the raw/unfiltered current listing) -- the
    // user only added it to ignorePatterns. That must never look like a deletion.
    const previous = { ".obsidian/plugins/foo/main.js": 1000 };
    const isIgnoredNow = (p: string) => p.startsWith(".obsidian/plugins/foo");
    const removed = detectRemovedPluginPaths(
      [".obsidian/plugins/foo/main.js"], // still present in the raw disk listing
      previous,
      isIgnoredNow
    );
    expect(removed).toEqual([]);
  });

  it("suppresses a genuinely-removed path if it was already ignored (avoids pointless tombstones)", () => {
    const previous = { ".obsidian/plugins/foo/main.js": 1000 };
    const isIgnored = (p: string) => p.startsWith(".obsidian/plugins/foo");
    const removed = detectRemovedPluginPaths(
      [], // genuinely gone from disk too
      previous,
      isIgnored
    );
    expect(removed).toEqual([]);
  });
});

describe("buildPluginSnapshot", () => {
  it("maps every raw path to the given timestamp", () => {
    const snapshot = buildPluginSnapshot([".obsidian/plugins/foo/main.js", ".obsidian/plugins/bar/main.js"], 12345);
    expect(snapshot).toEqual({
      ".obsidian/plugins/foo/main.js": 12345,
      ".obsidian/plugins/bar/main.js": 12345,
    });
  });

  it("returns an empty object for an empty path list", () => {
    expect(buildPluginSnapshot([], 12345)).toEqual({});
  });
});
