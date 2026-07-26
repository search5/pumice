import type { ButtonComponent } from "obsidian";

// ButtonComponent#setWarning() is marked @deprecated (steering toward setDestructive(), added in
// Obsidian 1.13.0) but is still the only destructive-button styling available on this plugin's
// minAppVersion floor (1.12.7). Routed through an unknown-cast duck-typed call rather than an
// eslint-disable comment, since eslint-comments/no-restricted-disable blocks suppressing
// @typescript-eslint/no-deprecated outright -- this is what actually keeps the warning from
// firing while still calling the exact method Obsidian provides pre-1.13.0.
export function setButtonWarning(btn: ButtonComponent): void {
  (btn as unknown as { setWarning: () => void }).setWarning();
}
