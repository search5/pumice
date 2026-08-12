// Implements SyncTransport on top of wsTransport.ts's WsSyncTransport -- pure translation
// between SyncTransport's shape and the WS wire protocol's op payloads
// (#11_websocket_동기화_프로토콜_설계.md). No Obsidian runtime dependency, same as WsSyncTransport
// itself, so this is testable with a plain fake standing in for WsSyncTransport (see
// test/wsSyncTransportAdapter.test.ts) rather than needing a real socket.

import type { DeltaResult, DownloadedFileWire, PreparedUploadFile, SyncTransport, UploadAckResult } from "./syncTransport";
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
type WsTransportLike = Pick<WsSyncTransport, "request" | "requestStream" | "runUpload">;

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

  async uploadBatch(vaultId: string, files: PreparedUploadFile[], onAck: (ack: UploadAckResult) => void): Promise<void> {
    await this.ws.runUpload(
      vaultId,
      files.map((f) => ({
        path: f.path,
        totalBytes: f.data.byteLength,
        modifiedAtMs: f.mtimeMs,
        data: new Uint8Array(f.data),
        contentHash: f.contentHash,
      })),
      onAck
    );
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
}
