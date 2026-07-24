Version history & local snapshots
===================================

Pumice keeps two independent, complementary safety nets around every file,
serving different purposes:

.. list-table::
   :header-rows: 1

   * -
     - Version history
     - Local snapshots
   * - Where it lives
     - On the server, alongside every other device's synced copy.
     - Only in this device's local Obsidian data — never synced or uploaded.
   * - When a version is captured
     - Every time a sync uploads a changed file.
     - On a timer while you edit, independent of sync.
   * - Survives a reinstall / new device
     - Yes — it's on the server.
     - No — it's local to this one installation.
   * - Retention
     - Kept indefinitely (server-side).
     - Auto-cleaned after a configurable number of days.

In short: version history is "what did the *server* see, and when," and local
snapshots are "what was I looking at a few minutes ago, before I next synced."
They're deliberately independent — disabling or losing one doesn't affect the
other.

Version history
------------------

Every time a sync uploads a changed file, pumice-server records a full backup
of the previous content before overwriting it (hard-linked on disk where
possible, so this doesn't multiply storage for unchanged bytes). That backup
is what Pumice's version history browser lets you look through and restore
from.

Opening version history
^^^^^^^^^^^^^^^^^^^^^^^^^^

With a file open, either:

* Click the **history** ribbon icon (**Open version history**), or
* Right-click the file (in the editor tab, file explorer, or more-options
  menu) and choose **Open version history**.

Browsing versions
^^^^^^^^^^^^^^^^^^^^

On desktop, the modal splits into a list (left) and a preview/diff pane
(right); on mobile, tapping a list entry slides into a full-screen preview,
and you can swipe left/right to step between revisions without going back to
the list each time.

The list groups nearby revisions together (close in time, same
device/user) rather than showing one row per raw save, and shows an avatar
per device/user so you can tell at a glance who made a given change and from
where. If a file was renamed or moved between two revisions, the entry calls
that out explicitly (e.g. "moved from ``old-folder/`` to ``new-folder/``," or
"renamed from ``old-name.md``") instead of silently showing unrelated-looking
history.

For any selected revision you can:

* **Preview** the content, with a diff toggle to see exactly what changed
  against the current version instead of the raw content.
* **Copy** the version's content to your clipboard.
* **Restore** it — this writes that revision's content back into your vault
  at its current path (decrypting first, transparently, if :ref:`E2EE
  <End-to-end encryption (E2EE)>` is enabled). Restoring the version
  that's already the newest is a no-op with a notice, not a wasted round
  trip. Restoring itself is also recorded as a new version, so it's never a
  destructive dead end — you can always go back further if a restore turns
  out to be the wrong one.

Local snapshots
------------------

Independent of any sync, Pumice watches the files you're actively working on
(``.md``, ``.canvas``, and ``.base`` files) and periodically saves a snapshot
of their content to a local database — the same idea as Obsidian core's own
File Recovery, implemented separately so it keeps working exactly the same
way regardless of whether core's own feature is installed, enabled, or
changes its storage format in some future Obsidian release.

A snapshot is taken when a file changes (on edit, on open, or on creation),
but throttled: at most one snapshot per file per **Save interval** (default 5
minutes), and skipped entirely if the content is identical to the last
snapshot — so idle files don't accumulate redundant copies. Snapshots older
than the **Retention period** (default 7 days) are cleaned up automatically
in the background.

Both of these are configurable under **Settings → Pumice → Local
snapshots**, along with a **Clear local snapshots** button that wipes every
saved snapshot immediately, if you want to start fresh.

Opening local snapshots
^^^^^^^^^^^^^^^^^^^^^^^^^^

Local snapshots don't have their own ribbon icon or command — they're reached
*from* version history. Open **version history** for a file (see above); if
that file has any local snapshots saved, an **Open saved snapshots** button
appears at the top of the list. From there, the browsing/preview/diff/copy
experience is the same as version history (including the same
desktop-split-view / mobile-swipe layout), but **Restore** here writes the
snapshot's content back into the file directly — there's no server
round-trip involved, since the snapshot never left this device.

.. note::

   Because local snapshots only exist on the device that took them, they
   won't show an "Open saved snapshots" button on a *different* device for
   the same file, even if that file has plenty of server-side version
   history. That's expected — check on the device where you were actually
   editing at the time.
