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
   HTTPS/WSS at that address (a plain-HTTP server with TLS toggled on in
   settings will fail the handshake).
4. Confirm you're logged in (**Settings → Pumice → Authentication** should
   show a **Delete** button, not **Log in**) — an expired or deleted token
   fails the same way as a network problem.
5. If you're behind a corporate proxy or a restrictive firewall, confirm it
   actually allows WebSocket connections (an HTTP ``Upgrade`` handshake) to
   that host/port — some proxies pass plain HTTP through fine but block or
   silently strip the upgrade, which looks identical to the server being
   unreachable.

Sync connection keeps reconnecting, or changes take a while to show up
------------------------------------------------------------------------------

**Symptom:** The **Connection status** line (**Settings → Pumice**) cycles
between connected/reconnecting, or another device's changes take noticeably
longer than a few seconds to arrive.

**Cause:** The persistent sync connection (see :doc:`architecture`) dropped
and is reconnecting with backoff — usually a flaky network, a server
restart, or a proxy/load balancer timing out an idle connection sooner than
Pumice's own heartbeat expects.

**Fix:** Open the **Diagnostics log** (**Settings → Pumice → Run sync**, or
the **Open sync diagnostics log** command) — it shows the actual
connect/reconnect/retry sequence, which is the fastest way to tell a
transient blip from something worth investigating further (misconfigured
proxy timeout, server actually down, etc.). Even while reconnecting, nothing
is lost: once the connection re-establishes, Pumice catches up on exactly
what it missed rather than needing a full rescan.

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

**Cause:** Large downloads are split into batches (bounded by both byte
size and file count, see :doc:`architecture`) and each batch retries
independently on failure — a device on a slower or less reliable
connection will naturally take longer to work through the same batch list,
especially if some batches need a retry. This isn't a failure: nothing is
lost or corrupted, it just takes longer proportional to how many retries
were needed.

**Fix:** Usually nothing to do — it self-corrects as batches complete. If
one device is consistently far slower than the others, check its own
network path to the server first (same troubleshooting as **"Test
connection" fails**, above) rather than assuming something's
misconfigured on the server.

Still stuck?
---------------

Open an issue on `GitHub <https://github.com/search5/pumice/issues>`_ with
your Obsidian version (desktop and/or mobile), Pumice version, and what
you've already tried.
