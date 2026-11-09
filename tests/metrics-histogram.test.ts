// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { LATENCY_BUCKET_UPPER_MS } from "../src/core/metrics-db";
import {
  addToHistogram,
  emptyHistogram,
  histogramCount,
  histogramMedian,
  latencyBucket,
  mergeHistogram,
} from "../src/core/metrics-histogram";

describe("duration histograms", () => {
  test("a value lands in the first bucket whose bound it does not exceed; beyond the last is the overflow", () => {
    expect(latencyBucket(0)).toBe(0);
    expect(latencyBucket(1)).toBe(0);
    expect(latencyBucket(1.5)).toBe(1);
    expect(latencyBucket(300_000)).toBe(LATENCY_BUCKET_UPPER_MS.length - 1);
    expect(latencyBucket(300_001)).toBe(LATENCY_BUCKET_UPPER_MS.length);
  });

  test("merging adds bucket counts; a histogram of another length is ignored", () => {
    const a = emptyHistogram();
    const b = emptyHistogram();
    addToHistogram(a, 40);
    addToHistogram(b, 40);
    addToHistogram(b, 4000);
    mergeHistogram(a, b);
    mergeHistogram(a, [1, 2, 3]);
    expect(histogramCount(a)).toBe(3);
  });

  test("the median is empty for no values and lands inside the bucket of the exact one", () => {
    expect(histogramMedian(emptyHistogram())).toBeNull();
    const values = [12, 18, 22, 80, 90, 400, 450];
    const hist = emptyHistogram();
    for (const v of values) addToHistogram(hist, v);
    const exact = [...values].sort((x, y) => x - y)[Math.floor(values.length / 2)] as number; // 80
    const estimate = histogramMedian(hist) as number;
    expect(latencyBucket(estimate)).toBe(latencyBucket(exact));
  });

  test("a median in the overflow bucket reads as the last bound", () => {
    const hist = emptyHistogram();
    for (let i = 0; i < 3; i++) addToHistogram(hist, 999_999);
    expect(histogramMedian(hist)).toBe(300_000);
  });
});
