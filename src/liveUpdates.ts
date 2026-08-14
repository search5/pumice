// Pure helpers for the SSE-based live-update loop (GET /watch on the server, see
// #10_실시간_변경_알림_구현_계획.md) -- deliberately free of fetch()/DOM dependencies so they're
// unit-testable without a real network connection.

export interface SseExtractResult {
  /** Whether at least one "data: changed" frame was found in this call. */
  changed: boolean;
  /** Leftover bytes after the last complete frame -- feed back in with the next chunk, since a
   * single reader.read() call can split a frame mid-way. */
  remainder: string;
}

/**
 * Pulls every complete SSE frame (terminated by a blank line, i.e. "\n\n") out of `buffer`.
 * ": keepalive" / ": connected" comment frames (watch_resource.py's heartbeat/initial frame) are
 * recognized and ignored -- they only exist to keep the connection alive through intermediaries,
 * not to trigger anything.
 */
export function extractSseFrames(buffer: string): SseExtractResult {
  let remainder = buffer;
  let changed = false;
  let sep: number;
  while ((sep = remainder.indexOf("\n\n")) !== -1) {
    const frame = remainder.slice(0, sep);
    remainder = remainder.slice(sep + 2);
    if (frame.startsWith("data: changed")) changed = true;
  }
  return { changed, remainder };
}

/** Exponential backoff with a cap -- doubles each call, never exceeds maxMs. */
export function nextBackoffMs(currentMs: number, maxMs: number): number {
  return Math.min(currentMs * 2, maxMs);
}

// 2026-08 Obsidian core reconnect fidelity follow-up (see
// #14_옵시디언싱크_정렬_구현계획.md): core's own reconnect backoff isn't just `base * 2^n` --
// it also multiplies by a ±50% random jitter factor each attempt, so many clients that dropped
// at the same moment (e.g. a server restart) don't all retry in lockstep (thundering herd).
// Deliberately kept separate from nextBackoffMs() above rather than folded into it: the stored
// backoffMs a caller carries between retries stays a clean deterministic doubling sequence, and
// jitter is instead applied fresh at each actual use site (see main.ts's runLiveUpdateLoop) --
// matching how core recomputes its own jitter per attempt rather than persisting a jittered
// value forward. randomFn is injectable so this stays unit-testable without mocking global
// Math.random.
export function applyJitter(ms: number, randomFn: () => number = Math.random): number {
  return ms * (0.5 + randomFn());
}

// How often runLiveUpdateLoop forces a sync while the live connection is up, independent of
// whether a push notification actually arrived -- mirrors Obsidian core's own Sync client
// (`window.setInterval(this.requestSync.bind(this), 3e4)`, confirmed via obsidian.asar v1.13.6,
// see #14_옵시디언싱크_정렬_구현계획.md). This is pumice's only periodic re-sync mechanism now
// (the old opt-in autoSync timer, and syncOnStartup with it, were both removed as redundant --
// see settings.ts) -- without it, a lost/dropped push notification would go unnoticed until the
// next manual sync.
export const LIVE_SYNC_SAFETY_NET_INTERVAL_MS = 30_000;
