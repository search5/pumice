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

// Streaming counterpart to mapWithConcurrency: same overlap-up-to-`limit` behavior and the same
// in-order guarantee (result i is yielded only once item i's fn() call resolves, even if a later
// item finished first), but yields results one at a time via an async generator instead of
// collecting the whole array before returning. Needed for the streaming upload path
// (syncClient.ts), where results are enqueued onto a fetch() request body as they're ready rather
// than all being held in memory before a single upload begins -- the entire point of streaming
// upload is not needing to buffer everything at once, so a plain mapWithConcurrency + array
// iteration would defeat it.
export async function* streamWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): AsyncGenerator<R> {
  let cursor = 0;
  const inFlight: Promise<R>[] = [];

  const fillWindow = () => {
    while (inFlight.length < limit && cursor < items.length) {
      inFlight.push(fn(items[cursor++]));
    }
  };

  fillWindow();
  while (inFlight.length > 0) {
    const result = await inFlight.shift()!;
    fillWindow();
    yield result;
  }
}
