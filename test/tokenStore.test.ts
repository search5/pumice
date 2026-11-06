import { describe, expect, it } from "vitest";
import {
  deleteToken,
  hasToken,
  loadE2eePassword,
  loadToken,
  saveE2eePassword,
  saveToken,
} from "../src/tokenStore";

// One device: app.secretStorage is shared by every vault, while loadLocalStorage/saveLocalStorage
// are per vault (like Obsidian's "<vault hash>-key" scoping).
function makeDevice() {
  const secrets = new Map<string, string>();
  const secretStorage = {
    getSecret: (id: string) => {
      if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`invalid secret id: ${id}`);
      return secrets.get(id) ?? null;
    },
    setSecret: (id: string, value: string) => {
      if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`invalid secret id: ${id}`);
      secrets.set(id, value);
    },
  };
  const locals = new Map<string, string | null>();
  const openVault = (name: string) =>
    ({
      vault: { getName: () => name },
      secretStorage,
      loadLocalStorage: (key: string) => locals.get(`${name}:${key}`) ?? null,
      saveLocalStorage: (key: string, value: string | null) => void locals.set(`${name}:${key}`, value),
    }) as never;
  return { secrets, openVault };
}

describe("per-vault credentials", () => {
  it("keeps a separate token for each vault", async () => {
    const { openVault } = makeDevice();
    const work = openVault("Work notes");
    const home = openVault("집");
    await saveToken(work, "token-work");
    await saveToken(home, "token-home");
    expect(await loadToken(work)).toBe("token-work");
    expect(await loadToken(home)).toBe("token-home");
  });

  it("keeps a separate E2EE password for each vault", async () => {
    const { openVault } = makeDevice();
    const a = openVault("A");
    const b = openVault("B");
    await saveE2eePassword(a, "pw-a");
    await saveE2eePassword(b, "pw-b");
    expect(await loadE2eePassword(a)).toBe("pw-a");
    expect(await loadE2eePassword(b)).toBe("pw-b");
  });

  it("logging out of one vault leaves the other signed in", async () => {
    const { openVault } = makeDevice();
    const a = openVault("A");
    const b = openVault("B");
    await saveToken(a, "ta");
    await saveToken(b, "tb");
    await deleteToken(a);
    expect(await hasToken(a)).toBe(false);
    expect(await loadToken(b)).toBe("tb");
  });

  it("uses ids Obsidian accepts for any vault name", async () => {
    const { openVault } = makeDevice();
    await expect(saveToken(openVault("My Vault (2) / 한글 😀"), "t")).resolves.toBeUndefined();
  });
});

describe("upgrading from the single device-wide secrets", () => {
  it("every vault adopts the old shared token once, then diverges independently", async () => {
    const { secrets, openVault } = makeDevice();
    secrets.set("sync-token", "shared-token");
    secrets.set("e2ee-password", "shared-pw");
    const a = openVault("A");
    const b = openVault("B");

    expect(await loadToken(a)).toBe("shared-token");
    expect(await loadToken(b)).toBe("shared-token");
    expect(await loadE2eePassword(a)).toBe("shared-pw");

    await saveToken(a, "new-a");
    expect(await loadToken(a)).toBe("new-a");
    expect(await loadToken(b)).toBe("shared-token");
    expect(secrets.get("sync-token")).toBe("shared-token"); // untouched: other vaults still need it
  });

  it("does not bring the shared token back after logging out of a vault", async () => {
    const { secrets, openVault } = makeDevice();
    secrets.set("sync-token", "shared-token");
    const a = openVault("A");
    expect(await loadToken(a)).toBe("shared-token");
    await deleteToken(a);
    expect(await loadToken(a)).toBe("");
    expect(await hasToken(a)).toBe(false);
  });

  it("a vault whose password was explicitly cleared does not re-adopt the shared one", async () => {
    const { secrets, openVault } = makeDevice();
    secrets.set("e2ee-password", "shared-pw");
    const a = openVault("A");
    await saveE2eePassword(a, "");
    expect(await loadE2eePassword(a)).toBe("");
  });

  it("a brand new vault with nothing stored has no credentials", async () => {
    const { openVault } = makeDevice();
    const a = openVault("A");
    expect(await loadToken(a)).toBe("");
    expect(await loadE2eePassword(a)).toBe("");
  });
});
