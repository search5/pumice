# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

## [0.0.35] - 2026-08-15

### Added

- `WsSyncTransport`: a pure client-side WebSocket protocol layer replacing
  gRPC-Web, modeled on Obsidian core Sync's own protocol (reverse-engineered
  from the shipped app for design/behavior reference only, never copied) —
  delta/upload/download/ping all go over one persistent connection.
- An always-on live connection: the plugin now connects automatically
  whenever a token is stored, matching real Obsidian core Sync, replacing
  the old opt-in "Live updates" toggle and the auto-sync-interval/
  sync-on-startup settings (redundant with the existing 30s safety-net sync,
  which core doesn't expose as a setting either).
- The status bar now shows an icon-only sync state
  (disabled/connecting/syncing/synced/error) with a hover tooltip, matching
  real Obsidian core Sync's own icon/state precedence — extracted directly
  from the shipped app rather than guessed — in place of the previous
  icon+inline-text connection indicator.
- File pushes dedup by content hash (`pushFile`), matching Obsidian core's
  own `push` op: if the server already has the exact content elsewhere in
  the vault, no bytes are sent.
- Reconnects resume via a `lastKnownChangeId` version catch-up instead of a
  full rescan, with a ±50% jittered reconnect backoff, both matching
  Obsidian core (confirmed via `obsidian.asar` analysis).
- `size`/`purge`/`usernames` WS ops plumbed through `SyncTransport`/
  `SyncClient`; per-file metadata carried in change-push notifications, with
  `applyPushedFileChange()` applying just the one pushed file instead of
  triggering a full resync.
- `@vitest/coverage-v8`, with `syncClient.ts` coverage driven from 16.69% to
  89.18% (87 new tests) via `test/obsidianTestStub.ts` + a vitest `"obsidian"`
  alias that finally let it run under a test environment at all.

### Changed

- `getFileHistory`/`downloadHistoryVersion`/`restoreHistoryVersion` migrated
  off REST onto WS.
- Automatically-triggered syncs (the 30s safety net, the debounced
  local-edit sync) no longer pop Notice toasts, matching core's quiet
  background behavior — only manual syncs (ribbon icon, command palette)
  show interactive feedback now. Failures are still logged to the sync
  diagnostics log either way.
- The general "Publish changes" scan no longer treats a file as eligible just
  because it sits under a configured "included folder" — only an explicit
  `publish: true` (to publish) or `publish: false` (to cancel) in a file's own
  frontmatter decides what shows up in the list now. Folders can still be
  marked "included" from the file/folder context menu, but that setting no
  longer changes which files appear.

### Removed

- Client-side protobuf/gRPC-Web codegen and build tooling (`sync.proto`,
  generated stubs, the `grpc-web`/`google-protobuf` dependencies) — the
  production bundle drops from 303KB to 158KB.
- The `liveUpdates`/`autoSync`/`syncIntervalSeconds`/`syncOnStartup` settings.

### Fixed

- The initial WS `init` handshake had no timeout at all, so a server that
  never answered hung the connection forever with no user feedback. Fixed by
  starting the heartbeat poll before `connect()` resolves, guarded so it
  never sends a premature idle ping before `init` actually succeeds.
- Pressing Tab inside this plugin's Settings tab now moves focus to the next
  field, as expected. (Obsidian's own Settings modal otherwise intercepts Tab
  and repurposes it as row-jump navigation; this plugin now stops that
  interception from reaching it.)
- "Publish current file" (the file context-menu action) now correctly cancels
  (unpublishes) a file whose frontmatter is `publish: false`, instead of only
  ever offering to publish. A file with no `publish` field at all is still
  blocked with an error, since there's no way to tell what was intended.
