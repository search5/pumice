import { describe, expect, it, vi } from "vitest";
import { WsSyncTransportAdapter } from "../src/wsSyncTransportAdapter";
import type { StreamFrame } from "../src/wsTransport";

// Only the surface WsSyncTransportAdapter actually calls -- avoids needing a real WsSyncTransport
// + fake socket setup (already covered by wsTransport.test.ts) for what's purely a translation
// layer between SyncTransport's shape and WsSyncTransport's.
function fakeWs() {
  return {
    request: vi.fn(),
    requestStream: vi.fn(),
    runUpload: vi.fn(),
  };
}

describe("WsSyncTransportAdapter.delta", () => {
  it("translates the request/response shape between snake_case wire fields and the WS camelCase payload", async () => {
    const ws = fakeWs();
    ws.request.mockResolvedValue({
      needUpload: ["a.md"],
      needDownload: [{ path: "b.md", modifiedAtMs: 1000, sizeBytes: 5, contentHash: "h", isDeleted: false }],
    });
    const adapter = new WsSyncTransportAdapter(ws as any);

    const result = await adapter.delta("vault1", [
      { path: "local.md", modified_at_ms: 2000, size_bytes: 3, content_hash: "lh", is_deleted: false },
    ]);

    expect(ws.request).toHaveBeenCalledWith("delta_req", {
      vaultId: "vault1",
      localFiles: [{ path: "local.md", modifiedAtMs: 2000, sizeBytes: 3, contentHash: "lh", isDeleted: false }],
    });
    expect(result).toEqual({
      needUpload: ["a.md"],
      needDownload: [{ path: "b.md", modified_at_ms: 1000, size_bytes: 5, content_hash: "h", is_deleted: false }],
    });
  });
});

describe("WsSyncTransportAdapter.uploadBatch", () => {
  it("delegates to runUpload and translates acks back through onAck", async () => {
    const ws = fakeWs();
    ws.runUpload.mockImplementation(async (_vaultId: string, _files: unknown, onAck: (a: unknown) => void) => {
      onAck({ path: "a.md", ok: true, error: "" });
    });
    const adapter = new WsSyncTransportAdapter(ws as any);
    const acks: unknown[] = [];

    const data = new TextEncoder().encode("hello").buffer;
    await adapter.uploadBatch("vault1", [{ path: "a.md", data, contentHash: "h", mtimeMs: 123 }], (ack) => acks.push(ack));

    expect(ws.runUpload).toHaveBeenCalledWith(
      "vault1",
      [{ path: "a.md", totalBytes: 5, modifiedAtMs: 123, data: expect.any(Uint8Array), contentHash: "h" }],
      expect.any(Function)
    );
    expect(acks).toEqual([{ path: "a.md", ok: true, error: "" }]);
  });
});

describe("WsSyncTransportAdapter.downloadBatch", () => {
  it("assembles header/binary/eof frames per path and calls onFile once each", async () => {
    const ws = fakeWs();
    ws.requestStream.mockImplementation(async (_op: string, _payload: unknown, onFrame: (f: StreamFrame) => void) => {
      // Sequential, one file fully open (header..eof) at a time -- pumice-server guarantees
      // this across an entire batch (see _stream_download_file's write_lock scope), precisely
      // so raw binary frames -- which carry no per-chunk path tag -- are never ambiguous about
      // which file they belong to.
      onFrame({ kind: "json", op: "file_chunk_header", payload: { vaultId: "vault1", path: "a.md", totalBytes: 3, modifiedAtMs: 10 } });
      onFrame({ kind: "binary", data: new TextEncoder().encode("AAA").buffer });
      onFrame({ kind: "json", op: "file_chunk_eof", payload: { path: "a.md", contentHash: "ha" } });
      onFrame({ kind: "json", op: "file_chunk_header", payload: { vaultId: "vault1", path: "b.md", totalBytes: 3, modifiedAtMs: 20 } });
      onFrame({ kind: "binary", data: new TextEncoder().encode("BBB").buffer });
      onFrame({ kind: "json", op: "file_chunk_eof", payload: { path: "b.md", contentHash: "hb" } });
    });
    const adapter = new WsSyncTransportAdapter(ws as any);
    const received: unknown[] = [];

    const result = await adapter.downloadBatch("vault1", ["a.md", "b.md"], async (file) => {
      received.push({ path: file.path, mtimeMs: file.mtimeMs, contentHash: file.contentHash, text: new TextDecoder().decode(file.data) });
      return true;
    });

    expect(received).toEqual([
      { path: "a.md", mtimeMs: 10, contentHash: "ha", text: "AAA" },
      { path: "b.md", mtimeMs: 20, contentHash: "hb", text: "BBB" },
    ]);
    expect(result).toEqual({ downloadedCount: 2, failedPaths: [] });
  });

  it("ignores an eof whose path doesn't match the currently-open file instead of misattributing data", async () => {
    // Defensive only -- the server guarantees this can't happen (see the other test's comment),
    // but if it ever did, silently dropping the mismatched frame beats corrupting a file.
    const ws = fakeWs();
    ws.requestStream.mockImplementation(async (_op: string, _payload: unknown, onFrame: (f: StreamFrame) => void) => {
      onFrame({ kind: "json", op: "file_chunk_header", payload: { vaultId: "v", path: "a.md", totalBytes: 3, modifiedAtMs: 1 } });
      onFrame({ kind: "binary", data: new TextEncoder().encode("AAA").buffer });
      onFrame({ kind: "json", op: "file_chunk_eof", payload: { path: "wrong.md", contentHash: "h" } });
    });
    const adapter = new WsSyncTransportAdapter(ws as any);
    const received: unknown[] = [];

    const result = await adapter.downloadBatch("v", ["a.md"], async (file) => {
      received.push(file.path);
      return true;
    });

    expect(received).toEqual([]);
    expect(result).toEqual({ downloadedCount: 0, failedPaths: [] });
  });

  it("waits for onFile's own async work before resolving, and tallies failures from its return value", async () => {
    const ws = fakeWs();
    ws.requestStream.mockImplementation(async (_op: string, _payload: unknown, onFrame: (f: StreamFrame) => void) => {
      onFrame({ kind: "json", op: "file_chunk_header", payload: { vaultId: "v", path: "a.md", totalBytes: 1, modifiedAtMs: 1 } });
      onFrame({ kind: "binary", data: new Uint8Array([1]).buffer });
      onFrame({ kind: "json", op: "file_chunk_eof", payload: { path: "a.md", contentHash: "h" } });
    });
    const adapter = new WsSyncTransportAdapter(ws as any);

    let resolveOnFile!: (v: boolean) => void;
    const onFilePromise = new Promise<boolean>((resolve) => (resolveOnFile = resolve));
    let settledBeforeReturn = false;
    const resultPromise = adapter.downloadBatch("v", ["a.md"], async () => {
      const ok = await onFilePromise;
      settledBeforeReturn = true;
      return ok;
    });

    // requestStream's mock has already "completed" by this point (it's not artificially async),
    // but onFile is still pending -- downloadBatch must not resolve until it does.
    await Promise.resolve();
    expect(settledBeforeReturn).toBe(false);

    resolveOnFile(false);
    const result = await resultPromise;

    expect(settledBeforeReturn).toBe(true);
    expect(result).toEqual({ downloadedCount: 0, failedPaths: ["a.md"] });
  });
});

describe("WsSyncTransportAdapter.ping", () => {
  it("sends a ping request", async () => {
    const ws = fakeWs();
    ws.request.mockResolvedValue({});
    const adapter = new WsSyncTransportAdapter(ws as any);

    await adapter.ping();

    expect(ws.request).toHaveBeenCalledWith("ping", {});
  });
});
