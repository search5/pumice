import { describe, expect, it } from "vitest";
import { extractSseFrames, nextBackoffMs } from "../src/liveUpdates";

describe("extractSseFrames", () => {
  it("extracts a single complete 'data: changed' frame", () => {
    const result = extractSseFrames("data: changed\n\n");
    expect(result.changed).toBe(true);
    expect(result.remainder).toBe("");
  });

  it("ignores a ': keepalive' comment frame", () => {
    const result = extractSseFrames(": keepalive\n\n");
    expect(result.changed).toBe(false);
    expect(result.remainder).toBe("");
  });

  it("ignores a ': connected' comment frame", () => {
    const result = extractSseFrames(": connected\n\n");
    expect(result.changed).toBe(false);
    expect(result.remainder).toBe("");
  });

  it("extracts multiple frames bundled into one chunk", () => {
    const result = extractSseFrames(": keepalive\n\ndata: changed\n\n: keepalive\n\n");
    expect(result.changed).toBe(true);
    expect(result.remainder).toBe("");
  });

  it("leaves a partial (not-yet-terminated) frame in the remainder", () => {
    const result = extractSseFrames("data: changed\n\ndata: cha");
    expect(result.changed).toBe(true);
    expect(result.remainder).toBe("data: cha");
  });

  it("returns no change and the whole buffer as remainder when nothing is complete yet", () => {
    const result = extractSseFrames("data: chan");
    expect(result.changed).toBe(false);
    expect(result.remainder).toBe("data: chan");
  });

  it("handles a frame split across two calls (remainder fed back in)", () => {
    const first = extractSseFrames("data: cha");
    expect(first.changed).toBe(false);
    expect(first.remainder).toBe("data: cha");

    const second = extractSseFrames(first.remainder + "nged\n\n");
    expect(second.changed).toBe(true);
    expect(second.remainder).toBe("");
  });

  it("returns no change for an empty buffer", () => {
    const result = extractSseFrames("");
    expect(result.changed).toBe(false);
    expect(result.remainder).toBe("");
  });
});

describe("nextBackoffMs", () => {
  it("doubles the current backoff", () => {
    expect(nextBackoffMs(1000, 60000)).toBe(2000);
  });

  it("caps at the maximum", () => {
    expect(nextBackoffMs(50000, 60000)).toBe(60000);
  });

  it("does not exceed the maximum even after several doublings", () => {
    expect(nextBackoffMs(60000, 60000)).toBe(60000);
  });
});
