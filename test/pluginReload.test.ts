import { describe, expect, it } from "vitest";
import { derivePluginIdsFromPaths } from "../src/pluginReload";

describe("derivePluginIdsFromPaths", () => {
  it("extracts the plugin id from a nested file path", () => {
    expect(derivePluginIdsFromPaths([".obsidian/plugins/dataview/main.js"], ".obsidian")).toEqual(["dataview"]);
  });

  it("dedupes multiple files under the same plugin", () => {
    const paths = [
      ".obsidian/plugins/dataview/main.js",
      ".obsidian/plugins/dataview/manifest.json",
      ".obsidian/plugins/dataview/styles.css",
    ];
    expect(derivePluginIdsFromPaths(paths, ".obsidian")).toEqual(["dataview"]);
  });

  it("collects ids from multiple different plugins, sorted", () => {
    const paths = [".obsidian/plugins/zzz-plugin/main.js", ".obsidian/plugins/aaa-plugin/main.js"];
    expect(derivePluginIdsFromPaths(paths, ".obsidian")).toEqual(["aaa-plugin", "zzz-plugin"]);
  });

  it("ignores non-plugin paths", () => {
    const paths = ["notes/todo.md", ".obsidian/bookmarks.json", ".obsidian/community-plugins.json"];
    expect(derivePluginIdsFromPaths(paths, ".obsidian")).toEqual([]);
  });

  it("ignores a bare plugins-root path with no subpath", () => {
    expect(derivePluginIdsFromPaths([".obsidian/plugins/"], ".obsidian")).toEqual([]);
    expect(derivePluginIdsFromPaths([".obsidian/plugins"], ".obsidian")).toEqual([]);
  });

  it("respects a custom configDir", () => {
    expect(derivePluginIdsFromPaths([".config-dir/plugins/foo/main.js"], ".config-dir")).toEqual(["foo"]);
  });

  it("returns an empty list for an empty input", () => {
    expect(derivePluginIdsFromPaths([], ".obsidian")).toEqual([]);
  });
});
