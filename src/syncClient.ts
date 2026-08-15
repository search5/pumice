import { TFile, Vault, FileManager, Notice, requestUrl } from "obsidian";
import { merge as mergeDiff3 } from "node-diff3";
import { ContentHashCache } from "./contentHashCache";
import type { LastSyncedHashStore } from "./lastSyncedHashStore";
import { isTextFilePath } from "./textFileTypes";
import { mapWithConcurrency } from "./concurrency";
import type { SyncPluginSettings } from "./settings";
import { t } from "./i18n";
import { buildPluginSnapshot, detectRemovedPluginPaths, filterSyncablePluginPaths } from "./pluginSync";
import { derivePluginIdsFromPaths } from "./pluginReload";
import { groupIntoBatches, runBatchedDownloads } from "./batching";
import type { HistoryVersionEntry, PurgeResult, RemoteFileMetaWire, SyncTransport, VaultSize } from "./syncTransport";

// e2eePassword isn't part of SyncPluginSettings itself (it lives in app.secretStorage, see
// tokenStore.ts) -- callers splice it in when constructing a SyncClient, so this is the actual
// runtime shape of the settings object this class works with.
type ClientSettings = SyncPluginSettings & { e2eePassword: string };

export interface SyncResult {
  uploaded: number;
  downloaded: number;
  deleted: number;
  failed: number;
  // Plugin ids touched by this sync's downloads/deletions (e.g. another device published a newer
  // version) -- main.ts hot-reloads whichever of these are already enabled on this device instead
  // of leaving them stale until the next restart. See #11_플러그인_핫리로드_구현_계획.md.
  updatedPluginIds: string[];
}

// Reported by internalSync() so callers (main.ts's syncNow()) can show progress instead of just a
// start/end Notice -- "done" counts items processed within the current phase, not overall.
export type SyncProgressPhase = "scan" | "upload" | "download";
export type SyncProgressCallback = (info: { phase: SyncProgressPhase; done: number; total: number }) => void;

// Reported by sync() on each retry after a failed internalSync() attempt, so callers can fold the
// retry status into their own UI (e.g. main.ts's syncNow() updates its progress Notice in place)
// instead of a separate hardcoded Notice popping up on top of it.
export type SyncRetryCallback = (info: { delayMs: number; retriesLeft: number }) => void;

// Mirrors the same debug/warn diagnostics main.ts's own logDebug() persists (in-sync retry
// attempts, files still failing after retries) into the caller's SyncDiagnosticsLog -- kept as a
// plain callback (like onProgress/onRetry above) rather than importing SyncDiagnosticsLog
// directly, so this class stays decoupled from Obsidian's App/local-storage specifics.
export type SyncLogCallback = (level: "debug" | "warn", message: string) => void;

// Re-exported for callers that imported it from here before the 2026-08 WS history migration
// follow-up moved the actual definition to syncTransport.ts (see that file's own comment).
export type { HistoryVersionEntry } from "./syncTransport";

// The four helpers below try the Vault API first, and only fall back to the Adapter API for paths
// outside the vault index (config files like .obsidian/bookmarks.json — not picked up as a TFile,
// so the Vault API has no way to reach them at all). This follows Obsidian's official plugin
// guidelines ("prefer the Vault API over the Adapter API"), falling back to Adapter only where the
// Vault API genuinely doesn't support it (unavoidable cases).
async function existsByPath(vault: Vault, path: string): Promise<boolean> {
  if (vault.getAbstractFileByPath(path)) return true;
  return vault.adapter.exists(path);
}

async function readBinaryByPath(vault: Vault, path: string): Promise<ArrayBuffer> {
  const file = vault.getAbstractFileByPath(path);
  if (file instanceof TFile) return vault.readBinary(file);
  return vault.adapter.readBinary(path);
}

async function statByPath(vault: Vault, path: string): Promise<{ mtime: number; size: number } | null> {
  const file = vault.getAbstractFileByPath(path);
  if (file instanceof TFile) return { mtime: file.stat.mtime, size: file.stat.size };
  return vault.adapter.stat(path);
}

// mtime is passed via Obsidian's own DataWriteOptions (public API, works identically on desktop and
// mobile) rather than a raw fs call, so this is the only place a downloaded file's mtime ever gets
// set -- and it happens atomically as part of the same write Obsidian already knows about, so
// TFile.stat reflects it immediately afterward (no separate out-of-band step that could go stale).
async function writeBinaryByPath(vault: Vault, path: string, data: ArrayBuffer, mtime?: number): Promise<void> {
  const options = mtime !== undefined ? { mtime } : undefined;
  const file = vault.getAbstractFileByPath(path);
  if (file instanceof TFile) {
    await vault.modifyBinary(file, data, options);
    return;
  }
  try {
    await vault.createBinary(path, data, options);
  } catch {
    await vault.adapter.writeBinary(path, data, options);
  }
}

async function ensureFolder(vault: Vault, dirPath: string): Promise<void> {
  if (!dirPath || vault.getAbstractFileByPath(dirPath)) return;
  try {
    await vault.createFolder(dirPath);
  } catch {
    /* Ignore if it already exists (e.g. created concurrently) */
  }
}

// vault.createFolder() (used by ensureFolder above) is the Vault API, which has never been
// exercised against nested config-dir paths like .obsidian/plugins/<id>/ -- bookmarks.json never
// needed folder creation since its parent (.obsidian) always already exists. This walks the
// Adapter API instead (vault.adapter.mkdir, 1.7.2+), level by level with an exists() check before
// each mkdir, so it's correct regardless of whether a given platform's mkdir() creates
// intermediate directories or only the immediate one.
async function ensureConfigFolder(vault: Vault, dirPath: string): Promise<void> {
  if (!dirPath) return;
  const parts = dirPath.split("/").filter((p) => p.length > 0);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (await vault.adapter.exists(current)) continue;
    try {
      await vault.adapter.mkdir(current);
    } catch {
      /* Ignore if it already exists (e.g. created concurrently) */
    }
  }
}

// Slash-based file path utilities
const pathUtil = {
  join(...parts: string[]): string {
    return parts.map(p => p.trim().replace(/^\/+|\/+$/g, "")).filter(p => p.length > 0).join("/");
  },
  dirname(filePath: string): string {
    const parts = filePath.split("/");
    parts.pop();
    return parts.join("/");
  },
  basename(filePath: string, ext?: string): string {
    const parts = filePath.split("/");
    let base = parts.pop() || "";
    if (ext && base.endsWith(ext)) {
      base = base.substring(0, base.length - ext.length);
    }
    return base;
  },
  extname(filePath: string): string {
    const parts = filePath.split(".");
    return parts.length > 1 ? "." + parts.pop() : "";
  }
};

// SHA-256 helper using the browser's standard Web Crypto API
async function sha256(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

// Keeps a persisted log message (see SyncLogCallback) readably short even when a batch of dozens
// or hundreds of paths fails at once.
function formatPathList(paths: string[]): string {
  const MAX_SHOWN = 5;
  const shown = paths.slice(0, MAX_SHOWN).join(", ");
  return paths.length > MAX_SHOWN ? `${shown}, and ${paths.length - MAX_SHOWN} more` : shown;
}

export class SyncClient {
  private transport: SyncTransport;
  private vault: Vault;
  private fileManager: FileManager;
  private pluginDir: string;
  private token: string;
  private settings: ClientSettings;
  private deletedFiles: Record<string, number>;
  private updateDeletedFiles: (deleted: Record<string, number>) => Promise<void>;
  private hashCache?: ContentHashCache;
  private lastSyncedHashStore?: LastSyncedHashStore;
  private onProgress?: SyncProgressCallback;
  private onRetry?: SyncRetryCallback;
  private lastProgressReportAt = 0;
  private e2eeKeyCache: CryptoKey | null = null;
  // Paths this sync is currently writing to the vault itself (downloads, tombstone deletes) --
  // shared with the plugin's vault event listeners (see main.ts) so a write this sync performs
  // doesn't get misread as a fresh local edit and queue a needless follow-up sync. Populated only
  // for the duration of each individual write, not the whole sync, so a genuine concurrent edit to
  // a different file is never suppressed.
  private selfWritePaths: Set<string>;
  private onLog?: SyncLogCallback;
  // Raw (unfiltered by ignorePatterns) .obsidian/plugins/** paths seen on the last successful
  // sync -- diffed against the current listing each scan to synthesize deletion tombstones for
  // plugin removals, since vault.on("delete", ...) never fires for config-dir paths. See
  // #7_플러그인_동기화_구현_계획.md.
  private lastKnownPluginPaths: Record<string, number>;
  private updateLastKnownPluginPaths?: (paths: Record<string, number>) => Promise<void>;

  private async getE2eeKey(): Promise<CryptoKey> {
    if (this.e2eeKeyCache) {
      return this.e2eeKeyCache;
    }
    const vaultId = this.vault.getName();
    const encoder = new TextEncoder();
    const salt = encoder.encode("obsidian-sync-salt-" + vaultId);
    const password = this.settings.e2eePassword || "";

    // Derive the E2EE AES-GCM 256 key using PBKDF2
    const baseKey = await crypto.subtle.importKey(
      "raw",
      encoder.encode(password),
      "PBKDF2",
      false,
      ["deriveKey"]
    );

    this.e2eeKeyCache = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: salt,
        iterations: 100000,
        hash: "SHA-256"
      },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );

    return this.e2eeKeyCache;
  }

  private async encryptData(plainBuffer: ArrayBuffer, key: CryptoKey): Promise<ArrayBuffer> {
    const plainHash = await crypto.subtle.digest("SHA-256", plainBuffer);
    const iv = new Uint8Array(plainHash).slice(0, 12);

    const encrypted = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: iv,
        tagLength: 128
      },
      key,
      plainBuffer
    );

    // encrypted = ciphertext + tag (16 bytes)
    // Packed as (12b IV + 16b tag + ciphertext) to stay compatible with the existing desktop client format
    const encryptedBytes = new Uint8Array(encrypted);
    const tag = encryptedBytes.slice(-16);
    const ciphertext = encryptedBytes.slice(0, -16);

    const result = new Uint8Array(12 + 16 + ciphertext.length);
    result.set(iv, 0);
    result.set(tag, 12);
    result.set(ciphertext, 28);

    return result.buffer;
  }

  private async decryptData(encryptedBuffer: ArrayBuffer, key: CryptoKey): Promise<ArrayBuffer> {
    if (encryptedBuffer.byteLength < 28) {
      throw new Error("Invalid encrypted buffer size");
    }
    const encryptedBytes = new Uint8Array(encryptedBuffer);
    const iv = encryptedBytes.slice(0, 12);
    const tag = encryptedBytes.slice(12, 28);
    const ciphertext = encryptedBytes.slice(28);

    // Recombined as ciphertext + tag (16 bytes) for Web Crypto's decrypt API
    const dataToDecrypt = new Uint8Array(ciphertext.length + 16);
    dataToDecrypt.set(ciphertext, 0);
    dataToDecrypt.set(tag, ciphertext.length);

    return crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: iv,
        tagLength: 128
      },
      key,
      dataToDecrypt
    );
  }

  // Fingerprints the current E2EE password so cached wire hashes (ContentHashCache.getWireHash)
  // can detect a password change and refuse to reuse ciphertext hashes computed under the old key.
  private async getKeyFingerprint(): Promise<string> {
    const password = this.settings.e2eePassword || "";
    return sha256(new TextEncoder().encode(password).buffer);
  }

  private async getFileMetadataFromBuffer(arrayBuffer: ArrayBuffer): Promise<{ size: number; hash: string; buffer: ArrayBuffer }> {
    if (this.settings.enableE2EE && this.settings.e2eePassword) {
      const key = await this.getE2eeKey();
      const encrypted = await this.encryptData(arrayBuffer, key);
      const hash = await sha256(encrypted);
      return { size: encrypted.byteLength, hash: hash, buffer: encrypted };
    } else {
      const hash = await sha256(arrayBuffer);
      return { size: arrayBuffer.byteLength, hash: hash, buffer: arrayBuffer };
    }
  }

  constructor(
    transport: SyncTransport,
    vault: Vault,
    fileManager: FileManager,
    pluginDir: string,
    token: string,
    settings: ClientSettings,
    deletedFiles: Record<string, number>,
    updateDeletedFiles: (deleted: Record<string, number>) => Promise<void>,
    hashCache?: ContentHashCache,
    onProgress?: SyncProgressCallback,
    onRetry?: SyncRetryCallback,
    selfWritePaths?: Set<string>,
    onLog?: SyncLogCallback,
    lastSyncedHashStore?: LastSyncedHashStore,
    lastKnownPluginPaths?: Record<string, number>,
    updateLastKnownPluginPaths?: (paths: Record<string, number>) => Promise<void>
  ) {
    this.transport = transport;
    this.vault = vault;
    this.fileManager = fileManager;
    this.pluginDir = pluginDir;
    this.token = token;
    this.settings = settings;
    this.deletedFiles = deletedFiles;
    this.updateDeletedFiles = updateDeletedFiles;
    this.hashCache = hashCache;
    this.onProgress = onProgress;
    this.onRetry = onRetry;
    this.selfWritePaths = selfWritePaths ?? new Set<string>();
    this.onLog = onLog;
    this.lastSyncedHashStore = lastSyncedHashStore;
    this.lastKnownPluginPaths = lastKnownPluginPaths ?? {};
    this.updateLastKnownPluginPaths = updateLastKnownPluginPaths;
  }

  // Always reports the final item of a phase (done === total) so the UI never gets stuck showing a
  // stale count; otherwise throttled to a few times a second so mapWithConcurrency's per-file
  // callbacks don't turn into a per-file Notice DOM update on large vaults.
  private reportProgress(phase: SyncProgressPhase, done: number, total: number): void {
    if (!this.onProgress) return;
    const now = Date.now();
    if (done !== total && now - this.lastProgressReportAt < 150) return;
    this.lastProgressReportAt = now;
    this.onProgress({ phase, done, total });
  }

  private async calculateHash(file: TFile): Promise<string> {
    const arrayBuffer = await this.vault.readBinary(file);
    return sha256(arrayBuffer);
  }

  // Routes to ensureConfigFolder (Adapter-based, see its comment) for paths under the vault's
  // config dir -- e.g. a newly-downloaded .obsidian/plugins/<id>/main.js whose folder doesn't
  // exist locally yet -- and to the regular Vault-API-based ensureFolder for everything else.
  private async ensureFolderForPath(filePath: string): Promise<void> {
    const dir = pathUtil.dirname(filePath);
    const configDir = this.vault.configDir;
    if (dir === configDir || dir.startsWith(`${configDir}/`)) {
      await ensureConfigFolder(this.vault, dir);
    } else {
      await ensureFolder(this.vault, dir);
    }
  }

  // Marks `path` as a self-write for the duration of `action` -- vault.on() fires synchronously as
  // part of the write itself (before the awaited promise resolves), so adding the path before
  // calling `action` guarantees the plugin's event listener sees it in `selfWritePaths` when it
  // checks. Removed again in `finally` so the window stays as narrow as the write itself.
  private async writeSelfPath<T>(path: string, action: () => Promise<T>): Promise<T> {
    this.selfWritePaths.add(path);
    try {
      return await action();
    } finally {
      this.selfWritePaths.delete(path);
    }
  }

  private isIgnored(filePath: string): boolean {
    const ignoreLines = this.settings.ignorePatterns
      .split("\n")
      .map((l: string) => l.trim())
      .filter((l: string) => l.length > 0);

    const normalizedPath = filePath.replace(/\\/g, "/");

    // Built-in ignore rule
    if (!this.settings.syncBookmarks && normalizedPath === `${this.vault.configDir}/bookmarks.json`) {
      return true;
    }

    for (const pattern of ignoreLines) {
      if (normalizedPath === pattern || normalizedPath.startsWith(pattern + "/")) {
        return true;
      }
    }

    return false;
  }

  public async sync(): Promise<SyncResult> {
    let retries = 3;
    let delay = 1000;

    while (true) {
      try {
        return await this.internalSync();
      } catch (e: unknown) {
        retries--;
        if (retries <= 0) {
          throw e;
        }
        console.warn(`Sync failed, retrying in ${delay}ms... (Remaining retries: ${retries})`, e);
        this.onRetry?.({ delayMs: delay, retriesLeft: retries });
        await new Promise((resolve) => window.setTimeout(resolve, delay));
        delay *= 2;
      }
    }
  }

  // Builds one file's full [header, data..., eof] FileChunk sequence -- shared by both upload
  // paths below (streaming and the batched gRPC-Web fallback), which only differ in how these
  // chunks get onto the wire, not in how they're built.
  // Reuses the buffer read (and, under E2EE, encrypted) during the scan step above when
  // available -- this is what avoids reading/re-encrypting every file a second time here, which
  // is otherwise unavoidable on the very first sync since need_upload == every file.
  private async prepareUploadFile(
    uploadPath: string,
    scannedWireBuffers: Map<string, { buffer: ArrayBuffer; hash: string; mtime: number }>
  ): Promise<{ path: string; data: ArrayBuffer; contentHash: string; mtimeMs: number } | null> {
    try {
      const cached = scannedWireBuffers.get(uploadPath);
      let sendBuffer: ArrayBuffer;
      let contentHash: string;
      let mtime: number;

      if (cached) {
        sendBuffer = cached.buffer;
        contentHash = cached.hash;
        mtime = cached.mtime;
        // Consumed -- release it now instead of holding it until the whole sync finishes, so
        // later files/batches don't keep every earlier one's buffers alive at once.
        scannedWireBuffers.delete(uploadPath);
      } else {
        const exists = await existsByPath(this.vault, uploadPath);
        if (!exists) return null;

        const arrayBuffer = await readBinaryByPath(this.vault, uploadPath);
        sendBuffer = arrayBuffer;
        contentHash = "";

        if (this.settings.enableE2EE && this.settings.e2eePassword) {
          const key = await this.getE2eeKey();
          sendBuffer = await this.encryptData(arrayBuffer, key);
          contentHash = await sha256(sendBuffer);
        } else {
          contentHash = await sha256(arrayBuffer);
        }

        const stat = await statByPath(this.vault, uploadPath);
        mtime = stat ? stat.mtime : Date.now();
      }

      return { path: uploadPath, data: sendBuffer, contentHash, mtimeMs: mtime };
    } catch (err) {
      console.error(`Error preparing ${uploadPath} for upload:`, err);
      return null;
    }
  }

  // Uploads exactly `paths` (a subset of needUploadList on the first call, a shrinking list of
  // previously-failed paths on retries -- see internalSync's retry loop) via the transport.
  // Failures are reported through `onAck` like any other ack, not thrown -- a single bad file
  // must not abort the rest of the batch.
  private async uploadFileBatch(
    paths: string[],
    vaultId: string,
    scannedWireBuffers: Map<string, { buffer: ArrayBuffer; hash: string; mtime: number }>,
    sizeByPath: Map<string, number>,
    onAck: (ack: { path: string; ok: boolean; error: string }) => void
  ): Promise<void> {
    if (paths.length === 0) return;

    // Split into multiple batches bounded by byte size and file count -- keeps only one batch's
    // worth of prepared (already-encrypted, for E2EE) file bytes in memory at a time instead of
    // the whole need-upload set at once, same reasoning as runBatchedDownloads' batching.
    // MAX_FILES_PER_BATCH exists because byte size alone isn't enough of a cap: a real vault is
    // dominated by many small notes, so a byte-only cap lets one batch swallow nearly the whole
    // list before it fills up.
    const BATCH_TARGET_BYTES = 20 * 1024 * 1024;
    const MAX_FILES_PER_BATCH = 500;
    const uploadBatches = groupIntoBatches(paths, (p) => sizeByPath.get(p) ?? 0, BATCH_TARGET_BYTES, MAX_FILES_PER_BATCH);

    for (const batchPaths of uploadBatches) {
      // Reading/hashing (and, under E2EE, encrypting) each file one at a time is an O(files)
      // chain of Capacitor-bridge round trips -- this overlaps them instead. mapWithConcurrency
      // preserves per-item result order, though the transport doesn't depend on that ordering
      // (each prepared file carries its own path).
      const UPLOAD_PREP_CONCURRENCY = 8;
      const prepared = await mapWithConcurrency(batchPaths, UPLOAD_PREP_CONCURRENCY, (uploadPath) =>
        this.prepareUploadFile(uploadPath, scannedWireBuffers)
      );
      const files = prepared.filter((f): f is NonNullable<typeof f> => f !== null);

      // Handle this batch's acks before preparing the next -- deliberately sequential (no
      // pipelining of batch N+1's prep against batch N's send/ack wait), same tradeoff as before.
      await this.transport.uploadBatch(vaultId, files, onAck);
    }
  }

  private conflictBackupPath(path: string): string {
    const ext = pathUtil.extname(path);
    const baseName = path.substring(0, path.length - ext.length);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `${baseName}.sync-conflict-${timestamp}${ext}`;
  }

  // Backs up `path`'s current local content to `<name>.sync-conflict-<timestamp>.<ext>` before
  // it's about to be replaced -- shared by every conflictResolution path that needs this safety
  // net (manual, server-wins, merge's can't-attempt-at-all fallback, and merge's marked-conflict
  // case).
  private async backupLocalVersion(path: string): Promise<string> {
    const oldData = await readBinaryByPath(this.vault, path);
    const conflictPath = this.conflictBackupPath(path);
    await writeBinaryByPath(this.vault, conflictPath, oldData);
    return conflictPath;
  }

  // client-wins keeps the local file exactly as-is (never overwritten), but the losing remote
  // edit -- a real change made on another device -- must not just vanish either: it's written
  // alongside as a conflict copy instead of being silently discarded, the same safety net every
  // other resolution mode gets for whichever side loses.
  private async backupRemoteVersion(path: string, data: ArrayBuffer): Promise<string> {
    const conflictPath = this.conflictBackupPath(path);
    await writeBinaryByPath(this.vault, conflictPath, data);
    return conflictPath;
  }

  // Attempts a 3-way merge for a conflicting text file: diffs the last-synced "base" version
  // against both the current local and current remote content (node-diff3's `merge`, the same
  // diff3 algorithm git itself uses for merges). Non-overlapping edits from both sides are always
  // combined automatically; where both sides changed the *same* lines, that one region gets
  // git-style `<<<<<<<`/`=======`/`>>>>>>>` conflict markers inline instead of losing either
  // side's edits wholesale -- everything else in the file still merges normally around it.
  // Returns null (meaning: fall back to the old backup-and-overwrite-with-remote behavior)
  // only when a merge can't be attempted at all -- not a text file, no recorded last-synced hash
  // for this path, or that base version has since been pruned from server history.
  private async tryAutoMergeConflict(
    path: string,
    remotePlainData: ArrayBuffer
  ): Promise<{ mergedText: string; hasConflictMarkers: boolean } | null> {
    if (!isTextFilePath(path) || !this.lastSyncedHashStore) return null;

    try {
      const baseHash = await this.lastSyncedHashStore.get(path);
      if (!baseHash) return null;

      const history = await this.getFileHistory(path);
      const baseEntry = history.find((h) => h.content_hash === baseHash && !h.deleted);
      if (!baseEntry) return null;

      const baseData = await this.downloadHistoryVersion(path, baseEntry.history_id);
      const localData = await readBinaryByPath(this.vault, path);

      const decoder = new TextDecoder("utf-8");
      const baseText = decoder.decode(baseData);
      const localText = decoder.decode(localData);
      const remoteText = decoder.decode(remotePlainData);

      const { conflict, result } = mergeDiff3(localText, baseText, remoteText, {
        stringSeparator: "\n",
        label: { a: "local", b: "remote" },
      });
      return { mergedText: result.join("\n"), hasConflictMarkers: conflict };
    } catch (e: unknown) {
      console.error(`Merge attempt failed for ${path}, falling back to conflict backup:`, e);
      return null;
    }
  }

  // Downloads exactly `paths`, same shrinking-list-on-retry usage as uploadFileBatch above.
  // Per-file failures (hash mismatch, save error) are collected into `failedPaths` and returned
  // rather than thrown, so one bad file doesn't lose the rest of the batch.
  // progressState is shared across every batch of a single sync's downloads (see runDownloads)
  // so the reported "done/total" reflects the whole need-download set, not just this one batch.
  private async downloadFileBatch(
    paths: string[],
    vaultId: string,
    progressState: { done: number; total: number }
  ): Promise<{ downloadedCount: number; failedPaths: string[] }> {
    if (paths.length === 0) return { downloadedCount: 0, failedPaths: [] };

    // onFile returns whether the file was accepted -- the transport tallies
    // downloadedCount/failedPaths from that and from any exception it throws (see
    // WsSyncTransportAdapter.downloadBatch), so this no longer needs its own outer try/catch.
    return this.transport.downloadBatch(vaultId, paths, async (file) => {
      this.reportProgress("download", ++progressState.done, progressState.total);

      const calculatedHash = await sha256(file.data);
      if (calculatedHash !== file.contentHash) {
        console.error(`Hash verification failed for downloaded file: ${file.path}`);
        return false;
      }

      const currentPath = file.path;
      const currentMtime = file.mtimeMs;

      await this.ensureFolderForPath(currentPath);

      const exists = await existsByPath(this.vault, currentPath);

      let plainData: ArrayBuffer = file.data;
      // calculatedHash is the hash of the wire bytes (ciphertext when E2EE is on) — reused
      // as-is for the cache when E2EE is off, since it's then already the plaintext hash
      // Publish needs; recomputed from the decrypted bytes otherwise (cheap: no extra I/O,
      // the buffer's already in memory). Computed up front (moved ahead of the conflict
      // check below) since the unconditional text merge attempt needs this plaintext as the
      // "remote" side of a 3-way merge, and client-wins needs it too, to back up the losing side.
      let plainHashForCache = calculatedHash;
      if (this.settings.enableE2EE && this.settings.e2eePassword) {
        const key = await this.getE2eeKey();
        plainData = await this.decryptData(file.data, key);
        plainHashForCache = await sha256(plainData);
      }

      let handledByMerge = false;

      if (exists) {
        // Text files always attempt a 3-way merge first, regardless of settings.conflictResolution
        // -- tryAutoMergeConflict() itself gates on isTextFilePath() (see its own comment), so
        // this call is unconditional here (see 16_conflict_resolution_텍스트_상시병합.md). It
        // still returns null when it genuinely can't attempt one (not text, no
        // lastSyncedHashStore, no recorded base hash, or the base version was pruned from server
        // history) -- that's the only remaining case where conflictResolution's
        // server-wins/client-wins fallback applies to a text file; it always applies to a
        // non-text file, since merge is never attempted for those at all.
        const mergeAttempt = await this.tryAutoMergeConflict(currentPath, plainData);

        if (mergeAttempt !== null && !mergeAttempt.hasConflictMarkers) {
          // Clean merge -- local's and remote's edits didn't touch the same lines. If the
          // result is actually identical to what the server just sent (the common case for
          // a config-dir file like community-plugins.json when this device made no local
          // edits since its last sync), there is no real merge to speak of -- treat it as an
          // ordinary "adopt remote" download instead of a synthetic local edit. Doing the
          // latter unconditionally used to rely on this write being picked up by the
          // debounced auto-sync machinery and re-uploaded so lastSyncedHashStore would catch
          // up; whenever that indirect re-upload didn't happen promptly, the next sync's
          // Delta would still see this path as unresolved and re-offer it for merge, so the
          // exact same "Auto-merged" notice kept firing every sync even though nothing had
          // actually changed on either side.
          const remoteText = new TextDecoder("utf-8").decode(plainData);
          if (mergeAttempt.mergedText !== remoteText) {
            const mergedData = new TextEncoder().encode(mergeAttempt.mergedText).buffer;
            // Deliberately NOT writeSelfPath: this write should look like a fresh local edit
            // so the existing debounced-sync machinery (main.ts) picks it up and re-uploads
            // the merged result through the ordinary upload path on the next pass -- no
            // special immediate-reupload plumbing needed, since this write's mtime will be
            // newer than the server's stored version and Delta will naturally resolve it to
            // need_upload next time.
            await writeBinaryByPath(this.vault, currentPath, mergedData);
            new Notice(t("plugins.sync.msg-auto-merged", "Auto-merged {{filename}} — both changes kept", { filename: pathUtil.basename(currentPath) }));
            const mergedFile = this.vault.getAbstractFileByPath(currentPath);
            if (this.hashCache && mergedFile instanceof TFile) {
              this.hashCache.set(mergedFile, await sha256(mergedData));
            }
            handledByMerge = true;
          }
          // else: falls through to the ordinary "adopt remote" write below -- no local content
          // is being discarded, so no backup and no synthetic-edit notice.
        } else if (mergeAttempt !== null) {
          // Some region really was edited on both sides -- everything else already merged
          // automatically; only that region is left, marked inline (git-style) for the user
          // to resolve by hand. Back up the pre-merge local content first, same safety net as
          // the fallback path below, then write the merged-with-markers file itself via
          // writeSelfPath so it doesn't immediately re-upload with unresolved markers still in
          // it -- the user's own next edit (removing the markers) is what should trigger the
          // next sync.
          try {
            await this.backupLocalVersion(currentPath);
          } catch (backupErr) {
            console.error(`Failed to create pre-merge backup for ${currentPath}:`, backupErr);
          }
          const mergedData = new TextEncoder().encode(mergeAttempt.mergedText).buffer;
          await this.writeSelfPath(currentPath, () => writeBinaryByPath(this.vault, currentPath, mergedData));
          new Notice(t("plugins.sync.msg-merge-conflict-markers", "Merge conflict in {{filename}} — resolve the <<<<<<< markers and save", { filename: pathUtil.basename(currentPath) }));
          const mergedFile = this.vault.getAbstractFileByPath(currentPath);
          if (this.hashCache && mergedFile instanceof TFile) {
            this.hashCache.set(mergedFile, await sha256(mergedData));
          }
          handledByMerge = true;
        } else if (this.settings.conflictResolution === "client-wins") {
          // No merge was attempted (non-text, or a text file with nothing to merge against) --
          // the local file wins and is left untouched, but the losing remote edit is a real
          // change made on another device: back it up as a conflict copy instead of silently
          // discarding it, the same safety net server-wins gets below.
          try {
            const conflictPath = await this.backupRemoteVersion(currentPath, plainData);
            new Notice(t("plugins.sync.msg-conflict-backup-created", "Conflict backup created: {{filename}}", { filename: pathUtil.basename(conflictPath) }));
          } catch (backupErr) {
            console.error(`Failed to create conflict backup for ${currentPath}:`, backupErr);
          }
          // Deliberately not a failure -- retrying would only hit this same skip forever.
          return true;
        } else {
          // "server-wins" (also the fallback for a text file merge couldn't be attempted for):
          // back up local, then fall through to the ordinary adopt-remote write below.
          try {
            const conflictPath = await this.backupLocalVersion(currentPath);
            new Notice(t("plugins.sync.msg-conflict-backup-created", "Conflict backup created: {{filename}}", { filename: pathUtil.basename(conflictPath) }));
          } catch (backupErr) {
            console.error(`Failed to create conflict backup for ${currentPath}:`, backupErr);
          }
        }
      }

      if (!handledByMerge) {
        // mtime is set here, atomically, via Obsidian's own write options -- works the same
        // way on desktop and mobile, and TFile.stat reflects it immediately afterward.
        await this.writeSelfPath(currentPath, () => writeBinaryByPath(this.vault, currentPath, plainData, currentMtime));

        // Seeds the same cache Publish's diff scan reads from, so a file that just arrived via
        // regular sync doesn't get re-read and re-hashed the next time Publish checks it.
        if (this.hashCache) {
          const written = this.vault.getAbstractFileByPath(currentPath);
          if (written instanceof TFile) this.hashCache.set(written, plainHashForCache);
        }

        // Only recorded as "confirmed in sync with server" when the server's own content was
        // taken as-is -- a merge produces content the server doesn't have yet, so that path
        // must not be marked synced until the merged result is actually uploaded. Keyed on
        // calculatedHash (the wire/ciphertext hash under E2EE, same as plain hash otherwise)
        // to match the hash space Delta/history use server-side -- NOT plainHashForCache,
        // which is deliberately the plaintext hash instead (see its own comment above).
        this.lastSyncedHashStore?.set(currentPath, calculatedHash);
      }

      if (this.deletedFiles[currentPath]) {
        delete this.deletedFiles[currentPath];
      }

      return true;
    });
  }

  // Extracted from internalSync's 3-2 step (see runDownloads's own comment for why deletions and
  // downloads are handled separately) so the same logic can also run for a single pushed
  // deletion (see applyPushedFileChange) without a full Delta round trip. Returns whether a
  // local delete actually happened (internalSync's deleteCount only increments on that, not on
  // a not-found no-op) -- the deletedFiles tombstone is cleared regardless, same as before this
  // was extracted.
  private async applyServerDeletion(metaPath: string): Promise<boolean> {
    let deleted = false;
    try {
      const file = this.vault.getAbstractFileByPath(metaPath);
      if (file) {
        await this.writeSelfPath(metaPath, () => this.fileManager.trashFile(file));
        deleted = true;
      } else if (await this.vault.adapter.exists(metaPath)) {
        // A file outside the vault index (.obsidian/* etc.) — deleting directly via the Adapter
        // is the only option.
        await this.writeSelfPath(metaPath, () => this.vault.adapter.remove(metaPath));
        deleted = true;
      }
    } catch (e: unknown) {
      console.error(`Failed to delete local file ${metaPath}:`, e);
    }
    if (this.deletedFiles[metaPath]) {
      delete this.deletedFiles[metaPath];
    }
    return deleted;
  }

  // 2026-08 push-metadata fidelity follow-up (see #11_websocket_동기화_프로토콜_설계.md and
  // llm-wiki/03-*.md) -- applies exactly the one file a `push` notification named, instead of
  // running a full internalSync()/Delta for every remote change regardless of how much actually
  // changed. Safe to call concurrently with nothing else touching this SyncClient instance (the
  // caller, main.ts, is responsible for not overlapping this with a full sync() call on shared
  // mutable state like deletedFiles/hashCache -- see main.ts's isSyncing guard).
  public async applyPushedFileChange(file: RemoteFileMetaWire): Promise<void> {
    if (file.is_deleted) {
      await this.applyServerDeletion(file.path);
      return;
    }
    await this.downloadFileBatch([file.path], this.vault.getName(), { done: 0, total: 1 });
  }

  private async internalSync(): Promise<SyncResult> {
    const vaultId = this.vault.getName();

    // 1. Scan local file metadata. Reading and hashing every file one at a time (as this used to
    // do unconditionally) is what made regular sync so much slower than it needed to be on any
    // vault of real size, especially on mobile where each vault read crosses the Capacitor
    // bridge: SCAN_CONCURRENCY overlaps those reads, and ContentHashCache skips the read+hash
    // entirely for any file whose mtime/size haven't changed since it was last scanned -- the
    // common case for the vast majority of files on every sync after the first. This applies to
    // E2EE too: AES-GCM's IV here is deterministically derived from the plaintext hash (see
    // encryptData above), not random, so re-encrypting unchanged content always reproduces the
    // same ciphertext -- the wire hash is cached the same way, additionally keyed to the current
    // password (getKeyFingerprint) so a password change can't reuse a stale ciphertext hash.
    const SCAN_CONCURRENCY = 8;
    const filesToScan = this.vault.getFiles().filter((f) => !this.isIgnored(f.path));
    const hashCacheEntries: Array<{ file: TFile; hash: string }> = [];
    const keyFingerprint =
      this.settings.enableE2EE && this.settings.e2eePassword ? await this.getKeyFingerprint() : "";

    // Prefetches every path's cache entry in one IndexedDB transaction instead of letting each of
    // the getWireHash()/getHash() calls below open its own -- see #8_ContentHashCache_배치읽기_구현_계획.md.
    // Opening filesToScan.length separate transactions just to check for a cache hit is what made
    // the "scan X/Y" progress phase slow on vaults with many files, even when almost everything was
    // an unchanged-file cache hit.
    const prefetchedHashes = this.hashCache
      ? await this.hashCache.getMany(filesToScan.map((f) => f.path))
      : undefined;

    // Reused by the upload-prep step below so a file read (and, under E2EE, encrypted) during this
    // scan isn't read/encrypted a second time if it turns out to need uploading -- the common case
    // on the very first sync, when every file is new and nothing in ContentHashCache can help yet.
    // Bounded by a byte budget so a large vault's full first-sync upload set can't all be held in
    // memory at once; entries that don't fit are simply skipped and re-read at upload time as before.
    const REUSE_BUDGET_BYTES = 200 * 1024 * 1024;
    let reuseBudgetRemaining = REUSE_BUDGET_BYTES;
    const scannedWireBuffers = new Map<string, { buffer: ArrayBuffer; hash: string; mtime: number }>();
    const maybeCacheWireBuffer = (path: string, buffer: ArrayBuffer, hash: string, mtime: number): void => {
      if (buffer.byteLength > reuseBudgetRemaining) return;
      scannedWireBuffers.set(path, { buffer, hash, mtime });
      reuseBudgetRemaining -= buffer.byteLength;
    };

    let scanDone = 0;
    const scanResults = await mapWithConcurrency(filesToScan, SCAN_CONCURRENCY, async (file) => {
      let size: number;
      let hash: string;
      let plainHashForCache: string;
      let cacheable = true;

      if (this.settings.enableE2EE && this.settings.e2eePassword) {
        if (this.hashCache) {
          const meta = await this.hashCache.getWireHash(file, keyFingerprint, async () => {
            const arrayBuffer = await this.vault.readBinary(file);
            const encMeta = await this.getFileMetadataFromBuffer(arrayBuffer);
            maybeCacheWireBuffer(file.path, encMeta.buffer, encMeta.hash, file.stat.mtime);
            return { plainHash: await sha256(arrayBuffer), wireHash: encMeta.hash, wireSize: encMeta.size };
          }, prefetchedHashes);
          hash = meta.wireHash;
          size = meta.wireSize;
          plainHashForCache = meta.plainHash;
          // getWireHash already persisted the full record (plain hash + wire hash + fingerprint)
          // itself -- pushing it into the setMany batch below would overwrite that record with one
          // that's missing the wire fields, since IndexedDB put() replaces the whole value.
          cacheable = false;
        } else {
          const arrayBuffer = await this.vault.readBinary(file);
          const meta = await this.getFileMetadataFromBuffer(arrayBuffer);
          size = meta.size;
          hash = meta.hash;
          plainHashForCache = await sha256(arrayBuffer);
          maybeCacheWireBuffer(file.path, meta.buffer, meta.hash, file.stat.mtime);
        }
      } else if (this.hashCache) {
        hash = await this.hashCache.getHash(file, async () => {
          const arrayBuffer = await this.vault.readBinary(file);
          const computedHash = await sha256(arrayBuffer);
          maybeCacheWireBuffer(file.path, arrayBuffer, computedHash, file.stat.mtime);
          return computedHash;
        }, prefetchedHashes);
        size = file.stat.size;
        plainHashForCache = hash;
      } else {
        const arrayBuffer = await this.vault.readBinary(file);
        hash = await sha256(arrayBuffer);
        size = arrayBuffer.byteLength;
        plainHashForCache = hash;
        maybeCacheWireBuffer(file.path, arrayBuffer, hash, file.stat.mtime);
      }

      this.reportProgress("scan", ++scanDone, filesToScan.length);
      return { file, hash, size, plainHashForCache, cacheable };
    });

    interface LocalFileMeta {
      path: string;
      modified_at_ms: number;
      size_bytes: number;
      content_hash: string;
      is_deleted: boolean;
    }
    const localFilesMeta: LocalFileMeta[] = scanResults.map((r) => ({
      path: r.file.path,
      modified_at_ms: r.file.stat.mtime,
      size_bytes: r.size,
      content_hash: r.hash,
      is_deleted: false,
    }));

    // Seeds the same cache Publish's diff scan reads from, and re-seeds it here too so an
    // unchanged file's next scan (regular sync or Publish) stays a cache hit. Collected and
    // written in one batch rather than per file — a separate IndexedDB transaction per file
    // noticeably slows this down once there are hundreds/thousands of files.
    if (this.hashCache) {
      for (const r of scanResults) {
        if (r.cacheable) hashCacheEntries.push({ file: r.file, hash: r.plainHashForCache });
      }
      this.hashCache.setMany(hashCacheEntries);
    }

    // Explicitly include the bookmarks file in sync — {configDir}/bookmarks.json is a config file
    // outside the vault index, so it's never picked up as a TFile. The Vault API has no way to
    // reach it at all, so using the Adapter here is unavoidable.
    if (this.settings.syncBookmarks) {
      const bookmarkPath = `${this.vault.configDir}/bookmarks.json`;
      const exists = await this.vault.adapter.exists(bookmarkPath);
      if (exists) {
        try {
          const stat = await this.vault.adapter.stat(bookmarkPath);
          if (stat) {
            const arrayBuffer = await this.vault.adapter.readBinary(bookmarkPath);
            const { size, hash, buffer } = await this.getFileMetadataFromBuffer(arrayBuffer);
            maybeCacheWireBuffer(bookmarkPath, buffer, hash, stat.mtime);
            localFilesMeta.push({
              path: bookmarkPath,
              modified_at_ms: stat.mtime,
              size_bytes: size,
              content_hash: hash,
              is_deleted: false,
            });
          }
        } catch (e: unknown) {
          console.error("Failed to stat or read bookmarks.json:", e);
        }
      }
    }

    // Explicitly include installed community plugins in sync — .obsidian/plugins/** is, like
    // bookmarks.json above, outside the vault index and unreachable via the Vault API, so this
    // walks it directly through the Adapter. See #7_플러그인_동기화_구현_계획.md.
    let rawPluginPaths: string[] = [];
    if (this.settings.syncPlugins) {
      const pluginsRoot = `${this.vault.configDir}/plugins`;

      // adapter.list() only returns one directory level, so recurse into each subfolder found.
      const collectFiles = async (dirPath: string): Promise<string[]> => {
        if (!(await this.vault.adapter.exists(dirPath))) return [];
        const { files, folders } = await this.vault.adapter.list(dirPath);
        const nested = await Promise.all(folders.map((f) => collectFiles(f)));
        return [...files, ...nested.flat()];
      };

      const communityPluginsPath = `${this.vault.configDir}/community-plugins.json`;
      const rawPluginFiles = await collectFiles(pluginsRoot);
      const communityPluginsExists = await this.vault.adapter.exists(communityPluginsPath);
      // Raw = every path actually on disk, unfiltered by ignorePatterns -- this is what the
      // deletion diff below compares against, deliberately kept separate from the
      // filterSyncablePluginPaths() output used for the actual content scan (see
      // detectRemovedPluginPaths()'s own comment for why: an ignorePatterns change must never look
      // like a deletion).
      rawPluginPaths = communityPluginsExists ? [...rawPluginFiles, communityPluginsPath] : rawPluginFiles;

      const allPluginFiles = filterSyncablePluginPaths(rawPluginPaths, {
        isIgnored: (p) => this.isIgnored(p),
        syncPluginData: this.settings.syncPluginData,
      });

      await mapWithConcurrency(allPluginFiles, SCAN_CONCURRENCY, async (path) => {
        try {
          const stat = await this.vault.adapter.stat(path);
          if (!stat) return;
          const arrayBuffer = await this.vault.adapter.readBinary(path);
          const { size, hash, buffer } = await this.getFileMetadataFromBuffer(arrayBuffer);
          maybeCacheWireBuffer(path, buffer, hash, stat.mtime);
          localFilesMeta.push({
            path,
            modified_at_ms: stat.mtime,
            size_bytes: size,
            content_hash: hash,
            is_deleted: false,
          });
        } catch (e: unknown) {
          console.error(`Failed to stat or read plugin file ${path}:`, e);
        }
      });

      // Detect plugins removed locally since the last sync (no vault "delete" event fires for
      // config-dir paths, so this is the only way to notice) and fold them into the same
      // deletedFiles tombstone mechanism regular files already use -- everything downstream
      // (the tombstone loop right below, and the send/receive handling further down) needs no
      // changes to pick these up.
      for (const removedPath of detectRemovedPluginPaths(rawPluginPaths, this.lastKnownPluginPaths, (p) => this.isIgnored(p))) {
        this.deletedFiles[removedPath] = Date.now();
      }
    }

    // Add client-side deletion history (tombstones)
    for (const [delPath, delTime] of Object.entries(this.deletedFiles)) {
      if (this.isIgnored(delPath)) {
        continue;
      }
      localFilesMeta.push({
        path: delPath,
        modified_at_ms: delTime,
        size_bytes: 0,
        content_hash: "",
        is_deleted: true,
      });
    }

    // 2. Send the delta comparison request
    const deltaRes = await this.transport.delta(vaultId, localFilesMeta);

    let uploadCount = 0;
    let downloadCount = 0;
    let deleteCount = 0;

    const needUploadList = deltaRes.needUpload;
    const needDownloadList = deltaRes.needDownload;

    // 3-1. Reconcile locally-deleted files against the server response and clean up local state
    const sentDeletions = Object.keys(this.deletedFiles);
    const downloadPaths = new Set(needDownloadList.map((f) => f.path));
    for (const delPath of sentDeletions) {
      if (!downloadPaths.has(delPath)) {
        delete this.deletedFiles[delPath];
        deleteCount++;
      }
    }

    // 3-2. Apply server-side deletions locally (downloading tombstones)
    const filesToDelete = needDownloadList.filter((f) => f.is_deleted);
    for (const fileMeta of filesToDelete) {
      if (await this.applyServerDeletion(fileMeta.path)) deleteCount++;
    }

    // 4 & 5. UploadFiles and DownloadFiles run concurrently, not sequentially -- a path is only
    // ever need-upload XOR need-download XOR neither (the server's Delta() resolves every path to
    // exactly one bucket via hash/mtime comparison, see pumice-server's service.py), so the two
    // sets are always disjoint and can never race on the same file. Each keeps its own in-pass
    // retry loop (a file that comes back with ack.ok === false, or a hash mismatch/save error on
    // download, is retried a couple more times *within this same sync call* before being given up
    // on -- previously a single per-file failure was only logged and silently dropped, so it took
    // a whole separate manual sync (a fresh Delta) to pick it back up).
    const sizeByPath = new Map(localFilesMeta.map((f) => [f.path, f.size_bytes]));
    const hashByPath = new Map(localFilesMeta.map((f) => [f.path, f.content_hash]));
    const filesToDownload = needDownloadList.filter((f) => !f.is_deleted);
    const downloadSizeByPath = new Map(filesToDownload.map((f) => [f.path, f.size_bytes]));

    const runUploads = async (): Promise<string[]> => {
      const UPLOAD_RETRY_ATTEMPTS = 2;
      let pathsToUpload = needUploadList;
      for (let attempt = 0; pathsToUpload.length > 0 && attempt <= UPLOAD_RETRY_ATTEMPTS; attempt++) {
        if (attempt > 0) {
          const message = `Retrying ${pathsToUpload.length} failed upload(s), attempt ${attempt}/${UPLOAD_RETRY_ATTEMPTS}: ${formatPathList(pathsToUpload)}`;
          console.debug(message);
          this.onLog?.("debug", message);
          await new Promise((resolve) => window.setTimeout(resolve, 500 * attempt));
        }
        let uploadAcksProcessed = 0;
        const failedThisAttempt: string[] = [];
        const onUploadAck = (ack: { path: string; ok: boolean; error: string }): void => {
          const ackPath = ack.path;
          if (ack.ok) {
            uploadCount++;
            if (this.deletedFiles[ackPath]) {
              delete this.deletedFiles[ackPath];
            }
            // Records this path as confirmed in sync (the "base" a future 3-way merge diffs
            // against) -- server now has exactly the content whose hash this is.
            const uploadedHash = hashByPath.get(ackPath);
            if (uploadedHash) this.lastSyncedHashStore?.set(ackPath, uploadedHash);
          } else {
            console.error(`Upload failed for ${ackPath}: ${ack.error}`);
            failedThisAttempt.push(ackPath);
          }
          if (attempt === 0) this.reportProgress("upload", ++uploadAcksProcessed, pathsToUpload.length);
        };

        try {
          await this.uploadFileBatch(pathsToUpload, vaultId, scannedWireBuffers, sizeByPath, onUploadAck);
          pathsToUpload = failedThisAttempt;
        } catch (e: unknown) {
          // The whole batch/stream errored (e.g. connection drop mid-upload) rather than an
          // individual file coming back with ok=false -- every path in this attempt is unaccounted
          // for, so all of them are candidates for the next retry pass.
          console.error("Upload batch failed:", e);
        }
      }
      if (pathsToUpload.length > 0) {
        const message = `${pathsToUpload.length} upload(s) still failing after ${UPLOAD_RETRY_ATTEMPTS} in-sync retries: ${formatPathList(pathsToUpload)}`;
        console.warn(message);
        this.onLog?.("warn", message);
      }
      return pathsToUpload;
    };

    const runDownloads = async (): Promise<string[]> => {
      const DOWNLOAD_RETRY_ATTEMPTS = 2;
      // Same reasoning as uploads' MAX_FILES_PER_BATCH/BATCH_TARGET_BYTES: a DownloadFiles
      // request for the whole need-download list (thousands of files on a fresh vault's first
      // sync) used to be sent as one gRPC-Web call. Batching it means a batch's own failure
      // (server-side resource pressure from too many files in one request, a dropped
      // connection, etc.) only re-queues that batch on retry -- not the entire need-download
      // set, which previously failed identically on every retry with no way to make progress.
      const DOWNLOAD_BATCH_TARGET_BYTES = 20 * 1024 * 1024;
      const MAX_FILES_PER_DOWNLOAD_BATCH = 500;
      const pathsToDownload = filesToDownload.map((f) => f.path);
      const progressState = { done: 0, total: pathsToDownload.length };

      const { downloadedCount, failedPaths } = await runBatchedDownloads(
        pathsToDownload,
        downloadSizeByPath,
        (batchPaths) => this.downloadFileBatch(batchPaths, vaultId, progressState),
        {
          targetBytes: DOWNLOAD_BATCH_TARGET_BYTES,
          maxFiles: MAX_FILES_PER_DOWNLOAD_BATCH,
          retryAttempts: DOWNLOAD_RETRY_ATTEMPTS,
          onRetry: async (batchPaths, attempt) => {
            const message = `Retrying ${batchPaths.length} failed download(s), attempt ${attempt}/${DOWNLOAD_RETRY_ATTEMPTS}: ${formatPathList(batchPaths)}`;
            console.debug(message);
            this.onLog?.("debug", message);
            await new Promise((resolve) => window.setTimeout(resolve, 500 * attempt));
          },
        }
      );
      downloadCount += downloadedCount;

      if (failedPaths.length > 0) {
        const message = `${failedPaths.length} download(s) still failing after ${DOWNLOAD_RETRY_ATTEMPTS} in-sync retries: ${formatPathList(failedPaths)}`;
        console.warn(message);
        this.onLog?.("warn", message);
      }
      return failedPaths;
    };

    const [failedUploadPaths, failedDownloadPaths] = await Promise.all([runUploads(), runDownloads()]);

    // 6. Persist the updated deletion-history state
    await this.updateDeletedFiles(this.deletedFiles);

    // Persist this scan's raw plugin-path snapshot for next time's deletion diff -- deferred to
    // here (after the Delta round-trip and upload/download attempts, not right after the scan)
    // so a sync that fails partway through doesn't advance the snapshot past files that turn out
    // to still need a deletion tombstone next time. Only touched when syncPlugins is on: leaving
    // it untouched while off preserves the last-known state for whenever it's re-enabled, rather
    // than silently resetting it.
    if (this.settings.syncPlugins) {
      this.lastKnownPluginPaths = buildPluginSnapshot(rawPluginPaths, Date.now());
      await this.updateLastKnownPluginPaths?.(this.lastKnownPluginPaths);
    }

    return {
      uploaded: uploadCount,
      downloaded: downloadCount,
      deleted: deleteCount,
      failed: failedUploadPaths.length + failedDownloadPaths.length,
      updatedPluginIds: derivePluginIdsFromPaths(
        needDownloadList.map((f) => f.path),
        this.vault.configDir
      ),
    };
  }

  public async testConnection(): Promise<void> {
    await this.transport.ping();
  }

  // 2026-08 Obsidian core Sync WS fidelity follow-up (see
  // #11_websocket_동기화_프로토콜_설계.md's re-analysis) -- size/purge/usernames. No REST
  // equivalent exists for these (unlike history/restore above), so they go through the WS
  // transport directly rather than requestHttp().
  public async getVaultSize(): Promise<VaultSize> {
    return this.transport.size(this.vault.getName());
  }

  public async purgeVault(): Promise<PurgeResult> {
    return this.transport.purge(this.vault.getName());
  }

  public async getUsernames(): Promise<string[]> {
    return this.transport.getUsernames(this.vault.getName());
  }

  // fetch()-shaped wrapper around Obsidian's requestUrl -- required instead of fetch() for CORS-free
  // requests from a plugin, but its response shape (status/json/arrayBuffer already resolved,
  // throws by default) differs enough from fetch()'s Response that every call site below would
  // otherwise need rewriting. This adapter keeps them almost unchanged.
  private async httpFetch(
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string | ArrayBuffer }
  ): Promise<{
    ok: boolean;
    status: number;
    statusText: string;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
    json(): Promise<unknown>;
    arrayBuffer(): Promise<ArrayBuffer>;
  }> {
    const resp = await requestUrl({
      url,
      method: init?.method || "GET",
      headers: init?.headers,
      body: init?.body,
      throw: false,
    });
    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      statusText: "",
      headers: {
        get: (name: string) => resp.headers[name] ?? resp.headers[name.toLowerCase()] ?? null,
      },
      text: async () => resp.text,
      // RequestUrlResponse.json is typed `any` (parsed JSON is inherently arbitrary shape) --
      // explicit `unknown` keeps that from leaking past this wrapper's declared Promise<unknown>.
      json: async (): Promise<unknown> => resp.json as unknown,
      arrayBuffer: async () => resp.arrayBuffer,
    };
  }

  // Fetch the backup version history for a given file. 2026-08 WS history migration follow-up
  // (see #11_websocket_동기화_프로토콜_설계.md and llm-wiki/09-*.md) -- moved off REST
  // (requestHttp) onto the transport, since the server-side REST views this used to hit have
  // been removed in favor of the WS ops that already existed alongside them.
  public async getFileHistory(filePath: string): Promise<HistoryVersionEntry[]> {
    const vaultId = this.vault.getName();
    return this.transport.getHistory(vaultId, filePath);
  }

  // Download the binary content of a specific backup version ID.
  public async downloadHistoryVersion(filePath: string, historyId: number): Promise<ArrayBuffer> {
    const vaultId = this.vault.getName();
    const { data } = await this.transport.downloadHistoryVersion(vaultId, historyId);

    // History is stored server-side exactly as it was uploaded -- ciphertext when E2EE is on,
    // same as regular sync's UploadFiles/DownloadFiles. Every caller of this (version preview,
    // diff, copy) expects plaintext back, same as the regular download path already decrypts.
    if (this.settings.enableE2EE && this.settings.e2eePassword) {
      const key = await this.getE2eeKey();
      return this.decryptData(data, key);
    }
    return data;
  }

  // Download a specific backup version's data, restore it to the original path, and also ask the
  // server to record the restore so both sides stay in sync.
  public async restoreHistoryVersion(historyId: number, targetPath?: string): Promise<string> {
    const vaultId = this.vault.getName();

    // 1. Tell the server to restore (updates its own vault copy + DB metadata + records the
    // restore in history -- and now fires a change_notifier push, unlike the old REST view).
    await this.transport.restoreHistoryVersion(vaultId, historyId, targetPath || "");

    // 2. Fetch the version's actual bytes ourselves too, for an immediate local write rather
    // than waiting on that push round trip -- `path` is the server-resolved path (mirrors the
    // old REST download response's X-File-Path header) for when no targetPath was given.
    const { data, path: resolvedPath } = await this.transport.downloadHistoryVersion(vaultId, historyId, targetPath || "");
    const currentPath = targetPath || resolvedPath;
    if (!currentPath) {
      throw new Error("Failed to determine restore file path from server response.");
    }

    let arrayBuffer = data;
    // Same as downloadHistoryVersion: the backup is stored as ciphertext when E2EE is on, and
    // has to be decrypted before it's written back into the vault -- otherwise "restore" replaces
    // the note's actual content with raw ciphertext.
    if (this.settings.enableE2EE && this.settings.e2eePassword) {
      const key = await this.getE2eeKey();
      arrayBuffer = await this.decryptData(arrayBuffer, key);
    }

    // Write the restored data to the local filesystem
    await this.ensureFolderForPath(currentPath);

    // No explicit mtime here: a plain write already sets it to "now", which is what we want.
    await writeBinaryByPath(this.vault, currentPath, arrayBuffer);

    return currentPath;
  }

  private async computeHash(data: ArrayBuffer): Promise<string> {
    const hashBuffer = await crypto.subtle.digest("SHA-256", new Uint8Array(data));
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
  }

  public getPublishHost(): string {
    const protocol = this.settings.useTls ? "https" : "http";
    return `${protocol}://${this.settings.serverHost}:${this.settings.serverPort}`;
  }

  // The {username} in the publish site URL (/publish/{username}/{vault}/...) has to be the username
  // the server actually recognizes for this token, not the userName setting (a free-text display
  // label) — if the two differ, the upload still succeeds (saved under the server-recognized name's
  // directory) but a link built from the display name points at the wrong (empty) directory. With
  // the master admin token, this resolves to the ADMIN_USER env var (or "admin" if unset).
  public async getAuthenticatedUsername(): Promise<string | null> {
    const url = `${this.getPublishHost()}/api/token/info`;
    // This is only used to build a display link (the site URL's username segment) — a nice-to-have,
    // not required for the modal to function (callers already fall back to the local settings-based
    // guess on any failure). Without a timeout, a slow or unreachable network stalls the whole
    // Publish modal for as long as the platform's own connection timeout (which can be tens of
    // seconds), even though nothing else here depends on this call succeeding. requestUrl has no
    // AbortSignal support, so this races it against a timeout instead of truly cancelling it --
    // enough to stop it from blocking the caller, even if the underlying request lingers.
    const timeoutPromise = new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 3000));
    try {
      const response = await Promise.race([this.httpFetch(url, { headers: { "obs-token": this.token } }), timeoutPromise]);
      if (!response || !response.ok) return null;
      const info = (await response.json()) as { username: string | null };
      return info.username;
    } catch {
      return null;
    }
  }

  /** Returns the hash it computed for the upload, so callers can seed a local hash cache with it
   *  for free — it's already unavoidable work, computed regardless of any caching layer. */
  public async publishFile(filePath: string, permalink?: string | null): Promise<string> {
    const siteId = this.vault.getName();
    const data = await readBinaryByPath(this.vault, filePath);
    // Same per-file upload size limit as core Publish (reverse-engineered from obsidian.asar:
    // 52428800 = rejected with a "TOOLARGE" error above 50MB).
    if (data.byteLength > 50 * 1024 * 1024) {
      throw new Error(t("plugins.publish.error-file-too-large", "File exceeds the 50MB limit: {{path}}", { path: filePath }));
    }
    const hash = await this.computeHash(data);

    const url = `${this.getPublishHost()}/api/upload`;
    const response = await this.httpFetch(url, {
      method: "POST",
      headers: {
        "obs-token": this.token,
        "obs-id": siteId,
        "obs-path": encodeURIComponent(filePath),
        "obs-hash": hash,
        ...(permalink ? { "obs-permalink": encodeURIComponent(permalink) } : {}),
      },
      body: data,
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Publish failed: ${response.status} ${response.statusText}\n${errText}`);
    }
    return hash;
  }

  public async unpublishFile(filePath: string): Promise<void> {
    const siteId = this.vault.getName();
    const url = `${this.getPublishHost()}/api/remove`;
    const response = await this.httpFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: filePath, id: siteId, token: this.token }),
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Unpublish failed: ${response.status} ${response.statusText}\n${errText}`);
    }
  }

  public async getPublishedFiles(): Promise<string[]> {
    const vaultId = this.vault.getName();
    const protocol = this.settings.useTls ? "https" : "http";
    const url = `${protocol}://${this.settings.serverHost}:${this.settings.serverPort}/api/list`;
    const response = await this.httpFetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${this.token}`,
        "obs-id": vaultId,
      },
    });
    if (!response.ok) return [];
    const res = (await response.json()) as { files?: { path: string }[] };
    return (res.files || []).map((f) => f.path);
  }

  /** Returns the full /api/list response (path + hash included). Used by PublishModal. */
  public async listFiles(): Promise<Array<{ path: string; hash: string }>> {
    const vaultId = this.vault.getName();
    const protocol = this.settings.useTls ? "https" : "http";
    const url = `${protocol}://${this.settings.serverHost}:${this.settings.serverPort}/api/list`;
    const response = await this.httpFetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${this.token}`,
        "obs-id": vaultId,
      },
    });
    if (!response.ok) return [];
    const res = (await response.json()) as { files?: { path: string; hash: string }[] };
    return res.files || [];
  }

  // apiPostBackend convention: body automatically includes {id, token}
  private async postToBackend<T = unknown>(endpoint: string, body: object): Promise<T> {
    const siteId = this.vault.getName();
    const url = `${this.getPublishHost()}/${endpoint}`;
    const response = await this.httpFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: siteId, token: this.token, ...body }),
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`${endpoint} failed: ${response.status}\n${errText}`);
    }
    return (await response.json()) as T;
  }

  // apiPostFrontend convention: body automatically includes {token}
  private async postToFrontend<T = unknown>(endpoint: string, body: object): Promise<T> {
    const url = `${this.getPublishHost()}/${endpoint}`;
    const response = await this.httpFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: this.token, ...body }),
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`${endpoint} failed: ${response.status}\n${errText}`);
    }
    return (await response.json()) as T;
  }

  // Download: POST /api/download with {id, token, path} → binary
  public async downloadPublishedFile(filePath: string): Promise<ArrayBuffer> {
    const siteId = this.vault.getName();
    const url = `${this.getPublishHost()}/api/download`;
    const response = await this.httpFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: siteId, token: this.token, path: filePath }),
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`download failed: ${response.status}\n${errText}`);
    }
    return response.arrayBuffer();
  }

  // Password: GET
  public async getPasswords(): Promise<{ name: string }[]> {
    const res = await this.postToBackend<{ pass?: { name: string }[] }>("api/password", {});
    return res.pass || [];
  }

  // Password: ADD
  public async addPassword(name: string, pw: string): Promise<void> {
    await this.postToBackend("api/password", { name, pw });
  }

  // Password: DEL
  public async deletePassword(name: string): Promise<void> {
    await this.postToBackend("api/password", { del: name });
  }

  // Slug: GET slugs map
  public async getSlugs(): Promise<Record<string, string>> {
    const vaultName = this.vault.getName();
    const res = await this.postToFrontend<Record<string, string>>("api/slugs", { ids: [vaultName] });
    return res;
  }

  // Slug: SET slug
  public async setSlug(slug: string): Promise<void> {
    const vaultName = this.vault.getName();
    const host = `${this.settings.serverHost}:${this.settings.serverPort}`;
    await this.postToFrontend("api/slug", { id: vaultName, host, slug });
  }

  // Slug: CHECK slug
  public async checkSlug(slug: string): Promise<{ id: string; slug: string; host: string }> {
    return this.postToFrontend<{ id: string; slug: string; host: string }>("api/site", { slug });
  }

  // Share: LIST
  public async getShares(): Promise<{ uid: string; email: string; name: string; accepted: boolean }[]> {
    const vaultName = this.vault.getName();
    const url = `${this.getPublishHost()}/publish/share/list`;
    const response = await this.httpFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: this.token, site_uid: vaultName }),
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`share/list failed: ${response.status}\n${errText}`);
    }
    const res = (await response.json()) as { shares?: { uid: string; email: string; name: string; accepted: boolean }[] };
    return res.shares || [];
  }

  // Share: INVITE
  public async inviteShare(email: string): Promise<void> {
    const vaultName = this.vault.getName();
    const url = `${this.getPublishHost()}/publish/share/invite`;
    const response = await this.httpFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: this.token, site_uid: vaultName, email }),
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`share/invite failed: ${response.status}\n${errText}`);
    }
  }

  // Share: REMOVE
  public async removeShare(shareUid: string): Promise<void> {
    const vaultName = this.vault.getName();
    const url = `${this.getPublishHost()}/publish/share/remove`;
    const response = await this.httpFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: this.token, site_uid: vaultName, share_uid: shareUid }),
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`share/remove failed: ${response.status}\n${errText}`);
    }
  }

  // Share: ACCEPT
  public async acceptShare(code: string): Promise<void> {
    const url = `${this.getPublishHost()}/publish/share/accept`;
    const response = await this.httpFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: this.token, code }),
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`share/accept failed: ${response.status}\n${errText}`);
    }
  }

  // ─── Vault sync sharing (see 14_vault_sharing_설계.md) ────────────────────────────────────
  // Distinct from Share: LIST/INVITE/REMOVE/ACCEPT above, which grant access to a *published
  // site*, not to the vault's own sync data. Owner-only (invite/list/remove) vs.
  // self-acting (leave/sharedWithMe) mirrors web.py's VaultContext-scoped vs. plain-authenticated
  // route split.

  public async inviteVaultShare(email: string): Promise<void> {
    const url = `${this.getPublishHost()}/api/vault/share/invite`;
    const response = await this.httpFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: this.token, vault_id: this.vault.getName(), email }),
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`vault/share/invite failed: ${response.status}\n${errText}`);
    }
  }

  public async listVaultShares(): Promise<{ uid: string; email: string; accepted: boolean; createdAtMs: number }[]> {
    const url = `${this.getPublishHost()}/api/vault/share/list`;
    const response = await this.httpFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: this.token, vault_id: this.vault.getName() }),
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`vault/share/list failed: ${response.status}\n${errText}`);
    }
    const res = (await response.json()) as { shares?: { uid: string; email: string; accepted: boolean; createdAtMs: number }[] };
    return res.shares || [];
  }

  public async removeVaultShare(shareUid: string): Promise<void> {
    const url = `${this.getPublishHost()}/api/vault/share/remove`;
    const response = await this.httpFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: this.token, vault_id: this.vault.getName(), share_uid: shareUid }),
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`vault/share/remove failed: ${response.status}\n${errText}`);
    }
  }

  // The caller here (not the vault's owner -- this is what makes it different from
  // removeVaultShare above) is leaving a vault shared TO them, identified by the owner's own
  // account name plus this local folder's name (still the vault_id convention, see
  // settings.ts's sharedVaultOwner).
  public async leaveSharedVault(ownerUsername: string): Promise<void> {
    const url = `${this.getPublishHost()}/api/vault/share/leave`;
    const response = await this.httpFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: this.token, ownerUsername, vaultId: this.vault.getName() }),
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`vault/share/leave failed: ${response.status}\n${errText}`);
    }
  }

  public async listSharedWithMe(): Promise<{ ownerUsername: string; vaultId: string; accepted: boolean; createdAtMs: number }[]> {
    const url = `${this.getPublishHost()}/api/vault/shared-with-me`;
    const response = await this.httpFetch(url, {
      method: "GET",
      headers: { "Authorization": `Bearer ${this.token}` },
    });
    if (!response.ok) return [];
    const res = (await response.json()) as { vaults?: { ownerUsername: string; vaultId: string; accepted: boolean; createdAtMs: number }[] };
    return res.vaults || [];
  }
}
