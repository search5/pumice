import { SyncServiceClient } from "./generated/SyncServiceClientPb";
import * as pb from "./generated/sync_pb";
import * as grpcWeb from "grpc-web";
import { TFile, Vault, Notice } from "obsidian";
import { ContentHashCache } from "./contentHashCache";

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

function getMetadata(token: string, settings: any): grpcWeb.Metadata {
  return {
    "authorization": `Bearer ${token}`,
    "x-device-name": encodeURIComponent(settings.deviceName || "Unknown Device"),
    "x-user-name": encodeURIComponent(settings.userName || "Unknown User")
  };
}

export class SyncClient {
  private client: SyncServiceClient;
  private vault: Vault;
  private pluginDir: string;
  private token: string;
  private settings: any;
  private deletedFiles: Record<string, number>;
  private updateDeletedFiles: (deleted: Record<string, number>) => Promise<void>;
  private hashCache?: ContentHashCache;
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

  private async getFileMetadataFromBuffer(arrayBuffer: ArrayBuffer): Promise<{ size: number; hash: string }> {
    if (this.settings.enableE2EE && this.settings.e2eePassword) {
      const key = await this.getE2eeKey();
      const encrypted = await this.encryptData(arrayBuffer, key);
      const hash = await sha256(encrypted);
      return { size: encrypted.byteLength, hash: hash };
    } else {
      const hash = await sha256(arrayBuffer);
      return { size: arrayBuffer.byteLength, hash: hash };
    }
  }

  constructor(
    vault: Vault,
    pluginDir: string,
    token: string,
    settings: any,
    deletedFiles: Record<string, number>,
    updateDeletedFiles: (deleted: Record<string, number>) => Promise<void>,
    hashCache?: ContentHashCache
  ) {
    this.vault = vault;
    this.pluginDir = pluginDir;
    this.token = token;
    this.settings = settings;
    this.deletedFiles = deletedFiles;
    this.updateDeletedFiles = updateDeletedFiles;
    this.hashCache = hashCache;

    const protocol = settings.useTls ? "https" : "http";
    const hostUrl = `${protocol}://${settings.serverHost}:${settings.serverPort}`;
    this.client = new SyncServiceClient(hostUrl);
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
    if (!this.settings.syncBookmarks && normalizedPath === ".obsidian/bookmarks.json") {
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
      } catch (e) {
        retries--;
        if (retries <= 0) {
          throw e;
        }
        console.warn(`Sync failed, retrying in ${delay}ms... (Remaining retries: ${retries})`, e);
        new Notice(`동기화 실패, ${delay}ms 후 재시도합니다... (남은 재시도: ${retries})`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
      }
    }
  }

  private async internalSync(): Promise<{ uploaded: number; downloaded: number; deleted: number }> {
    const metadata = getMetadata(this.token, this.settings);
    const vaultId = this.vault.getName();

    // 1. Scan local file metadata
    const allFiles = this.vault.getFiles();
    const localFilesMeta: any[] = [];
    const hashCacheEntries: Array<{ file: TFile; hash: string }> = [];

    for (const file of allFiles) {
      if (this.isIgnored(file.path)) {
        continue;
      }

      const arrayBuffer = await this.vault.readBinary(file);
      const { size, hash } = await this.getFileMetadataFromBuffer(arrayBuffer);
      localFilesMeta.push({
        path: file.path,
        modified_at_ms: file.stat.mtime,
        size_bytes: size,
        content_hash: hash,
        is_deleted: false,
      });

      // Seeds the same cache Publish's diff scan reads from — regular sync already reads and hashes
      // every file, so by the time Publish checks anything it's very likely already cached. `hash`
      // above is only the plaintext hash when E2EE is off; hash it again when E2EE is on (cheap, no
      // extra I/O — the plaintext bytes are already in memory). Collected and written in one batch
      // below rather than per file — a separate IndexedDB transaction per file noticeably slows this
      // loop down once there are hundreds/thousands of files.
      if (this.hashCache) {
        const plainHash = this.settings.enableE2EE && this.settings.e2eePassword
          ? await sha256(arrayBuffer)
          : hash;
        hashCacheEntries.push({ file, hash: plainHash });
      }
    }
    this.hashCache?.setMany(hashCacheEntries);

    // Explicitly include the bookmarks file in sync — .obsidian/bookmarks.json is a config file
    // outside the vault index, so it's never picked up as a TFile. The Vault API has no way to
    // reach it at all, so using the Adapter here is unavoidable.
    if (this.settings.syncBookmarks) {
      const bookmarkPath = ".obsidian/bookmarks.json";
      const exists = await this.vault.adapter.exists(bookmarkPath);
      if (exists) {
        try {
          const stat = await this.vault.adapter.stat(bookmarkPath);
          if (stat) {
            const arrayBuffer = await this.vault.adapter.readBinary(bookmarkPath);
            const { size, hash } = await this.getFileMetadataFromBuffer(arrayBuffer);
            localFilesMeta.push({
              path: bookmarkPath,
              modified_at_ms: stat.mtime,
              size_bytes: size,
              content_hash: hash,
              is_deleted: false,
            });
          }
        } catch (e) {
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
          await this.vault.delete(file);
          deleteCount++;
        } else if (await this.vault.adapter.exists(metaPath)) {
          // A file outside the vault index (.obsidian/* etc.) — deleting directly via the Adapter
          // is the only option.
          await this.vault.adapter.remove(metaPath);
          deleteCount++;
        }
      } catch (e) {
        console.error(`Failed to delete local file ${metaPath}:`, e);
      }
      if (this.deletedFiles[metaPath]) {
        delete this.deletedFiles[metaPath];
      }
    }

    // 4. UploadFiles (gRPC-Web batch request)
    if (needUploadList.length > 0) {
      const uploadBatch = new pb.UploadBatch();
      const chunksList: pb.FileChunk[] = [];

      for (const uploadPath of needUploadList) {
        try {
          const exists = await existsByPath(this.vault, uploadPath);
          if (!exists) continue;

          const arrayBuffer = await readBinaryByPath(this.vault, uploadPath);

          let sendBuffer: ArrayBuffer = arrayBuffer;
          let contentHash = "";

          if (this.settings.enableE2EE && this.settings.e2eePassword) {
            const key = await this.getE2eeKey();
            sendBuffer = await this.encryptData(arrayBuffer, key);
            contentHash = await sha256(sendBuffer);
          } else {
            contentHash = await sha256(arrayBuffer);
          }

          const stat = await statByPath(this.vault, uploadPath);
          const mtime = stat ? stat.mtime : Date.now();

          // Header chunk
          const headerChunk = new pb.FileChunk();
          const header = new pb.ChunkHeader();
          header.setVaultId(vaultId);
          header.setPath(uploadPath);
          header.setTotalBytes(sendBuffer.byteLength);
          header.setModifiedAtMs(mtime);
          headerChunk.setHeader(header);
          chunksList.push(headerChunk);

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
            chunksList.push(dataChunk);
          }

          // EOF chunk
          const eofChunk = new pb.FileChunk();
          const eof = new pb.ChunkEOF();
          eof.setPath(uploadPath);
          eof.setContentHash(contentHash);
          eofChunk.setEof(eof);
          chunksList.push(eofChunk);
        } catch (err) {
          console.error(`Error preparation ${uploadPath} for upload:`, err);
        }
      }

      uploadBatch.setChunksList(chunksList);

      // Handle the server's streaming response
      await new Promise<void>((resolve, reject) => {
        const uploadStream = this.client.uploadFiles(uploadBatch, metadata);

        uploadStream.on("data", (ack: pb.UploadAck) => {
          const ackPath = ack.getPath();
          if (ack.getOk()) {
            uploadCount++;
            if (this.deletedFiles[ackPath]) {
              delete this.deletedFiles[ackPath];
            }
          } else {
            console.error(`Upload failed for ${ackPath}: ${ack.getError()}`);
          }
        });

        uploadStream.on("end", () => resolve());
        uploadStream.on("error", (err) => reject(err));
      });
    }

    // 5. DownloadFiles (gRPC-Web batch request)
    const filesToDownload = needDownloadList.filter((f) => !f.getIsDeleted());
    if (filesToDownload.length > 0) {
      const downloadReq = new pb.DownloadBatchRequest();
      downloadReq.setVaultId(vaultId);
      downloadReq.setPathsList(filesToDownload.map((f) => f.getPath()));

      await new Promise<void>((resolve, reject) => {
        const downloadStream = this.client.downloadFiles(downloadReq, metadata);
        const fileBuffers = new Map<string, { mtime: number; chunks: Uint8Array[] }>();

        downloadStream.on("data", async (chunk: pb.FileChunk) => {
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
                    new Notice(`충돌 파일 백업 생성됨: ${pathUtil.basename(conflictPath)}`);
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
            } catch (e) {
              console.error(`Failed to save downloaded file ${eofPath}:`, e);
            }
          }
        });

        downloadStream.on("end", () => resolve());
        downloadStream.on("error", (err) => reject(err));
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

  // Helper for making HTTP REST API calls
  private async requestHttp(method: string, apiPath: string, body?: any, isBinary = false): Promise<any> {
    const protocol = this.settings.useTls ? "https" : "http";
    const url = `${protocol}://${this.settings.serverHost}:${this.settings.serverPort}${apiPath}`;

    const headers: Record<string, string> = {
      "Authorization": `Bearer ${this.token}`,
      "X-Device-Name": encodeURIComponent(this.settings.deviceName || "Unknown Device"),
      "X-User-Name": encodeURIComponent(this.settings.userName || "Unknown User")
    };

    const options: RequestInit = {
      method: method,
      headers: headers
    };

    if (body) {
      options.body = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(url, options);
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
  public async getFileHistory(filePath: string): Promise<any[]> {
    const vaultId = this.vault.getName();
    const encodedPath = encodeURIComponent(filePath);
    const path = `/api/history?vault_id=${encodeURIComponent(vaultId)}&path=${encodedPath}`;

    const res = await this.requestHttp("GET", path);
    return res.versions || [];
  }

  // Download the binary content of a specific backup version ID (via the HTTP REST API)
  public async downloadHistoryVersion(filePath: string, historyId: number): Promise<ArrayBuffer> {
    const vaultId = this.vault.getName();
    const path = `/api/history/download?vault_id=${encodeURIComponent(vaultId)}&history_id=${historyId}`;

    const arrayBuffer = await this.requestHttp("GET", path, null, true);
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

    const response = await fetch(downloadUrl, { method: "GET", headers });
    if (!response.ok) {
      throw new Error(`HTTP Download failed: ${response.status} ${response.statusText}`);
    }

    // Read the X-File-Path header to determine which path to restore to
    const currentPath = targetPath || decodeURIComponent(response.headers.get("X-File-Path") || "");
    if (!currentPath) {
      throw new Error("Failed to determine restore file path from server response header.");
    }

    const arrayBuffer = await response.arrayBuffer();

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
    // seconds), even though nothing else here depends on this call succeeding.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(url, { headers: { "obs-token": this.token }, signal: controller.signal });
      if (!response.ok) return null;
      const info = (await response.json()) as { username: string | null };
      return info.username;
    } finally {
      clearTimeout(timeout);
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
      throw new Error(`파일이 50MB 제한을 초과했습니다: ${filePath}`);
    }
    const hash = await this.computeHash(data);

    const url = `${this.getPublishHost()}/api/upload`;
    const response = await fetch(url, {
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
    const response = await fetch(url, {
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
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${this.token}`,
        "obs-id": vaultId,
      },
    });
    if (!response.ok) return [];
    const res = await response.json();
    return (res.files || []).map((f: any) => f.path as string);
  }

  /** Returns the full /api/list response (path + hash included). Used by PublishModal. */
  public async listFiles(): Promise<Array<{ path: string; hash: string }>> {
    const vaultId = this.vault.getName();
    const protocol = this.settings.useTls ? "https" : "http";
    const url = `${protocol}://${this.settings.serverHost}:${this.settings.serverPort}/api/list`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${this.token}`,
        "obs-id": vaultId,
      },
    });
    if (!response.ok) return [];
    const res = await response.json();
    return res.files || [];
  }

  // apiPostBackend convention: body automatically includes {id, token}
  private async postToBackend(endpoint: string, body: object): Promise<any> {
    const siteId = this.vault.getName();
    const url = `${this.getPublishHost()}/${endpoint}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: siteId, token: this.token, ...body }),
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`${endpoint} failed: ${response.status}\n${errText}`);
    }
    return response.json();
  }

  // apiPostFrontend convention: body automatically includes {token}
  private async postToFrontend(endpoint: string, body: object): Promise<any> {
    const url = `${this.getPublishHost()}/${endpoint}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: this.token, ...body }),
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`${endpoint} failed: ${response.status}\n${errText}`);
    }
    return response.json();
  }

  // Download: POST /api/download with {id, token, path} → binary
  public async downloadPublishedFile(filePath: string): Promise<ArrayBuffer> {
    const siteId = this.vault.getName();
    const url = `${this.getPublishHost()}/api/download`;
    const response = await fetch(url, {
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
    const res = await this.postToBackend("api/password", {});
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
    const res = await this.postToFrontend("api/slugs", { ids: [vaultName] });
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
    return this.postToFrontend("api/site", { slug });
  }

  // Share: LIST
  public async getShares(): Promise<{ uid: string; email: string; name: string; accepted: boolean }[]> {
    const vaultName = this.vault.getName();
    const url = `${this.getPublishHost()}/publish/share/list`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: this.token, site_uid: vaultName }),
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`share/list failed: ${response.status}\n${errText}`);
    }
    const res = await response.json();
    return res.shares || [];
  }

  // Share: INVITE
  public async inviteShare(email: string): Promise<void> {
    const vaultName = this.vault.getName();
    const url = `${this.getPublishHost()}/publish/share/invite`;
    const response = await fetch(url, {
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
    const response = await fetch(url, {
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
    const response = await fetch(url, {
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
