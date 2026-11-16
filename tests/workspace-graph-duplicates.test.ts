// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { expect, test } from "bun:test";
import { bucketCount, DUPLICATE_COSINE, findSimilarity } from "../src/core/graph-duplicates";

/** `n` vectors around `centre`, each a little different, in 8 dimensions. */
const around = (centre: number[], n: number, spread: number, seed: number) =>
  Array.from({ length: n }, (_, i) =>
    Float32Array.from(centre.map((c, d) => c + (((i * 31 + d * 17 + seed) % 11) - 5) * spread)),
  );

test("near-duplicates are pairs of one bucket at or above the threshold, most alike first", async () => {
  const base = around([1, 0, 0, 0, 0, 0, 0, 0], 10, 0.2, 3);
  const copy = Float32Array.from(base[0]!, (v) => v * 1.001);
  const far = around([0, 0, 0, 0, 0, 0, 1, 0], 10, 0.2, 4);
  const vectors = [...base, copy, ...far];
  const found = (await findSimilarity(vectors))!.duplicates;
  expect(found.threshold).toBe(DUPLICATE_COSINE);
  const pairs = found.a.map((a, k) => [a, found.b[k]]);
  expect(pairs[0]).toEqual([0, 10]);
  expect(found.cosine[0]).toBeGreaterThan(0.999);
  expect(found.cosine.every((c) => c >= DUPLICATE_COSINE)).toBe(true);
  for (let k = 1; k < found.cosine.length; k++) expect(found.cosine[k]!).toBeLessThanOrEqual(found.cosine[k - 1]!);
  expect(found.truncated).toBe(false);
});

test("too few vectors give no duplicates; the bucket count grows with the library and stops at 36", async () => {
  expect(await findSimilarity(around([1, 0, 0, 0, 0, 0, 0, 0], 5, 0.1, 5))).toBeNull();
  expect(bucketCount(8)).toBe(2);
  expect(bucketCount(264)).toBe(11);
  expect(bucketCount(20000)).toBe(36);
});

test("a library of copies reports the first 2,000 pairs, most alike first, and says it was cut", async () => {
  // 200 identical vectors make 19,900 pairs at cosine 1: more than are kept, in the order of their indexes.
  const same = Array.from({ length: 200 }, () => Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0]));
  const others = Array.from({ length: 10 }, (_, i) =>
    Float32Array.from([0, 0, 0, 0, 0, 0, 0, 0].map((_, d) => (d === 1 + (i % 7) ? 1 : 0))),
  );
  const vectors = [...same, ...others];
  const found = (await findSimilarity(vectors))!.duplicates;
  expect(found.truncated).toBe(true);
  expect(found.a).toHaveLength(2000);
  const expected: Array<[number, number]> = [];
  for (let a = 0; a < 200 && expected.length < 2000; a++)
    for (let b = a + 1; b < 200 && expected.length < 2000; b++) expected.push([a, b]);
  expect(found.a.map((a, k) => [a, found.b[k]])).toEqual(expected);
});

test("each embedded asset gets its group and a place near the alike ones; an asset with no embedding gets none", async () => {
  const one = around([1, 0, 0, 0, 0, 0, 0, 0], 12, 0.05, 1);
  const two = around([0, 0, 0, 0, 0, 0, 1, 0], 12, 0.05, 2);
  const groups = (await findSimilarity([...one, undefined, ...two]))!.groups;
  expect(groups.count).toBe(bucketCount(24));
  expect(groups.group[12]).toBe(-1);
  expect([groups.x[12], groups.y[12], groups.z[12]]).toEqual([0, 0, 0]);
  const place = (i: number) => [groups.x[i]!, groups.y[i]!, groups.z[i]!];
  const apart = (a: number, b: number) => Math.hypot(...place(a).map((v, d) => v - place(b)[d]!));
  expect(new Set(one.map((_, i) => groups.group[i])).size).toBe(1);
  expect(groups.group[0]).not.toBe(groups.group[13]);
  // Alike assets sit closer to each other than to the other group.
  expect(apart(0, 1)).toBeLessThan(apart(0, 13));
});
