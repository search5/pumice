Installation
============

Make sure you have completed the steps in :doc:`prerequisites` first — in
particular, you'll need a running pumice-server instance and an account on it
before the plugin is useful.

**Pumice** can be installed in two ways: from Obsidian's Community Plugins
list, or by cloning the source repository and building it yourself.

Method 1 — Install from Community Plugins
-------------------------------------------

This is the simplest method for most users.

1. Open Obsidian and go to **Settings → Community plugins**.
2. Make sure community plugins are enabled, then click **Browse**.
3. Search for ``Pumice``, open it, and click **Install**.
4. Once installed, click **Enable**.

.. note::

   Pumice has not yet been manually reviewed by the Obsidian team (this shows
   up as a notice in the plugin's listing). This doesn't affect functionality —
   it's a status of the community review queue, not a warning about the plugin
   itself.

Method 2 — Clone the Git repository and build from source
-------------------------------------------------------------

Use this method if you want to build from a specific commit, contribute to the
plugin, or install it on a device without access to Community Plugins (for
example, to test an unreleased change).

**Requirements:** `Node.js <https://nodejs.org/>`_ (with npm) and ``protoc``
(the plugin talks to pumice-server over gRPC-Web, generated from
``sync.proto``).

.. code-block:: bash

   git clone https://github.com/search5/pumice.git
   cd pumice
   npm install
   npm run build

``npm run build`` produces ``main.js``, alongside the repo's existing
``manifest.json`` and ``styles.css``. Copy all three into
``<vault>/.obsidian/plugins/pumice/`` (create the folder if it doesn't exist),
then restart Obsidian and enable Pumice under **Settings → Community
plugins**.

.. note::

   For iterative development, ``npm run dev`` rebuilds ``main.js`` on every
   file change — combine it with Obsidian's own plugin reload (or a helper
   plugin like Hot Reload) instead of restarting Obsidian each time.

Updating
--------

If you installed via Community Plugins (Method 1), Obsidian will surface
available updates in **Settings → Community plugins** the same way it does
for any other plugin.

If you installed from source (Method 2), keep the plugin up to date by
pulling the latest changes and rebuilding:

.. code-block:: bash

   git pull
   npm run build

Then copy the three files over again and restart Obsidian.

Once installed, continue to :doc:`usage` to connect to your server.
