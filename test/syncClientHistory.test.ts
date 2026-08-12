import { describe, expect, it } from "vitest";
import { fakeFileManager, fakeTransport, fakeVault, makeClient } from "./syncClientTestUtils";

// 2026-08 WS history migration follow-up (see #11_websocket_동기화_프로토콜_설계.md and
// llm-wiki/09-*.md): getFileHistory/downloadHistoryVersion/restoreHistoryVersion move off REST
// (requestHttp) onto the transport, mirroring the WS ops that already existed server-side
// (history_req/history_dl_req/restore_req) but the client never used.

describe("SyncClient.getFileHistory", () => {
  it("delegates to transport.getHistory with the vault name and path", async () => {
    const versions = [{ history_id: 1, modified_at_ms: 1000, size_bytes: 5, content_hash: "h1", device_name: "PC", user_name: "Alice" }];
    const transport = fakeTransport({ getHistory: async () => versions });
    const vault = fakeVault();
    const client = makeClient(transport, vault, fakeFileManager());

    const result = await client.getFileHistory("note.md");

    expect(result).toEqual(versions);
  });
});

describe("SyncClient.downloadHistoryVersion", () => {
  it("delegates to transport.downloadHistoryVersion and returns the data (no E2EE)", async () => {
    const data = new TextEncoder().encode("v1 content").buffer;
    const calls: unknown[] = [];
    const transport = fakeTransport({
      downloadHistoryVersion: async (vaultId: string, historyId: number, path?: string) => {
        calls.push([vaultId, historyId, path]);
        return { data, path: "note.md", contentHash: "h1" };
      },
    });
    const vault = fakeVault();
    const client = makeClient(transport, vault, fakeFileManager());

    const result = await client.downloadHistoryVersion("note.md", 42);

    expect(calls).toEqual([["myvault", 42, undefined]]);
    expect(result).toBe(data);
  });
});

describe("SyncClient.restoreHistoryVersion", () => {
  it("tells the server to restore, downloads the version, and writes it to the given target path", async () => {
    const data = new TextEncoder().encode("v1 content").buffer;
    const restoreCalls: unknown[] = [];
    const downloadCalls: unknown[] = [];
    const transport = fakeTransport({
      restoreHistoryVersion: async (vaultId: string, historyId: number, path?: string) => {
        restoreCalls.push([vaultId, historyId, path]);
        return { ok: true, error: "" };
      },
      downloadHistoryVersion: async (vaultId: string, historyId: number, path?: string) => {
        downloadCalls.push([vaultId, historyId, path]);
        return { data, path: "note.md", contentHash: "h1" };
      },
    });
    const vault = fakeVault();
    const client = makeClient(transport, vault, fakeFileManager());

    const currentPath = await client.restoreHistoryVersion(42, "note.md");

    expect(restoreCalls).toEqual([["myvault", 42, "note.md"]]);
    expect(downloadCalls).toEqual([["myvault", 42, "note.md"]]);
    expect(currentPath).toBe("note.md");
    expect(vault.createBinary).toHaveBeenCalledWith("note.md", data, undefined);
  });

  it("falls back to the server-resolved path when no target path is given", async () => {
    const data = new TextEncoder().encode("v1 content").buffer;
    const transport = fakeTransport({
      restoreHistoryVersion: async () => ({ ok: true, error: "" }),
      downloadHistoryVersion: async () => ({ data, path: "server-resolved.md", contentHash: "h1" }),
    });
    const vault = fakeVault();
    const client = makeClient(transport, vault, fakeFileManager());

    const currentPath = await client.restoreHistoryVersion(42);

    expect(currentPath).toBe("server-resolved.md");
    expect(vault.createBinary).toHaveBeenCalledWith("server-resolved.md", data, undefined);
  });

  it("throws if neither a target path nor a server-resolved path is available", async () => {
    const transport = fakeTransport({
      restoreHistoryVersion: async () => ({ ok: true, error: "" }),
      downloadHistoryVersion: async () => ({ data: new ArrayBuffer(0), path: "", contentHash: "" }),
    });
    const vault = fakeVault();
    const client = makeClient(transport, vault, fakeFileManager());

    await expect(client.restoreHistoryVersion(42)).rejects.toThrow();
  });
});
