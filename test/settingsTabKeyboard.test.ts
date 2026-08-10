import { describe, expect, it } from "vitest";
import { shouldStopTabPropagation } from "../src/settingsTabKeyboard";

// shouldStopTabPropagation -- see settingsTabKeyboard.ts for why: Obsidian's own core Settings
// modal intercepts Tab on an ancestor container and repurposes it as vim-style "jump to the
// next setting row" navigation instead of native focus traversal. Stopping propagation on Tab
// specifically (and only Tab) at our own containerEl restores normal Tab-to-next-field behavior
// inside our settings tab, without touching any other key.
describe("shouldStopTabPropagation", () => {
  it("is true for Tab", () => {
    expect(shouldStopTabPropagation("Tab")).toBe(true);
  });

  it("is false for other keys, including similarly-named ones", () => {
    expect(shouldStopTabPropagation("Enter")).toBe(false);
    expect(shouldStopTabPropagation("Escape")).toBe(false);
    expect(shouldStopTabPropagation("ArrowDown")).toBe(false);
    expect(shouldStopTabPropagation("tab")).toBe(false); // case-sensitive: KeyboardEvent.key is "Tab"
  });
});
