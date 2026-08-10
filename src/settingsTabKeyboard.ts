// Obsidian's own core Settings modal attaches a keydown listener to the shared ancestor
// container every plugin's settings tab is rendered into (tabContentContainer), and repurposes
// Tab as vim-style "jump to the next/previous setting row" navigation instead of native
// browser focus traversal -- it calls preventDefault() unconditionally. This isn't something a
// plugin can override via any public API; it's closed-source core behavior on an element above
// where a plugin's own DOM lives.
//
// The workaround: since that listener is on an ANCESTOR and registered in the bubble phase, a
// plugin can attach its own keydown listener on its own containerEl (a descendant, so it fires
// first during bubbling) and call stopPropagation() specifically on Tab -- never
// preventDefault() -- so the event still reaches the browser's native default handling (which
// does the actual "move focus to the next focusable element" browsers do natively), it just
// never reaches Obsidian's outer listener to be redefined into row-jumping.

/** Whether a given KeyboardEvent.key value should have its propagation stopped so Obsidian's
 * own Settings-modal Tab interception (see module doc above) never sees it. Deliberately exact
 * ("Tab" only, case-sensitive per the real KeyboardEvent.key value) so no other key's behavior
 * -- including Shift+Tab, which still reports key "Tab" -- is affected. */
export function shouldStopTabPropagation(key: string): boolean {
  return key === "Tab";
}
