Usage
=====

Connecting to your server
---------------------------

Open **Settings → Pumice**. The first section covers the connection itself:

.. list-table::
   :header-rows: 1

   * - Field
     - Description
   * - User name
     - Shown in sync history and version history, to tell devices/people apart.
   * - Device name
     - Shown the same way, to tell *this* device apart from your others.
   * - Server address
     - Hostname or IP of your pumice-server instance.
   * - Server port
     - Combined sync + HTTP port (``8080`` by default on pumice-server).
   * - Use TLS
     - Enable if your server is reachable over HTTPS. Recommended for anything
       beyond localhost — see the TLS note in :doc:`prerequisites`.

Authenticating
^^^^^^^^^^^^^^^^

Click **Log in** in the Authentication row. This opens your server's login page
in your system browser; once you sign in there, it hands a device token back to
Obsidian automatically via an ``obsidian://`` callback — there's no token to
copy/paste. The token is stored in Obsidian's own secure secret storage, never
written to your vault or synced anywhere.

Once a token is set, the row shows **Delete** instead, letting you revoke it
from this device (you can also revoke any device's session from
pumice-server's own device-management UI).

Click **Test connection** at any point to confirm the plugin can actually
reach the server with the current settings.

What to sync
--------------

.. list-table::
   :header-rows: 1

   * - Setting
     - Description
   * - Sync files
     - Syncs files and folders in the vault. You'd normally leave this on;
       it's separated out mainly so bookmark-only sync is possible.
   * - Sync bookmarks
     - Syncs Obsidian's own bookmarks (``.obsidian/bookmarks.json``).
   * - Ignore patterns
     - Paths excluded from sync, one per line, glob patterns supported. The
       default list excludes Obsidian's own workspace/cache state and
       ``.trash`` — files that are local-machine-specific or throwaway by
       nature.

Running a sync
-----------------

* **Manually**: the refresh-icon ribbon button, or the **Sync now** command
  (Command Palette or **Settings → Pumice → Sync now**).
* **Automatically**: enable **Auto sync** to run on a timer (interval
  configurable, minimum 10 seconds), and/or **Sync on startup** to run once
  when Obsidian launches.
* **On edit**: saving a file also schedules a sync a short debounce delay
  later, so changes propagate without you having to remember to trigger one.

A sync walks through, in order: comparing local vs. server state (delta),
reconciling deletions, uploading changed local files, then downloading
changed remote files.

Conflict resolution
----------------------

If a file changed on both sides since the last sync, **Conflict resolution**
decides what happens when the server's copy is about to be downloaded over a
locally-modified file:

.. list-table::
   :header-rows: 1

   * - Mode
     - Behavior
   * - Manual (default)
     - Your local copy is backed up alongside the original, as
       ``<name>.sync-conflict-<timestamp>.<ext>``, before the server's version
       is written in. Nothing is silently lost — review the conflict copy and
       merge/discard by hand.
   * - Server wins
     - The server's version simply overwrites the local one, no conflict copy.
   * - Client wins
     - The local version is kept as-is; the incoming server version for that
       file is skipped for this sync.

End-to-end encryption (E2EE)
-------------------------------

Enabling **End-to-end encryption** encrypts file contents with a symmetric key
(AES-256-GCM) on your device before they're ever sent to the server — the
server only ever sees ciphertext. Every device syncing this vault must be
configured with the same **Sync encryption password**; a mismatch means every
device just downloads content it can't decrypt.

The password itself is stored in Obsidian's secret storage, like the auth
token — it is never written into the vault's synced settings, so it isn't
propagated to other devices automatically. You need to enter it yourself on
each device the first time.

.. note::

   Turning E2EE on or off after files are already synced doesn't retroactively
   re-encrypt/decrypt what's already on the server. Treat it as a decision to
   make before the first sync of a given vault, not something to toggle back
   and forth.

For local snapshots and version history — Pumice's two complementary safety
nets around sync — see :doc:`history`. For selectively publishing notes to a
public site, see :doc:`publish`.
