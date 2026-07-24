import type { App } from "obsidian";

export type SyncLogLevel = "debug" | "warn";

export interface SyncLogEntry {
  ts: number;
  level: SyncLogLevel;
  message: string;
}

const STORAGE_KEY = "sync-diagnostics-log";
// Bounds how much this grows in App#loadLocalStorage's vault-scoped storage -- oldest entries are
// dropped first once this many are on hand, so a long-running vault can't grow this unbounded.
const MAX_ENTRIES = 300;

// Persists the same debug/retry/queueing events that also go to console.debug/console.warn (see
// main.ts/syncClient.ts call sites) into Obsidian's own per-vault local storage, so they can be
// inspected later via SyncDiagnosticsModal instead of only being visible in devtools at the
// moment they happen.
export class SyncDiagnosticsLog {
  private app: App;
  private entries: SyncLogEntry[];

  constructor(app: App) {
    this.app = app;
    const stored: unknown = this.app.loadLocalStorage(STORAGE_KEY);
    this.entries = Array.isArray(stored) ? (stored as SyncLogEntry[]) : [];
  }

  log(level: SyncLogLevel, message: string): void {
    this.entries.push({ ts: Date.now(), level, message });
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
    this.app.saveLocalStorage(STORAGE_KEY, this.entries);
  }

  /** Oldest first, same order they were logged in. */
  getEntries(): SyncLogEntry[] {
    return this.entries;
  }

  clear(): void {
    this.entries = [];
    this.app.saveLocalStorage(STORAGE_KEY, null);
  }
}
