// Implements SyncTransport on top of wsTransport.ts's WsSyncTransport -- pure translation
// between SyncTransport's shape and the WS wire protocol's op payloads
// (#11_websocket_동기화_프로토콜_설계.md). No Obsidian runtime dependency, same as WsSyncTransport
// itself, so this is testable with a plain fake standing in for WsSyncTransport (see
// test/wsSyncTransportAdapter.test.ts) rather than needing a real socket.

import type {
  DeltaResult,
  DownloadedFileWire,
  HistoryVersionDownload,
  HistoryVersionEntry,
  PreparedUploadFile,
  PurgeResult,
  RestoreResult,
  SyncTransport,
  UploadAckResult,
  VaultSize,
} from "./syncTransport";
import type { StreamFrame, WsSyncTransport } from "./wsTransport";

interface WireFileMeta {
  path: string;
  modifiedAtMs: number;
  sizeBytes: number;
  contentHash: string;
  isDeleted: boolean;
}

// Only the subset of WsSyncTransport this adapter actually drives -- keeps tests from needing a
// real WsSyncTransport + fake socket just to exercise the translation logic here.
type WsTransportLike = Pick<WsSyncTransport, "request" | "requestStream" | "pushFile">;

interface InFlightDownload {
  mtimeMs: number;
  chunks: Uint8Array[];
}

export class WsSyncTransportAdapter implements SyncTransport {
  constructor(private readonly ws: WsTransportLike) {}

  async delta(vaultId: string, localFiles: Array<{ path: string; modified_at_ms: number; size_bytes: number; content_hash: string; is_deleted: boolean }>): Promise<DeltaResult> {
    const response = await this.ws.request<{ needUpload: string[]; needDownload: WireFileMeta[] }>("delta_req", {
      vaultId,
      localFiles: localFiles.map((f) => ({
        path: f.path,
        modifiedAtMs: f.modified_at_ms,
        sizeBytes: f.size_bytes,
        contentHash: f.content_hash,
        isDeleted: f.is_deleted,
      })),
    });
    return {
      needUpload: response.needUpload,
      needDownload: response.needDownload.map((f) => ({
        path: f.path,
        modified_at_ms: f.modifiedAtMs,
        size_bytes: f.sizeBytes,
        content_hash: f.contentHash,
        is_deleted: f.isDeleted,
      })),
    };
  }

  // PR6 of #14_옵시디언싱크_정렬_구현계획.md: the wire protocol no longer has a batch-upload op
  // (upload_begin's fileCount wrapper is gone) -- each file is its own push_req/push_ack round
  // trip, matching real Obsidian Sync's own per-file `push`. This loop is what preserves
  // uploadBatch's existing contract ("resolves once every file in `files` has been acked") for
  // syncClient.ts, which is otherwise completely unaware the wire protocol changed shape.
  async uploadBatch(vaultId: string, files: PreparedUploadFile[], onAck: (ack: UploadAckResult) => void): Promise<void> {
    for (const f of files) {
      const result = await this.ws.pushFile(vaultId, {
        path: f.path,
        totalBytes: f.data.byteLength,
        modifiedAtMs: f.mtimeMs,
        data: new Uint8Array(f.data),
        contentHash: f.contentHash,
      });
      onAck({ path: f.path, ok: result.ok, error: result.error });
    }
  }

  async downloadBatch(
    vaultId: string,
    paths: string[],
    onFile: (file: DownloadedFileWire) => Promise<boolean>
  ): Promise<{ downloadedCount: number; failedPaths: string[] }> {
    let downloadedCount = 0;
    const failedPaths: string[] = [];
    // At most one file is ever "open" (header received, eof not yet) within a batch at a time --
    // pumice-server serializes each file's whole header-through-eof emission against every other
    // file in the same DownloadFiles batch (files can still be *read* concurrently, just not
    // *emitted* concurrently), specifically so raw binary data frames -- which carry no per-chunk
    // path tag, unlike gRPC-Web's ChunkData.path -- are never ambiguous about which file they
    // belong to. See #11_websocket_동기화_프로토콜_설계.md and pumice-server's
    // _stream_download_file for the server side of this guarantee.
    let current: (InFlightDownload & { path: string }) | null = null;
    // Each eof triggers onFile's own async work (hash verify/E2EE decrypt/conflict merge/write)
    // without blocking receipt of the *next* file's frames -- but downloadBatch itself must not
    // resolve until every one of those has actually settled, or the caller could move on while a
    // write is still happening.
    const pending: Promise<void>[] = [];

    await this.ws.requestStream("download_req", { vaultId, paths }, (frame: StreamFrame) => {
      if (frame.kind === "json" && frame.op === "file_chunk_header") {
        const h = frame.payload as { path: string; modifiedAtMs: number };
        current = { path: h.path, mtimeMs: h.modifiedAtMs, chunks: [] };
        return;
      }
      if (frame.kind === "binary") {
        current?.chunks.push(new Uint8Array(frame.data as ArrayBuffer));
        return;
      }
      if (frame.kind === "json" && frame.op === "file_chunk_eof") {
        const e = frame.payload as { path: string; contentHash: string };
        if (!current || current.path !== e.path) return;
        const buf = current;
        current = null;

        const total = buf.chunks.reduce((n, c) => n + c.byteLength, 0);
        const merged = new Uint8Array(total);
        let offset = 0;
        for (const chunk of buf.chunks) {
          merged.set(chunk, offset);
          offset += chunk.byteLength;
        }

        pending.push(
          (async () => {
            try {
              const ok = await onFile({ path: e.path, mtimeMs: buf.mtimeMs, data: merged.buffer, contentHash: e.contentHash });
              if (ok) downloadedCount++;
              else failedPaths.push(e.path);
            } catch (err: unknown) {
              console.error(`Failed to process downloaded file ${e.path}:`, err);
              failedPaths.push(e.path);
            }
          })()
        );
      }
    });

    await Promise.all(pending);
    return { downloadedCount, failedPaths };
  }

  async ping(): Promise<void> {
    await this.ws.request("ping", {});
  }

  async size(vaultId: string): Promise<VaultSize> {
    const response = await this.ws.request<{ vaultSizeBytes: number; totalSizeBytes: number; limitBytes: number }>(
      "size_req",
      { vaultId }
    );
    return { vaultSizeBytes: response.vaultSizeBytes, totalSizeBytes: response.totalSizeBytes, limitBytes: response.limitBytes };
  }

  async purge(vaultId: string): Promise<PurgeResult> {
    const response = await this.ws.request<{ ok: boolean; error: string }>("purge_req", { vaultId });
    return { ok: response.ok, error: response.error };
  }

  async getUsernames(vaultId: string): Promise<string[]> {
    const response = await this.ws.request<{ usernames: string[] }>("usernames_req", { vaultId });
    return response.usernames;
  }

  async getHistory(vaultId: string, path: string): Promise<HistoryVersionEntry[]> {
    const response = await this.ws.request<{
      versions: Array<{ historyId: number; modifiedAtMs: number; sizeBytes: number; contentHash: string; deviceName: string; userName: string; deleted?: boolean; relatedPath?: string | null }>;
    }>("history_req", { vaultId, path });
    return response.versions.map((v) => ({
      history_id: v.historyId,
      modified_at_ms: v.modifiedAtMs,
      size_bytes: v.sizeBytes,
      content_hash: v.contentHash,
      device_name: v.deviceName,
      user_name: v.userName,
      deleted: v.deleted,
      related_path: v.relatedPath,
    }));
  }

  async restoreHistoryVersion(vaultId: string, historyId: number, path = ""): Promise<RestoreResult> {
    const response = await this.ws.request<{ ok: boolean; error: string }>("restore_req", { vaultId, historyId, path });
    return { ok: response.ok, error: response.error };
  }

  // Same header/binary/eof frame shape as downloadBatch above (server-side both go through
  // _file_chunk_to_frame -- see ws_sync_resource.py), just for exactly one file, so this
  // doesn't need downloadBatch's multi-file "current" tracking.
  async downloadHistoryVersion(vaultId: string, historyId: number, path = ""): Promise<HistoryVersionDownload> {
    const chunks: Uint8Array[] = [];
    let resolvedPath = "";
    let contentHash = "";

    await this.ws.requestStream("history_dl_req", { vaultId, historyId, path }, (frame: StreamFrame) => {
      if (frame.kind === "json" && frame.op === "file_chunk_header") {
        resolvedPath = (frame.payload as { path: string }).path;
        return;
      }
      if (frame.kind === "binary") {
        chunks.push(new Uint8Array(frame.data as ArrayBuffer));
        return;
      }
      if (frame.kind === "json" && frame.op === "file_chunk_eof") {
        contentHash = (frame.payload as { contentHash: string }).contentHash;
      }
    });

    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return { data: merged.buffer, path: resolvedPath, contentHash };
  }
}
