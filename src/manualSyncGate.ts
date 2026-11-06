// While the user's own "Sync now" (ribbon icon, command, settings button) is running, automatic
// sync stays out of the way: ws push notifications, the debounced-local-edit trigger, the 30s
// safety net and the reconnect catch-up are all ignored -- not queued. The manual sync computes its
// own full Delta, so anything those would have fetched is covered by it, and queued pushes used to
// be re-applied one file at a time right after it finished, racing the result it had just produced.
// Automatic sync resumes by itself when the manual one ends (the live connection is never closed).
//
// No "obsidian" import so it stays testable in isolation, like liveStatus.ts.
export class ManualSyncGate {
  private running = false;

  get active(): boolean {
    return this.running;
  }

  begin(): void {
    this.running = true;
  }

  end(): void {
    this.running = false;
  }

  /** True for an automatic sync request (silent) or a ws push arriving during a manual sync. */
  shouldIgnoreAutomatic(): boolean {
    return this.running;
  }
}
