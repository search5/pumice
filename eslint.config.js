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
  { ignores: ["src/generated/**", "main.js", "docs/_build/**"] },
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: "./tsconfig.json" },
    },
  },
]);
