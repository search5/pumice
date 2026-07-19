import { App } from "obsidian";

// Obsidian's own secret storage (desktop + mobile, no platform-specific code needed) --
// see https://docs.obsidian.md, App.secretStorage, available since 1.11.4.
const SECRET_ID = "sync-token";

// Where tokens lived before this plugin switched to app.secretStorage: saveToken() always wrote
// here (in addition to trying the OS keychain on desktop), regardless of platform, so every
// existing user's token can be recovered from here exactly once and migrated in.
const LEGACY_LOCAL_STORAGE_KEY = "pumice-token";

export async function saveToken(app: App, token: string): Promise<void> {
  app.secretStorage.setSecret(SECRET_ID, token);
}

export async function loadToken(app: App): Promise<string> {
  const secret = app.secretStorage.getSecret(SECRET_ID);
  if (secret) return secret;

  // Routed through App#loadLocalStorage, not raw localStorage -- confirmed on a real Obsidian
  // instance that the two don't interoperate (App#saveLocalStorage("k", v) actually writes to a
  // vault-scoped key, observed as "<16-hex-char vault hash>-k"), so this can only ever recover a
  // token from a version of this plugin that itself wrote here via the same App API -- not the
  // truly old raw-localStorage.setItem() versions from before that. Kept anyway for the App-API
  // consistency guideline; genuinely legacy (pre-secretStorage) tokens require a fresh login.
  const legacy = app.loadLocalStorage(LEGACY_LOCAL_STORAGE_KEY) as string | null;
  if (legacy) {
    app.secretStorage.setSecret(SECRET_ID, legacy);
    app.saveLocalStorage(LEGACY_LOCAL_STORAGE_KEY, null);
    return legacy;
  }

  return "";
}

export async function deleteToken(app: App): Promise<void> {
  app.secretStorage.setSecret(SECRET_ID, "");
  // Same legacy-migration exception as loadToken's comment above.
  app.saveLocalStorage(LEGACY_LOCAL_STORAGE_KEY, null);
}

export async function hasToken(app: App): Promise<boolean> {
  return (await loadToken(app)) !== "";
}

// E2EE sync password -- same rationale as the auth token above: never let it touch data.json.
const E2EE_PASSWORD_SECRET_ID = "e2ee-password";

export async function saveE2eePassword(app: App, password: string): Promise<void> {
  app.secretStorage.setSecret(E2EE_PASSWORD_SECRET_ID, password);
}

export async function loadE2eePassword(app: App): Promise<string> {
  return app.secretStorage.getSecret(E2EE_PASSWORD_SECRET_ID) || "";
}
