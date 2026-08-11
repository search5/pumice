// Splits a path list into batches bounded by both byte size and file count -- byte size alone
// isn't enough of a cap: a real vault is dominated by many small notes, so a byte-only cap lets one
// batch swallow nearly the whole file list before it fills up (confirmed against realistic-size
// synthetic data in #4_구현_계획.md -- a byte-only version put 95%+ of files in a single batch).
// A file larger than targetBytes on its own still gets its own batch rather than being skipped.
export function groupIntoBatches(
  paths: string[],
  sizeOf: (path: string) => number,
  targetBytes: number,
  maxFiles: number
): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let currentBytes = 0;
  for (const path of paths) {
    const size = sizeOf(path);
    if (current.length > 0 && (currentBytes + size > targetBytes || current.length >= maxFiles)) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(path);
    currentBytes += size;
    if (currentBytes > targetBytes || current.length >= maxFiles) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export interface BatchDownloadResult {
  downloadedCount: number;
  failedPaths: string[];
}

export interface RunBatchedDownloadsOptions {
  targetBytes: number;
  maxFiles: number;
  retryAttempts: number;
  onRetry?: (batchPaths: string[], attempt: number) => void | Promise<void>;
  onBatchGiveUp?: (batchPaths: string[]) => void;
}

// Downloads `paths` in batches (see groupIntoBatches) instead of one request for the whole
// need-download list. Each batch is retried independently, up to retryAttempts times, using
// exactly the same in-pass-retry shape uploads already had -- but scoped to that one batch, so a
// single batch's stream failure only re-queues that batch's own paths, never the rest of the
// list. This is what makes a single bad/oversized batch's failure stop compounding into
// "the entire need-download set fails identically on every retry", which is what happened before
// downloads were batched at all: one request for e.g. 2500 files, and any whole-stream error left
// every one of those 2500 paths unaccounted for on every subsequent retry.
export async function runBatchedDownloads(
  paths: string[],
  sizeByPath: Map<string, number>,
  download: (batchPaths: string[]) => Promise<BatchDownloadResult>,
  opts: RunBatchedDownloadsOptions
): Promise<BatchDownloadResult> {
  const batches = groupIntoBatches(paths, (p) => sizeByPath.get(p) ?? 0, opts.targetBytes, opts.maxFiles);

  let downloadedCount = 0;
  const failedPaths: string[] = [];

  for (const batch of batches) {
    let pathsToDownload = batch;
    for (let attempt = 0; pathsToDownload.length > 0 && attempt <= opts.retryAttempts; attempt++) {
      if (attempt > 0) {
        await opts.onRetry?.(pathsToDownload, attempt);
      }
      try {
        const result = await download(pathsToDownload);
        downloadedCount += result.downloadedCount;
        pathsToDownload = result.failedPaths;
      } catch {
        // The whole batch/stream errored rather than an individual file coming back with a
        // failure -- every path in this attempt is unaccounted for, so they're all retry
        // candidates for this batch's next attempt (and only this batch's).
      }
    }
    if (pathsToDownload.length > 0) {
      opts.onBatchGiveUp?.(pathsToDownload);
      failedPaths.push(...pathsToDownload);
    }
  }

  return { downloadedCount, failedPaths };
}
