import { TFile } from "obsidian";

interface CachedHash {
  mtime: number;
  size: number;
  hash: string;
  // E2EE wire (ciphertext) hash/size -- cached separately from the plaintext hash above, since the
  // ciphertext (and therefore its hash) depends on the encryption key as well as the file content.
  // keyFingerprint pins the cached value to the password it was derived under, so an E2EE password
  // change invalidates every cached wire hash instead of silently reusing stale ciphertext hashes.
  wireHash?: string;
  wireSize?: number;
  keyFingerprint?: string;
}

// Publish's diff scan (and, in principle, anything else that needs a file's content hash) has to
// read a file's full bytes and hash them just to find out whether it changed since last time — for
// a vault of a few dozen files that's free, but for thousands of files it dominates the scan, and on
// mobile each read also crosses the Capacitor bridge. This persists the last computed hash per path,
// keyed on mtime+size: if a file's mtime and size are exactly what they were when we last hashed it,
// its content hasn't changed (any edit bumps mtime), so the read+hash is skipped entirely and the
// cached value is reused. Only files that actually changed since the last scan pay the real cost.
export class ContentHashCache {
  private db: IDBDatabase | null = null;

  async init(): Promise<void> {
    const dbName = "pumice-content-hash-cache";
    this.db = await new Promise((resolve) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("hashes")) db.createObjectStore("hashes");
      };
      req.onerror = () => resolve(null);
      req.onsuccess = () => resolve(req.result);
    });
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  private get(path: string): Promise<CachedHash | null> {
    return new Promise((resolve) => {
      if (!this.db) return resolve(null);
      try {
        const req = this.db.transaction("hashes", "readonly").objectStore("hashes").get(path);
        req.onsuccess = () => resolve((req.result as CachedHash) ?? null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  private put(path: string, value: CachedHash): void {
    if (!this.db) return;
    try {
      this.db.transaction("hashes", "readwrite").objectStore("hashes").put(value, path);
    } catch {
      /* best-effort cache — a failed write just means this file gets re-hashed next time */
    }
  }

  /**
   * Returns file's content hash, reusing the cached value when its mtime+size haven't changed.
   * When `prefetched` is passed (see getMany()), the lookup is a plain Map#get() instead of a
   * fresh IndexedDB transaction -- the caller is expected to have prefetched every path it's
   * about to ask for in one batch. Omitting it preserves the original per-call behavior for
   * callers (e.g. Publish's diff scan) that haven't been updated to prefetch.
   */
  async getHash(
    file: TFile,
    compute: () => Promise<string>,
    prefetched?: Map<string, CachedHash>
  ): Promise<string> {
    const cached = prefetched ? prefetched.get(file.path) : await this.get(file.path);
    if (cached && cached.mtime === file.stat.mtime && cached.size === file.stat.size) {
      return cached.hash;
    }
    const hash = await compute();
    this.put(file.path, { mtime: file.stat.mtime, size: file.stat.size, hash });
    return hash;
  }

  /**
   * E2EE counterpart to getHash(): AES-GCM's IV here is deterministically derived from the
   * plaintext hash (see syncClient.ts's encryptData), so re-encrypting unchanged content always
   * reproduces the same ciphertext -- the wire hash is just as cacheable as the plaintext hash,
   * keyed the same way (mtime+size) plus keyFingerprint to catch password changes. On a cache hit
   * this skips reading and re-encrypting the file entirely, same as getHash() skips reading it.
   */
  async getWireHash(
    file: TFile,
    keyFingerprint: string,
    compute: () => Promise<{ plainHash: string; wireHash: string; wireSize: number }>,
    prefetched?: Map<string, CachedHash>
  ): Promise<{ plainHash: string; wireHash: string; wireSize: number }> {
    const cached = prefetched ? prefetched.get(file.path) : await this.get(file.path);
    if (
      cached &&
      cached.mtime === file.stat.mtime &&
      cached.size === file.stat.size &&
      cached.keyFingerprint === keyFingerprint &&
      cached.wireHash !== undefined &&
      cached.wireSize !== undefined
    ) {
      return { plainHash: cached.hash, wireHash: cached.wireHash, wireSize: cached.wireSize };
    }
    const result = await compute();
    this.put(file.path, {
      mtime: file.stat.mtime,
      size: file.stat.size,
      hash: result.plainHash,
      wireHash: result.wireHash,
      wireSize: result.wireSize,
      keyFingerprint,
    });
    return result;
  }

  /**
   * Records an already-known hash directly, for callers that computed it as an unavoidable side
   * effect of something else (e.g. hashing a file to upload it) rather than asking this cache for
   * it — avoids a redundant re-hash the next time this file's status is checked.
   */
  set(file: TFile, hash: string): void {
    this.put(file.path, { mtime: file.stat.mtime, size: file.stat.size, hash });
  }

  /**
   * Batched form of get() — the read-side counterpart of setMany() below, for the same reason:
   * regular sync looks this cache up for every local file on every scan pass (to decide whether a
   * read+hash can be skipped), and opening a separate IndexedDB transaction per file just to check
   * for a cache hit dominates the scan once there are hundreds/thousands of files. Callers pass the
   * result to getHash()/getWireHash()'s `prefetched` parameter instead of letting them each open
   * their own transaction. Paths with no cached entry are simply absent from the returned map
   * (never mapped to null/undefined), so Map#has()/Map#get() naturally distinguish "no entry" from
   * "entry present."
   */
  async getMany(paths: string[]): Promise<Map<string, CachedHash>> {
    const result = new Map<string, CachedHash>();
    if (!this.db || paths.length === 0) return result;
    return new Promise((resolve) => {
      try {
        const store = this.db!.transaction("hashes", "readonly").objectStore("hashes");
        let remaining = paths.length;
        for (const path of paths) {
          const req = store.get(path);
          req.onsuccess = () => {
            if (req.result) result.set(path, req.result as CachedHash);
            if (--remaining === 0) resolve(result);
          };
          req.onerror = () => {
            if (--remaining === 0) resolve(result);
          };
        }
      } catch {
        resolve(result); // best-effort cache — treat a failed batch as a full cache miss
      }
    });
  }

  /**
   * Batched form of set() — regular sync seeds this cache for every local file on every sync pass,
   * and opening a separate IndexedDB transaction per file (as set() does) noticeably slows that
   * loop down once there are hundreds/thousands of files. This does the whole batch in one
   * transaction instead.
   */
  setMany(entries: Array<{ file: TFile; hash: string }>): void {
    if (!this.db || entries.length === 0) return;
    try {
      const store = this.db.transaction("hashes", "readwrite").objectStore("hashes");
      for (const { file, hash } of entries) {
        store.put({ mtime: file.stat.mtime, size: file.stat.size, hash }, file.path);
      }
    } catch {
      /* best-effort cache — a failed batch just means these files get re-hashed next time */
    }
  }
}
