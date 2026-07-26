import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  // Global ignores (a config object with only `ignores` applies to the whole array, not just
  // configs after it). src/generated/ is protoc-gen-js/protoc-gen-grpc-web output (see
  // scripts/gen-proto.mjs) -- not hand-maintained source, so linting it here would just flag
  // protoc's own boilerplate (e.g. its blanket `/* eslint-disable */` in the .ts/.js
  // implementation files) as if someone had written it by hand. The .d.ts files are committed
  // (see .gitignore) specifically so external tools that don't run generation first can still
  // resolve real types; they're clean on their own (no disable comments, no boilerplate -- just
  // declarations) but are excluded here too since they're still not something anyone edits directly.
  // scripts/ and esbuild.config.mjs are pure Node.js build/release tooling (proto codegen, version
  // bumping, CI helpers, the bundler config itself) -- none of it ships inside main.js or runs
  // inside Obsidian, so obsidianmd's rules (which all assume every file is potential plugin
  // runtime code -- no Node.js built-ins, no console.log, etc.) are a scope mismatch here, not a
  // real finding. docs/_static/custom.js is likewise not plugin code -- it's a small script for
  // the separate Sphinx documentation *website* (see docs/conf.py's html_js_files), served
  // alongside the docs, never touching Obsidian at all.
  { ignores: ["src/generated/**", "main.js", "docs/_build/**", "scripts/**", "esbuild.config.mjs", "docs/_static/**"] },
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: "./tsconfig.json" },
    },
  },
]);
