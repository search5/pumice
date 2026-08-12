// Pure WebSocket sync protocol layer -- no Obsidian runtime dependency, so it's testable with a
// fake socket (see test/wsTransport.test.ts) the same way batching.ts's runBatchedDownloads is
// testable with a fake download callback. syncClient.ts-level concerns (Obsidian Vault access,
// E2EE, conflict resolution) live in wsSyncClient.ts instead, on top of this.
//
// Wire protocol: see #11_websocket_동기화_프로토콜_설계.md. One persistent connection per vault;
// JSON text frames for control messages ({requestId, op, payload}), raw binary frames (no
// envelope) for file content. Unlike Obsidian core's own Sync plugin (which this design is
// modeled on but does not copy), requests are multiplexed via requestId instead of being fully
// serialized one-at-a-time -- see the design doc's "요청 동시성" section for why. The one
// deliberate exception is binary file-chunk streams (upload/download/history-download): raw
// binary frames carry no requestId, so only one such stream may be active on the connection at
// a time -- enforced here by queuing (see requestStream/runUpload), matching the server's
// STREAM_IN_PROGRESS rejection so the client never actually triggers it.

export interface WsEnvelope<TPayload = unknown> {
  requestId: number;
  op: string;
  payload: TPayload;
}

export interface InitPayload {
  token: string;
  vaultId: string;
  deviceName: string;
  userName: string;
  clientVersion: string;
}

export interface InitOkPayload {
  serverVersion: string;
  timestampMs: number;
  maxInFlight: number;
  // Advertised per-file upload cap, mirroring Obsidian core's own Sync client (perFileMax) --
  // see #11_websocket_동기화_프로토콜_설계.md's re-analysis. Not yet enforced client-side before
  // attempting an upload (the server already rejects an oversized file with a clear per-file
  // UploadAck error, same as a hash mismatch) -- connect()'s caller gets this value in the
  // resolved InitOkPayload if it ever wants to skip the wasted round trip up front.
  maxFileSizeBytes: number;
}

// 2026-08 Obsidian core Sync WS fidelity follow-up (see
// #11_websocket_동기화_프로토콜_설계.md and llm-wiki/07-*.md) -- push now carries the changed
// file's own metadata (matching real Obsidian Sync's per-file push) instead of a bare vaultId
// flag that forced every push to trigger a full Delta re-scan regardless of how much changed.
export interface PushedFileChangeMeta {
  vaultId: string;
  path: string;
  modifiedAtMs: number;
  sizeBytes: number;
  contentHash: string;
  isDeleted: boolean;
}

export class WsTransportError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export type StreamFrame = { kind: "json"; op: string; payload: unknown } | { kind: "binary"; data: unknown };

export interface UploadFileInput {
  path: string;
  totalBytes: number;
  modifiedAtMs: number;
  data: ArrayBufferView;
  contentHash: string;
}

// Minimal WebSocket surface this transport needs -- lets tests inject a fake socket instead of
// a real browser/Node WebSocket.
export interface WsLike {
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  binaryType?: string;
  // ev params are optional (not just typed `unknown`) so a real WebSocket -- whose onopen/
  // onclose/onerror always pass an Event -- is assignable here, while a fake test double can
  // still just call these with zero arguments.
  onopen: ((ev?: unknown) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export type WsFactory = (url: string) => WsLike;

interface PendingUnary {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
  sentAt: number;
}

interface PendingStream {
  onFrame: (frame: StreamFrame) => void;
  resolve: () => void;
  reject: (err: Error) => void;
}

// Exported so the caller (wsSyncClient.ts) can schedule checkHeartbeat() at the same cadence
// this file's own idle thresholds below assume, without duplicating the literal value.
export const HEARTBEAT_CHECK_INTERVAL_MS = 20_000;
const PING_AFTER_IDLE_MS = 10_000;
const DISCONNECT_AFTER_IDLE_MS = 120_000;
// Mirrors Obsidian core's own Sync client, which wraps every request() in a 60s timeout and
// disconnects the whole connection on expiry rather than just failing that one request (there's
// no way to know the request is simply lost vs. the connection itself being half-dead). Checked
// via checkHeartbeat() polling, like the idle thresholds above, for the same testability reason
// (see that section's own comment) -- so an unanswered request can take up to ~this plus one
// heartbeat interval to actually be detected, not exactly REQUEST_TIMEOUT_MS.
const REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_IN_FLIGHT = 8;

export class WsSyncTransport {
  private ws: WsLike | null = null;
  private nextRequestId = 1;
  private maxInFlight = DEFAULT_MAX_IN_FLIGHT;

  private unaryPending = new Map<number, PendingUnary>();
  private unaryInFlightCount = 0;
  private unaryQueue: Array<() => void> = [];

  private streamPending = new Map<number, PendingStream>();
  private streamActive = false;
  private streamQueue: Array<() => void> = [];

  private lastMessageTs = 0;
  private onPush?: (file: PushedFileChangeMeta) => void;
  private onCloseCb?: () => void;

  constructor(private readonly wsFactory: WsFactory) {}

  // Lets the caller (wsSyncClient/main.ts) notice a dropped connection and stop treating a
  // cached transport instance as usable -- without this there's no way to tell "still open" from
  // "the socket died and every future request() will just reject" apart from trying one and
  // catching the failure.
  onClose(cb: () => void): void {
    this.onCloseCb = cb;
  }

  onChangePush(cb: (file: PushedFileChangeMeta) => void): void {
    this.onPush = cb;
  }

  connect(url: string, init: InitPayload): Promise<InitOkPayload> {
    return new Promise((resolve, reject) => {
      const ws = this.wsFactory(url);
      this.ws = ws;
      // Browsers and Node's WebSocket both default binaryType to "blob" -- binary frames would
      // arrive as a Blob instead of an ArrayBuffer, which handleBinaryFrame below can't use
      // synchronously (Blob reads are async). Obsidian core's own Sync plugin sets this same
      // flag for the same reason (confirmed in the app's shipped code, see the design doc).
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        this.lastMessageTs = Date.now();
        const requestId = this.allocateRequestId();
        this.unaryPending.set(requestId, {
          resolve: (payload) => {
            const initOk = payload as InitOkPayload;
            this.maxInFlight = initOk.maxInFlight || DEFAULT_MAX_IN_FLIGHT;
            resolve(initOk);
          },
          reject,
          sentAt: Date.now(),
        });
        this.sendJson({ requestId, op: "init", payload: init });
      };
      ws.onerror = () => reject(new Error("WebSocket connection failed"));
      ws.onclose = () => this.handleClose();
      ws.onmessage = (ev) => this.handleMessage(ev.data);
    });
  }

  close(): void {
    this.ws?.close();
  }

  // ── unary request/response: delta_req, history_req, restore_req ──────────────────────────
  //
  // Deliberately NOT `async function` + `await waitForSlot()`: awaiting even an
  // already-resolved promise still defers to a microtask, which would mean a request never
  // actually sends synchronously even when a slot is free right now. The Promise executor
  // below runs synchronously instead, so the send happens in the same tick when possible, and
  // is deferred only by actually queuing a closure when a slot genuinely isn't free yet.

  request<TRes = unknown>(op: string, payload: unknown): Promise<TRes> {
    const requestId = this.allocateRequestId();
    return new Promise<TRes>((resolve, reject) => {
      const pending: PendingUnary = {
        resolve: (p) => {
          this.releaseUnarySlot();
          resolve(p as TRes);
        },
        reject: (e) => {
          this.releaseUnarySlot();
          reject(e);
        },
        sentAt: 0, // set for real in send() below -- a request queued behind maxInFlight hasn't
        // actually gone out yet, so its timeout budget shouldn't start counting down until it has.
      };
      const send = () => {
        pending.sentAt = Date.now();
        this.unaryPending.set(requestId, pending);
        this.sendJson({ requestId, op, payload });
      };
      if (this.unaryInFlightCount < this.maxInFlight) {
        this.unaryInFlightCount++;
        send();
      } else {
        this.unaryQueue.push(() => {
          this.unaryInFlightCount++;
          send();
        });
      }
    });
  }

  private releaseUnarySlot(): void {
    this.unaryInFlightCount--;
    const next = this.unaryQueue.shift();
    next?.();
  }

  // ── streaming request/response: download_req, history_dl_req ─────────────────────────────

  requestStream(op: string, payload: unknown, onFrame: (frame: StreamFrame) => void): Promise<void> {
    const requestId = this.allocateRequestId();
    return new Promise<void>((resolve, reject) => {
      const pending: PendingStream = {
        onFrame,
        resolve: () => {
          this.releaseStreamSlot();
          resolve();
        },
        reject: (e) => {
          this.releaseStreamSlot();
          reject(e);
        },
      };
      const send = () => {
        this.streamPending.set(requestId, pending);
        this.sendJson({ requestId, op, payload });
      };
      this.claimStreamSlotOrQueue(send);
    });
  }

  // ── upload: client-driven, server acks per file + a final stream_end ─────────────────────

  runUpload(
    vaultId: string,
    files: UploadFileInput[],
    onAck: (ack: { path: string; ok: boolean; error: string }) => void
  ): Promise<void> {
    const requestId = this.allocateRequestId();
    return new Promise<void>((resolve, reject) => {
      const pending: PendingStream = {
        onFrame: (frame) => {
          if (frame.kind === "json" && frame.op === "upload_ack") {
            onAck(frame.payload as { path: string; ok: boolean; error: string });
          }
        },
        resolve: () => {
          this.releaseStreamSlot();
          resolve();
        },
        reject: (e) => {
          this.releaseStreamSlot();
          reject(e);
        },
      };
      const send = () => {
        this.streamPending.set(requestId, pending);
        this.sendJson({ requestId, op: "upload_begin", payload: { vaultId, fileCount: files.length } });
        for (const file of files) {
          this.sendJson({
            requestId,
            op: "file_chunk_header",
            // contentHash declared up front here too (not just at eof below), mirroring
            // Obsidian core's own Sync client -- see #11_websocket_동기화_프로토콜_설계.md's
            // re-analysis and wire_types.ChunkHeader's docstring (server side) for why.
            payload: {
              vaultId, path: file.path, totalBytes: file.totalBytes, modifiedAtMs: file.modifiedAtMs,
              contentHash: file.contentHash,
            },
          });
          this.ws!.send(file.data);
          this.sendJson({ requestId, op: "file_chunk_eof", payload: { path: file.path, contentHash: file.contentHash } });
        }
      };
      this.claimStreamSlotOrQueue(send);
    });
  }

  private claimStreamSlotOrQueue(send: () => void): void {
    if (!this.streamActive) {
      this.streamActive = true;
      send();
    } else {
      this.streamQueue.push(send);
    }
  }

  private releaseStreamSlot(): void {
    this.streamActive = false;
    const next = this.streamQueue.shift();
    if (next) {
      this.streamActive = true;
      next();
    }
  }

  // ── low-level send/receive ────────────────────────────────────────────────────────────────

  private allocateRequestId(): number {
    return this.nextRequestId++;
  }

  private sendJson(envelope: WsEnvelope): void {
    this.ws!.send(JSON.stringify(envelope));
  }

  private handleMessage(data: unknown): void {
    this.lastMessageTs = Date.now();

    if (typeof data !== "string") {
      this.handleBinaryFrame(data);
      return;
    }

    let envelope: WsEnvelope;
    try {
      envelope = JSON.parse(data) as WsEnvelope;
    } catch {
      return; // malformed frame from the server -- nothing sane to do with it here
    }
    const { requestId, op, payload } = envelope;

    if (op === "pong") return;
    if (op === "push") {
      this.onPush?.(payload as PushedFileChangeMeta);
      return;
    }

    const unary = this.unaryPending.get(requestId);
    if (unary) {
      this.unaryPending.delete(requestId);
      if (op === "error") {
        const err = payload as { code: string; message: string };
        unary.reject(new WsTransportError(err.code, err.message));
      } else {
        unary.resolve(payload);
      }
      return;
    }

    const stream = this.streamPending.get(requestId);
    if (!stream) return; // response for a requestId we're no longer tracking (e.g. after close)

    if (op === "stream_end") {
      this.streamPending.delete(requestId);
      stream.resolve();
    } else if (op === "error") {
      this.streamPending.delete(requestId);
      const err = payload as { code: string; message: string };
      stream.reject(new WsTransportError(err.code, err.message));
    } else {
      stream.onFrame({ kind: "json", op, payload });
    }
  }

  private handleBinaryFrame(data: unknown): void {
    // Exactly one stream can be active at a time (see the module docstring), so there's never
    // an ambiguity about which pending stream a binary frame belongs to.
    for (const stream of this.streamPending.values()) {
      stream.onFrame({ kind: "binary", data });
      return;
    }
  }

  private handleClose(): void {
    const err = new Error("WebSocket connection closed");
    for (const pending of this.unaryPending.values()) pending.reject(err);
    this.unaryPending.clear();
    for (const pending of this.streamPending.values()) pending.reject(err);
    this.streamPending.clear();
    this.onCloseCb?.();
  }

  // ── heartbeat: idle-based, mirrors Obsidian core's own Sync plugin. Deliberately doesn't
  // schedule its own timer (no setInterval call anywhere in this file) -- like batching.ts's
  // runBatchedDownloads takes its retry delay from the caller instead of calling
  // window.setTimeout itself, the caller (wsSyncClient.ts, which runs in the real Obsidian
  // environment) is expected to invoke checkHeartbeat() on its own window.setInterval, roughly
  // every 20s for the connection's lifetime. Keeping this file free of any timer API call is
  // what lets it stay unit-testable in a plain Node environment (no `window`) with tests just
  // calling checkHeartbeat() directly instead of needing a DOM/jsdom environment. ─────────────

  checkHeartbeat(): void {
    const idleMs = Date.now() - this.lastMessageTs;
    if (idleMs > DISCONNECT_AFTER_IDLE_MS) {
      this.close();
      return;
    } else if (idleMs > PING_AFTER_IDLE_MS) {
      this.sendJson({ requestId: this.allocateRequestId(), op: "ping", payload: {} });
    }
    this.checkRequestTimeouts();
  }

  // A pinging connection can still have an individual request whose response was silently lost
  // (server bug, dropped frame) -- the idle check above alone would never catch that, since
  // pings/pongs keep lastMessageTs fresh indefinitely. Mirrors Obsidian core's own per-request
  // timeout (see REQUEST_TIMEOUT_MS): reject that one request with a distinguishable error, then
  // tear down the whole connection the same way core does -- there's no way to know the request
  // is simply lost vs. the connection itself being wedged, so the safe assumption is the latter.
  private checkRequestTimeouts(): void {
    const now = Date.now();
    for (const [requestId, pending] of this.unaryPending) {
      if (now - pending.sentAt > REQUEST_TIMEOUT_MS) {
        this.unaryPending.delete(requestId);
        pending.reject(new Error("Request timed out"));
        this.close();
        return;
      }
    }
  }
}
