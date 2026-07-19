import { SyncServiceClient } from "./generated/SyncServiceClientPb";
import * as pb from "./generated/sync_pb";
import * as grpcWeb from "grpc-web";
import { TFile, Vault, FileManager, Notice, requestUrl } from "obsidian";
import { ContentHashCache } from "./contentHashCache";
import { mapWithConcurrency, streamWithConcurrency } from "./concurrency";
import type { SyncPluginSettings } from "./settings";
import { t } from "./i18n";

// e2eePassword isn't part of SyncPluginSettings itself (it lives in app.secretStorage, see
// tokenStore.ts) -- callers splice it in when constructing a SyncClient, so this is the actual
// runtime shape of the settings object this class works with.
type ClientSettings = SyncPluginSettings & { e2eePassword: string };

// Reported by internalSync() so callers (main.ts's syncNow()) can show progress instead of just a
// start/end Notice -- "done" counts items processed within the current phase, not overall.
export type SyncProgressPhase = "scan" | "upload" | "download";
export type SyncProgressCallback = (info: { phase: SyncProgressPhase; done: number; total: number }) => void;

// Reported by sync() on each retry after a failed internalSync() attempt, so callers can fold the
// retry status into their own UI (e.g. main.ts's syncNow() updates its progress Notice in place)
// instead of a separate hardcoded Notice popping up on top of it.
export type SyncRetryCallback = (info: { delayMs: number; retriesLeft: number }) => void;

// Shape of a single /api/history entry, as returned by the server. Structurally compatible with
// syncHistoryModal.ts's own HistoryVersion (kept separate there since that's a UI-facing type).
export interface HistoryVersionEntry {
  history_id: number;
  modified_at_ms: number;
  size_bytes: number;
  content_hash: string;
  device_name: string;
  user_name: string;
  deleted?: boolean;
  related_path?: string | null;
}

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

// Uint8Array concatenation utility
const concatUint8Arrays = (arrays: Uint8Array[]): Uint8Array => {
  let totalLength = arrays.reduce((acc, val) => acc + val.length, 0);
  let result = new Uint8Array(totalLength);
  let offset = 0;
  for (let arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
};

function getMetadata(token: string, settings: ClientSettings): grpcWeb.Metadata {
  return {
    "authorization": `Bearer ${token}`,
    "x-device-name": encodeURIComponent(settings.deviceName || "Unknown Device"),
    "x-user-name": encodeURIComponent(settings.userName || "Unknown User")
  };
}

// ─── Streaming upload (#4_옵션B_구현_계획.md 설계 B) ─────────────────────────────────
//
// Envelope wire format matches pumice-server's EnvelopeStreamParser (streaming.py) exactly:
// 1 byte flags (bit 0x80 = trailer, no payload) + 4 bytes big-endian payload length + payload.
// Sent as raw bytes (not base64) -- confirmed against the server, which does not base64-decode
// this endpoint's body the way the gRPC-Web-text resource does for UploadFiles.

export function encodeEnvelopeFrame(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + payload.length);
  new DataView(frame.buffer).setUint32(1, payload.length, false);
  frame.set(payload, 5);
  return frame;
}

// Incrementally parses enveloped frames out of a fetch() response body stream, calling onFrame
// once per complete frame as soon as its bytes have all arrived -- mirrors the incremental
// parsing EnvelopeStreamParser does server-side, just for the response direction instead of the
// request direction. Doesn't assume a stream chunk boundary lines up with a frame boundary.
export async function readEnvelopedResponses(
  body: ReadableStream<Uint8Array>,
  onFrame: (flags: number, payload: Uint8Array) => void
): Promise<void> {
  const reader = body.getReader();
  let buffer = new Uint8Array(0);

  while (true) {
    const { done, value } = await reader.read();
    if (value && value.length > 0) {
      const merged = new Uint8Array(buffer.length + value.length);
      merged.set(buffer, 0);
      merged.set(value, buffer.length);
      buffer = merged;
    }

    while (buffer.length >= 5) {
      const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      const flags = view.getUint8(0);
      const length = view.getUint32(1, false);
      const frameEnd = 5 + length;
      if (buffer.length < frameEnd) break; // wait for more bytes
      onFrame(flags, buffer.slice(5, frameEnd));
      buffer = buffer.slice(frameEnd);
    }

    if (done) break;
  }
}

// fetch()'s streaming request bodies (ReadableStream + duplex: 'half') require HTTP/2 + HTTPS --
// Chrome docs: "The fetch will be rejected if the connection is HTTP/1.x." pumice-server itself
// only ever speaks plain HTTP/1.1 (see #4_옵션B_구현_계획.md); TLS+HTTP/2 has to come from a
// reverse proxy in front of it. If the user hasn't configured TLS, the actual connection can't be
// HTTP/2 regardless of what the browser API itself supports, so skip straight to the
// non-streaming fallback instead of attempting (and always failing) the duplex feature-detection.
export function supportsStreamingUpload(settings: ClientSettings): boolean {
  if (!settings.useTls) return false;

  // Standard feature-detection pattern from Chrome's documentation: construct a Request with a
  // stream body and check whether `duplex` is actually read (vs. silently ignored, which is what
  // happens in browsers that don't support streaming request bodies at all).
  let duplexAccessed = false;
  new Request("https://example.com", {
    method: "POST",
    body: new ReadableStream(),
    // @ts-ignore -- duplex is not yet in the TS lib.dom fetch types
    get duplex() {
      duplexAccessed = true;
      return "half";
    },
  });
  return duplexAccessed;
}

// Splits needUploadList into batches bounded by both byte size and file count -- byte size alone
// isn't enough of a cap: a real vault is dominated by many small notes, so a byte-only cap lets one
// batch swallow nearly the whole file list before it fills up (confirmed against realistic-size
// synthetic data in #4_구현_계획.md -- a byte-only version put 95%+ of files in a single batch).
// A file larger than targetBytes on its own still gets its own batch rather than being skipped.
function groupIntoBatches(
  paths: string[],
  sizeOf: (path: string) => number,
  targetBytes: number,
  maxFiles: number
): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let currentBytes = 0;
  for (const path of paths) {
    const size = sizeOf(path);
    if (current.length > 0 && (currentBytes + size > targetBytes || current.length >= maxFiles)) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(path);
    currentBytes += size;
    if (currentBytes > targetBytes || current.length >= maxFiles) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export class SyncClient {
  private client: SyncServiceClient;
  private vault: Vault;
  private fileManager: FileManager;
  private pluginDir: string;
  private token: string;
  private settings: ClientSettings;
  private deletedFiles: Record<string, number>;
  private updateDeletedFiles: (deleted: Record<string, number>) => Promise<void>;
  private hashCache?: ContentHashCache;
  private onProgress?: SyncProgressCallback;
  private onRetry?: SyncRetryCallback;
  private lastProgressReportAt = 0;
  private e2eeKeyCache: CryptoKey | null = null;

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
    vault: Vault,
    fileManager: FileManager,
    pluginDir: string,
    token: string,
    settings: ClientSettings,
    deletedFiles: Record<string, number>,
    updateDeletedFiles: (deleted: Record<string, number>) => Promise<void>,
    hashCache?: ContentHashCache,
    onProgress?: SyncProgressCallback,
    onRetry?: SyncRetryCallback
  ) {
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

    const protocol = settings.useTls ? "https" : "http";
    const hostUrl = `${protocol}://${settings.serverHost}:${settings.serverPort}`;
    this.client = new SyncServiceClient(hostUrl);
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

  public async sync(): Promise<{ uploaded: number; downloaded: number; deleted: number }> {
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
  private async buildFileChunks(
    uploadPath: string,
    vaultId: string,
    scannedWireBuffers: Map<string, { buffer: ArrayBuffer; hash: string; mtime: number }>
  ): Promise<pb.FileChunk[]> {
    try {
      // Reuse the buffer read (and, under E2EE, encrypted) during the scan step above when
      // available -- this is what avoids reading/re-encrypting every file a second time here,
      // which is otherwise unavoidable on the very first sync since need_upload == every file.
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
        if (!exists) return [];

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

      const fileChunks: pb.FileChunk[] = [];

      // Header chunk
      const headerChunk = new pb.FileChunk();
      const header = new pb.ChunkHeader();
      header.setVaultId(vaultId);
      header.setPath(uploadPath);
      header.setTotalBytes(sendBuffer.byteLength);
      header.setModifiedAtMs(mtime);
      headerChunk.setHeader(header);
      fileChunks.push(headerChunk);

      // Data chunks
      const CHUNK_SIZE = 256 * 1024;
      let sequence = 0;
      for (let offset = 0; offset < sendBuffer.byteLength; offset += CHUNK_SIZE) {
        const chunk = sendBuffer.slice(offset, offset + CHUNK_SIZE);
        const dataChunk = new pb.FileChunk();
        const dataPayload = new pb.ChunkData();
        dataPayload.setPath(uploadPath);
        dataPayload.setSequence(sequence++);
        dataPayload.setData(new Uint8Array(chunk));
        dataChunk.setData(dataPayload);
        fileChunks.push(dataChunk);
      }

      // EOF chunk
      const eofChunk = new pb.FileChunk();
      const eof = new pb.ChunkEOF();
      eof.setPath(uploadPath);
      eof.setContentHash(contentHash);
      eofChunk.setEof(eof);
      fileChunks.push(eofChunk);

      return fileChunks;
    } catch (err) {
      console.error(`Error preparation ${uploadPath} for upload:`, err);
      return [];
    }
  }

  // True client-streaming upload (#4_옵션B_구현_계획.md 설계 B): one open connection, no "batch"
  // concept at all -- chunks are enqueued onto the request body as each file finishes being
  // prepared (overlapped up to UPLOAD_PREP_CONCURRENCY at a time via streamWithConcurrency), and
  // the server (pumice-server's StreamingUploadRequest/EnvelopeStreamParser) parses and writes
  // them to disk incrementally as they arrive rather than after the whole request is buffered.
  //
  // Files must be streamed in order, one fully completed (header, all data, eof) before the next
  // file's header starts -- the server tracks only one "current file" per connection and discards
  // an unfinished one if a new header arrives (mirrors the batched path's per-file ordering,
  // which was always implicit there since each file's triplet was already contiguous within one
  // serialized UploadBatch message). streamWithConcurrency's in-order yield guarantee is what
  // keeps overlapped preparation from accidentally interleaving two files' chunks on the wire.
  private async uploadFilesStreaming(
    needUploadList: string[],
    vaultId: string,
    scannedWireBuffers: Map<string, { buffer: ArrayBuffer; hash: string; mtime: number }>,
    onAck: (ack: pb.UploadAck) => void
  ): Promise<void> {
    const UPLOAD_PREP_CONCURRENCY = 8;

    const bodyStream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        try {
          for await (const fileChunks of streamWithConcurrency(
            needUploadList,
            UPLOAD_PREP_CONCURRENCY,
            (uploadPath) => this.buildFileChunks(uploadPath, vaultId, scannedWireBuffers)
          )) {
            for (const chunk of fileChunks) {
              controller.enqueue(encodeEnvelopeFrame(chunk.serializeBinary()));
            }
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      },
    });

    const protocol = this.settings.useTls ? "https" : "http";
    const url = `${protocol}://${this.settings.serverHost}:${this.settings.serverPort}/obsidian.sync.v1.SyncService/UploadFilesStream`;

    // requestUrl() (httpFetch() above) can't do this: its body is `string | ArrayBuffer`, with no
    // ReadableStream/duplex option -- the entire point of this method is streaming a request body
    // that's produced incrementally, which requestUrl has no way to express. Raw fetch() is the only
    // API that supports it, and it's exactly what supportsStreamingUpload() gates this call on.
    const resp = await fetch(url, {
      method: "POST",
      // @ts-ignore -- duplex is not yet in the TS lib.dom fetch types
      duplex: "half",
      headers: {
        "authorization": `Bearer ${this.token}`,
        "x-device-name": encodeURIComponent(this.settings.deviceName || "Unknown Device"),
        "x-user-name": encodeURIComponent(this.settings.userName || "Unknown User"),
      },
      body: bodyStream,
    });

    if (!resp.ok || !resp.body) {
      throw new Error(`Streaming upload request failed: HTTP ${resp.status}`);
    }

    await readEnvelopedResponses(resp.body, (flags, payload) => {
      if (flags & 0x80) return; // trailer frame -- marks end of the ack stream, no payload
      onAck(pb.UploadAck.deserializeBinary(payload));
    });
  }

  private async internalSync(): Promise<{ uploaded: number; downloaded: number; deleted: number }> {
    const metadata = getMetadata(this.token, this.settings);
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
          });
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
        });
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
    const deltaReq = new pb.DeltaRequest();
    deltaReq.setVaultId(vaultId);

    const localFilesList: pb.FileMeta[] = [];
    for (const f of localFilesMeta) {
      const meta = new pb.FileMeta();
      meta.setPath(f.path);
      meta.setModifiedAtMs(f.modified_at_ms);
      meta.setSizeBytes(f.size_bytes);
      meta.setContentHash(f.content_hash);
      meta.setIsDeleted(f.is_deleted);
      localFilesList.push(meta);
    }
    deltaReq.setLocalFilesList(localFilesList);

    const deltaRes = await this.client.delta(deltaReq, metadata);

    let uploadCount = 0;
    let downloadCount = 0;
    let deleteCount = 0;

    const needUploadList = deltaRes.getNeedUploadList();
    const needDownloadList = deltaRes.getNeedDownloadList();

    // 3-1. Reconcile locally-deleted files against the server response and clean up local state
    const sentDeletions = Object.keys(this.deletedFiles);
    const downloadPaths = new Set(needDownloadList.map((f) => f.getPath()));
    for (const delPath of sentDeletions) {
      if (!downloadPaths.has(delPath)) {
        delete this.deletedFiles[delPath];
        deleteCount++;
      }
    }

    // 3-2. Apply server-side deletions locally (downloading tombstones)
    const filesToDelete = needDownloadList.filter((f) => f.getIsDeleted());
    for (const fileMeta of filesToDelete) {
      const metaPath = fileMeta.getPath();
      try {
        const file = this.vault.getAbstractFileByPath(metaPath);
        if (file) {
          await this.fileManager.trashFile(file);
          deleteCount++;
        } else if (await this.vault.adapter.exists(metaPath)) {
          // A file outside the vault index (.obsidian/* etc.) — deleting directly via the Adapter
          // is the only option.
          await this.vault.adapter.remove(metaPath);
          deleteCount++;
        }
      } catch (e: unknown) {
        console.error(`Failed to delete local file ${metaPath}:`, e);
      }
      if (this.deletedFiles[metaPath]) {
        delete this.deletedFiles[metaPath];
      }
    }

    // 4. UploadFiles -- true client-streaming (#4_옵션B_구현_계획.md 설계 B) when the browser and
    // configured connection support it, falling back to batched gRPC-Web unary requests (#4 옵션
    // A) otherwise. Both paths report acks through the same callback/progress logic.
    let uploadAcksProcessed = 0;
    const onUploadAck = (ack: pb.UploadAck): void => {
      const ackPath = ack.getPath();
      if (ack.getOk()) {
        uploadCount++;
        if (this.deletedFiles[ackPath]) {
          delete this.deletedFiles[ackPath];
        }
      } else {
        console.error(`Upload failed for ${ackPath}: ${ack.getError()}`);
      }
      this.reportProgress("upload", ++uploadAcksProcessed, needUploadList.length);
    };

    if (supportsStreamingUpload(this.settings)) {
      await this.uploadFilesStreaming(needUploadList, vaultId, scannedWireBuffers, onUploadAck);
    } else {
      // Split into multiple batches bounded by byte size and file count. A single UploadBatch
      // covering the whole first-sync upload set would otherwise have to sit fully serialized in
      // memory before the first byte goes out; per the benchmark in #4_구현_계획.md (real
      // generated protobuf classes, ~1.1GB synthetic upload), batching this cut peak RSS by ~17x
      // and was *faster* to prepare/serialize too, not slower -- avoiding the reallocation cost
      // of building one huge array/message. MAX_FILES_PER_BATCH exists because byte size alone
      // isn't enough of a cap: a real vault is dominated by many small notes, so a byte-only cap
      // let one batch swallow 95%+ of the file list in that same benchmark.
      const BATCH_TARGET_BYTES = 20 * 1024 * 1024;
      const MAX_FILES_PER_BATCH = 500;
      const sizeByPath = new Map(localFilesMeta.map((f) => [f.path, f.size_bytes]));
      const uploadBatches = groupIntoBatches(needUploadList, (p) => sizeByPath.get(p) ?? 0, BATCH_TARGET_BYTES, MAX_FILES_PER_BATCH);

      for (const batchPaths of uploadBatches) {
        const uploadBatch = new pb.UploadBatch();

        // Same fix as the scan step above and for the same reason: reading/hashing each file to
        // upload one at a time is an O(files) chain of Capacitor-bridge round trips. This
        // overlaps them instead. mapWithConcurrency preserves per-item result order, so
        // flattening perFileChunks reproduces exactly the same overall chunk sequence the old
        // sequential loop would have -- each file's own [header, data..., eof] triplet stays
        // intact and in order, only which files finish preparing in what wall-clock order changes.
        const UPLOAD_PREP_CONCURRENCY = 8;
        const perFileChunks = await mapWithConcurrency(batchPaths, UPLOAD_PREP_CONCURRENCY, (uploadPath) =>
          this.buildFileChunks(uploadPath, vaultId, scannedWireBuffers)
        );

        uploadBatch.setChunksList(perFileChunks.flat());

        // Handle the server's streaming response for this one batch before preparing the next --
        // deliberately sequential (no pipelining of batch N+1's prep against batch N's send/ack
        // wait) for this first version; see #4_구현_계획.md "향후 개선" for why that tradeoff was
        // deferred rather than built without measuring it first.
        await new Promise<void>((resolve, reject) => {
          const uploadStream = this.client.uploadFiles(uploadBatch, metadata);
          uploadStream.on("data", onUploadAck);
          uploadStream.on("end", () => resolve());
          uploadStream.on("error", (err) => reject(err instanceof Error ? err : new Error(String(err))));
        });
      }
    }

    // 5. DownloadFiles (gRPC-Web batch request)
    const filesToDownload = needDownloadList.filter((f) => !f.getIsDeleted());
    if (filesToDownload.length > 0) {
      const downloadReq = new pb.DownloadBatchRequest();
      downloadReq.setVaultId(vaultId);
      downloadReq.setPathsList(filesToDownload.map((f) => f.getPath()));

      let downloadsProcessed = 0;
      await new Promise<void>((resolve, reject) => {
        const downloadStream = this.client.downloadFiles(downloadReq, metadata);
        const fileBuffers = new Map<string, { mtime: number; chunks: Uint8Array[] }>();

        // Wrapped so the listener itself stays synchronous (as EventEmitter#on expects) while the
        // async body inside is still fully error-guarded -- an unguarded throw in here (e.g. the
        // sha256 call below) would otherwise become an unhandled promise rejection instead of the
        // same "log and move on to the next file" handling every other failure path here gets.
        downloadStream.on("data", (chunk: pb.FileChunk) => {
          void (async () => {
          try {
          if (chunk.hasHeader()) {
            const header = chunk.getHeader()!;
            fileBuffers.set(header.getPath(), {
              mtime: Number(header.getModifiedAtMs()),
              chunks: [],
            });
          } else if (chunk.hasData()) {
            const dataPayload = chunk.getData()!;
            const buf = fileBuffers.get(dataPayload.getPath());
            if (buf) {
              buf.chunks.push(dataPayload.getData_asU8());
            }
          } else if (chunk.hasEof()) {
            const eofPayload = chunk.getEof()!;
            const eofPath = eofPayload.getPath();
            const buf = fileBuffers.get(eofPath);
            if (!buf) return;

            const fileDataBytes = concatUint8Arrays(buf.chunks);
            fileBuffers.delete(eofPath);
            this.reportProgress("download", ++downloadsProcessed, filesToDownload.length);

            const calculatedHash = await sha256(fileDataBytes.buffer as ArrayBuffer);
            if (calculatedHash !== eofPayload.getContentHash()) {
              console.error(`Hash verification failed for downloaded file: ${eofPath}`);
              return;
            }

            try {
              const currentPath = eofPath;
              const currentMtime = buf.mtime;

              const dir = pathUtil.dirname(currentPath);
              await ensureFolder(this.vault, dir);

              const exists = await existsByPath(this.vault, currentPath);
              if (exists) {
                if (this.settings.conflictResolution === "client-wins") {
                  return;
                }
                if (this.settings.conflictResolution === "manual") {
                  try {
                    const oldData = await readBinaryByPath(this.vault, currentPath);
                    const ext = pathUtil.extname(currentPath);
                    const baseName = currentPath.substring(0, currentPath.length - ext.length);
                    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
                    const conflictPath = `${baseName}.sync-conflict-${timestamp}${ext}`;
                    await writeBinaryByPath(this.vault, conflictPath, oldData);
                    new Notice(t("plugins.sync.msg-conflict-backup-created", "Conflict backup created: {{filename}}", { filename: pathUtil.basename(conflictPath) }));
                  } catch (backupErr) {
                    console.error(`Failed to create conflict backup for ${currentPath}:`, backupErr);
                  }
                }
              }

              let plainData: ArrayBuffer = fileDataBytes.buffer as ArrayBuffer;
              // calculatedHash is the hash of the wire bytes (ciphertext when E2EE is on) — reused
              // as-is for the cache when E2EE is off, since it's then already the plaintext hash
              // Publish needs; recomputed from the decrypted bytes otherwise (cheap: no extra I/O,
              // the buffer's already in memory).
              let plainHashForCache = calculatedHash;
              if (this.settings.enableE2EE && this.settings.e2eePassword) {
                const key = await this.getE2eeKey();
                plainData = await this.decryptData(fileDataBytes.buffer as ArrayBuffer, key);
                plainHashForCache = await sha256(plainData);
              }

              // mtime is set here, atomically, via Obsidian's own write options -- works the same
              // way on desktop and mobile, and TFile.stat reflects it immediately afterward.
              await writeBinaryByPath(this.vault, currentPath, plainData, currentMtime);

              // Seeds the same cache Publish's diff scan reads from, so a file that just arrived via
              // regular sync doesn't get re-read and re-hashed the next time Publish checks it.
              if (this.hashCache) {
                const written = this.vault.getAbstractFileByPath(currentPath);
                if (written instanceof TFile) this.hashCache.set(written, plainHashForCache);
              }

              downloadCount++;

              if (this.deletedFiles[currentPath]) {
                delete this.deletedFiles[currentPath];
              }
            } catch (e: unknown) {
              console.error(`Failed to save downloaded file ${eofPath}:`, e);
            }
          }
          } catch (e: unknown) {
            console.error("Failed to process downloaded chunk:", e);
          }
          })();
        });

        downloadStream.on("end", () => resolve());
        downloadStream.on("error", (err) => reject(err instanceof Error ? err : new Error(String(err))));
      });
    }

    // 6. Persist the updated deletion-history state
    await this.updateDeletedFiles(this.deletedFiles);

    return {
      uploaded: uploadCount,
      downloaded: downloadCount,
      deleted: deleteCount,
    };
  }

  public async testConnection(): Promise<void> {
    const metadata = getMetadata(this.token, this.settings);
    const request = new pb.Empty();
    await this.client.ping(request, metadata);
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

  // Helper for making HTTP REST API calls
  private async requestHttp<T = unknown>(method: string, apiPath: string, body?: unknown, isBinary?: false): Promise<T>;
  private async requestHttp(method: string, apiPath: string, body: unknown, isBinary: true): Promise<ArrayBuffer>;
  private async requestHttp(method: string, apiPath: string, body?: unknown, isBinary = false): Promise<unknown> {
    const protocol = this.settings.useTls ? "https" : "http";
    const url = `${protocol}://${this.settings.serverHost}:${this.settings.serverPort}${apiPath}`;

    const headers: Record<string, string> = {
      "Authorization": `Bearer ${this.token}`,
      "X-Device-Name": encodeURIComponent(this.settings.deviceName || "Unknown Device"),
      "X-User-Name": encodeURIComponent(this.settings.userName || "Unknown User")
    };

    const options: { method: string; headers: Record<string, string>; body?: string } = {
      method: method,
      headers: headers
    };

    if (body) {
      options.body = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
    }

    const response = await this.httpFetch(url, options);
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`HTTP Request failed: ${response.status} ${response.statusText}\n${errText}`);
    }

    if (isBinary) {
      return response.arrayBuffer();
    }

    return response.json();
  }

  // Fetch the backup version history for a given file (via the HTTP REST API)
  public async getFileHistory(filePath: string): Promise<HistoryVersionEntry[]> {
    const vaultId = this.vault.getName();
    const encodedPath = encodeURIComponent(filePath);
    const path = `/api/history?vault_id=${encodeURIComponent(vaultId)}&path=${encodedPath}`;

    const res = await this.requestHttp<{ versions?: HistoryVersionEntry[] }>("GET", path);
    return res.versions || [];
  }

  // Download the binary content of a specific backup version ID (via the HTTP REST API)
  public async downloadHistoryVersion(filePath: string, historyId: number): Promise<ArrayBuffer> {
    const vaultId = this.vault.getName();
    const path = `/api/history/download?vault_id=${encodeURIComponent(vaultId)}&history_id=${historyId}`;

    const arrayBuffer = await this.requestHttp("GET", path, null, true);

    // History is stored server-side exactly as it was uploaded -- ciphertext when E2EE is on,
    // same as regular sync's UploadFiles/DownloadFiles. Every caller of this (version preview,
    // diff, copy) expects plaintext back, same as the regular download path already decrypts.
    if (this.settings.enableE2EE && this.settings.e2eePassword) {
      const key = await this.getE2eeKey();
      return this.decryptData(arrayBuffer, key);
    }
    return arrayBuffer;
  }

  // Download a specific backup version's data, restore it to the original path, and also ask the
  // server to record the restore so both sides stay in sync (via the HTTP REST API)
  public async restoreHistoryVersion(historyId: number, targetPath?: string): Promise<string> {
    const vaultId = this.vault.getName();

    // 1. Send the restore request to the server (updates server-side DB metadata and immediately
    // records the restore in history)
    const restoreReqBody = {
      vault_id: vaultId,
      path: targetPath || "",
      history_id: historyId
    };
    await this.requestHttp("POST", "/api/history/restore", restoreReqBody);

    // 2. Receive the HTTP download response directly and extract the data
    const protocol = this.settings.useTls ? "https" : "http";
    const downloadUrl = `${protocol}://${this.settings.serverHost}:${this.settings.serverPort}/api/history/download?vault_id=${encodeURIComponent(vaultId)}&history_id=${historyId}`;

    const headers: Record<string, string> = {
      "Authorization": `Bearer ${this.token}`,
      "X-Device-Name": encodeURIComponent(this.settings.deviceName || "Unknown Device"),
      "X-User-Name": encodeURIComponent(this.settings.userName || "Unknown User")
    };

    const response = await this.httpFetch(downloadUrl, { method: "GET", headers });
    if (!response.ok) {
      throw new Error(`HTTP Download failed: ${response.status} ${response.statusText}`);
    }

    // Read the X-File-Path header to determine which path to restore to
    const currentPath = targetPath || decodeURIComponent(response.headers.get("X-File-Path") || "");
    if (!currentPath) {
      throw new Error("Failed to determine restore file path from server response header.");
    }

    let arrayBuffer = await response.arrayBuffer();

    // Same as downloadHistoryVersion: the backup is stored as ciphertext when E2EE is on, and
    // has to be decrypted before it's written back into the vault -- otherwise "restore" replaces
    // the note's actual content with raw ciphertext.
    if (this.settings.enableE2EE && this.settings.e2eePassword) {
      const key = await this.getE2eeKey();
      arrayBuffer = await this.decryptData(arrayBuffer, key);
    }

    // Write the restored data to the local filesystem
    const dir = pathUtil.dirname(currentPath);
    await ensureFolder(this.vault, dir);

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
  public async publishFile(filePath: string): Promise<string> {
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
}
