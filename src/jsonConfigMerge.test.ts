import { describe, expect, it } from "vitest";
import { isMergeableConfigJson, mergeConfigJson } from "./jsonConfigMerge";

const j = (v: unknown) => JSON.stringify(v, null, 2);

describe("isMergeableConfigJson", () => {
  it("matches only the two plugin list files, at any config dir", () => {
    expect(isMergeableConfigJson(".obsidian/community-plugins.json")).toBe(true);
    expect(isMergeableConfigJson("cfg/core-plugins.json")).toBe(true);
    expect(isMergeableConfigJson(".obsidian/app.json")).toBe(false);
  });
});

describe("mergeConfigJson", () => {
  it("keeps plugins appended on both devices (the diff3 false-conflict case)", () => {
    const merged = mergeConfigJson(j(["a", "b"]), j(["a", "b", "local"]), j(["a", "b", "remote"]));
    expect(JSON.parse(merged as string).sort()).toEqual(["a", "b", "local", "remote"]);
  });

  it("propagates a removal made on one side", () => {
    const merged = mergeConfigJson(j(["a", "b", "c"]), j(["a", "c"]), j(["a", "b", "c", "d"]));
    expect(JSON.parse(merged as string).sort()).toEqual(["a", "c", "d"]);
  });

  it("merges core-plugins toggles per key", () => {
    const base = { files: true, graph: true, canvas: true };
    const merged = mergeConfigJson(j(base), j({ ...base, graph: false }), j({ ...base, canvas: false, sync: true }));
    expect(JSON.parse(merged as string)).toEqual({ files: true, graph: false, canvas: false, sync: true });
  });

  it("returns null when both sides set the same key differently", () => {
    const base = { graph: true };
    expect(mergeConfigJson(j(base), j({ graph: false }), j({ graph: "x" }))).toBeNull();
  });

  it("returns null for unparsable input", () => {
    expect(mergeConfigJson("[]", "<<<<<<<", "[]")).toBeNull();
  });
});
