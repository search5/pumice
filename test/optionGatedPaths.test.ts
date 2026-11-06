import { describe, expect, it, vi } from "vitest";
import { SyncClient } from "../src/syncClient";
import { getDefaultSettings, type SyncPluginSettings } from "../src/settings";
import { fakeFileManager, fakeTransport, fakeVault } from "./syncClientTestUtils";

// Regression: with "sync plugins" off, plugin files / community-plugins.json were only left out of
// the LOCAL scan -- the server's Delta still listed them (other devices uploaded them) and they were
// downloaded anyway, over the plugin folders already installed here: an endless stream of conflicts.

const PLUGIN_FILE = ".obsidian/plugins/some-plugin/main.js";
const PLUGIN_DATA = ".obsidian/plugins/some-plugin/data.json";
const COMMUNITY = ".obsidian/community-plugins.json";
const BOOKMARKS = ".obsidian/bookmarks.json";
const NOTE = "notes/todo.md";

const meta = (path: string, extra: Record<string, unknown> = {}) => ({
  path, modified_at_ms: 9000, size_bytes: 10, content_hash: "server", is_deleted: false, ...extra,
});

function setup(settings: Partial<SyncPluginSettings>, needDownload: Array<Record<string, unknown>>) {
  const downloadBatch = vi.fn(async () => ({ downloadedCount: 0, failedPaths: [] }));
  const transport = fakeTransport({
    delta: vi.fn(async () => ({ needUpload: [], needDownload }) as never),
    uploadBatch: vi.fn(async () => {}),
    downloadBatch,
  });
  const vault = fakeVault();
  const client = new SyncClient(
    transport,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vault as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fakeFileManager() as any,
    "/plugins/pumice",
    "test-token",
    { ...getDefaultSettings(vault.configDir), ...settings, e2eePassword: "" },
    {},
    async () => {},
  );
  return { client, downloadBatch, vault };
}

const downloaded = (downloadBatch: ReturnType<typeof vi.fn>) =>
  downloadBatch.mock.calls.flatMap((c) => c[1] as string[]);

describe("SyncClient.sync -- paths gated by a disabled sync option are not downloaded", () => {
  const remote = [meta(PLUGIN_FILE), meta(PLUGIN_DATA), meta(COMMUNITY), meta(BOOKMARKS), meta(NOTE)];

  it("plugins off: plugin files and community-plugins.json stay out, notes and bookmarks still come down", async () => {
    const { client, downloadBatch } = setup({ syncPlugins: false, syncBookmarks: true }, remote);
    await client.sync();
    expect(downloaded(downloadBatch).sort()).toEqual([BOOKMARKS, NOTE].sort());
  });

  it("plugins off: a server-side deletion of a plugin file is not applied to the installed plugin", async () => {
    const { client, vault } = setup({ syncPlugins: false }, [meta(PLUGIN_FILE, { is_deleted: true, content_hash: "" })]);
    vault.adapter.exists.mockResolvedValue(true);
    await client.sync();
    expect(vault.adapter.remove).not.toHaveBeenCalled();
  });

  it("plugins on: plugin files and community-plugins.json are downloaded (data.json only when its own option is on)", async () => {
    const { client, downloadBatch } = setup({ syncPlugins: true, syncPluginData: false }, remote);
    await client.sync();
    expect(downloaded(downloadBatch).sort()).toEqual([PLUGIN_FILE, COMMUNITY, BOOKMARKS, NOTE].sort());
  });

  it("plugins on, plugin data on: data.json is downloaded too", async () => {
    const { client, downloadBatch } = setup({ syncPlugins: true, syncPluginData: true }, remote);
    await client.sync();
    expect(downloaded(downloadBatch)).toContain(PLUGIN_DATA);
  });

  it("bookmarks off: bookmarks.json is not downloaded", async () => {
    const { client, downloadBatch } = setup({ syncBookmarks: false }, [meta(BOOKMARKS), meta(NOTE)]);
    await client.sync();
    expect(downloaded(downloadBatch)).toEqual([NOTE]);
  });
});

describe("SyncClient.applyPushedFileChange -- same gating for live push notifications", () => {
  it("ignores a pushed plugin file while plugin sync is off", async () => {
    const { client, downloadBatch } = setup({ syncPlugins: false }, []);
    await client.applyPushedFileChange({ path: PLUGIN_FILE, modified_at_ms: 1, size_bytes: 1, content_hash: "h", is_deleted: false });
    await client.applyPushedFileChange({ path: COMMUNITY, modified_at_ms: 1, size_bytes: 1, content_hash: "h", is_deleted: false });
    expect(downloadBatch).not.toHaveBeenCalled();
  });

  it("applies a pushed plugin file while plugin sync is on", async () => {
    const { client, downloadBatch } = setup({ syncPlugins: true }, []);
    await client.applyPushedFileChange({ path: PLUGIN_FILE, modified_at_ms: 1, size_bytes: 1, content_hash: "h", is_deleted: false });
    expect(downloadBatch).toHaveBeenCalledTimes(1);
  });
});

describe("plugin folder files are adopted from the server, never merged or conflict-marked", () => {
  const remoteJs = new TextEncoder().encode("// server version of main.js\nmodule.exports = 2;\n").buffer;
  const localJs = new TextEncoder().encode("// local version of main.js\nmodule.exports = 1;\n").buffer;

  async function download(path: string) {
    const { sha256 } = await import("./syncClientTestUtils");
    const hash = await sha256(remoteJs);
    const transport = fakeTransport({
      downloadBatch: vi.fn(async (_v: string, _p: string[], onFile: (f: unknown) => Promise<boolean>) => {
        await onFile({ path, data: remoteJs, contentHash: hash, mtimeMs: 777 });
        return { downloadedCount: 1, failedPaths: [] };
      }),
    });
    const vault = fakeVault();
    vault.adapter.exists.mockResolvedValue(true); // the plugin is already installed here
    vault.adapter.readBinary.mockResolvedValue(localJs);
    const store = { get: vi.fn(async () => "some-older-synced-hash"), getEntry: vi.fn(async () => null), set: vi.fn() };
    const client = new SyncClient(
      transport,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vault as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fakeFileManager() as any,
      "/plugins/pumice",
      "test-token",
      { ...getDefaultSettings(vault.configDir), syncPlugins: true, syncPluginData: true, e2eePassword: "" },
      {},
      async () => {},
      undefined, undefined, undefined, undefined, undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      store as any,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const merge = vi.spyOn(client as any, "tryAutoMergeConflict");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const backup = vi.spyOn(client as any, "backupLocalVersion");
    await client.applyPushedFileChange({ path, modified_at_ms: 777, size_bytes: remoteJs.byteLength, content_hash: hash, is_deleted: false });
    return { vault, merge, backup, store, hash };
  }

  it.each([PLUGIN_FILE, PLUGIN_DATA, ".obsidian/plugins/some-plugin/styles.css", ".obsidian/plugins/some-plugin/manifest.json"])(
    "%s: the server's copy replaces the local one without a merge attempt or a conflict backup",
    async (path) => {
      const { vault, merge, backup, store, hash } = await download(path);
      expect(merge).not.toHaveBeenCalled();
      expect(backup).not.toHaveBeenCalled();
      const call = [...vault.createBinary.mock.calls, ...vault.adapter.writeBinary.mock.calls].find((c) => c[0] === path);
      const written = call?.[1] as ArrayBuffer;
      expect(new TextDecoder().decode(written)).toBe("// server version of main.js\nmodule.exports = 2;\n");
      expect(new TextDecoder().decode(written)).not.toContain("<<<<<<<");
      expect(store.set).toHaveBeenCalledWith(path, hash, 777);
    },
  );

  it("an ordinary note still goes through the merge path", async () => {
    const { merge } = await download("notes/todo.md");
    expect(merge).toHaveBeenCalled();
  });
});
