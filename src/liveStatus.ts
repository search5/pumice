// Pure display-mapping for the live-updates SSE connection (main.ts's runLiveUpdateLoop()) --
// no "obsidian" import, kept testable in isolation. Icon names are lucide icon names as used by
// obsidian's setIcon(); labelKey/labelFallback are meant to be passed straight into t().
export type LiveConnectionState = "disabled" | "connecting" | "connected" | "reconnecting";

export interface LiveStatusDisplay {
  icon: string;
  labelKey: string;
  labelFallback: string;
}

const DISPLAY: Record<LiveConnectionState, LiveStatusDisplay> = {
  disabled: {
    icon: "wifi-off",
    labelKey: "status.live-disabled",
    labelFallback: "Live updates off",
  },
  connecting: {
    icon: "loader",
    labelKey: "status.live-connecting",
    labelFallback: "Live updates: connecting…",
  },
  connected: {
    icon: "wifi",
    labelKey: "status.live-connected",
    labelFallback: "Live updates: connected",
  },
  reconnecting: {
    icon: "wifi-off",
    labelKey: "status.live-reconnecting",
    labelFallback: "Live updates: reconnecting…",
  },
};

export function describeLiveStatus(state: LiveConnectionState): LiveStatusDisplay {
  return DISPLAY[state];
}
