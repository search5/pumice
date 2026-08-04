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
