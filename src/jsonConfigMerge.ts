// Semantic 3-way merge for the .obsidian config JSON files that two devices routinely edit at the
// same time (community-plugins.json, core-plugins.json). Pure -- no Vault/Adapter dependency.
//
// Why not just line-based diff3: these files are pretty-printed one entry per line, so two devices
// each appending a different plugin touch the same line (the previous last entry gains a trailing
// comma) and diff3 reports a conflict, leaving <<<<<<< markers in a file Obsidian then can't parse.
// Merging by meaning (set of ids / per-key values) has no such false conflicts.

const MERGEABLE_CONFIG_FILES = ["community-plugins.json", "core-plugins.json"];

export function isMergeableConfigJson(path: string): boolean {
  const name = path.split("/").pop() ?? "";
  return MERGEABLE_CONFIG_FILES.includes(name);
}

const CONFLICT = Symbol("conflict");
type Json = unknown;

function isPlainObject(v: Json): v is Record<string, Json> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepEqual(a: Json, b: Json): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Arrays of ids (community-plugins.json, legacy core-plugins.json): treated as sets. An entry
// survives unless a side removed it relative to base; new entries from either side are kept.
// Order follows remote first, then local-only additions, so every device converges on one order.
function mergeArray(base: Json[], local: Json[], remote: Json[]): Json[] | typeof CONFLICT {
  const all = [...base, ...local, ...remote];
  if (all.some((v) => typeof v !== "string")) return CONFLICT;
  const has = (arr: Json[], v: Json) => arr.includes(v);
  const keep = (v: Json) => (has(base, v) ? has(local, v) && has(remote, v) : has(local, v) || has(remote, v));
  const result: Json[] = [];
  for (const v of [...remote, ...local]) {
    if (keep(v) && !result.includes(v)) result.push(v);
  }
  return result;
}

function mergeValue(base: Json, local: Json, remote: Json): Json | typeof CONFLICT {
  if (deepEqual(local, remote)) return local;
  if (deepEqual(local, base)) return remote;
  if (deepEqual(remote, base)) return local;
  if (isPlainObject(local) && isPlainObject(remote)) {
    return mergeObject(isPlainObject(base) ? base : {}, local, remote);
  }
  if (Array.isArray(local) && Array.isArray(remote)) {
    return mergeArray(Array.isArray(base) ? base : [], local, remote);
  }
  return CONFLICT; // both sides changed the same scalar differently -- let the caller decide
}

function mergeObject(
  base: Record<string, Json>,
  local: Record<string, Json>,
  remote: Record<string, Json>
): Record<string, Json> | typeof CONFLICT {
  const out: Record<string, Json> = {};
  for (const key of [...Object.keys(remote), ...Object.keys(local)]) {
    if (key in out) continue;
    const merged = mergeValue(base[key], local[key], remote[key]);
    if (merged === CONFLICT) return CONFLICT;
    if (merged !== undefined) out[key] = merged;
  }
  return out;
}

/**
 * 3-way merges three versions of a config JSON file. Returns the merged text (2-space indented,
 * like Obsidian writes it), or null when the merge can't be done cleanly -- unparsable input, a
 * shape that isn't an array/object, or both sides setting the same key to different values -- so
 * the caller can fall back to its regular text merge.
 */
export function mergeConfigJson(baseText: string, localText: string, remoteText: string): string | null {
  try {
    const base: Json = JSON.parse(baseText);
    const local: Json = JSON.parse(localText);
    const remote: Json = JSON.parse(remoteText);
    const merged = mergeValue(base, local, remote);
    if (merged === CONFLICT || merged === undefined) return null;
    return JSON.stringify(merged, null, 2);
  } catch {
    return null;
  }
}
