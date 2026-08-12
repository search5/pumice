import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { SyncClient } from "../src/syncClient";
import { getDefaultSettings } from "../src/settings";
import { fakeFileManager, fakeTransport, fakeVault, makeClient, sha256 } from "./syncClientTestUtils";

// Coverage follow-up for SyncClient's upload path (prepareUploadFile / uploadFileBatch /
// backupLocalVersion, src/syncClient.ts around lines 421-527 as of this writing) -- part of the
// same parallel coverage-improvement effort as syncClientPush.test.ts / syncClientHistory.test.ts.
// All three targets are private methods reached via `(client as any).<method>(...)`, same
// unit-testing-a-private-helper-in-isolation pattern already used for those. Shared fakes
// (fakeTransport/fakeVault/fakeFileManager/makeClient/sha256) come from syncClientTestUtils.ts;
// see that file's own comment for why importing SyncClient outside real Obsidian works at all.

// makeClient() (syncClientTestUtils.ts) always builds settings with enableE2EE left at its
// getDefaultSettings() default (false) and no way to override it -- prepareUploadFile's E2EE
// branch needs a client built with enableE2EE: true and a non-empty e2eePassword, so this
// constructs a SyncClient directly with the same positional args makeClient uses, just with an
// E2EE-enabled settings object layered on top.
function makeE2eeClient(
  transport: ReturnType<typeof fakeTransport>,
  vault: ReturnType<typeof fakeVault>,
  fileManager: ReturnType<typeof fakeFileManager>,
  e2eePassword: string
): SyncClient {
  const settings = { ...getDefaultSettings(vault.configDir), enableE2EE: true, e2eePassword };
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
    async () => {}
  );
}

describe("SyncClient.prepareUploadFile -- E2EE off", () => {
  it("returns the plaintext buffer itself and its plain SHA-256 hash", async () => {
    const transport = fakeTransport();
    const vault = fakeVault();
    const fileManager = fakeFileManager();
    const client = makeClient(transport, vault, fileManager);

    const content = new TextEncoder().encode("hello world").buffer;
    vault.adapter.exists.mockResolvedValue(true);
    vault.adapter.readBinary.mockImplementation(async (p: string) => (p === "note.md" ? content : new ArrayBuffer(0)));
    vault.adapter.stat.mockResolvedValue({ mtime: 12345, size: content.byteLength });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (client as any).prepareUploadFile("note.md", new Map());

    expect(result.path).toBe("note.md");
    expect(new Uint8Array(result.data)).toEqual(new Uint8Array(content));
    expect(result.contentHash).toBe(await sha256(content));
    expect(result.mtimeMs).toBe(12345);
  });

  it("returns null and does not throw when the file no longer exists locally", async () => {
    const transport = fakeTransport();
    const vault = fakeVault();
    const fileManager = fakeFileManager();
    const client = makeClient(transport, vault, fileManager);

    vault.adapter.exists.mockResolvedValue(false);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (client as any).prepareUploadFile("gone.md", new Map());

    expect(result).toBeNull();
  });

  it("returns null (does not throw) when reading the file rejects", async () => {
    const transport = fakeTransport();
    const vault = fakeVault();
    const fileManager = fakeFileManager();
    const client = makeClient(transport, vault, fileManager);

    vault.adapter.exists.mockResolvedValue(true);
    vault.adapter.readBinary.mockRejectedValue(new Error("disk error"));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (client as any).prepareUploadFile("broken.md", new Map());

    expect(result).toBeNull();
  });

  it("falls back to Date.now() for mtime when the underlying stat lookup returns null", async () => {
    const transport = fakeTransport();
    const vault = fakeVault();
    const fileManager = fakeFileManager();
    const client = makeClient(transport, vault, fileManager);

    const content = new TextEncoder().encode("no stat available").buffer;
    vault.adapter.exists.mockResolvedValue(true);
    vault.adapter.readBinary.mockImplementation(async (p: string) => (p === "nostat.md" ? content : new ArrayBuffer(0)));
    vault.adapter.stat.mockResolvedValue(null);

    const before = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (client as any).prepareUploadFile("nostat.md", new Map());
    const after = Date.now();

    expect(result.mtimeMs).toBeGreaterThanOrEqual(before);
    expect(result.mtimeMs).toBeLessThanOrEqual(after);
  });

  it("reuses a cached scanned buffer instead of re-reading the vault, and consumes it from the map", async () => {
    const transport = fakeTransport();
    const vault = fakeVault();
    const fileManager = fakeFileManager();
    const client = makeClient(transport, vault, fileManager);

    const cachedBuffer = new TextEncoder().encode("cached content").buffer;
    const scannedWireBuffers = new Map([["note.md", { buffer: cachedBuffer, hash: "cached-hash", mtime: 999 }]]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (client as any).prepareUploadFile("note.md", scannedWireBuffers);

    expect(result).toEqual({ path: "note.md", data: cachedBuffer, contentHash: "cached-hash", mtimeMs: 999 });
    expect(vault.adapter.readBinary).not.toHaveBeenCalled();
    // Consumed -- the entry is removed once used, per the method's own doc comment.
    expect(scannedWireBuffers.has("note.md")).toBe(false);
  });
});

describe("SyncClient.prepareUploadFile -- E2EE on", () => {
  it("encrypts the buffer and hashes the CIPHERTEXT, not the plaintext", async () => {
    const transport = fakeTransport();
    const vault = fakeVault();
    const fileManager = fakeFileManager();
    const client = makeE2eeClient(transport, vault, fileManager, "correct horse battery staple");

    const plaintext = new TextEncoder().encode("super secret note content").buffer;
    vault.adapter.exists.mockResolvedValue(true);
    vault.adapter.readBinary.mockImplementation(async (p: string) => (p === "secret.md" ? plaintext : new ArrayBuffer(0)));
    vault.adapter.stat.mockResolvedValue({ mtime: 555, size: plaintext.byteLength });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (client as any).prepareUploadFile("secret.md", new Map());

    // The wire data is ciphertext, not the plaintext buffer.
    expect(new Uint8Array(result.data)).not.toEqual(new Uint8Array(plaintext));
    // The server-visible hash is over the ciphertext, never the plaintext -- this is what keeps
    // the server from ever learning a plaintext content hash under E2EE.
    expect(result.contentHash).toBe(await sha256(result.data));
    expect(result.contentHash).not.toBe(await sha256(plaintext));
    expect(result.mtimeMs).toBe(555);

    // Round-trip through the client's own decryptData to confirm the ciphertext really does
    // decrypt back to the original plaintext (not just "different bytes").
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const key = await (client as any).getE2eeKey();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const decrypted = await (client as any).decryptData(result.data, key);
    expect(new Uint8Array(decrypted)).toEqual(new Uint8Array(plaintext));
  });
});

describe("SyncClient.uploadFileBatch", () => {
  it("does nothing and never calls the transport for an empty path list", async () => {
    const transport = fakeTransport();
    const vault = fakeVault();
    const fileManager = fakeFileManager();
    const client = makeClient(transport, vault, fileManager);
    const onAck = vi.fn();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).uploadFileBatch([], "vault1", new Map(), new Map(), onAck);

    expect(transport.uploadBatch).not.toHaveBeenCalled();
    expect(onAck).not.toHaveBeenCalled();
  });

  it("prepares each path's wire file and forwards them plus onAck to transport.uploadBatch", async () => {
    const uploadBatch = vi.fn(async (_vaultId: string, files: { path: string }[], onAck: (a: { path: string; ok: boolean; error: string }) => void) => {
      for (const f of files) onAck({ path: f.path, ok: true, error: "" });
    });
    const transport = fakeTransport({ uploadBatch });
    const vault = fakeVault();
    const fileManager = fakeFileManager();
    const client = makeClient(transport, vault, fileManager);

    const contentA = new TextEncoder().encode("file a").buffer;
    const contentB = new TextEncoder().encode("file bbb").buffer;
    vault.adapter.exists.mockResolvedValue(true);
    vault.adapter.readBinary.mockImplementation(async (p: string) => (p === "a.md" ? contentA : contentB));
    vault.adapter.stat.mockImplementation(async (p: string) => (p === "a.md" ? { mtime: 100, size: 6 } : { mtime: 200, size: 8 }));

    // "b.md" is deliberately left out of sizeByPath -- exercises the `sizeByPath.get(p) ?? 0`
    // fallback used to size batches for a path the caller didn't (or couldn't) supply a size for.
    const sizeByPath = new Map([["a.md", 6]]);
    const acks: { path: string; ok: boolean; error: string }[] = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).uploadFileBatch(["a.md", "b.md"], "vault1", new Map(), sizeByPath, (ack: { path: string; ok: boolean; error: string }) => acks.push(ack));

    expect(transport.uploadBatch).toHaveBeenCalledTimes(1);
    const [vaultIdArg, filesArg] = uploadBatch.mock.calls[0];
    expect(vaultIdArg).toBe("vault1");
    expect(filesArg).toEqual([
      { path: "a.md", data: expect.any(ArrayBuffer), contentHash: await sha256(contentA), mtimeMs: 100 },
      { path: "b.md", data: expect.any(ArrayBuffer), contentHash: await sha256(contentB), mtimeMs: 200 },
    ]);
    expect(acks).toEqual([
      { path: "a.md", ok: true, error: "" },
      { path: "b.md", ok: true, error: "" },
    ]);
  });

  it("drops a path whose prep fails from the batch instead of reporting it via onAck", async () => {
    // Characterizes CURRENT behavior: uploadFileBatch's own doc comment says "failures are
    // reported through onAck like any other ack, not thrown", but prepareUploadFile's failures
    // (its try/catch, syncClient.ts ~459-462) are swallowed into a `null` that's filtered out of
    // `files` before transport.uploadBatch is ever called -- so a prep failure gets NEITHER an
    // onAck(ok:false) NOR a thrown error out of uploadFileBatch. It's silently dropped (aside
    // from a console.error). Only failures the transport itself reports via onAck actually
    // surface that way. This looks like a mismatch between the doc comment and the code, worth
    // a maintainer look, but left unfixed per this task's scope.
    const uploadBatch = vi.fn(async (_vaultId: string, files: { path: string }[], onAck: (a: { path: string; ok: boolean; error: string }) => void) => {
      for (const f of files) onAck({ path: f.path, ok: true, error: "" });
    });
    const transport = fakeTransport({ uploadBatch });
    const vault = fakeVault();
    const fileManager = fakeFileManager();
    const client = makeClient(transport, vault, fileManager);

    const goodContent = new TextEncoder().encode("fine").buffer;
    vault.adapter.exists.mockResolvedValue(true);
    vault.adapter.readBinary.mockImplementation(async (p: string) => {
      if (p === "bad.md") throw new Error("read failed");
      return goodContent;
    });
    vault.adapter.stat.mockResolvedValue({ mtime: 1, size: 4 });

    const sizeByPath = new Map([["good.md", 4], ["bad.md", 4]]);
    const acks: { path: string; ok: boolean; error: string }[] = [];
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).uploadFileBatch(["good.md", "bad.md"], "vault1", new Map(), sizeByPath, (ack: { path: string; ok: boolean; error: string }) => acks.push(ack));

    const [, filesArg] = uploadBatch.mock.calls[0];
    expect(filesArg).toHaveLength(1);
    expect(filesArg[0].path).toBe("good.md");
    // No ack of any kind (ok:true or ok:false) was ever produced for the failed path.
    expect(acks.find((a) => a.path === "bad.md")).toBeUndefined();
    expect(acks).toEqual([{ path: "good.md", ok: true, error: "" }]);

    consoleErrorSpy.mockRestore();
  });
});

describe("SyncClient.backupLocalVersion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-03-15T09:30:45.123Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes the path's current content to a <name>.sync-conflict-<timestamp>.<ext> path and returns it", async () => {
    const transport = fakeTransport();
    const vault = fakeVault();
    const fileManager = fakeFileManager();
    const client = makeClient(transport, vault, fileManager);

    const originalBytes = new TextEncoder().encode("the current local content").buffer;
    vault.adapter.readBinary.mockImplementation(async (p: string) => (p === "notes/a.md" ? originalBytes : new ArrayBuffer(0)));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conflictPath: string = await (client as any).backupLocalVersion("notes/a.md");

    expect(conflictPath).toBe("notes/a.sync-conflict-2024-03-15T09-30-45-123Z.md");
    // getAbstractFileByPath() returns null by default (fakeVault), so writeBinaryByPath's
    // Vault-API branch (vault.createBinary) is what actually gets exercised here, not the
    // adapter fallback.
    expect(vault.createBinary).toHaveBeenCalledTimes(1);
    const [writtenPath, writtenData] = vault.createBinary.mock.calls[0];
    expect(writtenPath).toBe(conflictPath);
    expect(new Uint8Array(writtenData)).toEqual(new Uint8Array(originalBytes));
  });

  it("leaves the path with no extension when the original path has none (pathUtil.extname edge case)", async () => {
    const transport = fakeTransport();
    const vault = fakeVault();
    const fileManager = fakeFileManager();
    const client = makeClient(transport, vault, fileManager);

    const originalBytes = new TextEncoder().encode("dotless file content").buffer;
    vault.adapter.readBinary.mockImplementation(async (p: string) => (p === "README" ? originalBytes : new ArrayBuffer(0)));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conflictPath: string = await (client as any).backupLocalVersion("README");

    expect(conflictPath).toBe("README.sync-conflict-2024-03-15T09-30-45-123Z");
    const [writtenPath] = vault.createBinary.mock.calls[0];
    expect(writtenPath).toBe(conflictPath);
  });
});
