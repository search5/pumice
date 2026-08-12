import { describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import { SyncClient } from "../src/syncClient";
import { getDefaultSettings } from "../src/settings";
import type { SyncTransport, DownloadedFileWire } from "../src/syncTransport";

// SyncClient's push-metadata fidelity follow-up (see #11_websocket_동기화_프로토콜_설계.md and
// llm-wiki/03-*.md): applyPushedFileChange() applies exactly the one file a `push` notification
// named, instead of a full internalSync()/Delta. This is SyncClient's first-ever unit test file
// (see llm-wiki/07-push-file-metadata.md for why none existed before) -- test/obsidianTestStub.ts
// + vitest.config.mts's resolve.alias make "obsidian"'s value imports (TFile, used via
// `instanceof`) resolvable outside the real Obsidian app. Scoped to applyPushedFileChange's own
// dispatch logic and the (pre-existing, unchanged) deletion/plain-download paths it reuses --
// not attempting to cover downloadFileBatch's full conflict-resolution/merge matrix here, which
// predates this file and is out of scope for this follow-up.

async function sha256(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fakeTransport(overrides: Partial<SyncTransport> = {}): SyncTransport {
  return {
    delta: vi.fn(),
    uploadBatch: vi.fn(),
    downloadBatch: vi.fn(),
    ping: vi.fn(),
    size: vi.fn(),
    purge: vi.fn(),
    getUsernames: vi.fn(),
    ...overrides,
  };
}

interface FakeVault {
  configDir: string;
  getName: ReturnType<typeof vi.fn>;
  getAbstractFileByPath: ReturnType<typeof vi.fn>;
  createBinary: ReturnType<typeof vi.fn>;
  modifyBinary: ReturnType<typeof vi.fn>;
  adapter: {
    exists: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    writeBinary: ReturnType<typeof vi.fn>;
  };
}

function fakeVault(): FakeVault {
  return {
    configDir: ".obsidian",
    getName: vi.fn(() => "myvault"),
    getAbstractFileByPath: vi.fn(() => null),
    createBinary: vi.fn(async () => {}),
    modifyBinary: vi.fn(async () => {}),
    adapter: {
      exists: vi.fn(async () => false),
      remove: vi.fn(async () => {}),
      writeBinary: vi.fn(async () => {}),
    },
  };
}

function fakeFileManager() {
  return { trashFile: vi.fn(async () => {}) };
}

function makeClient(
  transport: SyncTransport,
  vault: FakeVault,
  fileManager: ReturnType<typeof fakeFileManager>,
  deletedFiles: Record<string, number> = {},
  updateDeletedFiles: (deleted: Record<string, number>) => Promise<void> = async () => {}
): SyncClient {
  const settings = { ...getDefaultSettings(vault.configDir), e2eePassword: "" };
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
    updateDeletedFiles
  );
}

describe("SyncClient.applyPushedFileChange -- deletion", () => {
  it("trashes a file that's in the vault index", async () => {
    const transport = fakeTransport();
    const vault = fakeVault();
    const file = new TFile();
    file.path = "a.md";
    vault.getAbstractFileByPath.mockImplementation((p: string) => (p === "a.md" ? file : null));
    const fileManager = fakeFileManager();
    const client = makeClient(transport, vault, fileManager);

    await client.applyPushedFileChange({ path: "a.md", modified_at_ms: 0, size_bytes: 0, content_hash: "", is_deleted: true });

    expect(fileManager.trashFile).toHaveBeenCalledWith(file);
    expect(transport.downloadBatch).not.toHaveBeenCalled();
  });

  it("removes via the adapter a deleted path that's outside the vault index", async () => {
    const transport = fakeTransport();
    const vault = fakeVault();
    vault.adapter.exists.mockResolvedValue(true);
    const fileManager = fakeFileManager();
    const client = makeClient(transport, vault, fileManager);

    await client.applyPushedFileChange({ path: ".obsidian/bookmarks.json", modified_at_ms: 0, size_bytes: 0, content_hash: "", is_deleted: true });

    expect(vault.adapter.remove).toHaveBeenCalledWith(".obsidian/bookmarks.json");
    expect(fileManager.trashFile).not.toHaveBeenCalled();
  });

  it("does nothing and does not throw for a deletion of a path that doesn't exist locally", async () => {
    const transport = fakeTransport();
    const vault = fakeVault();
    const fileManager = fakeFileManager();
    const client = makeClient(transport, vault, fileManager);

    await expect(
      client.applyPushedFileChange({ path: "already-gone.md", modified_at_ms: 0, size_bytes: 0, content_hash: "", is_deleted: true })
    ).resolves.toBeUndefined();

    expect(fileManager.trashFile).not.toHaveBeenCalled();
    expect(vault.adapter.remove).not.toHaveBeenCalled();
  });

  it("clears a matching deletedFiles tombstone even when there was nothing left to delete", async () => {
    const transport = fakeTransport();
    const vault = fakeVault();
    const fileManager = fakeFileManager();
    const deletedFiles: Record<string, number> = { "already-gone.md": 12345 };
    const client = makeClient(transport, vault, fileManager, deletedFiles);

    await client.applyPushedFileChange({ path: "already-gone.md", modified_at_ms: 0, size_bytes: 0, content_hash: "", is_deleted: true });

    expect(deletedFiles["already-gone.md"]).toBeUndefined();
  });
});

describe("SyncClient.applyPushedFileChange -- download", () => {
  it("downloads exactly the one pushed path via the transport and writes it locally", async () => {
    const data = new TextEncoder().encode("hello").buffer;
    const hash = await sha256(data);
    const transport = fakeTransport({
      downloadBatch: vi.fn(async (vaultId: string, paths: string[], onFile: (f: DownloadedFileWire) => Promise<boolean>) => {
        const ok = await onFile({ path: paths[0], mtimeMs: 12345, data, contentHash: hash });
        return { downloadedCount: ok ? 1 : 0, failedPaths: ok ? [] : [paths[0]] };
      }),
    });
    const vault = fakeVault();
    const fileManager = fakeFileManager();
    const client = makeClient(transport, vault, fileManager);

    await client.applyPushedFileChange({ path: "new.md", modified_at_ms: 12345, size_bytes: 5, content_hash: hash, is_deleted: false });

    expect(transport.downloadBatch).toHaveBeenCalledWith("myvault", ["new.md"], expect.any(Function));
    expect(vault.createBinary).toHaveBeenCalledWith("new.md", expect.any(ArrayBuffer), { mtime: 12345 });
  });

  it("does not write when the downloaded content's hash doesn't match what was pushed", async () => {
    const data = new TextEncoder().encode("hello").buffer;
    const transport = fakeTransport({
      downloadBatch: vi.fn(async (vaultId: string, paths: string[], onFile: (f: DownloadedFileWire) => Promise<boolean>) => {
        const ok = await onFile({ path: paths[0], mtimeMs: 1, data, contentHash: "wrong-hash" });
        return { downloadedCount: ok ? 1 : 0, failedPaths: ok ? [] : [paths[0]] };
      }),
    });
    const vault = fakeVault();
    const fileManager = fakeFileManager();
    const client = makeClient(transport, vault, fileManager);

    await client.applyPushedFileChange({ path: "new.md", modified_at_ms: 1, size_bytes: 5, content_hash: "wrong-hash", is_deleted: false });

    expect(vault.createBinary).not.toHaveBeenCalled();
  });
});
