// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Duration histograms over the fixed bucket bounds in `metrics-db.ts`: an array
 * of counts, one per bound plus a last overflow bucket. A median does not roll
 * up across days, a histogram does; {@link histogramMedian} estimates it.
 */

import { LATENCY_BUCKET_UPPER_MS } from "./metrics-db";

const BOUNDS = LATENCY_BUCKET_UPPER_MS;

export function emptyHistogram(): number[] {
  return new Array<number>(BOUNDS.length + 1).fill(0);
}

/** Index of the bucket `valueMs` falls in (the last bucket is the overflow). */
export function latencyBucket(valueMs: number): number {
  const index = BOUNDS.findIndex((upper) => valueMs <= upper);
  return index === -1 ? BOUNDS.length : index;
}

export function addToHistogram(hist: number[], valueMs: number): void {
  const bucket = latencyBucket(valueMs);
  hist[bucket] = (hist[bucket] ?? 0) + 1;
}

/** `into` plus `other`, bucket by bucket (a stored histogram of another length is ignored). */
export function mergeHistogram(into: number[], other: readonly number[]): void {
  if (other.length !== into.length) return;
  for (let i = 0; i < into.length; i++) into[i] = (into[i] ?? 0) + (other[i] ?? 0);
}

export function histogramCount(hist: readonly number[]): number {
  return hist.reduce((sum, n) => sum + n, 0);
}

/**
 * The median the way the exact one is picked (the value at rank `floor(n / 2)` of the sorted values),
 * estimated inside its bucket by linear interpolation. `null` for an empty histogram. The overflow
 * bucket reads as its lower bound.
 */
export function histogramMedian(hist: readonly number[]): number | null {
  const n = histogramCount(hist);
  if (n === 0) return null;
  const rank = Math.floor(n / 2);
  let seen = 0;
  for (let i = 0; i < hist.length; i++) {
    const inBucket = hist[i] ?? 0;
    if (rank < seen + inBucket) {
      const lower = i === 0 ? 0 : (BOUNDS[i - 1] ?? 0);
      const upper = BOUNDS[i];
      if (upper === undefined) return lower;
      return Math.round(lower + ((upper - lower) * (rank - seen + 0.5)) / inBucket);
    }
    seen += inBucket;
  }
  return null;
}
