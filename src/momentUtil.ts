import { moment } from "obsidian";
import type { Moment } from "moment";

// Must keep going through "obsidian"'s moment (not import moment directly from the "moment"
// package) -- Obsidian configures that instance to match the user's own language setting, and a
// vanilla import would silently drop that locale-awareness. Only the static Moment type comes
// from the "moment" package itself.
export function toMoment(ts: number): Moment {
  // This cast looks like a no-op wherever "obsidian" (a devDependency, so absent from a
  // deps-only install) resolves properly and moment(ts) is already Moment-typed; it's kept
  // because environments without it see moment(ts) as any, and this is what stops that any
  // from leaking into every caller.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- necessary in environments where "obsidian" isn't resolved
  return moment(ts) as Moment;
}
