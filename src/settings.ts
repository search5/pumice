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

  enableE2EE: boolean;
  e2eePassword?: string;

  publishIncludeFolders: string;
  publishExcludeFolders: string;

  localSnapshotIntervalMinutes: number;
  localSnapshotKeepDays: number;
}

export const DEFAULT_SETTINGS: SyncPluginSettings = {
  serverHost: "localhost",
  serverPort: 8080,
  useTls: false,
  deviceName: "Obsidian Client",
  userName: "Obsidian User",

  syncFiles: true,
  syncBookmarks: true,
  ignorePatterns: [
    ".obsidian/workspace",
    ".obsidian/workspace.json",
    ".obsidian/workspace-mobile.json",
    ".obsidian/cache",
    ".obsidian/plugins/pumice",
    ".trash",
  ].join("\n"),

  autoSync: false,
  syncIntervalSeconds: 60,
  syncOnStartup: false,

  conflictResolution: "manual",

  enableE2EE: false,
  e2eePassword: "",

  publishIncludeFolders: "",
  publishExcludeFolders: [
    ".obsidian/workspace",
    ".obsidian/workspace.json",
    ".obsidian/workspace-mobile.json",
    ".obsidian/cache",
    ".obsidian/plugins/pumice",
    ".trash",
  ].join("\n"),

  localSnapshotIntervalMinutes: 5,
  localSnapshotKeepDays: 7,
};


