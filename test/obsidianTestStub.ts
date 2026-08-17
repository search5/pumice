// Stand-in for the "obsidian" package in tests. The real npm package is types-only (empty "main",
// see its package.json) -- at real runtime, Obsidian's own host app injects the actual
// implementation into the module registry via esbuild's `external: ["obsidian"]` (see
// esbuild.config.mjs), so `import { TFile, ... } from "obsidian"` only ever resolves to *something
// real* inside the Obsidian app itself. Outside that host (i.e. every test in this repo), there is
// nothing to import -- hence syncClient.ts, whose value imports from "obsidian" include
// `instanceof TFile` checks, had zero test coverage before this file existed (see
// llm-wiki/07-push-file-metadata.md). Aliased in vitest.config.mts's resolve.alias; does not
// affect the production esbuild bundle, which keeps "obsidian" external as before.
//
// Deliberately minimal: only what src/syncClient.ts and src/i18n.ts actually touch. Extend as
// more of the codebase gains test coverage that needs it.

export class TAbstractFile {
  path = "";
}

export class TFile extends TAbstractFile {
  stat = { mtime: 0, size: 0, ctime: 0 };
  basename = "";
  extension = "";
}

export class TFolder extends TAbstractFile {}

// Real Vault/FileManager are abstract-ish classes with dozens of members; tests build a fake
// object shaped like the subset syncClient.ts actually calls and cast it `as unknown as Vault`
// (same pattern contentHashCache.test.ts already uses for TFile -- see that file's own comment).
export class Vault {}
export class FileManager {}

// Real Notice pops a UI toast; a no-op stand-in is all tests need (nothing asserts on it here).
export class Notice {
  constructor(_message?: string, _timeout?: number) {}
  setMessage(_message: string): void {}
  hide(): void {}
}

export function requestUrl(): never {
  throw new Error("requestUrl is not implemented in the test stub -- tests should inject a fake SyncTransport instead of exercising real HTTP");
}

// i18n.ts calls this on every t() call to pick a locale.
export function getLanguage(): string {
  return "en";
}

// settings.ts's resolveDefaultDeviceName() reads Platform.isDesktop.
export const Platform = {
  isDesktop: true,
  isMobile: false,
};
