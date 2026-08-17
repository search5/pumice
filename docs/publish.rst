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
* The **Publish a shared site…** command (Command Palette only) is for
  publishing to *someone else's* site you've been invited to collaborate on
  — see :ref:`Collaborating on someone else's site` below.

Which files are eligible
----------------------------

A note ends up in scope for publishing based on, in priority order:

1. **Explicit frontmatter wins outright** — a note with ``publish: true`` in
   its YAML frontmatter is eligible even if it sits under an excluded
   folder; ``publish: false`` excludes it even if it sits under an included
   one. Either way, frontmatter overrides whatever the folder settings would
   otherwise say.
2. Without explicit frontmatter, **excluded folders** win — a note under one
   is never eligible.
3. Otherwise, **included folders** decide: a note under one is eligible, a
   note under neither an included nor excluded folder is not.

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

Frontmatter properties Publish understands
------------------------------------------------

Beyond the ``publish`` flag itself, a note's YAML frontmatter can drive how
it's presented on the published site — matching what real Obsidian Publish
itself reads from frontmatter:

.. list-table::
   :header-rows: 1

   * - Property
     - Effect
   * - ``permalink``
     - Serves the note at this path instead of one derived from its
       filename.
   * - ``description``
     - Used for the page's meta description / social-preview text instead
       of an auto-generated excerpt.
   * - ``image``
     - Used as the page's social-preview image.
   * - ``aliases``
     - Each alias also redirects to the note, so old URLs (from a past
       filename or permalink) keep working after a rename.

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

Site options
---------------

Opened via the site-name link at the top of the review screen — this is
where most of a published site's behavior and appearance lives:

.. list-table::
   :header-rows: 1

   * - Option
     - What it does
   * - Custom slug
     - Changes the vault's segment of the published URL from its raw vault
       name to something else you choose.
   * - Custom domain
     - Serves the site from your own domain instead of
       ``<server>/publish/<username>/<vault>/`` — a small dialog collects
       the hostname and whether to redirect visitors from the old URL. Also
       gates ``publish.js`` and Google Analytics (see below).
   * - Site name
     - The published site's display name.
   * - Home page
     - Which note is served at the site's root, instead of an index/listing
       page.
   * - Logo
     - Replaces the default site icon in the header.
   * - Theme
     - Light, dark, or follow-system default for visitors, plus whether
       visitors get a theme toggle of their own.
   * - Hide from search engines
     - Adds a ``noindex`` directive so the site doesn't get crawled/indexed.
   * - Hide title / Readable line length / Strict line breaks / Sliding
       window mode
     - Rendering behavior toggles matching real Obsidian Publish's own
       equivalent site settings.
   * - Show navigation
     - Whether the published site shows a folder-tree sidebar at all; when
       on, **Customize sidebar** lets you reorder or hide individual
       top-level folders/files for visitors (independent of your own vault's
       actual folder order).
   * - Enable search
     - Whether the site's search box is shown.
   * - Google Analytics
     - A tracking ID to inject — only actually loads once a custom domain is
       configured (matches real Obsidian Publish's own gating; see
       pumice-server's own docs for the full reasoning).
   * - Password management
     - Add or remove one or more passwords; visitors must enter one to view
       the site.
   * - Manage sharing
     - See :ref:`Collaborating on a published site` below.

**Custom CSS and JavaScript**: publishing a file literally named
``publish.css``, ``publish.js``, ``obsidian.css``, or ``favicon.ico`` at
your vault's root is enough — no separate setting here, they're just
recognized filenames that flow through the same publish process as any
other file. See pumice-server's own `docs/PUBLISH_CSS.md
<https://github.com/search5/pumice-server/blob/main/docs/PUBLISH_CSS.md>`_
and `docs/PUBLISH_JS.md
<https://github.com/search5/pumice-server/blob/main/docs/PUBLISH_JS.md>`_
for what's actually overridable and (for ``publish.js``) the same
custom-domain requirement mentioned above.

Collaborating on a published site
----------------------------------------

Separate from :ref:`vault sharing <Vault sharing>` in :doc:`usage` (which
grants full read/write *sync* access) — this is narrower: **Manage
sharing** in site options invites someone by email to publish/unpublish
changes on *this one site*, without giving them any access to sync your
vault at all.

Collaborating on someone else's site
""""""""""""""""""""""""""""""""""""""""""

If you've been invited this way, the **Publish a shared site…** command
opens a picker listing every site you've been added to. Choosing one opens
the normal Publish review screen — same tree, same site options, same
**Publish** button — just scoped to that remote site instead of your own
vault.

Removing content
--------------------

A file that falls out of eligibility — deleted locally, moved out of an
included folder, or switched to ``publish: false`` — shows up in the review
screen as **to delete** rather than silently lingering on the server. Check
it like any other item and click **Publish** to remove it from the live
site.
