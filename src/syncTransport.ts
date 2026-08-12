// The wire-level boundary SyncClient talks to for the three operations that actually move data
// (delta comparison, upload, download) -- everything transport-agnostic (scanning, E2EE encrypt/
// decrypt, conflict resolution/3-way merge, vault writes, hash caching) stays in SyncClient
// completely unchanged; only "how do bytes get to/from the server" is behind this interface.
//
// Two implementations: GrpcWebSyncTransport (syncClient.ts, wraps the existing gRPC-Web
// SyncServiceClient -- being removed once the WS transport fully replaces it) and
// WsSyncTransportAdapter (wsSyncTransportAdapter.ts, wraps wsTransport.ts's WsSyncTransport).
// See #11_websocket_동기화_프로토콜_설계.md for why this split exists instead of a from-scratch
// reimplementation of SyncClient's sync orchestration.

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
}
