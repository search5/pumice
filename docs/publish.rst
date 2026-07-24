Publishing
==========

Pumice can selectively publish notes to a website served directly by
pumice-server, at ``http://<server>/publish/<username>/<vault>/`` (or
``https://`` if TLS is enabled) — no separate hosting, no third-party publish
service.

Opening the Publish modal
----------------------------

* The **paper-plane** ribbon icon, or the **Publish changes** command, opens
  the full review screen (see below) for the whole vault.
* Right-clicking a single file and choosing **Publish current file** opens
  the same modal already scoped to just that one file, skipped straight to
  ready-to-publish (see :ref:`Force-publishing a single file` below).
* Right-clicking a **folder** shows an **Included folders** toggle — a quick
  way to add/remove that folder from ``publishIncludeFolders`` without a trip
  through the settings modal.

Which files are eligible
----------------------------

A note ends up in scope for publishing based on, in priority order:

1. **Excluded folders** always win — a note under an excluded folder is never
   considered, no matter what its frontmatter says.
2. **Explicit frontmatter** — if a note has ``publish: true`` or ``publish:
   false`` in its YAML frontmatter, that decides it outright, overriding
   whether it happens to sit under an included/excluded folder.
3. Otherwise, **included folders** decide: a note under one is eligible, a
   note that's under neither an included nor excluded folder is not.

Included/excluded folders are managed under **Settings → Pumice** or via the
folder right-click menu; the same default exclude list used for sync
(``.obsidian/workspace``, ``.trash``, etc. — see :doc:`usage`) also applies
to publishing by default.

Force-publishing a single file
----------------------------------

**Publish current file** is an explicit, deliberate action — the file
uploads regardless of folder inclusion rules. It does, however, require the
frontmatter to actually say ``publish: true`` first:

.. note::

   If the file doesn't already have ``publish: true`` in its frontmatter,
   **Publish current file** shows a message asking you to add it, instead of
   publishing. This is deliberate, not a limitation: publishing is
   frontmatter-driven everywhere else in the plugin, so a file published this
   way *without* that frontmatter would go live on the server, yet silently
   fall out of scope the next time a folder-wide **Publish changes** scan
   runs (since that scan only sees frontmatter/folder-based eligibility) —
   effectively becoming impossible to update again through the normal UI.
   Setting the frontmatter first keeps the file consistently in scope going
   forward.

Folder-level inclusion doesn't have this requirement — it's already
considered an explicit, deliberate mechanism on its own.

The review screen
---------------------

Before anything uploads, you get a tree view (folders before files, matching
Obsidian's own file explorer convention) of every eligible change, grouped
into **New files**, **Changed files**, and **Already published files**
(unchanged, or marked for deletion). Checking/unchecking a folder toggles
every file under it at once; a partially-checked folder shows an
indeterminate state.

A few extras on this screen:

* **Search** filters the tree by filename as you type.
* **Include linked files** walks the wikilinks/embeds of your currently
  checked files and checks anything they link to as well, so you don't have
  to hunt down every image or note a page references by hand.
* The **filter** icon opens **Publish filters**, the same included/excluded
  folder settings described above, without leaving the modal.

Click **Publish** to upload every checked item, or **Cancel** to back out
without changing anything.

.. note::

   Large uploads stream directly to the server instead of being split into
   batches, when your server is reachable over TLS (see :doc:`architecture`
   for how this works and which clients support it). Either way, nothing
   about what you see in the review screen changes — this only affects
   transfer efficiency for big vaults.

Site options
---------------

Opened via the site-name link at the top of the review screen:

.. list-table::
   :header-rows: 1

   * - Option
     - What it does
   * - Custom slug
     - Changes the vault's segment of the published URL from its raw vault
       name to something else you choose.
   * - Password protection
     - Add one or more passwords; visitors must enter one to view the site.
   * - Sharing
     - Invite specific people by email to view the site without a password —
       they accept the invite once, then it just works for them going
       forward. You can see pending vs. accepted invites here, and revoke
       access at any time.

Removing content
--------------------

A file that falls out of eligibility — deleted locally, moved out of an
included folder, or switched to ``publish: false`` — shows up in the review
screen as **to delete** rather than silently lingering on the server. Check
it like any other item and click **Publish** to remove it from the live
site.
