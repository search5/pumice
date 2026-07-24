Troubleshooting & FAQ
=======================

Plugin won't install or update
---------------------------------

**Symptom:** Installing or updating Pumice fails, especially on mobile,
even though the same version installs fine on desktop.

**Cause:** Pumice's ``minAppVersion`` may be newer than the Obsidian *app*
installed on that device. Desktop and mobile Obsidian don't always update
at the same pace — app-store rollout in particular can lag behind the
desktop release by days or weeks.

**Fix:** Check **Settings → About** on the device having trouble, and
update Obsidian itself there (via the App Store/Play Store on mobile) before
retrying the plugin install/update.

"Test connection" fails
---------------------------

**Symptom:** Clicking **Test connection** in settings fails, or sync never
completes.

**Fix:** Work through, in order:

1. Double-check **Server address** and **Server port** match what
   pumice-server is actually configured for.
2. Confirm the device running Obsidian can reach that host/port at all —
   same network, VPN connected, firewall not blocking it.
3. If **Use TLS** is on, make sure the server is actually reachable over
   HTTPS at that address (a plain-HTTP server with TLS toggled on in
   settings will fail the handshake).
4. Confirm you're logged in (**Settings → Pumice → Authentication** should
   show a **Delete** button, not **Log in**) — an expired or deleted token
   fails the same way as a network problem.

A vault syncs, but two devices never see each other's changes
-------------------------------------------------------------------

**Cause:** The two devices' vault folders don't have the *exact* same
name. Since the folder name is the vault's whole identity on the server
(see :doc:`prerequisites`), a mismatch isn't rejected with an error — it just
syncs as two unrelated vaults, each happily syncing with itself.

**Fix:** Rename one vault's folder to match the other exactly, then sync
again.

Downloaded files are unreadable garbage
-------------------------------------------

**Cause:** End-to-end encryption is enabled, and this device's **Sync
encryption password** doesn't match the password used on whichever device
originally uploaded that content. The server only ever stores ciphertext,
so a password mismatch downloads real ciphertext that this device can't
decrypt.

**Fix:** Re-enter the same encryption password on every device syncing this
vault (**Settings → Pumice → Security**). See :doc:`usage` for how E2EE is
scoped per-device.

"Publish current file" shows a message instead of publishing
-------------------------------------------------------------------

This is expected, not a bug — see :ref:`Force-publishing a single file` in
:doc:`publish`. Add ``publish: true`` to the note's frontmatter and try
again.

A large publish/sync feels slower on one device than another
-------------------------------------------------------------------

**Cause:** Likely the streaming-upload fast path (see :doc:`architecture`)
isn't available on that specific device — either the server isn't
configured for TLS, or the device's browser engine doesn't support
streaming request bodies yet (notably, Obsidian's iOS app only gained this
with iOS/iPadOS 26.4). This isn't a failure: uploads still complete
correctly over the batched fallback path, just less efficiently for very
large vaults.

**Fix (optional):** Put pumice-server behind TLS if it isn't already, and/or
update the device's OS, if you want the faster path there too.

Still stuck?
---------------

Open an issue on `GitHub <https://github.com/search5/pumice/issues>`_ with
your Obsidian version (desktop and/or mobile), Pumice version, and what
you've already tried.
