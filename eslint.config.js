import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  // Global ignores (a config object with only `ignores` applies to the whole array, not just
  // configs after it). src/generated/ is protoc-gen-js/protoc-gen-grpc-web output (see
  // scripts/gen-proto.mjs, gitignored, regenerated locally by the pre-dev/build/lint scripts) --
  // not hand-maintained source, so linting it here would just flag protoc's own boilerplate
  // (e.g. its blanket `/* eslint-disable */`) as if someone had written it by hand. Note that
  // external review tooling that lints this repo without running `npm install`/generation first
  // does NOT read this file's ignores -- it lints its own checkout directly, so this only keeps
  // local `eslint .` runs clean, not that specific review's output.
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
