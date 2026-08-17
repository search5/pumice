Architecture
============

Overview
-----------

.. list-table::
   :header-rows: 1

   * -
     - Details
   * - Client
     - TypeScript, Obsidian community plugin (this repository).
   * - Server
     - Python (Pyramid, over a plain WSGI/HTTP server), see
       `pumice-server <https://github.com/search5/pumice-server>`_.
   * - Transport
     - A single persistent WebSocket per vault carries the entire sync
       protocol (delta, push/pull, live change notifications, version
       history) — see the section below. Publish's own served site
       (``/publish/<user>/<vault>/...``) and the account/admin API are
       plain HTTP/REST, separate from this connection.
   * - Auth
     - A single device token per login, stored in Obsidian's own secret
       storage (``App#secretStorage``) — no platform-specific keychain code,
       works the same on desktop and mobile.

Transport: one persistent WebSocket per vault
--------------------------------------------------

Every sync operation — delta comparison, file push/pull, version history
list/download/restore, size/purge/username lookups — rides the *same* single
WebSocket connection, opened once per vault and kept open for as long as the
plugin is configured, instead of one request per action. This intentionally
matches real Obsidian core Sync's own wire behavior (confirmed by reading
``obsidian.asar``, not guessed at): reference behavior only, reimplemented
independently — see ``11_websocket_동기화_프로토콜_설계.md`` for the original
design writeup.

.. note::

   This replaced an earlier gRPC-Web transport entirely. There is no
   ``.proto`` schema, no ``protoc`` code generation, and no HTTP/REST
   fallback left anywhere in the sync path — building the plugin no longer
   requires ``protoc`` (see :doc:`installation`).

**Handshake and framing.** The client opens the connection and sends an
``init`` message (device token, vault id, device/user name, the plugin's own
version, and the last change id it already knows about). The server replies
``init_ok`` (server version, server clock, max upload size) and the
connection is considered authenticated from then on. Control messages are
JSON text frames (``{op, payload}``); file bytes travel as raw, unwrapped
binary frames. There's no request-id multiplexing — like real Obsidian
Sync's own connection, exactly **one request is outstanding at a time**;
anything else queues client-side rather than racing multiple in-flight
requests over the same socket.

**Uploads.** A file push is a ``push_req`` (path, content hash, size)
followed by either a ``push_ack`` right away — if the server already has
that exact content elsewhere in the vault (a copy, a rename), it links the
existing bytes into place and never asks for a re-upload — or a
``push_res{needData: true}``, at which point the client sends the file as a
single binary frame.

**Downloads.** The need-download list is split into batches bounded by both
byte size and file count (a byte-only cap lets a handful of huge files
starve everything else out of the same batch; see ``batching.ts``), and each
batch is retried independently up to a fixed attempt count — a single bad or
oversized batch's failure only re-queues that batch's own paths, not the
entire download set.

**Live updates.** Because every device keeps its connection open, a change
one device pushes is broadcast to every other open connection for the same
vault immediately — no polling, no waiting for a scheduled sync. On top of
that, a fixed ~30-second safety-net sync runs alongside live push (mirrors
core Sync's own behavior), so a missed or dropped push notification is never
more than about half a minute from being caught anyway. A reconnect after a
dropped connection replays only what changed since the client's last known
change id, not a full vault rescan.

**Heartbeat and reconnect.** There's no dedicated internal timer; the caller
polls a heartbeat check periodically — a ping goes out after the connection
has been idle 10 seconds, and it's considered dead (and reconnected, with
exponential backoff plus jitter to avoid a reconnect stampede if the server
restarts) after 120 seconds idle. A single request that's been outstanding
more than 60 seconds tears down the whole connection rather than waiting
indefinitely, since a lost response and a wedged socket look identical from
the client's side.

**What didn't move.** Conflict resolution (including the three-way text
merge), end-to-end encryption, and writing files into the vault all still
live entirely in the sync client, transport-agnostic — only *how bytes
reach the server* changed. Content-hash dedup is now a property of the push
handshake itself rather than a separate mechanism layered on top.

Settings tab: declarative only
------------------------------------

Obsidian 1.13.0 introduced a declarative settings API
(``getSettingDefinitions()``) that makes plugin settings appear in
Obsidian's own settings search. Pumice requires Obsidian 1.13.4+, so its
settings tab implements only that declarative API — there's no older
imperative ``display()`` fallback to keep in sync by hand; ``settingsTab.ts``
declares the settings once via ``getSettingDefinitions()`` and Obsidian
renders them.

Vault identity
------------------

A vault's identity on the server is the pair (account username, vault
folder name) — there's no separate vault ID. The vault's folder name is
used as-is, which is why every device syncing the same vault needs a folder
with that exact name (see :doc:`prerequisites`). Vault sharing (see
:doc:`usage`) extends this rather than replacing it: a shared vault is
still keyed by (its owner's username, its folder name) — the person it's
shared with just points their own device at that same pair instead of
their own.

Project structure
---------------------

.. code-block:: text

   pumice/
   ├── src/
   │   ├── main.ts                       # Plugin entry point: ribbons, commands, wiring
   │   ├── settings.ts                   # Settings types and defaults
   │   ├── settingsTab.ts                # Settings panel UI (declarative, see above)
   │   ├── settingsTabKeyboard.ts        # Tab-key focus handling inside the settings modal
   │   ├── syncClient.ts                 # Sync orchestration: delta, conflict merge, E2EE
   │   ├── syncTransport.ts              # Transport-agnostic interface the sync client talks to
   │   ├── wsTransport.ts                # The WebSocket transport itself (see above)
   │   ├── wsSyncTransportAdapter.ts     # Adapts wsTransport to syncTransport's shape
   │   ├── liveUpdates.ts                # Reconnect/backoff loop, push-notification wiring
   │   ├── liveStatus.ts                 # "syncing/idle/error" status shown in the UI
   │   ├── syncHistoryModal.ts           # Version history UI
   │   ├── syncDiagnosticsModal.ts       # Diagnostics log viewer (see :doc:`usage`)
   │   ├── syncDiagnosticsLog.ts         # The log buffer that modal reads (capped, per-vault)
   │   ├── fileRecoveryModal.ts          # Local snapshot recovery UI
   │   ├── localSnapshotStore.ts         # Local snapshot management (IndexedDB)
   │   ├── contentHashCache.ts           # Persists per-file content hashes
   │   ├── lastSyncedHashStore.ts        # Last-synced-hash bookkeeping for delta comparison
   │   ├── batching.ts                   # Download batching (see above)
   │   ├── concurrency.ts                # Concurrency-limited async helpers
   │   ├── diffView.ts                   # File diff rendering
   │   ├── textFileTypes.ts              # Which extensions get text-aware merge/diff
   │   ├── publishModal.ts               # Publish UI, including site options
   │   ├── publishEligibility.ts         # Which notes are in scope to publish
   │   ├── navigationOrdering.ts         # Published site's sidebar ordering/visibility
   │   ├── vaultShareModal.ts            # Invite someone to full read/write vault sync
   │   ├── sharedSitePickerModal.ts      # Pick a site you've been invited to co-publish
   │   ├── siteCollaboration.ts          # Backing logic for the picker above
   │   ├── pluginSync.ts, pluginReload.ts # Optional syncing of installed plugins themselves
   │   ├── swipeNavigation.ts            # Mobile swipe navigation (version history)
   │   ├── tokenStore.ts                 # Auth token storage (App#secretStorage)
   │   ├── deviceName.ts, errorMessage.ts # Small shared helpers
   │   └── i18n.ts, locales/             # Localization strings (Korean/English)
   ├── manifest.json                     # Obsidian plugin manifest
   └── esbuild.config.mjs                # Build configuration

See the repository's own `README
<https://github.com/search5/pumice/blob/main/README.md>`_ for build/release
tooling details.
