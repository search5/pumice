// Deliberately free of any "obsidian" import (even type-only ones drag Vitest into trying to
// resolve that package, which has no real runtime module -- just a .d.ts -- see the resolver in
// settings.ts, which is the one file that actually needs Platform and is left untested for that
// reason).

/** Pure decision: given a hostname lookup result (undefined/empty on failure or mobile, where
 * Node's os module doesn't exist at all), decide the default device name. */
export function pickDefaultDeviceName(hostname: string | undefined): string {
  const trimmed = hostname?.trim();
  return trimmed ? trimmed : "Obsidian Client";
}
