import { describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import { SyncClient } from "../src/syncClient";
import { getDefaultSettings, type ConflictResolution } from "../src/settings";
import type { DownloadedFileWire, HistoryVersionEntry, SyncTransport } from "../src/syncTransport";
import type { LastSyncedHashStore } from "../src/lastSyncedHashStore";
import type { ContentHashCache } from "../src/contentHashCache";
import { fakeFileManager, fakeTransport, fakeVault, sha256, type FakeVault } from "./syncClientTestUtils";

// downloadFileBatch's conflict-resolution matrix (see 16_conflict_resolution_텍스트_상시병합.md):
// text files (isTextFilePath()) always attempt a 3-way merge first, unconditionally --
// settings.conflictResolution ("server-wins"/"client-wins") only decides the fallback, for
// non-text files or a text file with nothing to merge against. Everything here is what
// syncClientPush.test.ts explicitly left out of scope (see its own comment). Driven the same way
// that file drives the simple cases: through applyPushedFileChange(), the simplest public entry
// point that reaches downloadFileBatch.
//
// syncClientTestUtils.ts's makeClient() is deliberately minimal (settings.conflictResolution is
// always the default, and hashCache/lastSyncedHashStore are always undefined) -- fine for the
// existing push tests, but this file needs to vary both to exercise every branch. Rather than
// extending that shared helper (risking collisions with whatever else is touching it in this
// parallel coverage push), makeClientEx() below builds a SyncClient directly out of the same
// fakeVault/fakeTransport/fakeFileManager fakes, which is all this file needs.

const enc = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer;
const dec = (b: ArrayBuffer): string => new TextDecoder("utf-8").decode(b);

function makeClientEx(
  transport: SyncTransport,
  vault: FakeVault,
  fileManager: ReturnType<typeof fakeFileManager>,
  opts: {
    conflictResolution?: ConflictResolution;
    lastSyncedHashStore?: { get: (path: string) => Promise<string | null>; set: (path: string, hash: string) => void };
    hashCache?: { set: (file: TFile, hash: string) => void };
  } = {}
): SyncClient {
  const settings = {
    ...getDefaultSettings(vault.configDir),
    e2eePassword: "",
    ...(opts.conflictResolution ? { conflictResolution: opts.conflictResolution } : {}),
  };
  return new SyncClient(
    transport,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vault as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fileManager as any,
    "/plugins/pumice",
    "test-token",
    settings,
    {},
    async () => {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    opts.hashCache as any,
    undefined,
    undefined,
    undefined,
    undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    opts.lastSyncedHashStore as any
  );
}

// Simulates the server delivering exactly one file through downloadBatch, same frame-shape as
// syncClientPush.test.ts's download tests. Captures onFile's own return value too, since that's
// the only outside-visible signal of the "accepted, not a failure" contract for the client-wins
// skip case. applyPushedFileChange itself returns void.
function makeDownloadTransport(
  content: ArrayBuffer,
  contentHash: string,
  mtimeMs: number,
  overrides: Partial<SyncTransport> = {}
): { transport: SyncTransport; accepted: () => boolean | undefined } {
  let accepted: boolean | undefined;
  const transport = fakeTransport({
    downloadBatch: vi.fn(async (_vaultId: string, paths: string[], onFile: (f: DownloadedFileWire) => Promise<boolean>) => {
      accepted = await onFile({ path: paths[0], mtimeMs, data: content, contentHash });
      return { downloadedCount: accepted ? 1 : 0, failedPaths: accepted ? [] : [paths[0]] };
    }),
    ...overrides,
  });
  return { transport, accepted: () => accepted };
}

const conflictSuffixRegex = (ext: string): RegExp => new RegExp(`\\.sync-conflict-.*\\.${ext}$`);
const CONFLICT_BACKUP_RE = conflictSuffixRegex("md");

describe("SyncClient downloadFileBatch -- hash verification", () => {
  it("does not modify an already-existing local file when the downloaded content's hash is wrong", async () => {
    // syncClientPush.test.ts already covers the brand-new-file (createBinary) side of this; this
    // covers the other write path (modifyBinary, taken when the file already exists) which that
    // file doesn't touch.
    const data = enc("hello");
    const file = new TFile();
    file.path = "existing.md";
    const vault = fakeVault();
    vault.getAbstractFileByPath.mockImplementation((p: string) => (p === "existing.md" ? file : null));
    const { transport, accepted } = makeDownloadTransport(data, "wrong-hash", 1);
    const client = makeClientEx(transport, vault, fakeFileManager());

    await client.applyPushedFileChange({ path: "existing.md", modified_at_ms: 1, size_bytes: data.byteLength, content_hash: "wrong-hash", is_deleted: false });

    expect(accepted()).toBe(false);
    expect(vault.modifyBinary).not.toHaveBeenCalled();
    expect(vault.createBinary).not.toHaveBeenCalled();
  });
});

describe("SyncClient downloadFileBatch -- merge is unconditional for text, config only decides the fallback", () => {
  it("attempts a 3-way merge for a text file even when conflictResolution is server-wins", async () => {
    const base = "line1\nline2\nline3";
    const local = "line1-local\nline2\nline3";
    const remote = "line1\nline2\nline3-remote";
    const baseHash = await sha256(enc(base));
    const remoteData = enc(remote);
    const remoteHash = await sha256(remoteData);
    const path = "note.md";

    const history: HistoryVersionEntry[] = [
      { history_id: 7, modified_at_ms: 0, size_bytes: base.length, content_hash: baseHash, device_name: "d", user_name: "u", deleted: false },
    ];
    const { transport, accepted } = makeDownloadTransport(remoteData, remoteHash, 999, {
      getHistory: vi.fn(async () => history),
      downloadHistoryVersion: vi.fn(async () => ({ data: enc(base), path, contentHash: baseHash })),
    });

    const file = new TFile();
    file.path = path;
    const vault = fakeVault();
    vault.getAbstractFileByPath.mockImplementation((p: string) => (p === path ? file : null));
    vault.readBinary.mockResolvedValue(enc(local));

    const lastSyncedHashStore = { get: vi.fn(async () => baseHash), set: vi.fn() };
    // Configured resolution is deliberately "server-wins" -- if the merge attempt were still
    // gated by the configured value (only a "merge" mode used to attempt one), this would just
    // back up local and adopt the raw remote text. A genuinely new merged result (distinct from
    // both local and raw remote) proves the merge attempt is unconditional now.
    const client = makeClientEx(transport, vault, fakeFileManager(), { conflictResolution: "server-wins", lastSyncedHashStore });

    await client.applyPushedFileChange({ path, modified_at_ms: 999, size_bytes: remoteData.byteLength, content_hash: remoteHash, is_deleted: false });

    expect(accepted()).toBe(true);
    expect(transport.getHistory).toHaveBeenCalled();
    expect(vault.modifyBinary).toHaveBeenCalledTimes(1);
    const written = dec(vault.modifyBinary.mock.calls[0][1] as ArrayBuffer);
    expect(written).toBe("line1-local\nline2\nline3-remote");
    expect(written).not.toBe(remote);
  });

  it("never attempts a merge for a non-text file, even when a mergeable base hash/history is available", async () => {
    const remote = "remote content";
    const remoteData = enc(remote);
    const remoteHash = await sha256(remoteData);
    const path = "asset.bin";

    // A merge would succeed if it were ever attempted (a real lastSyncedHashStore + matching
    // history entry are provided) -- the point of this test is that it must never be attempted
    // at all for a non-text path, proving isTextFilePath() alone gates the attempt.
    const history: HistoryVersionEntry[] = [
      { history_id: 1, modified_at_ms: 0, size_bytes: 4, content_hash: "base-hash", device_name: "d", user_name: "u", deleted: false },
    ];
    const { transport } = makeDownloadTransport(remoteData, remoteHash, 5, {
      getHistory: vi.fn(async () => history),
    });

    const file = new TFile();
    file.path = path;
    const vault = fakeVault();
    vault.getAbstractFileByPath.mockImplementation((p: string) => (p === path ? file : null));
    vault.readBinary.mockResolvedValue(enc("local content"));

    const lastSyncedHashStore = { get: vi.fn(async () => "base-hash"), set: vi.fn() };
    const client = makeClientEx(transport, vault, fakeFileManager(), { conflictResolution: "server-wins", lastSyncedHashStore });

    await client.applyPushedFileChange({ path, modified_at_ms: 5, size_bytes: remoteData.byteLength, content_hash: remoteHash, is_deleted: false });

    expect(transport.getHistory).not.toHaveBeenCalled();
    // server-wins fallback: backup first, then overwrite with the raw remote content.
    expect(vault.createBinary).toHaveBeenCalledTimes(1);
    expect((vault.createBinary.mock.calls[0][0] as string)).toMatch(conflictSuffixRegex("bin"));
    expect(vault.modifyBinary).toHaveBeenCalledTimes(1);
    expect(dec(vault.modifyBinary.mock.calls[0][1] as ArrayBuffer)).toBe(remote);
  });
});

// These exercise the fallback branch specifically: no lastSyncedHashStore is provided, so
// tryAutoMergeConflict() returns null immediately (regardless of the path being text or not),
// leaving conflictResolution as the only thing deciding what happens. They do NOT contradict the
// "text always merges" tests above -- a merge is still attempted first every time, it just can't
// succeed here because there's no recorded base version to merge against.
describe("SyncClient downloadFileBatch -- client-wins (merge-fallback)", () => {
  it("skips a client-wins download when the file already exists locally, without failing it", async () => {
    const remote = "remote content";
    const remoteData = enc(remote);
    const remoteHash = await sha256(remoteData);
    const path = "existing.md";

    const file = new TFile();
    file.path = path;
    const vault = fakeVault();
    vault.getAbstractFileByPath.mockImplementation((p: string) => (p === path ? file : null));

    const { transport, accepted } = makeDownloadTransport(remoteData, remoteHash, 5);
    const client = makeClientEx(transport, vault, fakeFileManager(), { conflictResolution: "client-wins" });

    await client.applyPushedFileChange({ path, modified_at_ms: 5, size_bytes: remoteData.byteLength, content_hash: remoteHash, is_deleted: false });

    // "Deliberately not a failure -- retrying would only hit this same skip forever" (see the
    // code's own comment): the skip must still be reported as accepted, not a failed path.
    expect(accepted()).toBe(true);
    expect(vault.modifyBinary).not.toHaveBeenCalled();
  });

  // The local file always wins under client-wins, but the losing remote version must not just be
  // silently discarded -- back it up the same way server-wins backs up whichever side loses, so
  // a real edit made on another device is never lost, only deferred to a manual look.
  it("backs up the losing remote version as a conflict copy, without touching the local file", async () => {
    const remote = "remote content";
    const remoteData = enc(remote);
    const remoteHash = await sha256(remoteData);
    const path = "existing.md";

    const file = new TFile();
    file.path = path;
    const vault = fakeVault();
    vault.getAbstractFileByPath.mockImplementation((p: string) => (p === path ? file : null));

    const { transport, accepted } = makeDownloadTransport(remoteData, remoteHash, 5);
    const client = makeClientEx(transport, vault, fakeFileManager(), { conflictResolution: "client-wins" });

    await client.applyPushedFileChange({ path, modified_at_ms: 5, size_bytes: remoteData.byteLength, content_hash: remoteHash, is_deleted: false });

    expect(accepted()).toBe(true);
    // The local file itself is genuinely untouched -- client-wins means the main path keeps
    // exactly what's already there, no in-place modification.
    expect(vault.modifyBinary).not.toHaveBeenCalled();
    // The losing (remote) content lands in a new conflict-suffixed file instead.
    expect(vault.createBinary).toHaveBeenCalledTimes(1);
    const [backupPath, backupData] = vault.createBinary.mock.calls[0] as [string, ArrayBuffer];
    expect(backupPath).toMatch(CONFLICT_BACKUP_RE);
    expect(backupPath).not.toBe(path);
    expect(dec(backupData)).toBe(remote);
  });
});

describe("SyncClient downloadFileBatch -- server-wins (merge-fallback)", () => {
  it("backs up the existing local version, then overwrites it with the remote content", async () => {
    const local = "local content";
    const remote = "remote content";
    const remoteData = enc(remote);
    const remoteHash = await sha256(remoteData);
    const path = "note.md";

    const file = new TFile();
    file.path = path;
    const vault = fakeVault();
    vault.getAbstractFileByPath.mockImplementation((p: string) => (p === path ? file : null));
    vault.readBinary.mockResolvedValue(enc(local));

    const { transport } = makeDownloadTransport(remoteData, remoteHash, 42);
    const client = makeClientEx(transport, vault, fakeFileManager(), { conflictResolution: "server-wins" });

    await client.applyPushedFileChange({ path, modified_at_ms: 42, size_bytes: remoteData.byteLength, content_hash: remoteHash, is_deleted: false });

    expect(vault.createBinary).toHaveBeenCalledTimes(1);
    const [backupPath, backupData] = vault.createBinary.mock.calls[0] as [string, ArrayBuffer];
    expect(backupPath).toMatch(CONFLICT_BACKUP_RE);
    expect(backupPath).not.toBe(path);
    expect(dec(backupData)).toBe(local);

    expect(vault.modifyBinary).toHaveBeenCalledTimes(1);
    expect(dec(vault.modifyBinary.mock.calls[0][1] as ArrayBuffer)).toBe(remote);

    // The backup must happen before the overwrite, not after (a backup taken after the overwrite
    // would just be backing up the new remote content, defeating its purpose).
    const backupOrder = vault.createBinary.mock.invocationCallOrder[0];
    const overwriteOrder = vault.modifyBinary.mock.invocationCallOrder[0];
    expect(backupOrder).toBeLessThan(overwriteOrder);
  });

  it("does not back up anything when the file doesn't already exist locally -- there's no local side to lose", async () => {
    const remote = "remote content";
    const remoteData = enc(remote);
    const remoteHash = await sha256(remoteData);
    const path = "brand-new.md";

    const vault = fakeVault();
    vault.getAbstractFileByPath.mockReturnValue(null);

    const { transport } = makeDownloadTransport(remoteData, remoteHash, 42);
    const client = makeClientEx(transport, vault, fakeFileManager(), { conflictResolution: "server-wins" });

    await client.applyPushedFileChange({ path, modified_at_ms: 42, size_bytes: remoteData.byteLength, content_hash: remoteHash, is_deleted: false });

    expect(vault.createBinary).toHaveBeenCalledTimes(1);
    expect(dec(vault.createBinary.mock.calls[0][1] as ArrayBuffer)).toBe(remote);
  });
});

// bookmarks.json's old "always merges regardless of configured resolution" special case (see the
// deleted bookmarksSync.ts / #9_북마크_강제병합_및_기본값_개선_구현_계획.md) is now just a plain
// consequence of it being .json -- isTextFilePath()-true, same as every other text file below.
// No dedicated bookmarks.json test is needed; these generic cases already cover it.
describe("SyncClient downloadFileBatch -- unconditional text merge sub-cases", () => {
  const path = "note.md";

  it("a clean merge that lands exactly on the remote content collapses to an ordinary adopt-remote write (regression: no repeated 'Auto-merged' notice loop)", async () => {
    // local === base (this device made no edits since its last sync); only the remote side
    // changed. The 3-way merge is "clean" (no overlapping edits) and its result is byte-for-byte
    // the same as the remote text -- per the code's own comment, this must be treated as a plain
    // "adopt remote" write, not a synthesized merge-edit, because treating it as a synthetic edit
    // is what caused the historical "Auto-merged" notice to refire every sync even when nothing
    // had actually changed on either side.
    const base = "line1\nline2\nline3";
    const local = base;
    const remote = "line1\nline2\nline3-changed";
    const baseHash = await sha256(enc(base));
    const remoteData = enc(remote);
    const remoteHash = await sha256(remoteData);

    const history: HistoryVersionEntry[] = [
      { history_id: 1, modified_at_ms: 0, size_bytes: base.length, content_hash: baseHash, device_name: "d", user_name: "u", deleted: false },
    ];
    const { transport } = makeDownloadTransport(remoteData, remoteHash, 100, {
      getHistory: vi.fn(async () => history),
      downloadHistoryVersion: vi.fn(async () => ({ data: enc(base), path, contentHash: baseHash })),
    });

    const file = new TFile();
    file.path = path;
    const vault = fakeVault();
    vault.getAbstractFileByPath.mockImplementation((p: string) => (p === path ? file : null));
    vault.readBinary.mockResolvedValue(enc(local));

    const lastSyncedHashStore = { get: vi.fn(async () => baseHash), set: vi.fn() };
    const hashCache = { set: vi.fn() };
    // "client-wins" configured here on purpose: if the merge attempt were (wrongly) gated by
    // config, client-wins would skip the download and back up the remote content instead of
    // ever touching modifyBinary with it -- seeing the remote content written directly proves
    // the merge attempt overrides the configured fallback entirely.
    const client = makeClientEx(transport, vault, fakeFileManager(), { conflictResolution: "client-wins", lastSyncedHashStore, hashCache });

    await client.applyPushedFileChange({ path, modified_at_ms: 100, size_bytes: remoteData.byteLength, content_hash: remoteHash, is_deleted: false });

    // Exactly one write (the ordinary adopt-remote write) -- no separate conflict-backup write
    // happened first, unlike the fallback/conflict-marker branches below.
    expect(vault.createBinary).not.toHaveBeenCalled();
    expect(vault.modifyBinary).toHaveBeenCalledTimes(1);
    expect(dec(vault.modifyBinary.mock.calls[0][1] as ArrayBuffer)).toBe(remote);

    // Went through the *ordinary* write path (server content taken as-is), which is what marks
    // the path as confirmed-in-sync -- a true merge result must NOT do this (see the next test).
    expect(lastSyncedHashStore.set).toHaveBeenCalledWith(path, remoteHash);
  });

  it("a clean merge that produces a genuinely new result writes the merged content, not the raw remote content", async () => {
    const base = "line1\nline2\nline3";
    const local = "line1-local\nline2\nline3";
    const remote = "line1\nline2\nline3-remote";
    const baseHash = await sha256(enc(base));
    const remoteData = enc(remote);
    const remoteHash = await sha256(remoteData);

    const history: HistoryVersionEntry[] = [
      { history_id: 2, modified_at_ms: 0, size_bytes: base.length, content_hash: baseHash, device_name: "d", user_name: "u", deleted: false },
    ];
    const { transport } = makeDownloadTransport(remoteData, remoteHash, 200, {
      getHistory: vi.fn(async () => history),
      downloadHistoryVersion: vi.fn(async () => ({ data: enc(base), path, contentHash: baseHash })),
    });

    const file = new TFile();
    file.path = path;
    const vault = fakeVault();
    vault.getAbstractFileByPath.mockImplementation((p: string) => (p === path ? file : null));
    vault.readBinary.mockResolvedValue(enc(local));

    const lastSyncedHashStore = { get: vi.fn(async () => baseHash), set: vi.fn() };
    const hashCache = { set: vi.fn() };
    const client = makeClientEx(transport, vault, fakeFileManager(), { conflictResolution: "client-wins", lastSyncedHashStore, hashCache });

    await client.applyPushedFileChange({ path, modified_at_ms: 200, size_bytes: remoteData.byteLength, content_hash: remoteHash, is_deleted: false });

    expect(vault.createBinary).not.toHaveBeenCalled(); // no backup for a clean (non-conflicting) merge
    expect(vault.modifyBinary).toHaveBeenCalledTimes(1);
    const written = dec(vault.modifyBinary.mock.calls[0][1] as ArrayBuffer);
    expect(written).toBe("line1-local\nline2\nline3-remote");
    expect(written).not.toBe(remote);
    expect(written).not.toBe(local);

    // A merge result is content the server doesn't have yet -- must NOT be marked confirmed-in-
    // sync (that would wrongly let a later sync skip re-uploading it).
    expect(lastSyncedHashStore.set).not.toHaveBeenCalled();
    expect(hashCache.set).toHaveBeenCalledTimes(1);
  });

  // The marker-conflict path is tested under both remaining configured values on purpose: it
  // must fire the same way regardless of server-wins/client-wins, since a genuine same-line
  // conflict always needs the user to resolve it by hand -- there's no sensible way for either
  // "wins" policy to auto-pick a side once diff3 itself couldn't.
  it.each([["server-wins"], ["client-wins"]] as const)(
    "an unresolvable conflict (both sides edited the same line) writes conflict markers after backing up the pre-merge local version, regardless of conflictResolution (%s)",
    async (conflictResolution) => {
      const base = "line1\nline2\nline3";
      const local = "line1\nlocal-line2\nline3";
      const remote = "line1\nremote-line2\nline3";
      const baseHash = await sha256(enc(base));
      const remoteData = enc(remote);
      const remoteHash = await sha256(remoteData);

      const history: HistoryVersionEntry[] = [
        { history_id: 3, modified_at_ms: 0, size_bytes: base.length, content_hash: baseHash, device_name: "d", user_name: "u", deleted: false },
      ];
      const { transport } = makeDownloadTransport(remoteData, remoteHash, 300, {
        getHistory: vi.fn(async () => history),
        downloadHistoryVersion: vi.fn(async () => ({ data: enc(base), path, contentHash: baseHash })),
      });

      const file = new TFile();
      file.path = path;
      const vault = fakeVault();
      vault.getAbstractFileByPath.mockImplementation((p: string) => (p === path ? file : null));
      vault.readBinary.mockResolvedValue(enc(local));

      const lastSyncedHashStore = { get: vi.fn(async () => baseHash), set: vi.fn() };
      const hashCache = { set: vi.fn() };
      const client = makeClientEx(transport, vault, fakeFileManager(), { conflictResolution, lastSyncedHashStore, hashCache });

      await client.applyPushedFileChange({ path, modified_at_ms: 300, size_bytes: remoteData.byteLength, content_hash: remoteHash, is_deleted: false });

      expect(vault.createBinary).toHaveBeenCalledTimes(1);
      const [backupPath, backupData] = vault.createBinary.mock.calls[0] as [string, ArrayBuffer];
      expect(backupPath).toMatch(CONFLICT_BACKUP_RE);
      expect(dec(backupData)).toBe(local);

      expect(vault.modifyBinary).toHaveBeenCalledTimes(1);
      const written = dec(vault.modifyBinary.mock.calls[0][1] as ArrayBuffer);
      expect(written).toContain("<<<<<<<");
      expect(written).toContain("=======");
      expect(written).toContain(">>>>>>>");
      expect(written).toContain("local-line2");
      expect(written).toContain("remote-line2");
      expect(hashCache.set).toHaveBeenCalledTimes(1);

      const backupOrder = vault.createBinary.mock.invocationCallOrder[0];
      const overwriteOrder = vault.modifyBinary.mock.invocationCallOrder[0];
      expect(backupOrder).toBeLessThan(overwriteOrder);

      // Same reasoning as the clean-new-merge case: unresolved content must not be marked synced.
      expect(lastSyncedHashStore.set).not.toHaveBeenCalled();
    }
  );

  it("falls back to server-wins's backup-and-overwrite when the recorded base hash has no matching (unpruned) history entry", async () => {
    // A distinct "can't merge" reason from the getHistory()-throws test below: the history call
    // itself succeeds, but no entry in it matches the locally-recorded base hash (e.g. that
    // version has since been pruned from server history) -- tryAutoMergeConflict's own comment
    // calls this out as one of the specific cases that fall back to null.
    const local = "local content";
    const remote = "remote content";
    const remoteData = enc(remote);
    const remoteHash = await sha256(remoteData);

    const history: HistoryVersionEntry[] = [
      { history_id: 9, modified_at_ms: 0, size_bytes: 4, content_hash: "some-other-hash", device_name: "d", user_name: "u", deleted: false },
    ];
    const { transport } = makeDownloadTransport(remoteData, remoteHash, 350, {
      getHistory: vi.fn(async () => history),
    });

    const file = new TFile();
    file.path = path;
    const vault = fakeVault();
    vault.getAbstractFileByPath.mockImplementation((p: string) => (p === path ? file : null));
    vault.readBinary.mockResolvedValue(enc(local));

    const lastSyncedHashStore = { get: vi.fn(async () => "pruned-base-hash"), set: vi.fn() };
    const client = makeClientEx(transport, vault, fakeFileManager(), { conflictResolution: "server-wins", lastSyncedHashStore });

    await client.applyPushedFileChange({ path, modified_at_ms: 350, size_bytes: remoteData.byteLength, content_hash: remoteHash, is_deleted: false });

    expect(transport.getHistory).toHaveBeenCalled();
    expect(transport.downloadHistoryVersion).not.toHaveBeenCalled();
    expect(vault.createBinary).toHaveBeenCalledTimes(1);
    expect((vault.createBinary.mock.calls[0][0] as string)).toMatch(CONFLICT_BACKUP_RE);
    expect(vault.modifyBinary).toHaveBeenCalledTimes(1);
    expect(dec(vault.modifyBinary.mock.calls[0][1] as ArrayBuffer)).toBe(remote);
  });

  it("falls back to client-wins's backup-and-skip when the merge attempt itself throws", async () => {
    // tryAutoMergeConflict wraps its whole body (base-hash lookup through the actual 3-way merge)
    // in a try/catch that falls back to null (== "couldn't merge, defer to conflictResolution
    // instead") on any failure. Forced here via getHistory() rejecting -- a real, reliably
    // reproducible failure mode (a dropped connection fetching the file's history), rather than
    // trying to make node-diff3's merge() itself throw.
    const local = "local content";
    const remote = "remote content";
    const remoteData = enc(remote);
    const remoteHash = await sha256(remoteData);

    const { transport } = makeDownloadTransport(remoteData, remoteHash, 400, {
      getHistory: vi.fn(async () => {
        throw new Error("simulated getHistory failure");
      }),
    });

    const file = new TFile();
    file.path = path;
    const vault = fakeVault();
    vault.getAbstractFileByPath.mockImplementation((p: string) => (p === path ? file : null));
    vault.readBinary.mockResolvedValue(enc(local));

    const lastSyncedHashStore = { get: vi.fn(async () => "some-base-hash"), set: vi.fn() };
    const client = makeClientEx(transport, vault, fakeFileManager(), { conflictResolution: "client-wins", lastSyncedHashStore });

    await expect(
      client.applyPushedFileChange({ path, modified_at_ms: 400, size_bytes: remoteData.byteLength, content_hash: remoteHash, is_deleted: false })
    ).resolves.toBeUndefined();

    // client-wins fallback: local untouched, losing remote content backed up instead.
    expect(vault.modifyBinary).not.toHaveBeenCalled();
    expect(vault.createBinary).toHaveBeenCalledTimes(1);
    const [backupPath, backupData] = vault.createBinary.mock.calls[0] as [string, ArrayBuffer];
    expect(backupPath).toMatch(CONFLICT_BACKUP_RE);
    expect(backupPath).not.toBe(path);
    expect(dec(backupData)).toBe(remote);
  });
});

describe("SyncClient downloadFileBatch -- conflict backup path stays in the original file's directory", () => {
  // Regression guard: every other test in this file uses a top-level path ("note.md"), which
  // can't tell a correctly-scoped conflict path from one that accidentally collapsed to just the
  // vault root -- both would match CONFLICT_BACKUP_RE identically. This exercises a nested path
  // specifically to prove the backup lands next to the original file, not at the vault root.
  const path = "folder/sub/note.md";
  const NESTED_CONFLICT_BACKUP_RE = /^folder\/sub\/note\.sync-conflict-.*\.md$/;

  it("server-wins backs up the local version into the same folder as the original", async () => {
    const local = "local content";
    const remote = "remote content";
    const remoteData = enc(remote);
    const remoteHash = await sha256(remoteData);

    const file = new TFile();
    file.path = path;
    const vault = fakeVault();
    vault.getAbstractFileByPath.mockImplementation((p: string) => (p === path ? file : null));
    vault.readBinary.mockResolvedValue(enc(local));

    const { transport } = makeDownloadTransport(remoteData, remoteHash, 42);
    const client = makeClientEx(transport, vault, fakeFileManager(), { conflictResolution: "server-wins" });

    await client.applyPushedFileChange({ path, modified_at_ms: 42, size_bytes: remoteData.byteLength, content_hash: remoteHash, is_deleted: false });

    const [backupPath] = vault.createBinary.mock.calls[0] as [string, ArrayBuffer];
    expect(backupPath).toMatch(NESTED_CONFLICT_BACKUP_RE);
  });

  it("client-wins backs up the remote version into the same folder as the original", async () => {
    const remote = "remote content";
    const remoteData = enc(remote);
    const remoteHash = await sha256(remoteData);

    const file = new TFile();
    file.path = path;
    const vault = fakeVault();
    vault.getAbstractFileByPath.mockImplementation((p: string) => (p === path ? file : null));

    const { transport } = makeDownloadTransport(remoteData, remoteHash, 5);
    const client = makeClientEx(transport, vault, fakeFileManager(), { conflictResolution: "client-wins" });

    await client.applyPushedFileChange({ path, modified_at_ms: 5, size_bytes: remoteData.byteLength, content_hash: remoteHash, is_deleted: false });

    const [backupPath] = vault.createBinary.mock.calls[0] as [string, ArrayBuffer];
    expect(backupPath).toMatch(NESTED_CONFLICT_BACKUP_RE);
  });
});
