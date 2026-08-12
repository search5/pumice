// vitest's "node" environment (see vitest.config.mts) has no `window` global -- real Obsidian
// always runs in Electron/a browser, where `window.setTimeout`/`clearTimeout` are always
// available, so src/*.ts code (syncClient.ts's retry-delay waits, getAuthenticatedUsername's
// timeout race, etc.) calls `window.setTimeout` unguarded. Without this, that call throws
// ReferenceError: window is not defined -- which several call sites happen to wrap in a
// try/catch for unrelated reasons, so the error gets silently swallowed instead of surfacing as
// a test failure, letting a test "pass" without actually exercising the retry-delay code path it
// meant to (see llm-wiki/10-*.md for how this was found). Only setTimeout/clearTimeout/
// setInterval/clearInterval are provided -- the minimum src/*.ts actually calls on `window`.
if (typeof globalThis.window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = globalThis;
}
