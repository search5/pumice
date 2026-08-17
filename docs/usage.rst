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
     - Enable if your server is reachable over HTTPS/WSS. Recommended for
       anything beyond localhost — see the TLS note in :doc:`prerequisites`.

Authenticating
^^^^^^^^^^^^^^^^

Click **Log in** in the Authentication row. This opens your server's login page
in your system browser; once you sign in there, it hands a device token back to
Obsidian automatically via an ``obsidian://`` callback — there's no token to
copy/paste. The token is stored in Obsidian's own secure secret storage, never
written to your vault or synced anywhere.

Once a token is set, the row shows **Delete** instead, letting you revoke it
from this device (you can also revoke any device's session from
pumice-server's own device-management UI). A **Connection status** line
below it shows the live state of the sync connection itself — this is
where you'd see the connection is up, reconnecting, or stuck.

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
   * - Sync installed plugins
     - Syncs your installed community plugins themselves —
       ``.obsidian/plugins/**`` code, manifests, and which ones are
       enabled. Off by default: this syncs *executable code*, not just
       data, so it's an explicit opt-in.
   * - Include plugin settings
     - Only shown once the setting above is on. Also syncs each plugin's
       own ``data.json``. Gated separately from the toggle above because a
       plugin's ``data.json`` commonly holds API keys or other secrets in
       plain text — decide deliberately whether those should leave this
       device.
   * - Ignore patterns
     - Paths excluded from sync, one per line, glob patterns supported. The
       default list excludes Obsidian's own workspace/cache state and
       ``.trash`` — files that are local-machine-specific or throwaway by
       nature.

Running a sync
-----------------

Once you're logged in, Pumice keeps one persistent connection to the server
open for as long as Obsidian is running (see :doc:`architecture`) — there's
no "auto sync interval" or "sync on startup" toggle to configure, because
syncing isn't something that happens on a timer anymore:

* **Local edits** are picked up and pushed shortly after you save, on a
  short debounce delay, so changes propagate without you having to
  remember to trigger anything.
* **Changes from other devices** arrive the same way in reverse — pushed to
  this device the moment another device uploads them, over the same open
  connection, not on the next scheduled poll.
* **A safety-net sync** runs in the background regardless (about every 30
  seconds), so anything a dropped push notification might have missed
  never stays out of sync for long.
* You can still trigger one manually at any time: the refresh-icon ribbon
  button, or the **Sync now** command (Command Palette or **Settings →
  Pumice → Run sync → Sync now**) — useful right after reconnecting, or
  just to confirm everything's caught up.

A sync compares local vs. server state (delta) and reconciles deletions
first, then uploads changed local files and downloads changed remote files
*concurrently* — a file is only ever an upload or a download in the same
pass, never both, so the two directions never race each other.

If the connection drops (network blip, server restart), Pumice reconnects
automatically with backoff, and catches up on just what it missed rather
than rescanning the whole vault.

Diagnostics log
^^^^^^^^^^^^^^^^^^

**Settings → Pumice → Run sync → Diagnostics log**, or the **Open sync
diagnostics log** command, opens a running log of what the sync connection
has actually been doing — skipped self-triggered events, retry attempts,
queued syncs, and similar detail below what a normal notice would surface.
It's local to this device (kept in Obsidian's own per-vault local storage,
capped at the most recent 300 entries), with **Copy** and **Clear** buttons.
Reach for it before filing an issue about sync behaving oddly — it's usually
the fastest way to see what actually happened.

Conflict resolution
----------------------

Text files (``.md``, ``.json``, ``.css``, ``.js``, ``.base``, ``.canvas``)
always attempt a **three-way merge** first, the same algorithm ``git``
uses: each side's changes are compared against the version both sides last
agreed on. Non-overlapping changes merge automatically and get re-uploaded
on the next sync — nothing is lost, nothing needs your attention. If both
sides changed the *same* lines, only that region gets inline ``<<<<<<<`` /
``=======`` / ``>>>>>>>`` conflict markers (like a ``git`` merge conflict);
everything else in the file still merges normally around it. Either way, a
backup of your pre-merge local copy is kept as
``<name>.sync-conflict-<timestamp>.<ext>``. Resolve any marked section and
save — that save is what triggers re-uploading it.

**Conflict resolution** in settings only comes into play when a three-way
merge *isn't* possible — a non-text file, or a text file with no prior
synced version to compare both sides against:

.. list-table::
   :header-rows: 1

   * - Mode
     - Behavior
   * - Server wins
     - The server's version overwrites the local one. Your local copy is
       still backed up first, as ``<name>.sync-conflict-<timestamp>.<ext>``
       — nothing is silently lost.
   * - Client wins
     - The local version is kept as-is; the incoming server version for
       that file is skipped for this sync.

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

Vault sharing
----------------

Vault sharing gives someone else the **same full read/write sync access you
have** to this vault — there's no separate view-only role; this is about
syncing, not about the selective, read-only publishing covered in
:doc:`publish`.

.. list-table::
   :header-rows: 1

   * - Control
     - What it does
   * - Manage sharing…
     - Opens a dialog to invite people by email (shown when you're not
       already syncing someone else's shared vault). You can see pending
       vs. accepted invites here, and revoke access at any time.
   * - Sync someone else's vault
     - The flip side — accept an invite by entering the owner's username
       here instead of your own. Your local vault folder still needs the
       exact same name as theirs (see :doc:`prerequisites`).
   * - Leave this shared vault
     - Shown once **Sync someone else's vault** is set — stops syncing
       that vault and returns this device to syncing its own.

.. note::

   If E2EE is enabled on a shared vault, the encryption password isn't part
   of the invite — share it with the other person yourself, out of band,
   the same way you'd set it up on any additional device of your own.

For local snapshots and version history — Pumice's two complementary safety
nets around sync — see :doc:`history`. For selectively publishing notes to a
public site (a completely separate, read-only concept from vault sharing
above), see :doc:`publish`.
