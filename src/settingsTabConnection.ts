// Which settings keys, when changed, invalidate the single shared WS transport (main.ts's
// wsTransport/wsConnecting) -- server address/port/TLS all feed buildWsUrl(). See
// settingChangeRequiresReconnect's call site in settingsTab.ts for why this matters: without it,
// changing the server address and then clicking "Test connection" reuses/awaits the stale
// connection to the OLD server, which has no handshake-level timeout and can hang forever if
// that server is now unreachable (found 2026-08-18: "Test connection stays on Checking...").
const CONNECTION_AFFECTING_KEYS = new Set(["serverHost", "serverPort", "useTls"]);

export function settingChangeRequiresReconnect(key: string, previousValue: unknown, newValue: unknown): boolean {
  return CONNECTION_AFFECTING_KEYS.has(key) && previousValue !== newValue;
}
