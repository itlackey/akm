// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The library's near-duplicate pairs, from the stored embeddings: what `assets.graph` reports so a host can list assets
 * that say the same thing. To avoid comparing every pair, the assets are first bucketed by meaning (spherical k-means
 * on the unit vectors) and only pairs inside a bucket are compared; the buckets are not reported. Nothing is embedded
 * and nothing is written; the work yields to the event loop as it goes, and the result is kept while the vectors stay
 * the same.
 */

import { createHash } from "node:crypto";

/** Fewest embedded assets duplicates are looked for in. */
const MIN_ASSETS = 8;
/** Most buckets, however large the library. */
const MAX_BUCKETS = 36;
/** Most vectors the bucket centres are found from; the rest are only assigned to them. */
const SAMPLE = 4000;
const ROUNDS = 16;
/** Cosine at or above which two assets of one bucket are reported as near-duplicates. */
export const DUPLICATE_COSINE = 0.96;
/** Most near-duplicate pairs reported, the most alike first. */
const MAX_PAIRS = 2000;

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Pairs of assets (by index) of one bucket whose vectors are at least `threshold` alike, most alike first. */
export interface Duplicates {
  threshold: number;
  a: number[];
  b: number[];
  cosine: number[];
  truncated: boolean;
}

/** How many buckets for `n` embedded assets: about the square root of n/2, from 2 to {@link MAX_BUCKETS}. */
export function bucketCount(n: number): number {
  return Math.max(2, Math.min(MAX_BUCKETS, Math.round(Math.sqrt(n / 2))));
}

let cache: { key: string; result: Duplicates | null } | undefined;

/** The vectors' content, in order: an index build that changed no embedding gives the same key. */
function contentKey(vectors: Array<Float32Array | undefined>): string {
  const hash = createHash("sha1");
  for (const v of vectors) hash.update(v ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : NO_VECTOR);
  return hash.digest("hex");
}
const NO_VECTOR = new Uint8Array(1);

/**
 * Near-duplicate pairs among the assets: spherical k-means puts the assets into buckets (centres from an evenly spaced
 * sample of at most 4,000, seeded deterministically, so the same vectors give the same pairs), and every pair inside a
 * bucket whose cosine is at least {@link DUPLICATE_COSINE} is reported. `null` without at least eight embedded assets.
 * The last result is reused while the vectors are the same, so index builds that change no embedding cost nothing here.
 */
export async function findDuplicates(vectors: Array<Float32Array | undefined>): Promise<Duplicates | null> {
  const key = contentKey(vectors);
  if (cache?.key === key) return cache.result;
  const dims = vectors.find((v) => v)?.length ?? 0;
  const usable: number[] = [];
  for (let i = 0; i < vectors.length; i++) if (vectors[i]?.length === dims) usable.push(i);
  if (!dims || usable.length < MIN_ASSETS) return null;

  // Unit vectors, packed: cosine is then a dot product.
  const unit = new Float32Array(usable.length * dims);
  usable.forEach((i, row) => {
    const v = vectors[i]!;
    let norm = 0;
    for (let d = 0; d < dims; d++) norm += v[d]! * v[d]!;
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < dims; d++) unit[row * dims + d] = v[d]! / norm;
  });
  // A bit per dimension, set where the vector is above the library's mean. Vectors as alike as a duplicate differ in
  // far fewer than a quarter of their bits (under a fifth on a 16,000-asset library), so a pair is multiplied out
  // only when its codes are that close.
  const words = Math.ceil(dims / 32);
  const mean = new Float64Array(dims);
  for (let row = 0; row < usable.length; row++) for (let d = 0; d < dims; d++) mean[d]! += unit[row * dims + d]!;
  const code = new Uint32Array(usable.length * words);
  for (let row = 0; row < usable.length; row++)
    for (let d = 0; d < dims; d++)
      if (unit[row * dims + d]! * usable.length > mean[d]!) code[row * words + (d >> 5)]! |= 1 << (d & 31);
  const closeBits = Math.ceil(dims / 4);
  const bitsApart = (x: number, y: number) => {
    let bits = 0;
    for (let w = 0; w < words; w++) {
      let v = code[x * words + w]! ^ code[y * words + w]!;
      v -= (v >>> 1) & 0x55555555;
      v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
      bits += (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
    }
    return bits;
  };
  const dot = (row: number, centre: Float32Array, c: number) => {
    let sum = 0;
    for (let d = 0; d < dims; d++) sum += unit[row * dims + d]! * centre[c * dims + d]!;
    return sum;
  };

  const k = bucketCount(usable.length);
  const step = Math.max(1, usable.length / SAMPLE);
  const sample: number[] = [];
  for (let at = 0; at < usable.length && sample.length < SAMPLE; at += step) sample.push(Math.floor(at));
  // k-means++ from a fixed start, with a deterministic generator, so a library always gets the same buckets.
  let seed = 7;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const centres = new Float32Array(k * dims);
  const setCentre = (c: number, row: number) => centres.set(unit.subarray(row * dims, row * dims + dims), c * dims);
  setCentre(0, sample[0]!);
  const far = new Float64Array(sample.length).fill(Number.POSITIVE_INFINITY);
  for (let c = 1; c < k; c++) {
    let total = 0;
    for (let s = 0; s < sample.length; s++) {
      far[s] = Math.min(far[s]!, Math.max(0, 1 - dot(sample[s]!, centres, c - 1)));
      total += far[s]! * far[s]!;
    }
    let r = random() * total;
    let chosen = sample.length - 1;
    for (let s = 0; s < sample.length; s++) {
      r -= far[s]! * far[s]!;
      if (r <= 0) {
        chosen = s;
        break;
      }
    }
    setCentre(c, sample[chosen]!);
  }
  const nearest = (row: number) => {
    let best = 0;
    let bestDot = Number.NEGATIVE_INFINITY;
    for (let c = 0; c < k; c++) {
      const value = dot(row, centres, c);
      if (value > bestDot) {
        bestDot = value;
        best = c;
      }
    }
    return best;
  };
  for (let round = 0; round < ROUNDS; round++) {
    const sums = new Float64Array(k * dims);
    for (const row of sample) {
      const c = nearest(row);
      for (let d = 0; d < dims; d++) sums[c * dims + d]! += unit[row * dims + d]!;
    }
    for (let c = 0; c < k; c++) {
      let norm = 0;
      for (let d = 0; d < dims; d++) norm += sums[c * dims + d]! ** 2;
      norm = Math.sqrt(norm);
      // A centre that lost every member keeps its place.
      if (norm > 0) for (let d = 0; d < dims; d++) centres[c * dims + d] = sums[c * dims + d]! / norm;
    }
    await yieldToLoop();
  }

  // Every asset to its nearest centre.
  const members: number[][] = Array.from({ length: k }, () => []);
  for (let row = 0; row < usable.length; row++) {
    members[nearest(row)]!.push(row);
    if (row % 2000 === 1999) await yieldToLoop();
  }

  // Near-duplicates: every pair inside a bucket. Pairs across buckets are not compared; two assets that alike almost
  // always share a bucket.
  // Only the best MAX_PAIRS are kept, so a library full of copies does not hold every pair in memory: the list is cut
  // back whenever it grows to eight times that, to the same top pairs a full sort would keep.
  let pairs: Array<[number, number, number]> = [];
  let pairCount = 0;
  const byAlike = (x: [number, number, number], y: [number, number, number]) =>
    y[2] - x[2] || x[0] - y[0] || x[1] - y[1];
  for (const rows of members) {
    for (let x = 0; x < rows.length; x++) {
      const p = rows[x]! * dims;
      for (let y = x + 1; y < rows.length; y++) {
        if (bitsApart(rows[x]!, rows[y]!) > closeBits) continue;
        const q = rows[y]! * dims;
        let cosine = 0;
        for (let d = 0; d < dims; d++) cosine += unit[p + d]! * unit[q + d]!;
        if (cosine >= DUPLICATE_COSINE) {
          pairs.push([usable[rows[x]!]!, usable[rows[y]!]!, cosine]);
          pairCount++;
          if (pairs.length >= MAX_PAIRS * 8) pairs = pairs.sort(byAlike).slice(0, MAX_PAIRS);
        }
      }
      if (x % 200 === 199) await yieldToLoop();
    }
    await yieldToLoop();
  }
  const kept = pairs.sort(byAlike).slice(0, MAX_PAIRS);
  const result: Duplicates = {
    threshold: DUPLICATE_COSINE,
    a: kept.map((p) => p[0]),
    b: kept.map((p) => p[1]),
    cosine: kept.map((p) => Math.round(p[2] * 10000) / 10000),
    truncated: pairCount > MAX_PAIRS,
  };
  cache = { key, result };
  return result;
}
