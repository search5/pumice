import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  // Global ignores (a config object with only `ignores` applies to the whole array, not just
  // configs after it). scripts/ and esbuild.config.mjs are pure Node.js build/release tooling
  // (version bumping, CI helpers, the bundler config itself) -- none of it ships inside main.js
  // or runs inside Obsidian, so obsidianmd's rules (which all assume every file is potential
  // plugin runtime code -- no Node.js built-ins, no console.log, etc.) are a scope mismatch
  // here, not a real finding. docs/_static/custom.js is likewise not plugin code -- it's a
  // small script for the separate Sphinx documentation *website* (see docs/conf.py's
  // html_js_files), served alongside the docs, never touching Obsidian at all.
  // test/** holds vitest specs -- they assume a Node/vitest-globals runtime (fake-indexeddb,
  // describe/it/expect), not an Obsidian plugin runtime, so obsidianmd's rules are a scope
  // mismatch here for the same reason they're a mismatch for scripts/ above. vitest.config.ts is
  // build/tooling config in the same vein as esbuild.config.mjs -- never ships inside main.js.
  { ignores: ["main.js", "docs/_build/**", "scripts/**", "esbuild.config.mjs", "docs/_static/**", "test/**", "vitest.config.mts"] },
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: "./tsconfig.json" },
    },
  },
  {
    // settings.ts's resolveDefaultDeviceName() reads the desktop hostname via a require("os")
    // call guarded by Platform.isDesktop (obsidianmd's own no-nodejs-modules rule expects and
    // allows exactly this pattern -- Node built-ins don't exist on mobile at all). `require`
    // itself just isn't a recognized global without this.
    files: ["src/settings.ts"],
    languageOptions: {
      globals: { require: "readonly" },
    },
  },
]);
