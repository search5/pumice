// Runs `fn` over `items` with at most `limit` in flight at once, preserving result order (result[i]
// corresponds to items[i] regardless of completion order). Reading/hashing files one at a time is
// fine on desktop's native fs, but on mobile each vault read crosses the Capacitor bridge, so doing
// them serially turns an O(files) round-trip cost into a very visible delay — this lets those round
// trips overlap instead. Shared by regular sync (syncClient.ts) and the Publish diff scan
// (publishModal.ts), which both have to walk every file in the vault.
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}
