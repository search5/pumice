import { App, TFile } from "obsidian";

export interface LocalSnapshot {
  path: string;
  ts: number;
  data: string;
}

export interface LocalSnapshotStoreOptions {
  intervalMinutes: number;
  keepDays: number;
}

const SNAPSHOT_EXTENSIONS = ["md", "canvas", "base"];
// Sorts autocomplete candidate paths in the same order as core (natural sort via Intl.Collator with numeric: true).
const pathCollatorInstance = new Intl.Collator(undefined, { usage: "sort", sensitivity: "base", numeric: true });
const pathCollator = (a: string, b: string) => pathCollatorInstance.compare(a, b);

// Reproduces the same policy as core's built-in "File Recovery" plugin (reverse-engineered from
// obsidian.asar/app.js, class O8: interval debouncing + skip-if-unchanged + retention cleanup +
// force-save), but instead of reading core's IndexedDB (`${appId}-backup`), we keep our own
// snapshots in our own plugin-specific DB. This removes any dependency on core's undocumented,
// unofficial storage schema entirely — this feature is completely unaffected if core changes that
// schema or the File Recovery plugin gets disabled.
export class LocalSnapshotStore {
  private db: IDBDatabase | null = null;
  private tsCache: Record<string, number> = {};
  private pendingFiles = new Set<string>();

  constructor(
    private app: App,
    private getOptions: () => LocalSnapshotStoreOptions
  ) {}

  async init(): Promise<void> {
    // We don't use core's `${app.appId}-backup` pattern since app.appId isn't part of the public API
    // (unofficial) — a single fixed name is enough, since IndexedDB storage is already isolated
    // (origin-scoped) per vault.
    const dbName = "pumice-local-snapshots";
    this.db = await new Promise((resolve) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (db.objectStoreNames.contains("snapshots")) db.deleteObjectStore("snapshots");
        const store = db.createObjectStore("snapshots", { autoIncrement: true });
        store.createIndex("path", "path");
        store.createIndex("ts", "ts");
      };
      req.onerror = () => resolve(null);
      req.onsuccess = () => resolve(req.result);
    });
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  async onFileChanged(file: TFile): Promise<void> {
    if (!this.db) return;
    if (!SNAPSHOT_EXTENSIONS.includes(file.extension)) return;

    const path = file.path;
    let lastTs = this.tsCache[path];
    if (lastTs === undefined) {
      const last = await this.getLastSnapshotByPath(path);
      lastTs = last?.ts ?? 0;
      this.tsCache[path] = lastTs;
    }

    const { intervalMinutes } = this.getOptions();
    const interval = isNaN(intervalMinutes) || intervalMinutes < 0 ? 5 : intervalMinutes;
    const now = Date.now();
    if (now - lastTs < interval * 60 * 1000) {
      this.pendingFiles.add(path);
      return;
    }

    const content = await this.app.vault.cachedRead(file);
    const last = await this.getLastSnapshotByPath(path);
    if (last && last.data === content) return;

    await this.add(path, now, content);
  }

  async resave(): Promise<void> {
    const paths = Array.from(this.pendingFiles);
    this.pendingFiles.clear();
    for (const path of paths) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) await this.onFileChanged(file);
    }
  }

  async cleanup(): Promise<void> {
    if (!this.db) return;
    const { keepDays } = this.getOptions();
    const keep = isNaN(keepDays) || keepDays < 1 ? 7 : keepDays;
    const cutoff = Date.now() - keep * 24 * 60 * 60 * 1000;

    await new Promise<void>((resolve) => {
      const tx = this.db!.transaction("snapshots", "readwrite");
      const index = tx.objectStore("snapshots").index("ts");
      const req = index.openCursor(IDBKeyRange.upperBound(cutoff));
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        } else {
          resolve();
        }
      };
      req.onerror = () => resolve();
    });
  }

  async forceAdd(path: string, data: string): Promise<void> {
    if (!this.db) return;
    const now = Date.now();
    await this.add(path, now, data);
  }

  async clearAll(): Promise<void> {
    if (!this.db) return;
    await new Promise<void>((resolve) => {
      const req = this.db!.transaction("snapshots", "readwrite").objectStore("snapshots").clear();
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    });
    this.tsCache = {};
  }

  async hasSnapshots(path: string): Promise<boolean> {
    if (!this.db) return false;
    const snapshots = await this.getSnapshotsForPath(path);
    return snapshots.length > 0;
  }

  getSnapshotsForPath(path: string): Promise<LocalSnapshot[]> {
    return new Promise((resolve) => {
      if (!this.db) {
        resolve([]);
        return;
      }
      try {
        const tx = this.db.transaction("snapshots", "readonly");
        const req = tx.objectStore("snapshots").index("path").getAll(path);
        req.onsuccess = () => resolve((req.result as LocalSnapshot[]).sort((a, b) => b.ts - a.ts));
        req.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
  }

  getAllPathsWithHistory(): Promise<string[]> {
    return new Promise((resolve) => {
      if (!this.db) {
        resolve([]);
        return;
      }
      try {
        const tx = this.db.transaction("snapshots", "readonly");
        const index = tx.objectStore("snapshots").index("path");
        const paths: string[] = [];
        const req = index.openCursor(null, "nextunique");
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) {
            paths.push((cursor.value as LocalSnapshot).path);
            cursor.continue();
          } else {
            resolve(paths.sort(pathCollator));
          }
        };
        req.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
  }

  private add(path: string, ts: number, data: string): Promise<void> {
    return new Promise((resolve) => {
      if (!this.db) {
        resolve();
        return;
      }
      const req = this.db.transaction("snapshots", "readwrite").objectStore("snapshots").add({ path, ts, data });
      req.onsuccess = () => {
        this.tsCache[path] = ts;
        resolve();
      };
      req.onerror = () => resolve();
    });
  }

  private getLastSnapshotByPath(path: string): Promise<LocalSnapshot | null> {
    return new Promise((resolve) => {
      if (!this.db) {
        resolve(null);
        return;
      }
      try {
        const tx = this.db.transaction("snapshots", "readonly");
        const req = tx.objectStore("snapshots").index("path").openCursor(IDBKeyRange.only(path), "prev");
        req.onsuccess = () => resolve(req.result ? (req.result.value as LocalSnapshot) : null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
}
