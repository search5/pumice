// Pure WebSocket sync protocol layer -- no Obsidian runtime dependency, so it's testable with a
// fake socket (see test/wsTransport.test.ts) the same way batching.ts's runBatchedDownloads is
// testable with a fake download callback. syncClient.ts-level concerns (Obsidian Vault access,
// E2EE, conflict resolution) live in wsSyncClient.ts instead, on top of this.
//
// Wire protocol: see #11_websocket_동기화_프로토콜_설계.md / #14_옵시디언싱크_정렬_구현계획.md.
// One persistent connection per vault; JSON text frames for control messages ({op, payload}), raw
// binary frames (no envelope) for file content. Matches Obsidian core's own Sync plugin exactly
// here (unlike an earlier version of this file, which multiplexed requests via a requestId field
// -- removed, see #14): the connection allows exactly one outstanding request at a time, tracked
// by a single `pending` slot, with anything else queued client-side. There is no requestId in the
// envelope at all -- like core, "the next non-push/non-pong message is the response to whatever
// is currently pending" is unambiguous once only one thing is ever pending.

export interface WsEnvelope<TPayload = unknown> {
  op: string;
  payload: TPayload;
}

export interface InitPayload {
  token: string;
  vaultId: string;
  deviceName: string;
  userName: string;
  clientVersion: string;
  // Version catch-up baseline (PR2/PR3 of #14_옵시디언싱크_정렬_구현계획.md) -- the
  // vault_change_log change_id this device last caught up to. 0 means "no baseline yet"
  // (brand-new device), which the server takes as a signal to skip the catch-up `push` burst
  // and let the existing full delta_req bootstrap handle it instead. Matches Obsidian core's
  // own `init` payload carrying a `version` field (confirmed via obsidian.asar analysis).
  lastKnownChangeId: number;
}

export interface InitOkPayload {
  serverVersion: string;
  timestampMs: number;
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

// Sent once after init_ok (and after any catch-up `push` burst) to signal "you're caught up as
// of this change_id" -- mirrors Obsidian core's own `ready` op (`onReady(version)`). The caller
// persists latestChangeId as the new lastKnownChangeId baseline for the next connection.
export interface ReadyPayload {
  latestChangeId: number;
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

type Pending =
  | { kind: "unary"; resolve: (payload: unknown) => void; reject: (err: Error) => void; sentAt: number }
  | {
      kind: "stream";
      onFrame: (frame: StreamFrame) => void;
      resolve: () => void;
      reject: (err: Error) => void;
      sentAt: number;
    };

interface QueuedRequest {
  send: () => void;
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

export class WsSyncTransport {
  private ws: WsLike | null = null;

  // Exactly one request may be outstanding on the connection at a time (unary or stream alike) --
  // anything else is queued here and sent once this becomes null again. See the module docstring
  // for why this replaced per-requestId multiplexing.
  private pending: Pending | null = null;
  private queue: QueuedRequest[] = [];

  private lastMessageTs = 0;
  private onPush?: (file: PushedFileChangeMeta) => void;
  private onReadyCb?: (payload: ReadyPayload) => void;
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

  // Callers should register this (and onChangePush/onClose) *before* calling connect() -- a
  // catch-up push burst can arrive immediately once init_ok is sent, and registering only after
  // connect() resolves leaves a real gap where an early push/ready could be silently dropped.
  onReady(cb: (payload: ReadyPayload) => void): void {
    this.onReadyCb = cb;
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
        this.pending = {
          kind: "unary",
          resolve: (payload) => {
            this.releaseSlot();
            resolve(payload as InitOkPayload);
          },
          reject: (e) => {
            this.releaseSlot();
            reject(e);
          },
          sentAt: Date.now(),
        };
        this.sendJson({ op: "init", payload: init });
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

  request<TRes = unknown>(op: string, payload: unknown): Promise<TRes> {
    return new Promise<TRes>((resolve, reject) => {
      const send = () => {
        this.pending = {
          kind: "unary",
          resolve: (p) => {
            this.releaseSlot();
            resolve(p as TRes);
          },
          reject: (e) => {
            this.releaseSlot();
            reject(e);
          },
          sentAt: Date.now(),
        };
        this.sendJson({ op, payload });
      };
      this.enqueue(send, reject);
    });
  }

  // ── streaming request/response: download_req, history_dl_req ─────────────────────────────

  requestStream(op: string, payload: unknown, onFrame: (frame: StreamFrame) => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const send = () => {
        this.pending = {
          kind: "stream",
          onFrame,
          resolve: () => {
            this.releaseSlot();
            resolve();
          },
          reject: (e) => {
            this.releaseSlot();
            reject(e);
          },
          sentAt: Date.now(),
        };
        this.sendJson({ op, payload });
      };
      this.enqueue(send, reject);
    });
  }

  // ── push: one file at a time, dedup-aware (PR6 of #14_옵시디언싱크_정렬_구현계획.md) ──────
  //
  // Replaced upload_begin/file_chunk_header/file_chunk_eof/upload_ack (a batch-oriented
  // quartet) with a single push_req per file, matching real Obsidian Sync's own `push` op
  // (confirmed via obsidian.asar analysis): declare path/hash/size up front, and the server
  // either already has that content live somewhere else in the vault (a dedup hit -- push_ack
  // comes straight back, no bytes needed) or replies push_res{needData:true} and the client
  // sends the whole file as one raw binary frame. There's no more batch wrapper: the caller
  // (wsSyncTransportAdapter.ts) just calls this once per file, and the connection's existing
  // single-outstanding-request serialization is what a batch used to exist to guarantee.

  pushFile(vaultId: string, file: UploadFileInput): Promise<{ ok: boolean; needData: boolean; error: string }> {
    return new Promise((resolve, reject) => {
      let result: { ok: boolean; needData: boolean; error: string } | null = null;
      const send = () => {
        this.pending = {
          kind: "stream",
          onFrame: (frame) => {
            if (frame.kind !== "json") return;
            if (frame.op === "push_res" && (frame.payload as { needData: boolean }).needData) {
              this.ws!.send(file.data);
            } else if (frame.op === "push_ack") {
              result = frame.payload as { ok: boolean; needData: boolean; error: string };
            }
          },
          resolve: () => {
            this.releaseSlot();
            // push_ack always precedes stream_end in practice (server sends it right before --
            // see ws_sync_resource.py's _run_push), but fall back to a synthetic failure rather
            // than resolving with null if that invariant is ever violated.
            resolve(result ?? { ok: false, needData: false, error: "no ack received" });
          },
          reject: (e) => {
            this.releaseSlot();
            reject(e);
          },
          sentAt: Date.now(),
        };
        this.sendJson({
          op: "push_req",
          payload: {
            vaultId, path: file.path, contentHash: file.contentHash,
            sizeBytes: file.totalBytes, modifiedAtMs: file.modifiedAtMs,
          },
        });
      };
      this.enqueue(send, reject);
    });
  }

  // Deliberately NOT `async function` + `await waitForSlot()`: awaiting even an already-resolved
  // promise still defers to a microtask, which would mean a request never actually sends
  // synchronously even when the connection is idle right now. Running send() synchronously here
  // when nothing is pending keeps that same-tick-send behavior; a request only gets deferred by
  // actually being queued behind a genuinely outstanding one.
  private enqueue(send: () => void, reject: (err: Error) => void): void {
    if (this.pending) {
      this.queue.push({ send, reject });
    } else {
      send();
    }
  }

  private releaseSlot(): void {
    this.pending = null;
    const next = this.queue.shift();
    next?.send();
  }

  // ── low-level send/receive ────────────────────────────────────────────────────────────────

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
    const { op, payload } = envelope;

    if (op === "pong") return;
    if (op === "push") {
      this.onPush?.(payload as PushedFileChangeMeta);
      return;
    }
    if (op === "ready") {
      this.onReadyCb?.(payload as ReadyPayload);
      return;
    }

    if (!this.pending) return; // response for a request we're no longer tracking (e.g. after close)

    if (this.pending.kind === "unary") {
      if (op === "error") {
        const err = payload as { code: string; message: string };
        this.pending.reject(new WsTransportError(err.code, err.message));
      } else {
        this.pending.resolve(payload);
      }
      return;
    }

    if (op === "stream_end") {
      this.pending.resolve();
    } else if (op === "error") {
      const err = payload as { code: string; message: string };
      this.pending.reject(new WsTransportError(err.code, err.message));
    } else {
      this.pending.onFrame({ kind: "json", op, payload });
    }
  }

  private handleBinaryFrame(data: unknown): void {
    if (this.pending?.kind === "stream") {
      this.pending.onFrame({ kind: "binary", data });
    }
  }

  private handleClose(): void {
    const err = new Error("WebSocket connection closed");
    // Snapshot and clear both before rejecting anything: `pending.reject` is wrapped with
    // releaseSlot() (see request()/requestStream()/pushFile() above), which would otherwise
    // shift the next queued request and actually send() it on this now-dead socket. Clearing
    // first makes that shift a no-op.
    const pending = this.pending;
    const queued = this.queue;
    this.pending = null;
    this.queue = [];
    pending?.reject(err);
    // Requests that never got a chance to send (still queued behind the one above) would
    // otherwise hang forever -- their Promise executor already ran and captured its own reject,
    // it just hasn't been invoked yet.
    for (const q of queued) q.reject(err);
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
      this.sendJson({ op: "ping", payload: {} });
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
    if (!this.pending) return;
    if (Date.now() - this.pending.sentAt > REQUEST_TIMEOUT_MS) {
      // reject() is wrapped with releaseSlot() (see request()/requestStream()/pushFile()), which
      // may immediately send() whatever's next in queue -- don't null out this.pending afterward
      // (that would clobber the newly-sent request's own pending state). close() below tears down
      // that request too via handleClose(), same as any other pending/queued request on close.
      this.pending.reject(new Error("Request timed out"));
      this.close();
    }
  }
}
