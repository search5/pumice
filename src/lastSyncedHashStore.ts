// Tracks, per path, the content hash both this device and the server last agreed on -- the "base"
// version a 3-way merge (see syncClient.ts's mergeConflict logic) diffs local/remote changes
// against. Deliberately separate from ContentHashCache: that cache is invalidated by mtime/size
// changes (it exists to skip re-hashing unchanged files), but this one must keep reflecting the
// last *confirmed sync* regardless of any local edits made since -- it's only ever updated by an
// actual successful upload ack or a successful non-conflict download.
export class LastSyncedHashStore {
  private db: IDBDatabase | null = null;

  async init(): Promise<void> {
    const dbName = "pumice-last-synced-hash";
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

  get(path: string): Promise<string | null> {
    return new Promise((resolve) => {
      if (!this.db) return resolve(null);
      try {
        const req = this.db.transaction("hashes", "readonly").objectStore("hashes").get(path);
        req.onsuccess = () => resolve((req.result as { hash: string } | undefined)?.hash ?? null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  set(path: string, hash: string): void {
    if (!this.db) return;
    try {
      this.db.transaction("hashes", "readwrite").objectStore("hashes").put({ hash, syncedAtMs: Date.now() }, path);
    } catch {
      /* best-effort -- a failed write just means the next conflict on this path skips merging */
    }
  }
}
