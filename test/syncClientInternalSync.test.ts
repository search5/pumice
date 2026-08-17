import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import { SyncClient } from "../src/syncClient";
import { getDefaultSettings, type SyncPluginSettings } from "../src/settings";
import type { SyncRetryCallback } from "../src/syncClient";
import {
  fakeFileManager,
  fakeTransport,
  fakeVault,
  makeClient,
  sha256,
  type FakeVault,
} from "./syncClientTestUtils";

// Coverage follow-up for SyncClient.internalSync() / sync() (src/syncClient.ts, internalSync
// around lines 761-1133 as of this writing) -- part of the same parallel coverage-improvement
// effort as syncClientPush.test.ts / syncClientHistory.test.ts / syncClientUpload.test.ts. This
// is the plugin's single most important piece of business logic (the whole scan -> delta ->
// upload/download -> deletion-reconciliation loop) and had zero automated coverage before this
// file. internalSync() itself is private and reached only through the public sync() (a thin
// retry wrapper around it, see sync()'s own comment in syncClient.ts) -- every test below drives
// it that way rather than reaching in with `(client as any).internalSync()`, since sync() adds
// nothing but a catch/retry around the exact same call.
//
// Deliberately NOT re-testing: prepareUploadFile/uploadFileBatch's own internals (syncClientUpload
// .test.ts), applyServerDeletion's own internals or the download conflict/merge matrix
// (syncClientPush.test.ts's applyPushedFileChange tests exercise the same underlying code),
// groupIntoBatches/runBatchedDownloads as pure functions (downloadBatching.test.ts), or
// pluginSync.ts's/bookmarksSync.ts's own filtering logic (pluginSync.test.ts / bookmarksSync
// .test.ts) -- only confirming internalSync() wires all of the above together correctly.

// makeClient() (syncClientTestUtils.ts) always builds default settings with no way to override
// individual fields (syncBookmarks/syncPlugins toggles, onRetry callback) -- this constructs a
// SyncClient directly with the same positional constructor args makeClient uses internally, just
// with overrides layered on top, same pattern as syncClientUpload.test.ts's makeE2eeClient.
function makeClientWithSettings(
  transport: ReturnType<typeof fakeTransport>,
  vault: FakeVault,
  fileManager: ReturnType<typeof fakeFileManager>,
  settingsOverrides: Partial<SyncPluginSettings> = {},
  deletedFiles: Record<string, number> = {},
  onRetry?: SyncRetryCallback,
  lastKnownPluginPaths?: Record<string, number>
): SyncClient {
  const settings = { ...getDefaultSettings(vault.configDir), e2eePassword: "", ...settingsOverrides };
  return new SyncClient(
    transport,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vault as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fileManager as any,
    "/plugins/pumice",
    "test-token",
    settings,
    deletedFiles,
    async () => {},
    undefined,
    undefined,
    onRetry,
    undefined,
    undefined,
    undefined,
    lastKnownPluginPaths
  );
}

function makeFile(path: string, mtime: number, size: number): TFile {
  const f = new TFile();
  f.path = path;
  f.stat = { mtime, size, ctime: 0 };
  return f;
}

beforeEach(() => {
  // sync()'s retry wrapper and the upload/download in-pass retry loops all delay via
  // `window.setTimeout` -- there is no `window` global under vitest's "node" environment
  // (confirmed: plain Node has no `window`), so exercising any retry path at all requires
  // providing one. Resolving synchronously (instead of actually waiting out the real delay)
  // keeps every retry test fast.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).window = {
    setTimeout: (fn: (...args: unknown[]) => void) => {
      fn();
      return 0;
    },
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SyncClient.sync -- nothing to do", () => {
  it("sends an empty scan to delta and returns an all-zero result for an empty vault", async () => {
    const transport = fakeTransport({ delta: vi.fn(async () => ({ needUpload: [], needDownload: [] })) });
    const vault = fakeVault();
    const fileManager = fakeFileManager();
    const client = makeClient(transport, vault, fileManager);

    const result = await client.sync();

    expect(transport.delta).toHaveBeenCalledWith("myvault", []);
    expect(result).toEqual({ uploaded: 0, downloaded: 0, deleted: 0, failed: 0, updatedPluginIds: [] });
  });
});

describe("SyncClient.sync -- scan step", () => {
  it("excludes ignored files from the local metadata sent to delta, but includes non-ignored ones", async () => {
    const transport = fakeTransport({ delta: vi.fn(async () => ({ needUpload: [], needDownload: [] })) });
    const vault = fakeVault();

    const keepContent = new TextEncoder().encode("keep-me").buffer;
    const keepHash = await sha256(keepContent);
    const keepFile = makeFile("notes/keep.md", 1000, keepContent.byteLength);
    // ".trash" is one of getDefaultSettings()'s built-in default ignorePatterns lines.
    const ignoredFile = makeFile(".trash/deleted-note.md", 2000, 5);

    vault.getFiles.mockReturnValue([keepFile, ignoredFile]);
    vault.readBinary.mockImplementation(async (f: TFile) => (f.path === "notes/keep.md" ? keepContent : new ArrayBuffer(5)));

    const fileManager = fakeFileManager();
    const client = makeClient(transport, vault, fileManager);

    await client.sync();

    const [, localFilesMeta] = (transport.delta as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as [
      string,
      Array<{ path: string; content_hash: string }>,
    ];
    expect(localFilesMeta).toEqual([
      { path: "notes/keep.md", modified_at_ms: 1000, size_bytes: keepContent.byteLength, content_hash: keepHash, is_deleted: false },
    ]);
    // The ignored file must never even be read/hashed.
    expect(vault.readBinary).not.toHaveBeenCalledWith(ignoredFile);
  });
});

describe("SyncClient.sync -- upload/download core flow", () => {
  it("uploads needUpload paths, downloads non-deleted needDownload paths, and tallies the result", async () => {
    const vault = fakeVault();

    const keepContent = new TextEncoder().encode("local-content").buffer;
    const keepHash = await sha256(keepContent);
    const keepFile = makeFile("keep.md", 1000, keepContent.byteLength);
    vault.getFiles.mockReturnValue([keepFile]);
    vault.readBinary.mockImplementation(async (f: TFile) => (f.path === "keep.md" ? keepContent : new ArrayBuffer(0)));

    const downloadContent = new TextEncoder().encode("remote-content").buffer;
    const downloadHash = await sha256(downloadContent);

    const transport = fakeTransport({
      delta: vi.fn(async () => ({
        needUpload: ["keep.md"],
        needDownload: [
          { path: "new.md", modified_at_ms: 5000, size_bytes: downloadContent.byteLength, content_hash: downloadHash, is_deleted: false },
        ],
      })),
      uploadBatch: vi.fn(async (_vaultId, files, onAck) => {
        for (const f of files) onAck({ path: f.path, ok: true, error: "" });
      }),
      downloadBatch: vi.fn(async (_vaultId, paths, onFile) => {
        const ok = await onFile({ path: paths[0], mtimeMs: 5000, data: downloadContent, contentHash: downloadHash });
        return { downloadedCount: ok ? 1 : 0, failedPaths: ok ? [] : [paths[0]] };
      }),
    });
    const fileManager = fakeFileManager();
    const client = makeClient(transport, vault, fileManager);

    const result = await client.sync();

    expect(transport.delta).toHaveBeenCalledWith(
      "myvault",
      expect.arrayContaining([expect.objectContaining({ path: "keep.md", content_hash: keepHash })])
    );
    // The upload reuses the buffer/hash already produced by the scan step above (see
    // prepareUploadFile's own comment) rather than re-reading "keep.md" a second time.
    expect(transport.uploadBatch).toHaveBeenCalledWith(
      "myvault",
      [expect.objectContaining({ path: "keep.md", contentHash: keepHash, mtimeMs: 1000 })],
      expect.any(Function)
    );
    expect(vault.createBinary).toHaveBeenCalledWith("new.md", expect.any(ArrayBuffer), { mtime: 5000 });
    expect(result).toEqual({ uploaded: 1, downloaded: 1, deleted: 0, failed: 0, updatedPluginIds: [] });
  });
});

describe("SyncClient.sync -- deletion reconciliation", () => {
  it("clears a pending local deletion and counts it once the server confirms it (absent from needDownload)", async () => {
    const transport = fakeTransport({ delta: vi.fn(async () => ({ needUpload: [], needDownload: [] })) });
    const vault = fakeVault();
    const fileManager = fakeFileManager();
    const deletedFiles: Record<string, number> = { "gone.md": 12345 };
    const updateDeletedFiles = vi.fn(async () => {});
    const client = makeClient(transport, vault, fileManager, deletedFiles, updateDeletedFiles);

    const result = await client.sync();

    // The tombstone itself must have been sent to delta as part of the scan.
    expect(transport.delta).toHaveBeenCalledWith("myvault", [
      { path: "gone.md", modified_at_ms: 12345, size_bytes: 0, content_hash: "", is_deleted: true },
    ]);
    expect(deletedFiles["gone.md"]).toBeUndefined();
    expect(result.deleted).toBe(1);
    expect(updateDeletedFiles).toHaveBeenCalledWith({});
  });

  it("does NOT reconcile a pending deletion the server still lists in needDownload", async () => {
    const transport = fakeTransport({
      delta: vi.fn(async () => ({
        needUpload: [],
        needDownload: [{ path: "gone.md", modified_at_ms: 12345, size_bytes: 0, content_hash: "", is_deleted: true }],
      })),
    });
    const vault = fakeVault();
    const file = makeFile("gone.md", 0, 0);
    vault.getAbstractFileByPath.mockImplementation((p: string) => (p === "gone.md" ? file : null));
    const fileManager = fakeFileManager();
    const deletedFiles: Record<string, number> = { "gone.md": 12345 };
    const client = makeClient(transport, vault, fileManager, deletedFiles);

    const result = await client.sync();

    // Routed to applyServerDeletion instead (see next describe block) -- exactly one delete,
    // not the "reconciled without a server round trip" path.
    expect(fileManager.trashFile).toHaveBeenCalledWith(file);
    expect(result.deleted).toBe(1);
  });

  it("routes a needDownload entry with is_deleted true to a local delete via trashFile", async () => {
    const transport = fakeTransport({
      delta: vi.fn(async () => ({
        needUpload: [],
        needDownload: [{ path: "a.md", modified_at_ms: 0, size_bytes: 0, content_hash: "", is_deleted: true }],
      })),
    });
    const vault = fakeVault();
    const file = makeFile("a.md", 0, 0);
    vault.getAbstractFileByPath.mockImplementation((p: string) => (p === "a.md" ? file : null));
    const fileManager = fakeFileManager();
    const client = makeClient(transport, vault, fileManager);

    const result = await client.sync();

    expect(fileManager.trashFile).toHaveBeenCalledWith(file);
    expect(transport.downloadBatch).not.toHaveBeenCalled();
    expect(result.deleted).toBe(1);
  });

  it("routes a needDownload deletion of a config-dir path outside the vault index to the adapter", async () => {
    const transport = fakeTransport({
      delta: vi.fn(async () => ({
        needUpload: [],
        needDownload: [{ path: ".obsidian/bookmarks.json", modified_at_ms: 0, size_bytes: 0, content_hash: "", is_deleted: true }],
      })),
    });
    const vault = fakeVault();
    // Applies to every path (including the bookmarks-scan-step's own exists() check for the
    // same path) -- harmless there since adapter.stat still defaults to null, so nothing gets
    // added to localFilesMeta from that unrelated check.
    vault.adapter.exists.mockResolvedValue(true);
    const fileManager = fakeFileManager();
    const client = makeClient(transport, vault, fileManager);

    const result = await client.sync();

    expect(vault.adapter.remove).toHaveBeenCalledWith(".obsidian/bookmarks.json");
    expect(fileManager.trashFile).not.toHaveBeenCalled();
    expect(result.deleted).toBe(1);
  });
});

describe("SyncClient.sync -- upload retry-on-failure", () => {
  it("retries a failed upload within the same sync call and counts it once it succeeds", async () => {
    const vault = fakeVault();
    const content = new TextEncoder().encode("retry-me").buffer;
    const file = makeFile("retry.md", 1, content.byteLength);
    vault.getFiles.mockReturnValue([file]);
    vault.readBinary.mockImplementation(async () => content);
    // prepareUploadFile only reuses the scan step's cached buffer on the FIRST attempt (it's
    // consumed/deleted from scannedWireBuffers once used, see that method's own comment) -- a
    // retry re-resolves the path via getAbstractFileByPath, same as a real vault would for a
    // file that's actually indexed.
    vault.getAbstractFileByPath.mockImplementation((p: string) => (p === "retry.md" ? file : null));

    let attempt = 0;
    const transport = fakeTransport({
      delta: vi.fn(async () => ({ needUpload: ["retry.md"], needDownload: [] })),
      uploadBatch: vi.fn(async (_vaultId, files, onAck) => {
        attempt++;
        for (const f of files) onAck({ path: f.path, ok: attempt > 1, error: attempt > 1 ? "" : "transient" });
      }),
    });
    const fileManager = fakeFileManager();
    const client = makeClient(transport, vault, fileManager);

    const result = await client.sync();

    expect(transport.uploadBatch).toHaveBeenCalledTimes(2);
    expect(result.uploaded).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("retries when the whole upload batch call throws (not just a per-file ack failure)", async () => {
    const vault = fakeVault();
    const content = new TextEncoder().encode("recovers-after-stream-drop").buffer;
    const file = makeFile("drops.md", 1, content.byteLength);
    vault.getFiles.mockReturnValue([file]);
    vault.readBinary.mockImplementation(async () => content);
    vault.getAbstractFileByPath.mockImplementation((p: string) => (p === "drops.md" ? file : null));

    let attempt = 0;
    const transport = fakeTransport({
      delta: vi.fn(async () => ({ needUpload: ["drops.md"], needDownload: [] })),
      uploadBatch: vi.fn(async (_vaultId, files, onAck) => {
        attempt++;
        if (attempt === 1) throw new Error("connection dropped mid-upload");
        for (const f of files) onAck({ path: f.path, ok: true, error: "" });
      }),
    });
    const fileManager = fakeFileManager();
    const client = makeClient(transport, vault, fileManager);

    const result = await client.sync();

    // A whole-batch exception (as opposed to an ok:false ack) leaves every path in that attempt
    // unaccounted for, so it must still be retried, not silently dropped.
    expect(transport.uploadBatch).toHaveBeenCalledTimes(2);
    expect(result.uploaded).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("onUploadAck's own tombstone-clear also fires for a path the 3-1 reconciliation step didn't already sweep", async () => {
    // 3-1 (see the "deletion reconciliation" describe block above) already clears every
    // deletedFiles entry NOT present in needDownload before uploads/downloads run -- so
    // onUploadAck's own `if (this.deletedFiles[ackPath]) delete ...` (syncClient.ts around line
    // 1035) is only reachable at all for a path 3-1 leaves behind, i.e. one delta reports in
    // BOTH needUpload and needDownload at once. That contradicts the disjoint-sets invariant the
    // surrounding code comments describe ("a path is only ever need-upload XOR need-download XOR
    // neither") -- this deliberately constructs that supposedly-impossible case to characterize
    // what onUploadAck's own defensive check actually does, not because it's expected to happen
    // for a well-behaved server.
    const vault = fakeVault();
    const content = new TextEncoder().encode("weird-both-buckets").buffer;
    const file = makeFile("weird.md", 1, content.byteLength);
    vault.getFiles.mockReturnValue([file]);
    vault.readBinary.mockImplementation(async () => content);

    const transport = fakeTransport({
      delta: vi.fn(async () => ({
        needUpload: ["weird.md"],
        needDownload: [{ path: "weird.md", modified_at_ms: 1, size_bytes: content.byteLength, content_hash: "irrelevant", is_deleted: false }],
      })),
      uploadBatch: vi.fn(async (_vaultId, files, onAck) => {
        for (const f of files) onAck({ path: f.path, ok: true, error: "" });
      }),
      // Also present in needDownload -- give the download side something harmless to do so this
      // doesn't also exercise (or get confused with) the download retry/failure paths.
      downloadBatch: vi.fn(async (_vaultId, paths, onFile) => {
        const ok = await onFile({ path: paths[0], mtimeMs: 1, data: content, contentHash: await sha256(content) });
        return { downloadedCount: ok ? 1 : 0, failedPaths: ok ? [] : [paths[0]] };
      }),
    });
    const fileManager = fakeFileManager();
    const deletedFiles: Record<string, number> = { "weird.md": 500 };
    const client = makeClient(transport, vault, fileManager, deletedFiles);

    await client.sync();

    expect(deletedFiles["weird.md"]).toBeUndefined();
  });

  it("gives up after a fixed number of in-sync retries and counts the file as failed", async () => {
    const vault = fakeVault();
    const content = new TextEncoder().encode("never-works").buffer;
    const file = makeFile("stuck.md", 1, content.byteLength);
    vault.getFiles.mockReturnValue([file]);
    vault.readBinary.mockImplementation(async () => content);
    // See the previous test's comment: retries need the file resolvable via
    // getAbstractFileByPath once the scan step's cached buffer has been consumed.
    vault.getAbstractFileByPath.mockImplementation((p: string) => (p === "stuck.md" ? file : null));

    const transport = fakeTransport({
      delta: vi.fn(async () => ({ needUpload: ["stuck.md"], needDownload: [] })),
      uploadBatch: vi.fn(async (_vaultId, files, onAck) => {
        for (const f of files) onAck({ path: f.path, ok: false, error: "permanently broken" });
      }),
    });
    const fileManager = fakeFileManager();
    const client = makeClient(transport, vault, fileManager);

    const result = await client.sync();

    // UPLOAD_RETRY_ATTEMPTS = 2 in internalSync() -> 3 total attempts (attempt 0, 1, 2), not
    // retried forever.
    expect(transport.uploadBatch).toHaveBeenCalledTimes(3);
    expect(result.uploaded).toBe(0);
    expect(result.failed).toBe(1);
  });
});

describe("SyncClient.sync -- download retry-on-failure", () => {
  it("retries a download whose hash didn't verify and counts it once it succeeds", async () => {
    const content = new TextEncoder().encode("v2-content").buffer;
    const correctHash = await sha256(content);

    let attempt = 0;
    const transport = fakeTransport({
      delta: vi.fn(async () => ({
        needUpload: [],
        needDownload: [{ path: "flaky.md", modified_at_ms: 1, size_bytes: content.byteLength, content_hash: correctHash, is_deleted: false }],
      })),
      downloadBatch: vi.fn(async (_vaultId, paths, onFile) => {
        attempt++;
        // First attempt: hash mismatch (simulating a corrupted/incomplete transfer). Second:
        // correct hash, accepted.
        const contentHash = attempt === 1 ? "corrupted-hash" : correctHash;
        const ok = await onFile({ path: paths[0], mtimeMs: 1, data: content, contentHash });
        return { downloadedCount: ok ? 1 : 0, failedPaths: ok ? [] : [paths[0]] };
      }),
    });
    const vault = fakeVault();
    const fileManager = fakeFileManager();
    const client = makeClient(transport, vault, fileManager);

    const result = await client.sync();

    expect(transport.downloadBatch).toHaveBeenCalledTimes(2);
    expect(result.downloaded).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("gives up after a fixed number of in-sync retries and counts the file as failed", async () => {
    const content = new TextEncoder().encode("always-corrupted").buffer;
    const correctHash = await sha256(content);

    const transport = fakeTransport({
      delta: vi.fn(async () => ({
        needUpload: [],
        needDownload: [{ path: "stuck.md", modified_at_ms: 1, size_bytes: content.byteLength, content_hash: correctHash, is_deleted: false }],
      })),
      downloadBatch: vi.fn(async (_vaultId, paths, onFile) => {
        const ok = await onFile({ path: paths[0], mtimeMs: 1, data: content, contentHash: "always-wrong" });
        return { downloadedCount: ok ? 1 : 0, failedPaths: ok ? [] : [paths[0]] };
      }),
    });
    const vault = fakeVault();
    const fileManager = fakeFileManager();
    const client = makeClient(transport, vault, fileManager);

    const result = await client.sync();

    // DOWNLOAD_RETRY_ATTEMPTS = 2 -> 3 total attempts, same cap shape as uploads.
    expect(transport.downloadBatch).toHaveBeenCalledTimes(3);
    expect(result.downloaded).toBe(0);
    expect(result.failed).toBe(1);
  });
});

describe("SyncClient.sync -- retry wrapper (transient internalSync failures)", () => {
  it("retries internalSync on a transient failure, reports via onRetry, and eventually succeeds", async () => {
    let call = 0;
    const transport = fakeTransport({
      delta: vi.fn(async () => {
        call++;
        if (call === 1) throw new Error("transient network error");
        return { needUpload: [], needDownload: [] };
      }),
    });
    const vault = fakeVault();
    const fileManager = fakeFileManager();
    const onRetry = vi.fn();
    const client = makeClientWithSettings(transport, vault, fileManager, {}, {}, onRetry);

    const result = await client.sync();

    expect(transport.delta).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith({ delayMs: 1000, retriesLeft: 2 });
    expect(result).toEqual({ uploaded: 0, downloaded: 0, deleted: 0, failed: 0, updatedPluginIds: [] });
  });

  it("gives up and rejects after exhausting its retries against a persistently-failing internalSync", async () => {
    const transport = fakeTransport({
      delta: vi.fn(async () => {
        throw new Error("still down");
      }),
    });
    const vault = fakeVault();
    const fileManager = fakeFileManager();
    const onRetry = vi.fn();
    const client = makeClientWithSettings(transport, vault, fileManager, {}, {}, onRetry);

    await expect(client.sync()).rejects.toThrow("still down");

    // sync() starts with 3 retries and gives up once they hit zero -- 1 initial attempt + 2
    // retries = 3 total calls, 2 onRetry reports (retriesLeft counts down 2, then 1; the 3rd
    // failure throws instead of reporting a 3rd retry).
    expect(transport.delta).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, { delayMs: 1000, retriesLeft: 2 });
    expect(onRetry).toHaveBeenNthCalledWith(2, { delayMs: 2000, retriesLeft: 1 });
  });
});

describe("SyncClient.sync -- result tallying across a mixed scenario", () => {
  it("combines upload success/failure, download success, and both deletion paths into one result", async () => {
    const vault = fakeVault();

    const upOkContent = new TextEncoder().encode("upload-ok").buffer;
    const upFailContent = new TextEncoder().encode("upload-fails").buffer;
    const upOkFile = makeFile("up-ok.md", 1, upOkContent.byteLength);
    const upFailFile = makeFile("up-fail.md", 1, upFailContent.byteLength);
    vault.getFiles.mockReturnValue([upOkFile, upFailFile]);
    vault.readBinary.mockImplementation(async (f: TFile) => (f.path === "up-ok.md" ? upOkContent : upFailContent));

    const downOkContent = new TextEncoder().encode("download-ok").buffer;
    const downOkHash = await sha256(downOkContent);

    const serverDeleteFile = makeFile("server-deletes-this.md", 0, 0);
    // up-fail.md needs to resolve via getAbstractFileByPath once its scan-step-cached buffer is
    // consumed on the first retry (see the upload-retry describe block's own comment above).
    vault.getAbstractFileByPath.mockImplementation((p: string) => {
      if (p === "server-deletes-this.md") return serverDeleteFile;
      if (p === "up-fail.md") return upFailFile;
      return null;
    });

    const transport = fakeTransport({
      delta: vi.fn(async () => ({
        needUpload: ["up-ok.md", "up-fail.md"],
        needDownload: [
          { path: "down-ok.md", modified_at_ms: 999, size_bytes: downOkContent.byteLength, content_hash: downOkHash, is_deleted: false },
          { path: "server-deletes-this.md", modified_at_ms: 0, size_bytes: 0, content_hash: "", is_deleted: true },
        ],
      })),
      uploadBatch: vi.fn(async (_vaultId, files, onAck) => {
        for (const f of files) {
          const ok = f.path !== "up-fail.md";
          onAck({ path: f.path, ok, error: ok ? "" : "boom" });
        }
      }),
      downloadBatch: vi.fn(async (_vaultId, paths, onFile) => {
        const ok = await onFile({ path: paths[0], mtimeMs: 999, data: downOkContent, contentHash: downOkHash });
        return { downloadedCount: ok ? 1 : 0, failedPaths: ok ? [] : [paths[0]] };
      }),
    });
    const fileManager = fakeFileManager();
    const deletedFiles: Record<string, number> = { "confirmed-gone.md": 1000 };
    const client = makeClient(transport, vault, fileManager, deletedFiles);

    const result = await client.sync();

    expect(result).toEqual({
      uploaded: 1, // up-ok.md
      downloaded: 1, // down-ok.md
      deleted: 2, // confirmed-gone.md (reconciled) + server-deletes-this.md (applied)
      failed: 1, // up-fail.md, permanently
      updatedPluginIds: [],
    });
    expect(fileManager.trashFile).toHaveBeenCalledWith(serverDeleteFile);
    expect(deletedFiles["confirmed-gone.md"]).toBeUndefined();
  });
});

describe("SyncClient.sync -- bookmarks wiring (lower priority)", () => {
  it("includes bookmarks.json in the scan when syncBookmarks is on and the file exists", async () => {
    const transport = fakeTransport({ delta: vi.fn(async () => ({ needUpload: [], needDownload: [] })) });
    const vault = fakeVault();
    const bookmarkContent = new TextEncoder().encode('{"items":[]}').buffer;
    const bookmarkHash = await sha256(bookmarkContent);
    const bookmarkPath = ".obsidian/bookmarks.json";

    vault.adapter.exists.mockImplementation(async (p: string) => p === bookmarkPath);
    vault.adapter.stat.mockImplementation(async (p: string) =>
      p === bookmarkPath ? { mtime: 42, size: bookmarkContent.byteLength } : null
    );
    vault.adapter.readBinary.mockImplementation(async (p: string) => (p === bookmarkPath ? bookmarkContent : new ArrayBuffer(0)));

    const fileManager = fakeFileManager();
    // makeClient()'s settings default syncBookmarks to true (getDefaultSettings()).
    const client = makeClient(transport, vault, fileManager);

    await client.sync();

    const [, localFilesMeta] = (transport.delta as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as [
      string,
      Array<{ path: string; content_hash: string; modified_at_ms: number }>,
    ];
    expect(localFilesMeta).toContainEqual({
      path: bookmarkPath,
      modified_at_ms: 42,
      size_bytes: bookmarkContent.byteLength,
      content_hash: bookmarkHash,
      is_deleted: false,
    });
  });

  it("excludes bookmarks.json from the scan when syncBookmarks is off, even if the file exists", async () => {
    const transport = fakeTransport({ delta: vi.fn(async () => ({ needUpload: [], needDownload: [] })) });
    const vault = fakeVault();
    const bookmarkPath = ".obsidian/bookmarks.json";
    vault.adapter.exists.mockImplementation(async (p: string) => p === bookmarkPath);
    vault.adapter.stat.mockImplementation(async () => ({ mtime: 42, size: 2 }));
    vault.adapter.readBinary.mockImplementation(async () => new TextEncoder().encode("{}").buffer);

    const fileManager = fakeFileManager();
    const client = makeClientWithSettings(transport, vault, fileManager, { syncBookmarks: false });

    await client.sync();

    const [, localFilesMeta] = (transport.delta as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as [
      string,
      Array<{ path: string }>,
    ];
    expect(localFilesMeta.some((f) => f.path === bookmarkPath)).toBe(false);
  });
});

describe("SyncClient.sync -- plugin sync wiring (lower priority)", () => {
  it("includes .obsidian/plugins/** files in the scan when syncPlugins is on", async () => {
    const transport = fakeTransport({ delta: vi.fn(async () => ({ needUpload: [], needDownload: [] })) });
    const vault = fakeVault();
    const mainJsContent = new TextEncoder().encode("console.log(1)").buffer;
    const mainJsHash = await sha256(mainJsContent);
    const pluginsRoot = ".obsidian/plugins";
    const pluginDir = ".obsidian/plugins/sample";
    const mainJsPath = ".obsidian/plugins/sample/main.js";

    vault.adapter.exists.mockImplementation(async (p: string) => p === pluginsRoot || p === pluginDir);
    vault.adapter.list.mockImplementation(async (p: string) => {
      if (p === pluginsRoot) return { files: [], folders: [pluginDir] };
      if (p === pluginDir) return { files: [mainJsPath], folders: [] };
      return { files: [], folders: [] };
    });
    vault.adapter.stat.mockImplementation(async (p: string) => (p === mainJsPath ? { mtime: 7, size: mainJsContent.byteLength } : null));
    vault.adapter.readBinary.mockImplementation(async (p: string) => (p === mainJsPath ? mainJsContent : new ArrayBuffer(0)));

    const fileManager = fakeFileManager();
    const client = makeClientWithSettings(transport, vault, fileManager, { syncPlugins: true });

    await client.sync();

    const [, localFilesMeta] = (transport.delta as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as [
      string,
      Array<{ path: string; content_hash: string }>,
    ];
    expect(localFilesMeta).toContainEqual(
      expect.objectContaining({ path: mainJsPath, content_hash: mainJsHash })
    );
  });

  it("synthesizes a deletion tombstone for a plugin file removed from disk since the last scan", async () => {
    // vault.on("delete", ...) never fires for config-dir paths, so a plugin removal is only
    // noticed by diffing the current raw .obsidian/plugins/** listing against the previous
    // scan's snapshot (lastKnownPluginPaths) -- this confirms internalSync() wires that diff
    // (detectRemovedPluginPaths, pluginSync.ts) into the same deletedFiles tombstone mechanism
    // regular file deletions use, not detectRemovedPluginPaths' own filtering logic.
    const removedPath = ".obsidian/plugins/old-plugin/main.js";
    const transport = fakeTransport({ delta: vi.fn(async () => ({ needUpload: [], needDownload: [] })) });
    const vault = fakeVault();
    // Nothing left on disk under .obsidian/plugins -- old-plugin/main.js is gone.
    vault.adapter.exists.mockImplementation(async (p: string) => p === ".obsidian/plugins");
    vault.adapter.list.mockImplementation(async () => ({ files: [], folders: [] }));

    const fileManager = fakeFileManager();
    const deletedFiles: Record<string, number> = {};
    const client = makeClientWithSettings(
      transport,
      vault,
      fileManager,
      { syncPlugins: true },
      deletedFiles,
      undefined,
      { [removedPath]: 1000 } // lastKnownPluginPaths from a previous scan
    );

    const result = await client.sync();

    const [, localFilesMeta] = (transport.delta as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as [
      string,
      Array<{ path: string; is_deleted: boolean }>,
    ];
    // The freshly-synthesized tombstone was sent to delta as part of this same scan...
    expect(localFilesMeta).toContainEqual(expect.objectContaining({ path: removedPath, is_deleted: true }));
    // ...and, since the (mocked) server's response doesn't ask for it back via needDownload, the
    // 3-1 reconciliation step (see that describe block above) immediately clears it again within
    // this same sync call.
    expect(deletedFiles[removedPath]).toBeUndefined();
    expect(result.deleted).toBe(1);
  });
});
