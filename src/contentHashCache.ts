import { TFile } from "obsidian";

interface CachedHash {
  mtime: number;
  size: number;
  hash: string;
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

  /** Returns file's content hash, reusing the cached value when its mtime+size haven't changed. */
  async getHash(file: TFile, compute: () => Promise<string>): Promise<string> {
    const cached = await this.get(file.path);
    if (cached && cached.mtime === file.stat.mtime && cached.size === file.stat.size) {
      return cached.hash;
    }
    const hash = await compute();
    this.put(file.path, { mtime: file.stat.mtime, size: file.stat.size, hash });
    return hash;
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
