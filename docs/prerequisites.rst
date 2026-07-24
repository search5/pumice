Prerequisites
=============

Before installing the plugin, make sure the following are in place.

A running pumice-server instance
---------------------------------

Pumice is a client only — it needs a `pumice-server
<https://github.com/search5/pumice-server>`_ instance to sync with, and there is no
hosted/managed option. You (or someone on your team) must run one yourselves.

See pumice-server's own README for setup (Docker image on GHCR, or run directly with
``uv``). Once it's running, you'll need:

* The server's host/address and port.
* An account on that server. New accounts are created by an admin (via the admin
  dashboard or the API) — there's no self-service sign-up.

Obsidian 1.12.7 or later
--------------------------

Pumice's settings tab uses Obsidian's declarative settings API where available
(1.13.0+), with a classic fallback UI for versions between 1.12.7 and 1.13.0. Check
your Obsidian version under **Settings → About**, and update if needed.

.. note::

   **Mobile users:** Obsidian's desktop and mobile apps don't always update at the
   same pace, and app-store rollout can lag behind the desktop release. If a Pumice
   update fails to install on your phone/tablet, check **Settings → About** there
   specifically — you may need to update Obsidian itself (not just Pumice) first.

Network reachability
----------------------

The device running Obsidian needs to be able to reach the server's host/port —
same LAN, VPN, or a public address, depending on how you've deployed
pumice-server. If you're syncing from outside your home/office network, you'll
need the server reachable from the internet (directly, via VPN, or behind a
reverse proxy).

.. note::

   **TLS is optional but recommended for anything beyond localhost**, and it
   unlocks an additional feature: when the server is reachable over TLS, large
   uploads stream directly instead of being split into batches (see
   :doc:`architecture`). Without TLS, sync and publish both still work fully —
   uploads just fall back to the batched path.

A quick mental model before you dive in
------------------------------------------

**The vault's folder name is its identity on the server.** There's no separate
vault ID — the vault's folder name is used as-is to key everything server-side
(sync, publish, version history). Every device syncing the same vault needs a
folder with the exact same name; a mismatch isn't rejected, it just syncs as an
unrelated vault. Keep this in mind when setting up a second device.

Continue to :doc:`installation`.
