import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WsSyncTransport } from "../src/wsTransport";
import type { WsLike } from "../src/wsTransport";
import { ConnectionSlots, connectWithDeadline } from "../src/connectionGuard";

// Socket that never errors, never closes and never answers init -- the "gateway swallowed the
// frames" case: nothing but a timeout can end the attempt.
class SilentWs implements WsLike {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  closeCalls = 0;
  send(): void {}
  close(): void {
    this.closeCalls++; // deliberately does NOT fire onclose, like a half-open socket
  }
}

const INIT = { token: "t", vaultId: "v", vaultOwner: "", deviceName: "d", userName: "u", clientVersion: "0", lastKnownChangeId: 0 };

function startAttempt() {
  const ws = new SilentWs();
  const transport = new WsSyncTransport(() => ws);
  const connect = transport.connect("ws://x/ws", INIT);
  // Avoid unhandled-rejection noise; tests assert on `connect` themselves.
  connect.catch(() => {});
  return { ws, transport, connect };
}

describe("ConnectionSlots.closeAll", () => {
  it("closes an in-flight attempt that is not yet the established transport (regression: hung connect after disconnectTransport)", async () => {
    const { ws, transport, connect } = startAttempt();
    ws.onopen?.(); // socket opened, init sent, no answer ever
    const slots = new ConnectionSlots<WsSyncTransport>();
    slots.attempt = transport;

    slots.closeAll();

    await expect(connect).rejects.toThrow("WebSocket connection closed");
    expect(ws.closeCalls).toBe(1);
    expect(slots.attempt).toBeNull();
  });

  it("closes both the attempt and the established transport, once each", () => {
    const a = { close: vi.fn() };
    const e = { close: vi.fn() };
    const slots = new ConnectionSlots<{ close(): void }>();
    slots.attempt = a;
    slots.established = e;
    slots.closeAll();
    expect(a.close).toHaveBeenCalledTimes(1);
    expect(e.close).toHaveBeenCalledTimes(1);
    expect(slots.established).toBeNull();
  });

  it("does not double-close when attempt and established are the same object", () => {
    const x = { close: vi.fn() };
    const slots = new ConnectionSlots<{ close(): void }>();
    slots.attempt = x;
    slots.established = x;
    slots.closeAll();
    expect(x.close).toHaveBeenCalledTimes(1);
  });
});

describe("connectWithDeadline", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const timers = {
    set: (cb: () => void, ms: number) => setTimeout(cb, ms),
    clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };

  it("aborts a hung attempt (no error, no close, no init response, no heartbeat) so the caller can retry", async () => {
    const { ws, transport, connect } = startAttempt();
    ws.onopen?.();
    const guarded = connectWithDeadline(connect, () => transport.close(), 30_000, timers);
    guarded.catch(() => {});

    await vi.advanceTimersByTimeAsync(29_999);
    expect(ws.closeCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);

    await expect(guarded).rejects.toThrow("WebSocket connection closed");
    expect(ws.closeCalls).toBe(1);
  });

  it("does not abort an attempt that succeeds before the deadline", async () => {
    const abort = vi.fn();
    const guarded = connectWithDeadline(Promise.resolve("ok"), abort, 30_000, timers);
    await expect(guarded).resolves.toBe("ok");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(abort).not.toHaveBeenCalled();
  });

  it("clears the deadline timer when the attempt fails on its own", async () => {
    const abort = vi.fn();
    const guarded = connectWithDeadline(Promise.reject(new Error("boom")), abort, 30_000, timers);
    await expect(guarded).rejects.toThrow("boom");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(abort).not.toHaveBeenCalled();
  });
});
