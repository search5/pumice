import { describe, expect, it } from "vitest";
import { pickDefaultDeviceName } from "../src/deviceName";

describe("pickDefaultDeviceName", () => {
  it("returns the hostname as-is when present", () => {
    expect(pickDefaultDeviceName("my-macbook")).toBe("my-macbook");
  });

  it("trims surrounding whitespace", () => {
    expect(pickDefaultDeviceName("  my-macbook  ")).toBe("my-macbook");
  });

  it("falls back to the generic label when undefined", () => {
    expect(pickDefaultDeviceName(undefined)).toBe("Obsidian Client");
  });

  it("falls back to the generic label for an empty string", () => {
    expect(pickDefaultDeviceName("")).toBe("Obsidian Client");
  });

  it("falls back to the generic label for a whitespace-only string", () => {
    expect(pickDefaultDeviceName("   ")).toBe("Obsidian Client");
  });
});
