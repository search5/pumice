import type { App } from "obsidian";

// Obsidian's own secret storage (desktop + mobile, no platform-specific code needed) --
// see https://docs.obsidian.md, App.secretStorage, available since 1.11.4.
//
// app.secretStorage is shared by every vault on the device (and, on mobile, by every vault in the
// app), so the ids are suffixed with a hash of the vault name: each vault keeps its own sync token
// and E2EE password. The vault name is also what the sync protocol uses as the server-side vault
// id (SyncClient: vault.getName()), so one local vault <-> one set of credentials. Obsidian only
// accepts lowercase alphanumeric ids with dashes, hence the hash instead of the raw name.
const TOKEN_SECRET_PREFIX = "sync-token";
const E2EE_SECRET_PREFIX = "e2ee-password";

// Before secrets were per vault, these two ids held the single device-wide value.
const GLOBAL_TOKEN_SECRET_ID = TOKEN_SECRET_PREFIX;
const GLOBAL_E2EE_SECRET_ID = E2EE_SECRET_PREFIX;

// Where tokens lived before this plugin switched to app.secretStorage: saveToken() always wrote
// here (in addition to trying the OS keychain on desktop), regardless of platform, so every
// existing user's token can be recovered from here exactly once and migrated in.
const LEGACY_LOCAL_STORAGE_KEY = "pumice-token";

// App#loadLocalStorage/saveLocalStorage are vault-scoped (observed as "<vault hash>-<key>"), which
// is exactly what's needed to remember, per vault, that the shared pre-upgrade value was already
// adopted -- so logging out of one vault doesn't make the next start re-import it.
const TOKEN_ADOPTED_FLAG = "pumice-token-per-vault";
const E2EE_ADOPTED_FLAG = "pumice-e2ee-per-vault";

async function vaultScopedId(app: App, prefix: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(app.vault.getName()));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}-${hex.slice(0, 16)}`;
}

/**
 * Reads this vault's secret. The first time a vault is opened after the upgrade it has no value of
 * its own yet, so it adopts the old device-wide one once (what every vault used until now) and from
 * then on only ever reads/writes its own -- changing or clearing it no longer touches other vaults.
 */
async function loadVaultSecret(app: App, prefix: string, globalId: string, adoptedFlag: string): Promise<string> {
  const id = await vaultScopedId(app, prefix);
  const own = app.secretStorage.getSecret(id);
  if (own) return own;
  if (app.loadLocalStorage(adoptedFlag)) return "";
  app.saveLocalStorage(adoptedFlag, "1");
  const shared = app.secretStorage.getSecret(globalId);
  if (!shared) return "";
  app.secretStorage.setSecret(id, shared);
  return shared;
}

async function saveVaultSecret(app: App, prefix: string, adoptedFlag: string, value: string): Promise<void> {
  app.secretStorage.setSecret(await vaultScopedId(app, prefix), value);
  // An explicit save/clear is this vault's own value now; never fall back to the shared one.
  app.saveLocalStorage(adoptedFlag, "1");
}

export async function saveToken(app: App, token: string): Promise<void> {
  await saveVaultSecret(app, TOKEN_SECRET_PREFIX, TOKEN_ADOPTED_FLAG, token);
}

export async function loadToken(app: App): Promise<string> {
  const secret = await loadVaultSecret(app, TOKEN_SECRET_PREFIX, GLOBAL_TOKEN_SECRET_ID, TOKEN_ADOPTED_FLAG);
  if (secret) return secret;

  // Routed through App#loadLocalStorage, not raw localStorage -- confirmed on a real Obsidian
  // instance that the two don't interoperate (App#saveLocalStorage("k", v) actually writes to a
  // vault-scoped key, observed as "<16-hex-char vault hash>-k"), so this can only ever recover a
  // token from a version of this plugin that itself wrote here via the same App API -- not the
  // truly old raw-localStorage.setItem() versions from before that. Kept anyway for the App-API
  // consistency guideline; genuinely legacy (pre-secretStorage) tokens require a fresh login.
  const legacy = app.loadLocalStorage(LEGACY_LOCAL_STORAGE_KEY) as string | null;
  if (legacy) {
    await saveToken(app, legacy);
    app.saveLocalStorage(LEGACY_LOCAL_STORAGE_KEY, null);
    return legacy;
  }

  return "";
}

export async function deleteToken(app: App): Promise<void> {
  // Only this vault's token -- other vaults stay signed in.
  await saveToken(app, "");
  // Same legacy-migration exception as loadToken's comment above.
  app.saveLocalStorage(LEGACY_LOCAL_STORAGE_KEY, null);
}

export async function hasToken(app: App): Promise<boolean> {
  return (await loadToken(app)) !== "";
}

// E2EE sync password -- same rationale as the auth token above: never let it touch data.json.
export async function saveE2eePassword(app: App, password: string): Promise<void> {
  await saveVaultSecret(app, E2EE_SECRET_PREFIX, E2EE_ADOPTED_FLAG, password);
}

export async function loadE2eePassword(app: App): Promise<string> {
  return loadVaultSecret(app, E2EE_SECRET_PREFIX, GLOBAL_E2EE_SECRET_ID, E2EE_ADOPTED_FLAG);
}
