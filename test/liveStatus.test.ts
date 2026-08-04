import { describe, expect, it } from "vitest";
import { describeLiveStatus, type LiveConnectionState } from "../src/liveStatus";

describe("describeLiveStatus", () => {
  const states: LiveConnectionState[] = ["disabled", "connecting", "connected", "reconnecting"];

  it("returns an icon and label key for every state", () => {
    for (const state of states) {
      const display = describeLiveStatus(state);
      expect(display.icon).toBeTruthy();
      expect(display.labelKey).toBeTruthy();
      expect(display.labelFallback).toBeTruthy();
    }
  });

  it("uses a distinct label key per state", () => {
    const labelKeys = states.map((state) => describeLiveStatus(state).labelKey);
    expect(new Set(labelKeys).size).toBe(states.length);
  });

  it("only the connected state uses the connected icon", () => {
    expect(describeLiveStatus("connected").icon).toBe("wifi");
    for (const state of states.filter((s) => s !== "connected")) {
      expect(describeLiveStatus(state).icon).not.toBe("wifi");
    }
  });
});
