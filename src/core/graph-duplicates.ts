// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The library's shape by meaning, from the stored embeddings: what `assets.graph` reports so a host can show which assets
 * are alike and list the ones that say the same thing. The assets are grouped by meaning (spherical k-means on the unit
 * vectors); each group is placed in 3D by its centre, so alike groups sit near each other, and each asset around its
 * group's centre by how its vector differs from it. Near-duplicate pairs are looked for only inside a group, to avoid
 * comparing every pair. `akm index` runs it at the end of a build whose vectors changed and stores the result
 * (index-layout-repository.ts); the graph read only reads it back. Nothing is embedded; the work yields to the event loop
 * as it goes.
 */

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

/**
 * Each asset's group by meaning and its place in 3D, in input order: `group[i]` is -1 and the place 0 for an asset with
 * no embedding. Groups have no names; a host names them by what their assets carry.
 */
export interface Groups {
  count: number;
  group: number[];
  x: number[];
  y: number[];
  z: number[];
}

/** Near-duplicate pairs and groups by meaning; see {@link findSimilarity}. */
export interface Similarity {
  duplicates: Duplicates;
  groups: Groups;
}

/** How many buckets for `n` embedded assets: about the square root of n/2, from 2 to {@link MAX_BUCKETS}. */
export function bucketCount(n: number): number {
  return Math.max(2, Math.min(MAX_BUCKETS, Math.round(Math.sqrt(n / 2))));
}

/**
 * Groups by meaning and near-duplicate pairs among the assets: spherical k-means puts the assets into buckets (centres from an evenly spaced
 * sample of at most 4,000, seeded deterministically, so the same vectors give the same pairs), and every pair inside a
 * bucket whose cosine is at least {@link DUPLICATE_COSINE} is reported; the buckets are the groups, placed by
 * {@link place}. `null` without at least eight embedded assets.
 */
export async function findSimilarity(vectors: Array<Float32Array | undefined>): Promise<Similarity | null> {
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
  const result: Similarity = {
    duplicates: {
      threshold: DUPLICATE_COSINE,
      a: kept.map((p) => p[0]),
      b: kept.map((p) => p[1]),
      cosine: kept.map((p) => Math.round(p[2] * 10000) / 10000),
      truncated: pairCount > MAX_PAIRS,
    },
    groups: place(unit, dims, usable, members, centres, vectors.length),
  };
  return result;
}

/**
 * Where each asset sits in 3D. A group's centre is placed along the three directions its centres differ most in (found
 * by power iteration from fixed starts), scaled so the groups spread about 100 units from the middle, then groups that
 * overlap are pushed apart. An asset sits around its centre along three fixed directions, by how its vector differs
 * from the centre, so a group's most typical assets are near its middle; a group's radius grows with the cube root of
 * its size.
 */
function place(
  unit: Float32Array,
  dims: number,
  usable: number[],
  members: number[][],
  centres: Float32Array,
  n: number,
): Groups {
  const k = members.length;
  const groups: Groups = {
    count: k,
    group: new Array<number>(n).fill(-1),
    x: new Array<number>(n).fill(0),
    y: new Array<number>(n).fill(0),
    z: new Array<number>(n).fill(0),
  };
  const live = members.flatMap((rows, c) => (rows.length ? [c] : []));
  const mean = new Float64Array(dims);
  for (const c of live) for (let d = 0; d < dims; d++) mean[d]! += centres[c * dims + d]! / live.length;
  const centred = (c: number, d: number) => centres[c * dims + d]! - mean[d]!;
  const axes: Float64Array[] = [];
  for (let a = 0; a < 3; a++) {
    let axis = Float64Array.from({ length: dims }, (_, d) => Math.sin(d * (a + 1) + 1));
    for (let round = 0; round < 60; round++) {
      const next = new Float64Array(dims);
      for (const c of live) {
        let along = 0;
        for (let d = 0; d < dims; d++) along += centred(c, d) * axis[d]!;
        for (let d = 0; d < dims; d++) next[d]! += along * centred(c, d);
      }
      for (const done of axes) {
        let along = 0;
        for (let d = 0; d < dims; d++) along += next[d]! * done[d]!;
        for (let d = 0; d < dims; d++) next[d]! -= along * done[d]!;
      }
      const norm = Math.hypot(...next) || 1;
      axis = next.map((v) => v / norm);
    }
    axes.push(axis);
  }
  // Group centres in 3D, spread to a root mean square of 100 from the middle.
  const at = members.map(() => [0, 0, 0]);
  for (const c of live)
    at[c] = axes.map((axis) => {
      let along = 0;
      for (let d = 0; d < dims; d++) along += centred(c, d) * axis[d]!;
      return along;
    });
  const spread = Math.sqrt(live.reduce((sum, c) => sum + at[c]!.reduce((s, v) => s + v * v, 0), 0) / live.length) || 1;
  for (const c of live) at[c] = at[c]!.map((v) => (100 * v) / spread);
  const radius = members.map((rows) => 2.6 * Math.cbrt(rows.length));
  for (let round = 0; round < 80; round++)
    for (const a of live)
      for (const b of live) {
        if (b <= a) continue;
        const gap = at[b]!.map((v, i) => v - at[a]![i]!);
        const apart = Math.hypot(...gap) || 1e-6;
        const need = 1.15 * (radius[a]! + radius[b]!);
        if (apart >= need) continue;
        const push = (need - apart) / 2 / apart;
        at[a] = at[a]!.map((v, i) => v - gap[i]! * push);
        at[b] = at[b]!.map((v, i) => v + gap[i]! * push);
      }
  // Three fixed directions for the spread inside a group.
  let seed = 11;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32 - 0.5;
  };
  const inner = [0, 1, 2].map(() => {
    const v = Float64Array.from({ length: dims }, random);
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  });
  members.forEach((rows, c) => {
    if (!rows.length) return;
    const offsets = rows.map((row) =>
      inner.map((dir) => {
        let along = 0;
        for (let d = 0; d < dims; d++) along += (unit[row * dims + d]! - centres[c * dims + d]!) * dir[d]!;
        return along;
      }),
    );
    const rms = Math.sqrt(offsets.reduce((sum, o) => sum + o[0]! ** 2 + o[1]! ** 2 + o[2]! ** 2, 0) / rows.length) || 1;
    const scale = radius[c]! / rms;
    rows.forEach((row, r) => {
      const i = usable[row]!;
      groups.group[i] = c;
      groups.x[i] = Math.round((at[c]![0]! + offsets[r]![0]! * scale) * 10) / 10;
      groups.y[i] = Math.round((at[c]![1]! + offsets[r]![1]! * scale) * 10) / 10;
      groups.z[i] = Math.round((at[c]![2]! + offsets[r]![2]! * scale) * 10) / 10;
    });
  });
  return groups;
}
