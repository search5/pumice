import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  // Global ignores (a config object with only `ignores` applies to the whole array, not just
  // configs after it). src/generated/ is protoc-gen-js/protoc-gen-grpc-web output (see
  // scripts/gen-proto.mjs) -- committed so external tools can resolve its types without running
  // npm install first, but it's not hand-maintained source and was never meant to be linted as
  // if it were: protoc's own generated header comment (`/* eslint-disable */`) already says so,
  // it just can't satisfy this config's own eslint-comments rules (no-unlimited-disable,
  // disable-enable-pair, no-restricted-disable), since those exist to police disable comments in
  // code someone actually wrote by hand.
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
