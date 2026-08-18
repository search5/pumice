import { moment } from "obsidian";
import type { Moment } from "moment";

// Must keep going through "obsidian"'s moment (not import moment directly from the "moment"
// package) -- Obsidian configures that instance to match the user's own language setting, and a
// vanilla import would silently drop that locale-awareness. Only the static Moment type comes
// from the "moment" package itself.
export function toMoment(ts: number): Moment {
  return moment(ts);
}
