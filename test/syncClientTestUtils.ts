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

export interface FakeVault {
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

export function fakeVault(): FakeVault {
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
