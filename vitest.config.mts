import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The real "obsidian" package is types-only (see test/obsidianTestStub.ts's own comment) --
    // this alias only affects the test run; esbuild.config.mjs's production bundle keeps
    // "obsidian" external as before, untouched by this file.
    alias: {
      obsidian: path.resolve(import.meta.dirname, "test/obsidianTestStub.ts"),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["test/setupGlobals.ts"],
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "html", "json-summary"],
    },
  },
});
