import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TFile } from "obsidian";
import { ContentHashCache } from "../src/contentHashCache";

// ContentHashCache only ever touches path/stat.mtime/stat.size, so a minimal object standing in
// for TFile is enough -- no real Vault/Obsidian environment needed.
function fakeFile(path: string, mtime: number, size: number): TFile {
  return { path, stat: { mtime, size } } as TFile;
}

async function newCache(): Promise<ContentHashCache> {
  const cache = new ContentHashCache();
  await cache.init();
  return cache;
}

describe("ContentHashCache.getMany", () => {
  let cache: ContentHashCache;

  beforeEach(async () => {
    cache = await newCache();
  });

  it("returns an empty map for an empty path list", async () => {
    const result = await cache.getMany([]);
    expect(result.size).toBe(0);
  });

  it("returns an empty map when nothing has been cached yet", async () => {
    const result = await cache.getMany(["notes/a.md", "notes/b.md"]);
    expect(result.size).toBe(0);
  });

  it("returns every entry written via setMany, in one batch", async () => {
    const fileA = fakeFile("notes/a.md", 100, 10);
    const fileB = fakeFile("notes/b.md", 200, 20);
    cache.setMany([
      { file: fileA, hash: "hash-a" },
      { file: fileB, hash: "hash-b" },
    ]);

    const result = await cache.getMany(["notes/a.md", "notes/b.md"]);

    expect(result.get("notes/a.md")).toEqual({ mtime: 100, size: 10, hash: "hash-a" });
    expect(result.get("notes/b.md")).toEqual({ mtime: 200, size: 20, hash: "hash-b" });
  });

  it("omits paths that were never cached, rather than mapping them to null/undefined", async () => {
    const fileA = fakeFile("notes/a.md", 100, 10);
    cache.setMany([{ file: fileA, hash: "hash-a" }]);

    const result = await cache.getMany(["notes/a.md", "notes/missing.md"]);

    expect(result.has("notes/a.md")).toBe(true);
    expect(result.has("notes/missing.md")).toBe(false);
  });

  it("does not throw before init() has been called (uninitialized db)", async () => {
    const uninitCache = new ContentHashCache();
    const result = await uninitCache.getMany(["notes/a.md"]);
    expect(result.size).toBe(0);
  });
});

describe("ContentHashCache.getHash with a prefetched map", () => {
  let cache: ContentHashCache;

  beforeEach(async () => {
    cache = await newCache();
  });

  it("returns the cached hash without calling compute() on a prefetch hit", async () => {
    const file = fakeFile("notes/a.md", 100, 10);
    cache.setMany([{ file, hash: "cached-hash" }]);
    const prefetched = await cache.getMany(["notes/a.md"]);
    const compute = vi.fn(async () => "freshly-computed-hash");

    const hash = await cache.getHash(file, compute, prefetched);

    expect(hash).toBe("cached-hash");
    expect(compute).not.toHaveBeenCalled();
  });

  it("calls compute() and persists the result on a prefetch miss (path absent from the map)", async () => {
    const file = fakeFile("notes/new.md", 100, 10);
    const prefetched = await cache.getMany([]); // deliberately doesn't include notes/new.md
    const compute = vi.fn(async () => "freshly-computed-hash");

    const hash = await cache.getHash(file, compute, prefetched);

    expect(hash).toBe("freshly-computed-hash");
    expect(compute).toHaveBeenCalledOnce();

    // persisted for next time
    const after = await cache.getMany(["notes/new.md"]);
    expect(after.get("notes/new.md")?.hash).toBe("freshly-computed-hash");
  });

  it("calls compute() when the prefetched entry's mtime/size is stale", async () => {
    const staleFile = fakeFile("notes/a.md", 100, 10);
    cache.setMany([{ file: staleFile, hash: "old-hash" }]);
    const prefetched = await cache.getMany(["notes/a.md"]);

    const changedFile = fakeFile("notes/a.md", 999, 10); // mtime changed since caching
    const compute = vi.fn(async () => "new-hash");

    const hash = await cache.getHash(changedFile, compute, prefetched);

    expect(hash).toBe("new-hash");
    expect(compute).toHaveBeenCalledOnce();
  });

  it("still works via individual get() when no prefetched map is passed (back-compat)", async () => {
    const file = fakeFile("notes/a.md", 100, 10);
    cache.setMany([{ file, hash: "cached-hash" }]);
    const compute = vi.fn(async () => "freshly-computed-hash");

    // No third argument -- this is publishModal.ts's call shape.
    const hash = await cache.getHash(file, compute);

    expect(hash).toBe("cached-hash");
    expect(compute).not.toHaveBeenCalled();
  });
});

describe("ContentHashCache.getWireHash with a prefetched map", () => {
  let cache: ContentHashCache;

  beforeEach(async () => {
    cache = await newCache();
  });

  it("returns the cached wire hash without calling compute() on a prefetch hit", async () => {
    const file = fakeFile("notes/a.md", 100, 10);
    // Seed via getWireHash itself once (no prefetch) so keyFingerprint/wire fields are populated.
    await cache.getWireHash(file, "fp-1", async () => ({
      plainHash: "plain-hash",
      wireHash: "wire-hash",
      wireSize: 42,
    }));
    const prefetched = await cache.getMany(["notes/a.md"]);
    const compute = vi.fn(async () => ({ plainHash: "x", wireHash: "y", wireSize: 1 }));

    const result = await cache.getWireHash(file, "fp-1", compute, prefetched);

    expect(result).toEqual({ plainHash: "plain-hash", wireHash: "wire-hash", wireSize: 42 });
    expect(compute).not.toHaveBeenCalled();
  });

  it("calls compute() on a prefetch miss and persists the result", async () => {
    const file = fakeFile("notes/new.md", 100, 10);
    const prefetched = await cache.getMany([]);
    const compute = vi.fn(async () => ({
      plainHash: "plain-hash",
      wireHash: "wire-hash",
      wireSize: 42,
    }));

    const result = await cache.getWireHash(file, "fp-1", compute, prefetched);

    expect(result).toEqual({ plainHash: "plain-hash", wireHash: "wire-hash", wireSize: 42 });
    expect(compute).toHaveBeenCalledOnce();
  });

  it("calls compute() when the prefetched entry's keyFingerprint doesn't match (password changed)", async () => {
    const file = fakeFile("notes/a.md", 100, 10);
    await cache.getWireHash(file, "fp-old", async () => ({
      plainHash: "plain-hash",
      wireHash: "wire-hash-old",
      wireSize: 42,
    }));
    const prefetched = await cache.getMany(["notes/a.md"]);
    const compute = vi.fn(async () => ({
      plainHash: "plain-hash",
      wireHash: "wire-hash-new",
      wireSize: 43,
    }));

    const result = await cache.getWireHash(file, "fp-new", compute, prefetched);

    expect(result.wireHash).toBe("wire-hash-new");
    expect(compute).toHaveBeenCalledOnce();
  });
});
