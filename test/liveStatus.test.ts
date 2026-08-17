import { describe, expect, it } from "vitest";
import { describeLiveStatus, type LiveConnectionState } from "../src/liveStatus";

describe("describeLiveStatus", () => {
  const states: LiveConnectionState[] = ["disabled", "connecting", "syncing", "synced", "error"];

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

  it("only the synced state uses the synced icon", () => {
    expect(describeLiveStatus("synced").icon).toBe("check-circle-2");
    for (const state of states.filter((s) => s !== "synced")) {
      expect(describeLiveStatus(state).icon).not.toBe("check-circle-2");
    }
  });

  it("only the error state uses the error icon", () => {
    expect(describeLiveStatus("error").icon).toBe("alert-circle");
    for (const state of states.filter((s) => s !== "error")) {
      expect(describeLiveStatus(state).icon).not.toBe("alert-circle");
    }
  });

  it("only the disabled state uses the disabled icon", () => {
    expect(describeLiveStatus("disabled").icon).toBe("refresh-cw-off");
    for (const state of states.filter((s) => s !== "disabled")) {
      expect(describeLiveStatus(state).icon).not.toBe("refresh-cw-off");
    }
  });

  it("connecting and syncing intentionally share the same icon, matching real Obsidian core Sync (which shows the same sync icon for a connection handshake and an actual sync operation)", () => {
    expect(describeLiveStatus("connecting").icon).toBe(describeLiveStatus("syncing").icon);
  });
});
