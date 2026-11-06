import { describe, expect, it, vi } from "vitest";
import { SyncClient } from "../src/syncClient";
import { getDefaultSettings } from "../src/settings";
import { isServerMtimePinnedPath, resolveReportedMtime } from "../src/serverMtimePin";
import { fakeFileManager, fakeTransport, fakeVault, sha256 } from "./syncClientTestUtils";

describe("isServerMtimePinnedPath", () => {
  it("covers exactly bookmarks.json and community-plugins.json in the config dir", () => {
    expect(isServerMtimePinnedPath(".obsidian/bookmarks.json", ".obsidian")).toBe(true);
    expect(isServerMtimePinnedPath(".obsidian/community-plugins.json", ".obsidian")).toBe(true);
    expect(isServerMtimePinnedPath(".obsidian/core-plugins.json", ".obsidian")).toBe(false);
    expect(isServerMtimePinnedPath(".obsidian/app.json", ".obsidian")).toBe(false);
    expect(isServerMtimePinnedPath("notes/bookmarks.json", ".obsidian")).toBe(false);
    expect(isServerMtimePinnedPath("cfg/bookmarks.json", "cfg")).toBe(true);
  });
});

describe("resolveReportedMtime", () => {
  it("reports the server's mtime when the local content equals the last-synced content", () => {
    expect(resolveReportedMtime({ hash: "h", mtimeMs: 1000 }, "h", 9999)).toBe(1000);
  });
  it("reports the file's own mtime once the content really changed", () => {
    expect(resolveReportedMtime({ hash: "h", mtimeMs: 1000 }, "other", 9999)).toBe(9999);
  });
  it("falls back to the file's own mtime when no server mtime was recorded (legacy entry / no entry)", () => {
    expect(resolveReportedMtime({ hash: "h" }, "h", 9999)).toBe(9999);
    expect(resolveReportedMtime(null, "h", 9999)).toBe(9999);
  });
});

function clientWithStore(transport: ReturnType<typeof fakeTransport>, vault: ReturnType<typeof fakeVault>, store: object) {
  return new SyncClient(
    transport,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vault as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fakeFileManager() as any,
    "/plugins/pumice",
    "test-token",
    { ...getDefaultSettings(vault.configDir), e2eePassword: "" },
    {},
    async () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store as any
  );
}

describe("SyncClient.sync -- server mtime pinning for bookmarks.json (regression: Obsidian rewriting identical content bumped mtime forever)", () => {
  async function runWith(entryFor: (hash: string) => { hash: string; mtimeMs?: number } | null, statAfter?: number) {
    const transport = fakeTransport({ delta: vi.fn(async () => ({ needUpload: [], needDownload: [] })) });
    const vault = fakeVault();
    const content = new TextEncoder().encode('{"items":[]}').buffer;
    const hash = await sha256(content);
    const path = ".obsidian/bookmarks.json";
    vault.adapter.exists.mockImplementation(async (p: string) => p === path);
    // Local file was just rewritten by Obsidian with identical content: mtime 9999.
    vault.adapter.stat.mockImplementation(async (p: string) => (p === path ? { mtime: 9999, size: content.byteLength } : null));
    vault.adapter.readBinary.mockImplementation(async (p: string) => (p === path ? content : new ArrayBuffer(0)));
    if (statAfter !== undefined) {
      let calls = 0;
      // 1st stat = scan, 2nd stat = the re-check right before rewriting the file
      vault.adapter.stat.mockImplementation(async () => ({ mtime: ++calls === 1 ? 9999 : statAfter, size: content.byteLength }));
    }
    const store = { get: vi.fn(async () => hash), getEntry: vi.fn(async () => entryFor(hash)), set: vi.fn() };
    await clientWithStore(transport, vault, store).sync();
    const [, meta] = (transport.delta as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as [
      string,
      Array<{ path: string; modified_at_ms: number }>,
    ];
    return { reported: meta.find((m) => m.path === path)!.modified_at_ms, vault, content };
  }

  it("reports the server's stored mtime when content matches the last-synced content", async () => {
    const { reported, vault, content } = await runWith((hash) => ({ hash, mtimeMs: 1000 }));
    expect(reported).toBe(1000);
    // The local file itself is rewritten (same bytes) with the server's mtime.
    expect(vault.adapter.writeBinary).toHaveBeenCalledTimes(1);
    expect(vault.adapter.writeBinary).toHaveBeenCalledWith(".obsidian/bookmarks.json", content, { mtime: 1000 });
  });

  it("reports the real mtime when the content differs from the last-synced content", async () => {
    const { reported, vault } = await runWith(() => ({ hash: "stale", mtimeMs: 1000 }));
    expect(reported).toBe(9999);
    expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
  });

  it("reports the real mtime when nothing was ever synced for it", async () => {
    const { reported, vault } = await runWith(() => null);
    expect(reported).toBe(9999);
    expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
  });

  it("does not touch the file when its mtime already equals the server's", async () => {
    const { reported, vault } = await runWith((hash) => ({ hash, mtimeMs: 9999 }));
    expect(reported).toBe(9999);
    expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
  });

  it("does not overwrite a file that was edited again after it was read", async () => {
    const { reported, vault } = await runWith((hash) => ({ hash, mtimeMs: 1000 }), 12345);
    expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
    expect(reported).toBe(9999);
  });
});

// ─── server-side merge wiring: the client never merges these two files itself ──────────────────

describe("SyncClient.sync -- bookmarks.json is merged by the server", () => {
  const path = ".obsidian/bookmarks.json";
  const localContent = new TextEncoder().encode('{"items":[{"type":"file","path":"mine.md"}]}').buffer;

  function setup(opts: { delta: { needUpload: string[]; needDownload: Array<Record<string, unknown>> }; lastSynced: string | null; e2ee?: boolean }) {
    const uploadBatch = vi.fn(async (_v: string, files: Array<{ path: string }>, onAck: (a: { path: string; ok: boolean; error: string }) => void) => {
      for (const f of files) onAck({ path: f.path, ok: true, error: "" });
    });
    const downloadBatch = vi.fn(async () => ({ downloadedCount: 0, failedPaths: [] }));
    const transport = fakeTransport({ delta: vi.fn(async () => opts.delta as never), uploadBatch, downloadBatch });
    const vault = fakeVault();
    vault.adapter.exists.mockImplementation(async (p: string) => p === path);
    vault.adapter.stat.mockImplementation(async (p: string) => (p === path ? { mtime: 5000, size: localContent.byteLength } : null));
    vault.adapter.readBinary.mockImplementation(async (p: string) => (p === path ? localContent : new ArrayBuffer(0)));
    const store = { get: vi.fn(async () => opts.lastSynced), getEntry: vi.fn(async () => null), set: vi.fn() };
    const client = clientWithStore(transport, vault, store);
    if (opts.e2ee) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).settings.enableE2EE = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).settings.e2eePassword = "pw";
    }
    return { client, uploadBatch, downloadBatch, store };
  }

  it("sends the last-synced hash as baseHash when uploading it", async () => {
    const { client, uploadBatch } = setup({ delta: { needUpload: [path], needDownload: [] }, lastSynced: "abc123" });
    await client.sync();
    const files = uploadBatch.mock.calls[0][1] as Array<{ path: string; baseHash?: string }>;
    expect(files.find((f) => f.path === path)?.baseHash).toBe("abc123");
  });

  it('sends baseHash "0" (no base) when this device never synced it', async () => {
    const { client, uploadBatch } = setup({ delta: { needUpload: [path], needDownload: [] }, lastSynced: null });
    await client.sync();
    const files = uploadBatch.mock.calls[0][1] as Array<{ path: string; baseHash?: string }>;
    expect(files.find((f) => f.path === path)?.baseHash).toBe("0");
  });

  it("uploads instead of downloading when the server is newer but this device has unsynced edits", async () => {
    const serverMeta = { path, modified_at_ms: 9000, size_bytes: 10, content_hash: "server", is_deleted: false };
    const { client, uploadBatch, downloadBatch } = setup({ delta: { needUpload: [], needDownload: [serverMeta] }, lastSynced: "older-than-local" });
    await client.sync();
    expect(uploadBatch).toHaveBeenCalledTimes(1);
    expect((uploadBatch.mock.calls[0][1] as Array<{ path: string }>).map((f) => f.path)).toEqual([path]);
    expect(downloadBatch).not.toHaveBeenCalled();
  });

  it("still downloads the server's version when this device has no unsynced edits", async () => {
    const hash = await sha256(localContent);
    const serverMeta = { path, modified_at_ms: 9000, size_bytes: 10, content_hash: "server", is_deleted: false };
    const { client, uploadBatch, downloadBatch } = setup({ delta: { needUpload: [], needDownload: [serverMeta] }, lastSynced: hash });
    await client.sync();
    expect(downloadBatch).toHaveBeenCalledTimes(1);
    expect(uploadBatch).not.toHaveBeenCalled();
  });

  it("is exempt from E2EE: uploaded as plaintext with a baseHash so the server can read and merge it", async () => {
    const { client, uploadBatch } = setup({ delta: { needUpload: [path], needDownload: [] }, lastSynced: "abc123", e2ee: true });
    await client.sync();
    const files = uploadBatch.mock.calls[0][1] as Array<{ path: string; baseHash?: string; data: ArrayBuffer; contentHash: string }>;
    const f = files.find((x) => x.path === path)!;
    expect(f.baseHash).toBe("abc123");
    expect(new TextDecoder().decode(f.data)).toBe(new TextDecoder().decode(localContent));
    expect(f.contentHash).toBe(await sha256(localContent));
  });

  it("reports the plaintext hash to Delta under E2EE (not a ciphertext hash)", async () => {
    const { client } = setup({ delta: { needUpload: [], needDownload: [] }, lastSynced: null, e2ee: true });
    const delta = (client as unknown as { transport: { delta: ReturnType<typeof vi.fn> } }).transport.delta;
    await client.sync();
    const [, meta] = delta.mock.calls[0] as [string, Array<{ path: string; content_hash: string }>];
    expect(meta.find((m) => m.path === path)?.content_hash).toBe(await sha256(localContent));
  });
});

describe("SyncClient download -- server-merged files under E2EE", () => {
  const path = ".obsidian/community-plugins.json";
  const plain = new TextEncoder().encode('["a","b"]').buffer;

  async function download(wire: ArrayBuffer) {
    const wireHash = await sha256(wire);
    const transport = fakeTransport({
      downloadBatch: vi.fn(async (_v: string, _p: string[], onFile: (f: unknown) => Promise<boolean>) => {
        await onFile({ path, data: wire, contentHash: wireHash, mtimeMs: 123 });
        return { downloadedCount: 1, failedPaths: [] };
      }),
    });
    const vault = fakeVault();
    const set = vi.fn();
    const client = clientWithStore(transport, vault, { get: vi.fn(async () => null), getEntry: vi.fn(async () => null), set });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).settings.enableE2EE = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).settings.e2eePassword = "pw";
    await client.applyPushedFileChange({ path, modified_at_ms: 123, size_bytes: wire.byteLength, content_hash: wireHash, is_deleted: false });
    return { vault, set, client };
  }

  const written = (vault: ReturnType<typeof fakeVault>) =>
    new TextDecoder().decode((vault.createBinary.mock.calls[0]?.[1] ?? vault.adapter.writeBinary.mock.calls[0]?.[1]) as ArrayBuffer);

  it("writes the plaintext JSON the server stores as-is (no decryption attempted)", async () => {
    const { vault, set } = await download(plain);
    expect(written(vault)).toBe('["a","b"]');
    expect(set).toHaveBeenCalledWith(path, await sha256(plain), 123);
  });

  it("still decrypts a copy that was stored encrypted before this exemption existed", async () => {
    const probe = (await download(plain)).client as unknown as {
      encryptData(d: ArrayBuffer, k: unknown): Promise<ArrayBuffer>;
      getE2eeKey(): Promise<unknown>;
    };
    const cipher = await probe.encryptData(plain, await probe.getE2eeKey());
    const { vault, set } = await download(cipher);
    expect(written(vault)).toBe('["a","b"]');
    // The synced hash is the plaintext hash, matching what is on disk now.
    expect(set).toHaveBeenCalledWith(path, await sha256(plain), 123);
  });
});
