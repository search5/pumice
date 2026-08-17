import { describe, expect, it, vi } from "vitest";
import { SyncClient } from "../src/syncClient";
import { getDefaultSettings } from "../src/settings";
import type { SyncTransport } from "../src/syncTransport";
import { fakeFileManager, fakeTransport, fakeVault, makeClient, sha256 } from "./syncClientTestUtils";
import type { FakeVault } from "./syncClientTestUtils";

// E2EE crypto helpers follow-up: getE2eeKey/encryptData/decryptData/getKeyFingerprint/
// getFileMetadataFromBuffer (src/syncClient.ts ~189-334) and the size/purge/usernames/
// testConnection delegation methods (~1134-1152) had zero unit coverage. All five crypto
// helpers are private, so this file reaches them via `(client as any).method(...)` casts --
// there's no other way to unit-test them in isolation (see this file's task brief). Shared
// fakes live in syncClientTestUtils.ts (also used by syncClientHistory.test.ts /
// syncClientPush.test.ts); makeClient() always builds a client with E2EE off and an empty
// password, so getFileMetadataFromBuffer's E2EE-on branch and getKeyFingerprint's
// different-password case need a client constructed directly with custom settings, mirroring
// what makeClient() itself does.

function makeE2eeClient(
  vault: FakeVault,
  fileManager: ReturnType<typeof fakeFileManager>,
  transport: SyncTransport,
  overrides: { enableE2EE?: boolean; e2eePassword?: string } = {}
): SyncClient {
  const settings = {
    ...getDefaultSettings(vault.configDir),
    enableE2EE: overrides.enableE2EE ?? false,
    e2eePassword: overrides.e2eePassword ?? "",
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
    async () => {}
  );
}

describe("SyncClient.getE2eeKey (private)", () => {
  it("derives the key once via PBKDF2 and reuses the cached key on later calls", async () => {
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());
    const deriveKeySpy = vi.spyOn(crypto.subtle, "deriveKey");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const key1 = await (client as any).getE2eeKey();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const key2 = await (client as any).getE2eeKey();

    expect(deriveKeySpy).toHaveBeenCalledTimes(1);
    expect(key1).toBe(key2);

    deriveKeySpy.mockRestore();
  });
});

describe("SyncClient.encryptData / decryptData (private)", () => {
  it("round-trips plaintext through encrypt then decrypt", async () => {
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const key = await (client as any).getE2eeKey();
    const plaintext = new TextEncoder().encode("hello world, this is plaintext").buffer;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const encrypted = await (client as any).encryptData(plaintext, key);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const decrypted = await (client as any).decryptData(encrypted, key);

    expect(new Uint8Array(decrypted)).toEqual(new Uint8Array(plaintext));
  });

  it("produces byte-identical ciphertext when the same plaintext is encrypted twice (deterministic content-derived IV)", async () => {
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const key = await (client as any).getE2eeKey();
    const plaintext = new TextEncoder().encode("same content, encrypted twice").buffer;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const encrypted1 = await (client as any).encryptData(plaintext, key);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const encrypted2 = await (client as any).encryptData(plaintext, key);

    expect(new Uint8Array(encrypted1)).toEqual(new Uint8Array(encrypted2));
  });

  it("produces different ciphertext for different plaintext", async () => {
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const key = await (client as any).getE2eeKey();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const encryptedA = await (client as any).encryptData(new TextEncoder().encode("content A").buffer, key);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const encryptedB = await (client as any).encryptData(new TextEncoder().encode("content B").buffer, key);

    expect(new Uint8Array(encryptedA)).not.toEqual(new Uint8Array(encryptedB));
  });

  it("fails to decrypt with a key derived from a different password", async () => {
    const vault = fakeVault();
    const clientA = makeE2eeClient(vault, fakeFileManager(), fakeTransport(), { e2eePassword: "correct-password" });
    const clientB = makeE2eeClient(vault, fakeFileManager(), fakeTransport(), { e2eePassword: "wrong-password" });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const keyA = await (clientA as any).getE2eeKey();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const keyB = await (clientB as any).getE2eeKey();
    const plaintext = new TextEncoder().encode("a secret note").buffer;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const encrypted = await (clientA as any).encryptData(plaintext, keyA);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((clientA as any).decryptData(encrypted, keyB)).rejects.toThrow();
  });

  it("throws for an encrypted buffer shorter than the 28-byte IV+tag header", async () => {
    const client = makeClient(fakeTransport(), fakeVault(), fakeFileManager());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const key = await (client as any).getE2eeKey();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((client as any).decryptData(new ArrayBuffer(10), key)).rejects.toThrow("Invalid encrypted buffer size");
  });
});

describe("SyncClient.getKeyFingerprint (private)", () => {
  it("returns the same fingerprint for the same password across repeated calls", async () => {
    const client = makeE2eeClient(fakeVault(), fakeFileManager(), fakeTransport(), { e2eePassword: "hunter2" });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fp1 = await (client as any).getKeyFingerprint();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fp2 = await (client as any).getKeyFingerprint();

    expect(fp1).toBe(fp2);
    expect(fp1).toBe(await sha256(new TextEncoder().encode("hunter2").buffer));
  });

  it("returns different fingerprints for different passwords", async () => {
    const clientA = makeE2eeClient(fakeVault(), fakeFileManager(), fakeTransport(), { e2eePassword: "password-a" });
    const clientB = makeE2eeClient(fakeVault(), fakeFileManager(), fakeTransport(), { e2eePassword: "password-b" });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fpA = await (clientA as any).getKeyFingerprint();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fpB = await (clientB as any).getKeyFingerprint();

    expect(fpA).not.toBe(fpB);
  });
});

describe("SyncClient.getFileMetadataFromBuffer (private)", () => {
  it("returns the plain SHA-256 hash and the original buffer unchanged when E2EE is off", async () => {
    const client = makeE2eeClient(fakeVault(), fakeFileManager(), fakeTransport(), { enableE2EE: false });
    const buffer = new TextEncoder().encode("plaintext file content").buffer;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = await (client as any).getFileMetadataFromBuffer(buffer);

    expect(meta.size).toBe(buffer.byteLength);
    expect(meta.hash).toBe(await sha256(buffer));
    expect(meta.buffer).toBe(buffer);
  });

  it("returns the ciphertext's size/hash and the encrypted buffer when E2EE is on", async () => {
    const client = makeE2eeClient(fakeVault(), fakeFileManager(), fakeTransport(), {
      enableE2EE: true,
      e2eePassword: "top-secret",
    });
    const buffer = new TextEncoder().encode("plaintext file content").buffer;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = await (client as any).getFileMetadataFromBuffer(buffer);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const key = await (client as any).getE2eeKey();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const expectedEncrypted = await (client as any).encryptData(buffer, key);

    expect(meta.buffer).not.toBe(buffer);
    expect(new Uint8Array(meta.buffer)).toEqual(new Uint8Array(expectedEncrypted));
    expect(meta.size).toBe(expectedEncrypted.byteLength);
    expect(meta.hash).toBe(await sha256(expectedEncrypted));
    expect(meta.hash).not.toBe(await sha256(buffer));
  });

  // Characterizes actual (undocumented) current behavior: enableE2EE alone isn't enough --
  // getFileMetadataFromBuffer's condition is `this.settings.enableE2EE && this.settings.e2eePassword`,
  // so an empty password silently falls back to the plaintext branch rather than encrypting with
  // an empty-string-derived key or raising an error.
  it("falls back to the plaintext branch when E2EE is enabled but the password is empty", async () => {
    const client = makeE2eeClient(fakeVault(), fakeFileManager(), fakeTransport(), {
      enableE2EE: true,
      e2eePassword: "",
    });
    const buffer = new TextEncoder().encode("plaintext file content").buffer;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = await (client as any).getFileMetadataFromBuffer(buffer);

    expect(meta.buffer).toBe(buffer);
    expect(meta.hash).toBe(await sha256(buffer));
  });
});

describe("SyncClient.testConnection", () => {
  it("delegates to transport.ping()", async () => {
    const ping = vi.fn(async () => {});
    const transport = fakeTransport({ ping });
    const client = makeClient(transport, fakeVault(), fakeFileManager());

    await client.testConnection();

    expect(ping).toHaveBeenCalledTimes(1);
  });
});

describe("SyncClient.getVaultSize", () => {
  it("delegates to transport.size with the vault name and returns its result", async () => {
    const size = { vaultSizeBytes: 100, totalSizeBytes: 200, limitBytes: -1 };
    const sizeFn = vi.fn(async () => size);
    const transport = fakeTransport({ size: sizeFn });
    const client = makeClient(transport, fakeVault(), fakeFileManager());

    const result = await client.getVaultSize();

    expect(sizeFn).toHaveBeenCalledWith("myvault");
    expect(result).toBe(size);
  });
});

describe("SyncClient.purgeVault", () => {
  it("delegates to transport.purge with the vault name and returns its result", async () => {
    const purgeResult = { ok: true, error: "" };
    const purge = vi.fn(async () => purgeResult);
    const transport = fakeTransport({ purge });
    const client = makeClient(transport, fakeVault(), fakeFileManager());

    const result = await client.purgeVault();

    expect(purge).toHaveBeenCalledWith("myvault");
    expect(result).toBe(purgeResult);
  });
});

describe("SyncClient.getUsernames", () => {
  it("delegates to transport.getUsernames with the vault name and returns its result", async () => {
    const usernames = ["alice", "bob"];
    const getUsernames = vi.fn(async () => usernames);
    const transport = fakeTransport({ getUsernames });
    const client = makeClient(transport, fakeVault(), fakeFileManager());

    const result = await client.getUsernames();

    expect(getUsernames).toHaveBeenCalledWith("myvault");
    expect(result).toBe(usernames);
  });
});
