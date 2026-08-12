import { vi } from "vitest";
import { SyncClient } from "../src/syncClient";
import { getDefaultSettings } from "../src/settings";
import type { SyncTransport } from "../src/syncTransport";

// Shared SyncClient test harness (fake Vault/FileManager/SyncTransport) -- see
// llm-wiki/07-push-file-metadata.md for why this exists (SyncClient had zero unit tests before
// that follow-up; test/obsidianTestStub.ts + vitest.config.mts's "obsidian" alias are what make
// importing SyncClient in a test possible at all).

export async function sha256(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function fakeTransport(overrides: Partial<SyncTransport> = {}): SyncTransport {
  return {
    delta: vi.fn(),
    uploadBatch: vi.fn(),
    downloadBatch: vi.fn(),
    ping: vi.fn(),
    size: vi.fn(),
    purge: vi.fn(),
    getUsernames: vi.fn(),
    getHistory: vi.fn(),
    downloadHistoryVersion: vi.fn(),
    restoreHistoryVersion: vi.fn(),
    ...overrides,
  };
}

// Full surface syncClient.ts actually calls on Vault/Vault.adapter (audited via
// `grep -oE "\bvault\.[a-zA-Z]+\(|\bvault\.adapter\.[a-zA-Z]+\(" src/syncClient.ts`) --
// every method is a vi.fn() with a harmless default (empty list / null / no-op resolve) so a
// test only needs to .mockImplementation()/.mockResolvedValue() the ones its scenario actually
// exercises, without ever needing to extend this shared shape (a coverage-drive push added many
// callers of this fake at once -- see llm-wiki/10-*.md -- so this is deliberately exhaustive
// up front to avoid parallel edits to this file colliding).
export interface FakeVault {
  configDir: string;
  getName: ReturnType<typeof vi.fn>;
  getFiles: ReturnType<typeof vi.fn>;
  getAbstractFileByPath: ReturnType<typeof vi.fn>;
  readBinary: ReturnType<typeof vi.fn>;
  createBinary: ReturnType<typeof vi.fn>;
  modifyBinary: ReturnType<typeof vi.fn>;
  createFolder: ReturnType<typeof vi.fn>;
  adapter: {
    exists: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    mkdir: ReturnType<typeof vi.fn>;
    readBinary: ReturnType<typeof vi.fn>;
    writeBinary: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    stat: ReturnType<typeof vi.fn>;
  };
}

export function fakeVault(): FakeVault {
  return {
    configDir: ".obsidian",
    getName: vi.fn(() => "myvault"),
    getFiles: vi.fn(() => []),
    getAbstractFileByPath: vi.fn(() => null),
    readBinary: vi.fn(async () => new ArrayBuffer(0)),
    createBinary: vi.fn(async () => {}),
    modifyBinary: vi.fn(async () => {}),
    createFolder: vi.fn(async () => {}),
    adapter: {
      exists: vi.fn(async () => false),
      list: vi.fn(async () => ({ files: [], folders: [] })),
      mkdir: vi.fn(async () => {}),
      readBinary: vi.fn(async () => new ArrayBuffer(0)),
      writeBinary: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      stat: vi.fn(async () => null),
    },
  };
}

export function fakeFileManager(): { trashFile: ReturnType<typeof vi.fn> } {
  return { trashFile: vi.fn(async () => {}) };
}

export function makeClient(
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
