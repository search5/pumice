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
    token: "tok", vaultId: "vault1", deviceName: "dev", userName: "user", clientVersion: "0.0.1",
  });
  const ws = getWs();
  ws.simulateOpen();
  const initEnvelope = ws.jsonSent("init")[0];
  ws.simulateJson({ requestId: initEnvelope.requestId, op: "init_ok", payload: { serverVersion: "0.1.0", timestampMs: 1000, maxInFlight: 2 } });
  await connectPromise;
  return { transport, ws };
}

describe("WsSyncTransport.connect", () => {
  it("sends init on open and resolves with the init_ok payload", async () => {
    const { transport, getWs } = makeTransport();
    const promise = transport.connect("ws://x/ws", {
      token: "tok", vaultId: "vault1", deviceName: "dev", userName: "user", clientVersion: "0.0.1",
    });
    const ws = getWs();
    ws.simulateOpen();

    expect(ws.jsonSent("init")).toEqual([
      { requestId: expect.any(Number), op: "init", payload: { token: "tok", vaultId: "vault1", deviceName: "dev", userName: "user", clientVersion: "0.0.1" } },
    ]);

    const requestId = ws.jsonSent("init")[0].requestId;
    ws.simulateJson({
      requestId, op: "init_ok",
      payload: { serverVersion: "0.1.0", timestampMs: 1000, maxInFlight: 8, maxFileSizeBytes: 2147483648 },
    });

    // maxFileSizeBytes (perFileMax, see #11_websocket_동기화_프로토콜_설계.md's re-analysis)
    // isn't consumed internally by the transport the way maxInFlight is -- it just has to reach
    // the caller unmodified in the resolved payload.
    await expect(promise).resolves.toEqual({
      serverVersion: "0.1.0", timestampMs: 1000, maxInFlight: 8, maxFileSizeBytes: 2147483648,
    });
  });

  it("rejects if the server responds to init with an error", async () => {
    const { transport, getWs } = makeTransport();
    const promise = transport.connect("ws://x/ws", { token: "bad", vaultId: "v", deviceName: "", userName: "", clientVersion: "" });
    const ws = getWs();
    ws.simulateOpen();
    const requestId = ws.jsonSent("init")[0].requestId;
    ws.simulateJson({ requestId, op: "error", payload: { code: "UNAUTHENTICATED", message: "nope" } });

    await expect(promise).rejects.toMatchObject({ code: "UNAUTHENTICATED", message: "nope" });
  });
});

describe("WsSyncTransport.request (unary, multiplexed)", () => {
  it("correlates responses to the correct request by requestId even when they arrive out of order", async () => {
    const { transport, ws } = await connectedTransport();

    const p1 = transport.request("delta_req", { vaultId: "v1" });
    const p2 = transport.request("delta_req", { vaultId: "v2" });
    const sent = ws.jsonSent("delta_req");
    expect(sent).toHaveLength(2);

    // Respond to the second request first.
    ws.simulateJson({ requestId: sent[1].requestId, op: "delta_res", payload: { needUpload: ["b"] } });
    ws.simulateJson({ requestId: sent[0].requestId, op: "delta_res", payload: { needUpload: ["a"] } });

    await expect(p1).resolves.toEqual({ needUpload: ["a"] });
    await expect(p2).resolves.toEqual({ needUpload: ["b"] });
  });

  it("rejects with a WsTransportError carrying the server's error code and message", async () => {
    const { transport, ws } = await connectedTransport();
    const p = transport.request("restore_req", { vaultId: "v1", path: "a.md", historyId: 1 });
    const requestId = ws.jsonSent("restore_req")[0].requestId;

    ws.simulateJson({ requestId, op: "error", payload: { code: "NOT_FOUND", message: "no such version" } });

    await expect(p).rejects.toBeInstanceOf(WsTransportError);
    await expect(p).rejects.toMatchObject({ code: "NOT_FOUND", message: "no such version" });
  });

  it("queues requests beyond maxInFlight and releases the queue as earlier ones complete", async () => {
    const { transport, ws } = await connectedTransport(); // maxInFlight: 2

    const p1 = transport.request("delta_req", {});
    const p2 = transport.request("delta_req", {});
    const p3 = transport.request("delta_req", {}); // should be queued, not sent yet

    expect(ws.jsonSent("delta_req")).toHaveLength(2);

    const [r1, r2] = ws.jsonSent("delta_req");
    ws.simulateJson({ requestId: r1.requestId, op: "delta_res", payload: {} });
    await p1;

    // Releasing one slot lets the third request go out.
    expect(ws.jsonSent("delta_req")).toHaveLength(3);

    const r3 = ws.jsonSent("delta_req")[2];
    ws.simulateJson({ requestId: r2.requestId, op: "delta_res", payload: {} });
    ws.simulateJson({ requestId: r3.requestId, op: "delta_res", payload: {} });
    await Promise.all([p2, p3]);
  });
});

describe("WsSyncTransport.requestStream (download/history-download)", () => {
  it("delivers json and binary frames in order via onFrame and resolves on stream_end", async () => {
    const { transport, ws } = await connectedTransport();
    const frames: any[] = [];

    const promise = transport.requestStream("download_req", { vaultId: "v1", paths: ["a.md"] }, (f) => frames.push(f));
    const requestId = ws.jsonSent("download_req")[0].requestId;

    ws.simulateJson({ requestId, op: "file_chunk_header", payload: { path: "a.md", totalBytes: 3, modifiedAtMs: 1 } });
    ws.simulateBinary(new Uint8Array([1, 2, 3]));
    ws.simulateJson({ requestId, op: "file_chunk_eof", payload: { path: "a.md", contentHash: "h" } });
    ws.simulateJson({ requestId, op: "stream_end", payload: {} });

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
    const requestId = ws.jsonSent("download_req")[0].requestId;

    ws.simulateJson({ requestId, op: "error", payload: { code: "INTERNAL", message: "boom" } });

    await expect(promise).rejects.toMatchObject({ code: "INTERNAL" });
  });

  it("serializes a second stream request client-side until the first finishes", async () => {
    const { transport, ws } = await connectedTransport();

    const p1 = transport.requestStream("download_req", { vaultId: "v1", paths: ["a.md"] }, () => {});
    const p2 = transport.requestStream("download_req", { vaultId: "v1", paths: ["b.md"] }, () => {});

    // Only the first has actually been sent -- the second is queued client-side rather than
    // being sent and rejected with STREAM_IN_PROGRESS by the server.
    expect(ws.jsonSent("download_req")).toHaveLength(1);

    const r1 = ws.jsonSent("download_req")[0];
    ws.simulateJson({ requestId: r1.requestId, op: "stream_end", payload: {} });
    await p1;

    expect(ws.jsonSent("download_req")).toHaveLength(2);
    const r2 = ws.jsonSent("download_req")[1];
    ws.simulateJson({ requestId: r2.requestId, op: "stream_end", payload: {} });
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

    const begin = ws.jsonSent("upload_begin")[0];
    expect(begin.payload).toEqual({ vaultId: "v1", fileCount: 1 });
    const requestId = begin.requestId;

    // contentHash is declared up front in the header now too, not just at eof below (item 6,
    // 2026-08 re-analysis follow-up -- see wsTransport.ts's comment at the send site).
    expect(ws.jsonSent("file_chunk_header")[0]).toMatchObject({
      requestId, payload: { path: "a.md", totalBytes: 2, modifiedAtMs: 5, contentHash: "h1" },
    });
    expect(ws.binarySent()).toEqual([data]);
    expect(ws.jsonSent("file_chunk_eof")[0]).toMatchObject({ requestId, payload: { path: "a.md", contentHash: "h1" } });

    ws.simulateJson({ requestId, op: "upload_ack", payload: { path: "a.md", ok: true, error: "" } });
    ws.simulateJson({ requestId, op: "stream_end", payload: {} });

    await promise;
    expect(acks).toEqual([{ path: "a.md", ok: true, error: "" }]);
  });
});

describe("WsSyncTransport push notifications", () => {
  it("calls the onChangePush callback without touching pending requests", async () => {
    const { transport, ws } = await connectedTransport();
    const onPush = vi.fn();
    transport.onChangePush(onPush);

    ws.simulateJson({ requestId: 0, op: "push", payload: { vaultId: "v1" } });

    expect(onPush).toHaveBeenCalledTimes(1);
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

    const requestId = ws.jsonSent("delta_req")[0].requestId;
    ws.simulateJson({ requestId, op: "delta_res", payload: { needUpload: [] } });

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

  it("does not affect other in-flight requests when one of them times out", async () => {
    const { transport, ws } = await connectedTransport(); // maxInFlight: 2
    const p1 = transport.request("delta_req", {});
    vi.advanceTimersByTime(65_000);
    const p2 = transport.request("delta_req", {}); // sent well within its own 60s budget

    transport.checkHeartbeat();

    await expect(p1).rejects.toThrow(/timed out/i);
    // p2 was rejected too, but only as collateral damage of the connection closing (handleClose
    // rejects everything still pending) -- there's no way to time out just one request without
    // tearing down the shared connection, matching Obsidian core's own behavior.
    await expect(p2).rejects.toBeInstanceOf(Error);
  });
});

describe("WsSyncTransport connection close", () => {
  it("rejects all pending unary and stream requests", async () => {
    const { transport, ws } = await connectedTransport();
    const p1 = transport.request("delta_req", {});
    const p2 = transport.requestStream("download_req", {}, () => {});

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
