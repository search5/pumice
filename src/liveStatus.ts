// Pure display-mapping for the live connection's status bar/settings-tab indicator (main.ts's
// runLiveUpdateLoop()/syncNow()) -- no "obsidian" import, kept testable in isolation.
//
// State set and precedence deliberately mirror real Obsidian core Sync's own status model,
// reverse-engineered from the shipped app (/opt/Obsidian/resources/obsidian.asar, extracted and
// read directly -- see llm-wiki/12-*.md for the extraction and exact source excerpts). Core's
// SyncStore.getStatus() is:
//
//   !initialized        -> "uninitialized"
//   !vaultId             -> "disconnected"
//   error || fileRetry.length>0 -> "error"    (checked BEFORE syncing -- a persisting per-file
//                                               failure keeps showing as an error even while a
//                                               later sync attempt is actively retrying it)
//   pause                -> "paused"
//   syncing               -> "syncing"
//   else                  -> "synced"
//
// core's _updateStatusBar() then maps each to an icon + CSS status class (mod-working/
// mod-success/mod-error): uninitialized/syncing -> "sync-small" (mod-working), disconnected ->
// "refresh-cw-off" (mod-error), paused -> "paused" (mod-working), synced -> "check-small"
// (mod-success), error -> "sync-small" (mod-error, same icon as syncing -- distinguished only by
// color). "sync-small"/"check-small"/"paused" are icons the core Sync plugin registers for
// itself at runtime, not part of Obsidian's base bundled icon set, so not safely usable by a
// community plugin (confirmed absent from the base icon registry in app.js, unlike "refresh-cw"/
// "refresh-cw-off"/"check-circle-2", which are present and used here instead) -- and "error"
// gets its own distinct icon (alert-circle) rather than reusing the syncing icon, since a
// community plugin can't rely on core's internal mod-error color class to carry that
// distinction visually the way core's own status bar can.
//
// pumice has no "paused" (core's pause/resume toggle) or "uninitialized" (a brief pre-init
// moment) concept of its own, so those two are folded into the closest states pumice actually
// has: "uninitialized" behaves like "syncing" in core anyway (same icon+class), and there's
// nothing pumice-side to pause. "connecting" (WS handshake, including a reconnect attempt --
// core doesn't visually distinguish first-connect from reconnect either, both just show
// "syncing" with a "Connecting to server" tooltip) is pumice's own addition, standing in for
// core's brief pre-"initialized" window.
export type LiveConnectionState = "disabled" | "connecting" | "syncing" | "synced" | "error";

export interface LiveStatusDisplay {
  icon: string;
  labelKey: string;
  labelFallback: string;
}

const DISPLAY: Record<LiveConnectionState, LiveStatusDisplay> = {
  // core: "disconnected" (no vaultId configured) -- pumice's closest equivalent is no token.
  disabled: {
    icon: "refresh-cw-off",
    labelKey: "status.live-disabled",
    labelFallback: "Sync disabled",
  },
  // core: "syncing" state with syncStatus text "Connecting to server" (covers both first
  // connect and reconnect attempts -- core doesn't distinguish them visually either).
  connecting: {
    icon: "refresh-cw",
    labelKey: "status.connecting",
    labelFallback: "Connecting to server…",
  },
  // core: "syncing" (an actual sync operation, not just a socket handshake).
  syncing: {
    icon: "refresh-cw",
    labelKey: "status.syncing",
    labelFallback: "Syncing…",
  },
  // core: "synced".
  synced: {
    icon: "check-circle-2",
    labelKey: "status.synced",
    labelFallback: "Fully synced",
  },
  // core: "error" (this.error, or a file stuck retrying) -- pumice's analog is "the last sync
  // attempt failed, or finished with files still failing after in-sync retries," cleared again
  // only by a subsequent sync that completes clean. See main.ts's lastSyncFailed field.
  error: {
    icon: "alert-circle",
    labelKey: "status.sync-error",
    labelFallback: "Sync error",
  },
};

export function describeLiveStatus(state: LiveConnectionState): LiveStatusDisplay {
  return DISPLAY[state];
}
