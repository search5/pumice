// bookmarks.json and community-plugins.json: when this device's content is identical to what the
// server holds, the local file's own mtime is set to the *server's* stored mtime (and that mtime is
// what gets reported), not left at whatever time the file was last rewritten, so every device
// shows the same mtime for the same content. (The server's Delta compares hashes before mtimes, so
// this does not change what gets synced -- it only keeps the mtimes consistent.)
//
// The same two files are also merged *on the server only* (pumice-server's config_merge.py): a push
// names the version it was based on (`baseHash`), the server 3-way merges against its current
// version, and clients just download the result -- they never merge these files themselves.
// These two files are exempt from E2EE (the server must be able to read them to merge them).
// Pure -- no Vault/Adapter dependency.

export function isServerMtimePinnedPath(path: string, configDir: string): boolean {
  return path === `${configDir}/bookmarks.json` || path === `${configDir}/community-plugins.json`;
}

export interface LastSyncedEntry {
  hash: string;
  mtimeMs?: number;
}

// `entry` is what this device last confirmed in sync with the server (hash + the mtime the server
// holds for it). Only when the local content hash still equals that hash is the server's mtime
// reported; any real local edit reports the file's own mtime as before.
export function resolveReportedMtime(entry: LastSyncedEntry | null, localHash: string, localMtime: number): number {
  if (entry && entry.mtimeMs !== undefined && entry.hash === localHash) return entry.mtimeMs;
  return localMtime;
}
