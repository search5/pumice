import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WsSyncTransport, WsTransportError } from "../src/wsTransport";
import type { WsLike } from "../src/wsTransport";

// Standin for a real WebSocket -- lets tests drive open/message/close deterministically instead
// of needing a real socket, same approach as downloadBatching.test.ts's fake `download` callback.
class FakeWs implements WsLike {
  readyState = 0;
  sent: Array<{ kind: "json"; envelope: any } | { kind: "binary"; data: unknown }> = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (typeof data === "string") {
      this.sent.push({ kind: "json", envelope: JSON.parse(data) });
    } else {
      this.sent.push({ kind: "binary", data });
    }
  }

  close(): void {
    this.onclose?.();
  }

  simulateOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  simulateJson(envelope: any): void {
    this.onmessage?.({ data: JSON.stringify(envelope) });
  }

  simulateBinary(data: unknown): void {
    this.onmessage?.({ data });
  }

  simulateClose(): void {
    this.onclose?.();
  }

  jsonSent(op?: string) {
    return this.sent.filter((m) => m.kind === "json" && (op === undefined || m.envelope.op === op)).map((m: any) => m.envelope);
  }

  binarySent() {
    return this.sent.filter((m) => m.kind === "binary").map((m: any) => m.data);
  }
}

function makeTransport() {
  let ws: FakeWs;
  const transport = new WsSyncTransport((_url) => {
    ws = new FakeWs();
    return ws;
  });
  return { transport, getWs: () => ws! };
}

async function connectedTransport() {
  const { transport, getWs } = makeTransport();
  const connectPromise = transport.connect("ws://x/ws", {
    token: "tok", vaultId: "vault1", deviceName: "dev", userName: "user", clientVersion: "0.0.1", lastKnownChangeId: 0,
  });
  const ws = getWs();
  ws.simulateOpen();
  ws.simulateJson({ op: "init_ok", payload: { serverVersion: "0.1.0", timestampMs: 1000, maxFileSizeBytes: 2147483648 } });
  await connectPromise;
  return { transport, ws };
}

describe("WsSyncTransport.connect", () => {
  it("sends init on open and resolves with the init_ok payload", async () => {
    const { transport, getWs } = makeTransport();
    const promise = transport.connect("ws://x/ws", {
      token: "tok", vaultId: "vault1", deviceName: "dev", userName: "user", clientVersion: "0.0.1", lastKnownChangeId: 42,
    });
    const ws = getWs();
    ws.simulateOpen();

    expect(ws.jsonSent("init")).toEqual([
      { op: "init", payload: { token: "tok", vaultId: "vault1", deviceName: "dev", userName: "user", clientVersion: "0.0.1", lastKnownChangeId: 42 } },
    ]);

    // maxFileSizeBytes (perFileMax, see #11_websocket_동기화_프로토콜_설계.md's re-analysis)
    // isn't consumed internally by the transport -- it just has to reach the caller unmodified
    // in the resolved payload.
    ws.simulateJson({ op: "init_ok", payload: { serverVersion: "0.1.0", timestampMs: 1000, maxFileSizeBytes: 2147483648 } });

    await expect(promise).resolves.toEqual({
      serverVersion: "0.1.0", timestampMs: 1000, maxFileSizeBytes: 2147483648,
    });
  });

  it("rejects if the server responds to init with an error", async () => {
    const { transport, getWs } = makeTransport();
    const promise = transport.connect("ws://x/ws", { token: "bad", vaultId: "v", deviceName: "", userName: "", clientVersion: "", lastKnownChangeId: 0 });
    const ws = getWs();
    ws.simulateOpen();
    ws.simulateJson({ op: "error", payload: { code: "UNAUTHENTICATED", message: "nope" } });

    await expect(promise).rejects.toMatchObject({ code: "UNAUTHENTICATED", message: "nope" });
  });
});

describe("WsSyncTransport.request (unary, serialized)", () => {
  it("resolves with the response payload", async () => {
    const { transport, ws } = await connectedTransport();

    const p = transport.request("delta_req", { vaultId: "v1" });
    expect(ws.jsonSent("delta_req")).toEqual([{ op: "delta_req", payload: { vaultId: "v1" } }]);

    ws.simulateJson({ op: "delta_res", payload: { needUpload: ["a"] } });

    await expect(p).resolves.toEqual({ needUpload: ["a"] });
  });

  it("rejects with a WsTransportError carrying the server's error code and message", async () => {
    const { transport, ws } = await connectedTransport();
    const p = transport.request("restore_req", { vaultId: "v1", path: "a.md", historyId: 1 });

    ws.simulateJson({ op: "error", payload: { code: "NOT_FOUND", message: "no such version" } });

    await expect(p).rejects.toBeInstanceOf(WsTransportError);
    await expect(p).rejects.toMatchObject({ code: "NOT_FOUND", message: "no such version" });
  });

  it("queues a second request until the first resolves, sending it only then", async () => {
    const { transport, ws } = await connectedTransport();

    const p1 = transport.request("delta_req", { vaultId: "v1" });
    const p2 = transport.request("delta_req", { vaultId: "v2" });

    // Only the first has actually gone out -- the connection allows exactly one outstanding
    // request at a time, matching Obsidian core's own Sync client.
    expect(ws.jsonSent("delta_req")).toEqual([{ op: "delta_req", payload: { vaultId: "v1" } }]);

    ws.simulateJson({ op: "delta_res", payload: { needUpload: ["a"] } });
    await expect(p1).resolves.toEqual({ needUpload: ["a"] });

    expect(ws.jsonSent("delta_req")).toEqual([
      { op: "delta_req", payload: { vaultId: "v1" } },
      { op: "delta_req", payload: { vaultId: "v2" } },
    ]);

    ws.simulateJson({ op: "delta_res", payload: { needUpload: ["b"] } });
    await expect(p2).resolves.toEqual({ needUpload: ["b"] });
  });
});

describe("WsSyncTransport.requestStream (download/history-download)", () => {
  it("delivers json and binary frames in order via onFrame and resolves on stream_end", async () => {
    const { transport, ws } = await connectedTransport();
    const frames: any[] = [];

    const promise = transport.requestStream("download_req", { vaultId: "v1", paths: ["a.md"] }, (f) => frames.push(f));

    ws.simulateJson({ op: "file_chunk_header", payload: { path: "a.md", totalBytes: 3, modifiedAtMs: 1 } });
    ws.simulateBinary(new Uint8Array([1, 2, 3]));
    ws.simulateJson({ op: "file_chunk_eof", payload: { path: "a.md", contentHash: "h" } });
    ws.simulateJson({ op: "stream_end", payload: {} });

    await promise;
    expect(frames).toEqual([
      { kind: "json", op: "file_chunk_header", payload: { path: "a.md", totalBytes: 3, modifiedAtMs: 1 } },
      { kind: "binary", data: new Uint8Array([1, 2, 3]) },
      { kind: "json", op: "file_chunk_eof", payload: { path: "a.md", contentHash: "h" } },
    ]);
  });

  it("rejects on an error frame instead of resolving", async () => {
    const { transport, ws } = await connectedTransport();
    const promise = transport.requestStream("download_req", { vaultId: "v1", paths: ["a.md"] }, () => {});

    ws.simulateJson({ op: "error", payload: { code: "INTERNAL", message: "boom" } });

    await expect(promise).rejects.toMatchObject({ code: "INTERNAL" });
  });

  it("serializes a second stream request client-side until the first finishes", async () => {
    const { transport, ws } = await connectedTransport();

    const p1 = transport.requestStream("download_req", { vaultId: "v1", paths: ["a.md"] }, () => {});
    const p2 = transport.requestStream("download_req", { vaultId: "v1", paths: ["b.md"] }, () => {});

    // Only the first has actually been sent -- the second is queued client-side rather than
    // being sent and rejected with STREAM_IN_PROGRESS by the server.
    expect(ws.jsonSent("download_req")).toHaveLength(1);

    ws.simulateJson({ op: "stream_end", payload: {} });
    await p1;

    expect(ws.jsonSent("download_req")).toHaveLength(2);
    ws.simulateJson({ op: "stream_end", payload: {} });
    await p2;
  });

  it("serializes a unary request queued behind an in-flight stream request", async () => {
    const { transport, ws } = await connectedTransport();

    const p1 = transport.requestStream("download_req", { vaultId: "v1", paths: ["a.md"] }, () => {});
    const p2 = transport.request("delta_req", { vaultId: "v1" });

    expect(ws.jsonSent("delta_req")).toHaveLength(0);

    ws.simulateJson({ op: "stream_end", payload: {} });
    await p1;

    expect(ws.jsonSent("delta_req")).toHaveLength(1);
    ws.simulateJson({ op: "delta_res", payload: {} });
    await p2;
  });
});

describe("WsSyncTransport.runUpload", () => {
  it("sends upload_begin, one header/binary/eof triplet per file, and resolves on stream_end", async () => {
    const { transport, ws } = await connectedTransport();
    const acks: any[] = [];

    const data = new Uint8Array([9, 9]);
    const promise = transport.runUpload(
      "v1",
      [{ path: "a.md", totalBytes: 2, modifiedAtMs: 5, data, contentHash: "h1" }],
      (ack) => acks.push(ack)
    );

    expect(ws.jsonSent("upload_begin")).toEqual([{ op: "upload_begin", payload: { vaultId: "v1", fileCount: 1 } }]);

    // contentHash is declared up front in the header now too, not just at eof below (item 6,
    // 2026-08 re-analysis follow-up -- see wsTransport.ts's comment at the send site).
    expect(ws.jsonSent("file_chunk_header")[0]).toEqual({
      op: "file_chunk_header",
      payload: { vaultId: "v1", path: "a.md", totalBytes: 2, modifiedAtMs: 5, contentHash: "h1" },
    });
    expect(ws.binarySent()).toEqual([data]);
    expect(ws.jsonSent("file_chunk_eof")[0]).toEqual({ op: "file_chunk_eof", payload: { path: "a.md", contentHash: "h1" } });

    ws.simulateJson({ op: "upload_ack", payload: { path: "a.md", ok: true, error: "" } });
    ws.simulateJson({ op: "stream_end", payload: {} });

    await promise;
    expect(acks).toEqual([{ path: "a.md", ok: true, error: "" }]);
  });
});

describe("WsSyncTransport push notifications", () => {
  it("calls the onChangePush callback without touching pending requests", async () => {
    const { transport, ws } = await connectedTransport();
    const onPush = vi.fn();
    transport.onChangePush(onPush);

    ws.simulateJson({ op: "push", payload: { vaultId: "v1" } });

    expect(onPush).toHaveBeenCalledTimes(1);
  });

  // 2026-08 push-metadata fidelity follow-up (see
  // #11_websocket_동기화_프로토콜_설계.md and llm-wiki/07-*.md) -- push now carries the
  // changed file's own metadata (matching real Obsidian Sync) instead of a bare vaultId flag.
  it("passes the pushed file's metadata through to the callback", async () => {
    const { transport, ws } = await connectedTransport();
    const onPush = vi.fn();
    transport.onChangePush(onPush);

    ws.simulateJson({
      op: "push",
      payload: { vaultId: "v1", path: "a.md", modifiedAtMs: 1000, sizeBytes: 5, contentHash: "h1", isDeleted: false },
    });

    expect(onPush).toHaveBeenCalledWith({ vaultId: "v1", path: "a.md", modifiedAtMs: 1000, sizeBytes: 5, contentHash: "h1", isDeleted: false });
  });

  it("does not consume a pending request's slot (push can arrive mid-request)", async () => {
    const { transport, ws } = await connectedTransport();
    const onPush = vi.fn();
    transport.onChangePush(onPush);

    const p = transport.request("delta_req", {});
    ws.simulateJson({ op: "push", payload: { vaultId: "v1" } });
    expect(onPush).toHaveBeenCalledTimes(1);

    ws.simulateJson({ op: "delta_res", payload: { needUpload: [] } });
    await expect(p).resolves.toEqual({ needUpload: [] });
  });
});

describe("WsSyncTransport ready (version catch-up)", () => {
  // PR2/PR3 of #14_옵시디언싱크_정렬_구현계획.md -- confirmed via obsidian.asar analysis that
  // real Obsidian Sync has no separate "give me changes since X" RPC: init carries the client's
  // last known version, and the server streams the difference as ordinary push frames, then
  // signals `ready`. Mirrors the push-notification tests above.
  it("calls the onReady callback with the latestChangeId payload", async () => {
    const { transport, ws } = await connectedTransport();
    const onReady = vi.fn();
    transport.onReady(onReady);

    ws.simulateJson({ op: "ready", payload: { latestChangeId: 42 } });

    expect(onReady).toHaveBeenCalledWith({ latestChangeId: 42 });
  });

  it("does not consume a pending request's slot (ready can arrive mid-request)", async () => {
    const { transport, ws } = await connectedTransport();
    const onReady = vi.fn();
    transport.onReady(onReady);

    const p = transport.request("delta_req", {});
    ws.simulateJson({ op: "ready", payload: { latestChangeId: 1 } });
    expect(onReady).toHaveBeenCalledTimes(1);

    ws.simulateJson({ op: "delta_res", payload: { needUpload: [] } });
    await expect(p).resolves.toEqual({ needUpload: [] });
  });

  it("delivers a catch-up push burst followed by ready, in order, without touching pending requests", async () => {
    const { transport, ws } = await connectedTransport();
    const pushed: unknown[] = [];
    transport.onChangePush((f) => pushed.push(f));
    const onReady = vi.fn();
    transport.onReady(onReady);

    ws.simulateJson({ op: "push", payload: { vaultId: "v1", path: "a.md", modifiedAtMs: 1, sizeBytes: 1, contentHash: "h1", isDeleted: false } });
    ws.simulateJson({ op: "push", payload: { vaultId: "v1", path: "b.md", modifiedAtMs: 2, sizeBytes: 2, contentHash: "h2", isDeleted: false } });
    ws.simulateJson({ op: "ready", payload: { latestChangeId: 7 } });

    expect(pushed).toHaveLength(2);
    expect(onReady).toHaveBeenCalledWith({ latestChangeId: 7 });
  });
});

describe("WsSyncTransport heartbeat", () => {
  // checkHeartbeat() is called directly rather than relying on an internal timer -- the
  // transport deliberately never calls setInterval itself (see its docstring), so there's no
  // timer for fake-timers to drive here in the first place. The caller (wsSyncClient.ts, a
  // later PR) owns scheduling it on a real window.setInterval.
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does nothing while recently active", async () => {
    const { transport, ws } = await connectedTransport();
    ws.sent = [];

    vi.advanceTimersByTime(5_000);
    transport.checkHeartbeat();

    expect(ws.jsonSent("ping")).toHaveLength(0);
    expect(ws.sent).toHaveLength(0);
  });

  it("sends a ping once idle for more than 10s", async () => {
    const { transport, ws } = await connectedTransport();
    ws.sent = []; // clear the init frame so we only look at post-connect traffic

    vi.advanceTimersByTime(15_000);
    transport.checkHeartbeat();

    expect(ws.jsonSent("ping")).toHaveLength(1);
  });

  it("closes the connection once idle for more than 120s", async () => {
    const { transport, ws } = await connectedTransport();
    const onClose = vi.fn();
    ws.onclose = onClose;

    vi.advanceTimersByTime(130_000);
    transport.checkHeartbeat();

    expect(onClose).toHaveBeenCalled();
  });
});

describe("WsSyncTransport request timeout", () => {
  // Mirrors Obsidian core's own Sync client, which wraps every request() in a 60s timeout and
  // disconnects on expiry (see #11_websocket_동기화_프로토콜_설계.md's re-analysis, 2026-08).
  // Like the heartbeat above, checked via checkHeartbeat() polling rather than a dedicated
  // per-request timer -- this file deliberately never calls setTimeout/setInterval itself.
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not time out a request answered well within 60s", async () => {
    const { transport, ws } = await connectedTransport();
    const p = transport.request("delta_req", {});

    vi.advanceTimersByTime(5_000);
    transport.checkHeartbeat();

    ws.simulateJson({ op: "delta_res", payload: { needUpload: [] } });

    await expect(p).resolves.toEqual({ needUpload: [] });
  });

  it("rejects a request that never gets a response after 60s and closes the connection", async () => {
    const { transport, ws } = await connectedTransport();
    const onClose = vi.fn();
    ws.onclose = onClose;

    const p = transport.request("delta_req", {});
    vi.advanceTimersByTime(65_000);
    transport.checkHeartbeat();

    await expect(p).rejects.toThrow(/timed out/i);
    expect(onClose).toHaveBeenCalled();
  });

  it("does not start a queued request's timeout budget until it actually sends", async () => {
    const { transport, ws } = await connectedTransport();
    const p1 = transport.request("delta_req", {});
    vi.advanceTimersByTime(65_000); // p1 alone is now overdue

    const onClose = vi.fn();
    ws.onclose = onClose;
    transport.checkHeartbeat();

    await expect(p1).rejects.toThrow(/timed out/i);
    expect(onClose).toHaveBeenCalled();
  });

  it("rejects a request still queued behind a timed-out one instead of leaving it hanging", async () => {
    const { transport, ws } = await connectedTransport();
    const p1 = transport.request("delta_req", {});
    const p2 = transport.request("delta_req", {}); // queued behind p1

    vi.advanceTimersByTime(65_000);
    transport.checkHeartbeat();

    await expect(p1).rejects.toThrow(/timed out/i);
    await expect(p2).rejects.toBeInstanceOf(Error);
  });
});

describe("WsSyncTransport connection close", () => {
  it("rejects the pending request", async () => {
    const { transport, ws } = await connectedTransport();
    const p1 = transport.request("delta_req", {});

    ws.simulateClose();

    await expect(p1).rejects.toBeInstanceOf(Error);
  });

  it("rejects requests still queued behind the pending one instead of leaving them hanging", async () => {
    const { transport, ws } = await connectedTransport();
    const p1 = transport.request("delta_req", {});
    const p2 = transport.request("delta_req", {}); // never got to send

    ws.simulateClose();

    await expect(p1).rejects.toBeInstanceOf(Error);
    await expect(p2).rejects.toBeInstanceOf(Error);
  });

  it("calls the onClose callback so a caller can stop treating this instance as usable", async () => {
    const { transport, ws } = await connectedTransport();
    const onClose = vi.fn();
    transport.onClose(onClose);

    ws.simulateClose();

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
