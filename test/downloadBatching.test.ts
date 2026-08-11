import { describe, expect, it, vi } from "vitest";
import { groupIntoBatches, runBatchedDownloads } from "../src/batching";

// Regression coverage for a real-world failure: a fresh vault's first sync needed ~2500
// files, and runDownloads sent the *entire* need-download list as one DownloadFiles request
// with no batching (unlike uploads, which are capped via groupIntoBatches). The client's
// retry loop only shrinks its retry list on a per-file ack, so a whole-stream failure (the
// server-side fallout of fanning that many files out at once, see pumice-server's
// DownloadFiles fix) left the full 2528-file list unchanged on every retry -- it failed
// identically, forever. groupIntoBatches already existed for uploads but had no direct
// tests of its own; runBatchedDownloads is the new per-batch-retry orchestration that makes
// downloads use it too.

describe("groupIntoBatches", () => {
  it("returns no batches for an empty path list", () => {
    expect(groupIntoBatches([], () => 0, 1000, 10)).toEqual([]);
  });

  it("keeps everything in one batch when under both limits", () => {
    const paths = ["a", "b", "c"];
    expect(groupIntoBatches(paths, () => 10, 1000, 10)).toEqual([["a", "b", "c"]]);
  });

  it("splits once the file-count cap is reached", () => {
    const paths = ["a", "b", "c", "d", "e"];
    expect(groupIntoBatches(paths, () => 1, 1000, 2)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });

  it("splits once the byte-size cap is reached", () => {
    const paths = ["a", "b", "c"];
    const sizeOf = (p: string) => (p === "b" ? 60 : 40);
    // a(40) -> 40; b(60) -> 100 (still <= 100, stays); c(40) would push to 140 > 100, new batch
    expect(groupIntoBatches(paths, sizeOf, 100, 10)).toEqual([["a", "b"], ["c"]]);
  });

  it("gives an oversized single file its own batch rather than dropping it", () => {
    const paths = ["huge", "small"];
    const sizeOf = (p: string) => (p === "huge" ? 5000 : 10);
    expect(groupIntoBatches(paths, sizeOf, 1000, 10)).toEqual([["huge"], ["small"]]);
  });
});

describe("runBatchedDownloads", () => {
  const opts = { targetBytes: 1000, maxFiles: 2, retryAttempts: 2 };
  const noSizes = new Map<string, number>();

  it("does nothing for an empty path list", async () => {
    const download = vi.fn();
    const result = await runBatchedDownloads([], noSizes, download, opts);
    expect(result).toEqual({ downloadedCount: 0, failedPaths: [] });
    expect(download).not.toHaveBeenCalled();
  });

  it("issues one call per batch, not one call for the whole list", async () => {
    const paths = ["a", "b", "c", "d", "e"]; // maxFiles=2 -> batches of [a,b] [c,d] [e]
    const download = vi.fn(async (batch: string[]) => ({ downloadedCount: batch.length, failedPaths: [] }));

    const result = await runBatchedDownloads(paths, noSizes, download, opts);

    expect(download).toHaveBeenCalledTimes(3);
    expect(download.mock.calls.map((c) => c[0])).toEqual([["a", "b"], ["c", "d"], ["e"]]);
    expect(result).toEqual({ downloadedCount: 5, failedPaths: [] });
  });

  it("retries only the failed batch's own paths, not other batches", async () => {
    const paths = ["a", "b", "c", "d"]; // batches: [a,b] [c,d]
    const calls: string[][] = [];
    const download = vi.fn(async (batch: string[]) => {
      calls.push(batch);
      if (batch.includes("c")) {
        throw new Error("whole-batch stream error");
      }
      return { downloadedCount: batch.length, failedPaths: [] };
    });

    const result = await runBatchedDownloads(paths, noSizes, download, { ...opts, retryAttempts: 1 });

    // [a,b] succeeds once; [c,d] is attempted (1 initial + 1 retry = 2 calls), both fail
    expect(calls).toEqual([["a", "b"], ["c", "d"], ["c", "d"]]);
    expect(result).toEqual({ downloadedCount: 2, failedPaths: ["c", "d"] });
  });

  it("a batch that fails every retry does not force a successful batch to be retried too", async () => {
    const paths = ["a", "b"]; // two separate batches (maxFiles=2 groups them together, so force separate batches via size)
    const sizeByPath = new Map([["a", 1000], ["b", 1000]]); // each alone fills targetBytes -> own batch
    const download = vi.fn(async (batch: string[]) => {
      if (batch[0] === "b") throw new Error("b always fails");
      return { downloadedCount: batch.length, failedPaths: [] };
    });

    const result = await runBatchedDownloads(paths, sizeByPath, download, opts);

    const aCalls = download.mock.calls.filter((c) => c[0][0] === "a");
    expect(aCalls.length).toBe(1); // "a"'s batch never gets retried just because "b"'s batch failed
    expect(result).toEqual({ downloadedCount: 1, failedPaths: ["b"] });
  });

  it("shrinks the retry list using the download callback's own per-file failedPaths", async () => {
    const paths = ["a", "b"];
    let attempt = 0;
    const download = vi.fn(async (batch: string[]) => {
      attempt++;
      if (attempt === 1) return { downloadedCount: 1, failedPaths: ["b"] };
      return { downloadedCount: 1, failedPaths: [] };
    });

    const result = await runBatchedDownloads(paths, noSizes, download, opts);

    expect(download.mock.calls.map((c) => c[0])).toEqual([["a", "b"], ["b"]]);
    expect(result).toEqual({ downloadedCount: 2, failedPaths: [] });
  });

  it("calls onRetry with the batch being retried and the attempt number", async () => {
    const paths = ["a"];
    let calls = 0;
    const download = vi.fn(async () => {
      calls++;
      return calls < 2 ? { downloadedCount: 0, failedPaths: ["a"] } : { downloadedCount: 1, failedPaths: [] };
    });
    const onRetry = vi.fn();

    await runBatchedDownloads(paths, noSizes, download, { ...opts, onRetry });

    expect(onRetry).toHaveBeenCalledWith(["a"], 1);
  });
});
