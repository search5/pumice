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
     - Python (``asyncioreactor`` + ``grpc.aio`` + Twisted), see
       `pumice-server <https://github.com/search5/pumice-server>`_.
   * - Transport
     - gRPC-Web (HTTP/2 multiplexing, bidirectional streaming) for the core
       sync protocol; a hand-rolled ``fetch()`` streaming path for large
       uploads when TLS is available (see the section below); plain
       HTTP/REST for publish, version history, and account endpoints.
   * - Auth
     - A single device token per login, stored in Obsidian's own secret
       storage (``App#secretStorage``) — no platform-specific keychain code,
       works the same on desktop and mobile.

Transport: gRPC-Web and the streaming fallback
--------------------------------------------------

Most sync traffic (the file delta comparison, batched uploads, downloads,
version-history calls) rides over **gRPC-Web**: many files travel
concurrently over a single HTTP/2 connection instead of one request per
file, and both client (``grpc-web``) and server (a Twisted ``Resource``
speaking the protocol natively, not a separate proxy) support it directly.

Uploads have a second path on top of that. Browsers' ``fetch()`` API can
stream a request body as it's produced (rather than buffering the whole
thing in memory first) — but only when the connection is HTTPS *and*
negotiates HTTP/2, and only in browser engines that implement it at all
(Chromium-based engines have supported it since 2022; WebKit/Safari only
gained support in version 26.4, which matters specifically for Obsidian's
iOS app, since it embeds the system WebKit engine via Capacitor rather than
shipping its own).

Pumice detects this support at runtime (a standard feature-detection
pattern: constructing a request with a stream body and checking whether the
``duplex`` option is actually read) and, when both the server is configured
for TLS *and* the current browser engine supports it, streams large uploads
directly instead of splitting them into batches. Everywhere else — HTTP
without TLS, or an engine without streaming-body support — falls back to the
same batched gRPC-Web path Pumice has always used, entirely transparently;
nothing about the UI or the resulting synced state differs between the two
paths.

Settings tab: two rendering paths, one set of settings
-----------------------------------------------------------

Obsidian 1.13.0 introduced a declarative settings API
(``getSettingDefinitions()``) that makes plugin settings appear in
Obsidian's own settings search. Since Pumice supports back to Obsidian
1.12.7, its settings tab implements *both*: the declarative API for 1.13.0+,
and the older imperative ``display()`` method as a fallback for versions
between 1.12.7 and 1.13.0 — Obsidian itself decides which one actually runs,
based on the running app's version, so both are kept behaviorally in sync by
hand in the plugin's source.

Vault identity
------------------

A vault's identity on the server is the pair (account username, vault
folder name) — there's no separate vault ID. The vault's folder name is
used as-is, which is why every device syncing the same vault needs a folder
with that exact name (see :doc:`prerequisites`).

Project structure
---------------------

.. code-block:: text

   pumice/
   ├── src/
   │   ├── main.ts                    # Plugin entry point
   │   ├── settings.ts                # Settings types and defaults
   │   ├── settingsTab.ts             # Settings panel UI (dual-path, see above)
   │   ├── syncClient.ts              # gRPC/HTTP client: sync, history, publish
   │   ├── syncHistoryModal.ts        # Version history UI
   │   ├── fileRecoveryModal.ts       # Local snapshot recovery UI
   │   ├── publishModal.ts            # Publish UI
   │   ├── localSnapshotStore.ts      # Local snapshot management (IndexedDB)
   │   ├── contentHashCache.ts        # Persists per-file content hashes
   │   ├── concurrency.ts             # Concurrency-limited async helpers
   │   ├── diffView.ts                # File diff rendering
   │   ├── swipeNavigation.ts         # Mobile swipe navigation
   │   ├── tokenStore.ts              # Auth token storage (App#secretStorage)
   │   ├── errorMessage.ts            # Error-to-string helper
   │   ├── i18n.ts, locales/          # Localization strings (Korean/English)
   │   └── generated/                 # Generated from sync.proto by protoc
   ├── sync.proto                     # gRPC schema
   ├── manifest.json                  # Obsidian plugin manifest
   └── esbuild.config.mjs             # Build configuration

See the repository's own `README
<https://github.com/search5/pumice/blob/main/README.md>`_ for build/release
tooling details.
