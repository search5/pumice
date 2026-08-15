import { Platform } from "obsidian";
import { pickDefaultDeviceName } from "./deviceName";

export type ConflictResolution = "server-wins" | "client-wins" | "manual" | "merge";

// require()'s Node "os" module must stay lexically inside this Platform.isDesktop check for
// eslint-plugin-obsidianmd's no-nodejs-modules rule -- Node built-ins don't exist at all on
// mobile (Capacitor). pickDefaultDeviceName() (deviceName.ts) is the actual tested decision
// logic; this is just the OS-facing wrapper around it, so it's left to manual verification
// instead (see #9_북마크_강제병합_및_기본값_개선_구현_계획.md 3-2절).
function resolveDefaultDeviceName(): string {
  if (Platform.isDesktop) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- Platform.isDesktop-guarded require(), the pattern eslint-plugin-obsidianmd's own no-nodejs-modules rule expects
      const hostname = (require("os") as typeof import("os")).hostname();
      return pickDefaultDeviceName(hostname);
    } catch {
      return pickDefaultDeviceName(undefined);
    }
  }
  return pickDefaultDeviceName(undefined);
}

export interface SyncPluginSettings {
  serverHost: string;
  serverPort: number;
  useTls: boolean;
  deviceName: string;
  userName: string;

  // "" (default) = this vault is my own. Non-empty = sync against that account's vault
  // instead, using this local folder's name as the vault_id -- requires an accepted (or
  // pending, since sharing is binary access with no role gate) share from that account.
  // See 14_vault_sharing_설계.md -- pumice has no vault picker, so this is the only way to
  // point a local vault at someone else's, and the local folder name still has to match the
  // owner's vault_id exactly, same as pumice's existing self-owned convention.
  sharedVaultOwner: string;

  syncFiles: boolean;
  syncBookmarks: boolean;
  // .obsidian/plugins/** (code, manifest, assets) + community-plugins.json (the enabled list).
  // Off by default: this syncs executable code, a real trust-boundary expansion beyond note
  // content -- see #7_플러그인_동기화_구현_계획.md.
  syncPlugins: boolean;
  // Each plugin's own data.json, gated separately from syncPlugins since it's the one file in a
  // plugin folder that commonly holds secrets (API tokens etc.) in plaintext.
  syncPluginData: boolean;
  ignorePatterns: string;

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
    deviceName: resolveDefaultDeviceName(),
    userName: "Obsidian User",

    sharedVaultOwner: "",

    syncFiles: true,
    syncBookmarks: true,
    syncPlugins: false,
    syncPluginData: false,
    ignorePatterns: defaultExcludePatterns,

    conflictResolution: "merge",

    enableE2EE: false,

    publishIncludeFolders: "",
    publishExcludeFolders: defaultExcludePatterns,

    localSnapshotIntervalMinutes: 5,
    localSnapshotKeepDays: 7,
  };
}


