export type ConflictResolution = "server-wins" | "client-wins" | "manual";

export interface SyncPluginSettings {
  serverHost: string;
  serverPort: number;
  useTls: boolean;
  deviceName: string;
  userName: string;

  syncFiles: boolean;
  syncBookmarks: boolean;
  ignorePatterns: string;

  autoSync: boolean;
  syncIntervalSeconds: number;
  syncOnStartup: boolean;

  conflictResolution: ConflictResolution;

  // The password itself lives in app.secretStorage (see tokenStore.ts), never in data.json.
  enableE2EE: boolean;

  publishIncludeFolders: string;
  publishExcludeFolders: string;

  localSnapshotIntervalMinutes: number;
  localSnapshotKeepDays: number;
}

// A function of the vault's config dir, not a static constant: it's usually ".obsidian", but
// Obsidian lets it be renamed per-vault (Vault#configDir), and these default patterns need to
// match whatever it actually is for a given vault rather than assuming the common case.
export function getDefaultSettings(configDir: string): SyncPluginSettings {
  const defaultExcludePatterns = [
    `${configDir}/workspace`,
    `${configDir}/workspace.json`,
    `${configDir}/workspace-mobile.json`,
    `${configDir}/cache`,
    `${configDir}/plugins/pumice`,
    ".trash",
  ].join("\n");

  return {
    serverHost: "localhost",
    serverPort: 8080,
    useTls: false,
    deviceName: "Obsidian Client",
    userName: "Obsidian User",

    syncFiles: true,
    syncBookmarks: true,
    ignorePatterns: defaultExcludePatterns,

    autoSync: false,
    syncIntervalSeconds: 60,
    syncOnStartup: false,

    conflictResolution: "manual",

    enableE2EE: false,

    publishIncludeFolders: "",
    publishExcludeFolders: defaultExcludePatterns,

    localSnapshotIntervalMinutes: 5,
    localSnapshotKeepDays: 7,
  };
}


