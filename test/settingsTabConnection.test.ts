import { describe, expect, it } from "vitest";
import { settingChangeRequiresReconnect } from "../src/settingsTabConnection";

describe("settingChangeRequiresReconnect", () => {
  it("is true when serverHost actually changes", () => {
    expect(settingChangeRequiresReconnect("serverHost", "old.example.com", "new.example.com")).toBe(true);
  });

  it("is true when serverPort actually changes", () => {
    expect(settingChangeRequiresReconnect("serverPort", 8080, 9090)).toBe(true);
  });

  it("is true when useTls actually changes", () => {
    expect(settingChangeRequiresReconnect("useTls", false, true)).toBe(true);
  });

  it("is false when the new value is identical to the old one", () => {
    expect(settingChangeRequiresReconnect("serverHost", "same.example.com", "same.example.com")).toBe(false);
  });

  it("is false for keys unrelated to the transport, even when they change", () => {
    expect(settingChangeRequiresReconnect("userName", "Alice", "Bob")).toBe(false);
    expect(settingChangeRequiresReconnect("deviceName", "Laptop", "Phone")).toBe(false);
  });
});
