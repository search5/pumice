import { describe, expect, it } from "vitest";
import { applyJitter, extractSseFrames, nextBackoffMs } from "../src/liveUpdates";

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

describe("applyJitter", () => {
  it("returns exactly half at the lowest end of the random range (0)", () => {
    expect(applyJitter(1000, () => 0)).toBe(500);
  });

  it("returns the unmodified value at the midpoint of the random range (0.5)", () => {
    expect(applyJitter(1000, () => 0.5)).toBe(1000);
  });

  it("approaches one and a half times at the highest end of the random range (just under 1)", () => {
    expect(applyJitter(1000, () => 0.999)).toBeCloseTo(1499, 0);
  });

  it("defaults to Math.random when no randomFn is given, staying within the ±50% band", () => {
    for (let i = 0; i < 50; i++) {
      const result = applyJitter(1000);
      expect(result).toBeGreaterThanOrEqual(500);
      expect(result).toBeLessThan(1500);
    }
  });
});
