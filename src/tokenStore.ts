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

  const legacy = localStorage.getItem(LEGACY_LOCAL_STORAGE_KEY);
  if (legacy) {
    app.secretStorage.setSecret(SECRET_ID, legacy);
    localStorage.removeItem(LEGACY_LOCAL_STORAGE_KEY);
    return legacy;
  }

  return "";
}

export async function deleteToken(app: App): Promise<void> {
  app.secretStorage.setSecret(SECRET_ID, "");
  localStorage.removeItem(LEGACY_LOCAL_STORAGE_KEY);
}

export async function hasToken(app: App): Promise<boolean> {
  return (await loadToken(app)) !== "";
}
