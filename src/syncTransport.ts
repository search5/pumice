// The wire-level boundary SyncClient talks to for every server-facing operation (delta
// comparison, upload, download, history/restore, size/purge/usernames) -- everything
// transport-agnostic (scanning, E2EE encrypt/decrypt, conflict resolution/3-way merge, vault
// writes, hash caching) stays in SyncClient completely unchanged; only "how do bytes get to/from
// the server" is behind this interface.
//
// Sole implementation: WsSyncTransportAdapter (wsSyncTransportAdapter.ts, wraps
// wsTransport.ts's WsSyncTransport). A gRPC-Web implementation existed before PR5 removed
// gRPC-Web entirely; REST (requestHttp in syncClient.ts) was the last non-WS path, used only for
// history/restore until the 2026-08 WS migration follow-up moved those here too -- see
// #11_websocket_동기화_프로토콜_설계.md and llm-wiki/09-*.md.

export interface LocalFileMetaWire {
  path: string;
  modified_at_ms: number;
  size_bytes: number;
  content_hash: string;
  is_deleted: boolean;
}

export interface RemoteFileMetaWire {
  path: string;
  modified_at_ms: number;
  size_bytes: number;
  content_hash: string;
  is_deleted: boolean;
}

export interface DeltaResult {
  needUpload: string[];
  needDownload: RemoteFileMetaWire[];
}

// Already fully prepared by SyncClient -- E2EE-encrypted (or not, if E2EE is off) and hashed.
// The transport never touches plaintext and doesn't need to know whether E2EE is even on.
export interface PreparedUploadFile {
  path: string;
  data: ArrayBuffer;
  contentHash: string;
  mtimeMs: number;
}

export interface UploadAckResult {
  path: string;
  ok: boolean;
  error: string;
}

// Wire bytes as received -- still possibly E2EE ciphertext, SyncClient decrypts and verifies.
export interface DownloadedFileWire {
  path: string;
  mtimeMs: number;
  data: ArrayBuffer;
  contentHash: string;
}

// 2026-08 Obsidian core Sync WS fidelity follow-up (see
// #11_websocket_동기화_프로토콜_설계.md's re-analysis) -- size/purge/usernames aren't part of
// the hot sync loop (matching why history/restore live on SyncClient directly instead of this
// interface, see syncClient.ts), but unlike those they're WS ops with no REST equivalent, so
// they do need to go through the transport.
export interface VaultSize {
  vaultSizeBytes: number;
  totalSizeBytes: number;
  limitBytes: number; // -1 = no quota configured
}

export interface PurgeResult {
  ok: boolean;
  error: string;
}

// 2026-08 WS history migration follow-up (see #11_websocket_동기화_프로토콜_설계.md and
// llm-wiki/09-*.md) -- history/restore moved from REST (requestHttp in syncClient.ts, now
// removed server-side) onto this transport, same reasoning as size/purge/usernames above: no
// REST equivalent exists anymore, so there's nowhere else for them to live.

// Shape of a single history_req entry, as returned by the server. Structurally compatible with
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

export interface RestoreResult {
  ok: boolean;
  error: string;
}

// `path` is the server-resolved target path (from history_dl_req's file_chunk_header, mirroring
// how the old REST download response's X-File-Path header let a caller with no path of its own
// -- restoreHistoryVersion's targetPath-not-given case -- learn which path to restore to).
export interface HistoryVersionDownload {
  data: ArrayBuffer;
  path: string;
  contentHash: string;
}

export interface SyncTransport {
  delta(vaultId: string, localFiles: LocalFileMetaWire[]): Promise<DeltaResult>;

  // Resolves once every file in `files` has been acked (onAck called for each) -- a whole-batch
  // transport failure (dropped connection etc.) should reject rather than resolve, so the
  // caller's retry loop can tell "some files acked, rest unaccounted for" apart from "call never
  // even started."
  uploadBatch(vaultId: string, files: PreparedUploadFile[], onAck: (ack: UploadAckResult) => void): Promise<void>;

  // Resolves once every requested path has either been delivered (onFile called and its promise
  // settled) or given up on (server-side skip, e.g. the path doesn't exist -- silently absent,
  // same as today). onFile returns whether the file was accepted (hash verified etc.); the
  // transport tallies downloadedCount/failedPaths from that so callers don't have to. Progress
  // reporting is the caller's concern (onFile can close over whatever state it needs) --
  // deliberately not a separate parameter here.
  downloadBatch(
    vaultId: string,
    paths: string[],
    onFile: (file: DownloadedFileWire) => Promise<boolean>
  ): Promise<{ downloadedCount: number; failedPaths: string[] }>;

  ping(): Promise<void>;

  size(vaultId: string): Promise<VaultSize>;
  purge(vaultId: string): Promise<PurgeResult>;
  getUsernames(vaultId: string): Promise<string[]>;

  getHistory(vaultId: string, path: string): Promise<HistoryVersionEntry[]>;
  // `path` overrides which path to restore the downloaded bytes to server-side context (empty
  // string = let the server fall back to the history entry's own stored path, same as
  // restore_req's payload.path -- see ws_sync_resource.py's _handle_restore).
  downloadHistoryVersion(vaultId: string, historyId: number, path?: string): Promise<HistoryVersionDownload>;
  restoreHistoryVersion(vaultId: string, historyId: number, path?: string): Promise<RestoreResult>;
}
