// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Maps over items concurrently with a pool size limit.
 * Uses Promise.allSettled semantics — one failure does not cancel others.
 *
 * Cooperative cancellation (P0.5 seam for the workflow scheduler): when
 * `opts.signal` aborts, workers stop CLAIMING new items — in-flight `fn`
 * calls run to completion (pass the same signal into `fn`'s own work to
 * preempt those too). Unclaimed items stay `undefined` in the result,
 * indistinguishable from individual failures by design: callers already
 * treat `undefined` as "no result".
 */
export async function concurrentMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency = 1,
  opts?: { signal?: AbortSignal },
): Promise<Array<R | undefined>> {
  const results: Array<R | undefined> = new Array(items.length).fill(undefined);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      if (opts?.signal?.aborted) return;
      const i = nextIndex++;
      try {
        results[i] = await fn(items[i]!, i);
      } catch {
        // individual failure: leave undefined, caller checks
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}
