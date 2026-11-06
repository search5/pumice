// Pure helpers keeping a WS connection *attempt* from wedging the live-update loop -- no Obsidian
// or timer-API dependency (timers are injected), so they're testable the same way wsTransport.ts is.
//
// Background: main.ts only publishes `wsTransport` after connect() succeeds, so code that closed
// "the current connection" (disconnectTransport(), the online/offline handlers) never touched an
// attempt still in flight. disconnectTransport() also cleared that attempt's heartbeat timer --
// the only thing that enforces the connect/init timeouts -- so an attempt whose socket produced
// neither onerror/onclose nor an init response stayed pending forever, and runLiveUpdateLoop()
// (which awaits getTransport()) never retried.

export interface Closable {
  close(): void;
}

// Tracks the connection currently being established separately from the established one, so
// "drop the connection" can reach both.
export class ConnectionSlots<T extends Closable> {
  attempt: T | null = null;
  established: T | null = null;

  closeAll(): void {
    const attempt = this.attempt;
    const established = this.established;
    this.attempt = null;
    this.established = null;
    attempt?.close();
    if (established && established !== attempt) established.close();
  }
}

export interface DeadlineTimers {
  set(cb: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

// Overall cap on one connect attempt, independent of the heartbeat timer: on expiry the attempt is
// closed (which makes connect() reject), so the caller's retry/backoff path always gets control back.
export async function connectWithDeadline<R>(
  connect: Promise<R>,
  abort: () => void,
  deadlineMs: number,
  timers: DeadlineTimers
): Promise<R> {
  const handle = timers.set(abort, deadlineMs);
  try {
    return await connect;
  } finally {
    timers.clear(handle);
  }
}
