import { describe, expect, it } from "vitest";
import { ManualSyncGate } from "../src/manualSyncGate";

describe("ManualSyncGate", () => {
  it("lets automatic sync and pushes through when no manual sync is running", () => {
    expect(new ManualSyncGate().shouldIgnoreAutomatic()).toBe(false);
  });

  it("ignores automatic sync and pushes for exactly as long as a manual sync runs", () => {
    const gate = new ManualSyncGate();
    gate.begin();
    expect(gate.active).toBe(true);
    expect(gate.shouldIgnoreAutomatic()).toBe(true);
    gate.end();
    expect(gate.active).toBe(false);
    expect(gate.shouldIgnoreAutomatic()).toBe(false);
  });

  it("ending without having begun is harmless", () => {
    const gate = new ManualSyncGate();
    gate.end();
    expect(gate.shouldIgnoreAutomatic()).toBe(false);
  });
});
