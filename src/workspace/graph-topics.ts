// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The library's topics and near-duplicates, from the stored embeddings: what `assets.graph` reports so a host can say
 * what the library holds, where it overlaps, and which assets say the same thing. Nothing is embedded and nothing is
 * written; the work yields to the event loop as it goes and is kept for one index build.
 */

/** Fewest embedded assets topics are found for. */
const MIN_ASSETS = 8;
/** Most topics, however large the library. */
const MAX_TOPICS = 36;
/** Most vectors the topic centres are found from; the rest are only assigned to them. */
const SAMPLE = 4000;
const ROUNDS = 16;
/** Cosine at or above which two assets of one topic are reported as near-duplicates. */
export const DUPLICATE_COSINE = 0.96;
/** Most near-duplicate pairs reported, the most alike first. */
const MAX_PAIRS = 2000;
/** Topics each topic names as nearest. */
const RELATED_TOPICS = 3;

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export interface Topics {
  /** One per topic: a short name from its assets' paths and titles, its distinctive words, and how many assets it has. */
  topics: Array<{ label: string; terms: string[]; size: number; related: Array<{ topic: number; cosine: number }> }>;
  /** Each asset's topic, -1 for an asset with no usable vector. */
  topic: number[];
  /** Pairs of assets (by index) of one topic whose vectors are at least {@link DUPLICATE_COSINE} alike, most alike first. */
  duplicates: { threshold: number; a: number[]; b: number[]; cosine: number[]; truncated: boolean };
}

/** How many topics for `n` embedded assets: about the square root of n/2, from 2 to {@link MAX_TOPICS}. */
export function topicCount(n: number): number {
  return Math.max(2, Math.min(MAX_TOPICS, Math.round(Math.sqrt(n / 2))));
}

let cache: { key: string; result: Topics } | undefined;

/**
 * Groups the assets by meaning (spherical k-means on the unit vectors: centres from an evenly spaced sample of at most
 * 4,000, seeded deterministically, so the same vectors give the same topics), names each topic by the words of its
 * assets' paths and titles that are most particular to it, and finds near-duplicate pairs inside each topic. `names[i]`
 * is asset i's path and title. With a `key` (the index's build), the result is reused until the key changes.
 */
export async function findTopics(
  vectors: Array<Float32Array | undefined>,
  names: string[],
  key?: string,
): Promise<Topics> {
  if (key !== undefined && cache?.key === key && cache.result.topic.length === vectors.length) return cache.result;
  const empty: Topics = {
    topics: [],
    topic: vectors.map(() => -1),
    duplicates: { threshold: DUPLICATE_COSINE, a: [], b: [], cosine: [], truncated: false },
  };
  const dims = vectors.find((v) => v)?.length ?? 0;
  const usable: number[] = [];
  for (let i = 0; i < vectors.length; i++) if (vectors[i]?.length === dims) usable.push(i);
  if (!dims || usable.length < MIN_ASSETS) return empty;

  // Unit vectors, packed: cosine is then a dot product.
  const unit = new Float32Array(usable.length * dims);
  usable.forEach((i, row) => {
    const v = vectors[i]!;
    let norm = 0;
    for (let d = 0; d < dims; d++) norm += v[d]! * v[d]!;
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < dims; d++) unit[row * dims + d] = v[d]! / norm;
  });
  const dot = (row: number, centre: Float32Array, c: number) => {
    let sum = 0;
    for (let d = 0; d < dims; d++) sum += unit[row * dims + d]! * centre[c * dims + d]!;
    return sum;
  };

  const k = topicCount(usable.length);
  const step = Math.max(1, usable.length / SAMPLE);
  const sample: number[] = [];
  for (let at = 0; at < usable.length && sample.length < SAMPLE; at += step) sample.push(Math.floor(at));
  // k-means++ from a fixed start, with a deterministic generator, so a library always gets the same topics.
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

  // Every asset to its nearest centre; topics are renumbered largest first, and empty ones dropped.
  const raw = new Int32Array(usable.length);
  for (let row = 0; row < usable.length; row++) {
    raw[row] = nearest(row);
    if (row % 2000 === 1999) await yieldToLoop();
  }
  const sizes = new Array(k).fill(0);
  for (const c of raw) sizes[c]++;
  const order = sizes
    .map((size, c) => ({ size, c }))
    .filter((t) => t.size > 0)
    .sort((x, y) => y.size - x.size || x.c - y.c);
  const renumber = new Map(order.map((t, n) => [t.c, n]));
  const topic = vectors.map(() => -1);
  usable.forEach((i, row) => {
    topic[i] = renumber.get(raw[row]!)!;
  });

  const members: number[][] = order.map(() => []);
  usable.forEach((i, row) => {
    members[topic[i]!]!.push(row);
  });
  const centreOf = (n: number) => order[n]!.c;
  const topics = order.map((t, n) => ({
    ...nameTopic(
      members[n]!.map((row) => names[usable[row]!] ?? ""),
      names,
    ),
    size: t.size,
    related: order
      .map((_, m) => {
        let cosine = 0;
        for (let d = 0; d < dims; d++) cosine += centres[centreOf(n) * dims + d]! * centres[centreOf(m) * dims + d]!;
        return { topic: m, cosine: Math.round(cosine * 1000) / 1000 };
      })
      .filter((r) => r.topic !== n)
      .sort((x, y) => y.cosine - x.cosine)
      .slice(0, RELATED_TOPICS),
  }));

  // Near-duplicates: every pair inside a topic. Pairs across topics are not compared; two assets that alike almost
  // always share a topic.
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
  const result: Topics = {
    topics,
    topic,
    duplicates: {
      threshold: DUPLICATE_COSINE,
      a: kept.map((p) => p[0]),
      b: kept.map((p) => p[1]),
      cosine: kept.map((p) => Math.round(p[2] * 10000) / 10000),
      truncated: pairCount > MAX_PAIRS,
    },
  };
  if (key !== undefined) cache = { key, result };
  return result;
}

const STOP = new Set(
  "the and for with from into this that what when how why are was not use using about your you our its md readme index skill skills knowledge memory memories command commands agent agents script scripts workflow workflows fact facts lesson lessons references reference assets asset src lib test tests docs".split(
    " ",
  ),
);
/** The words of a path or title worth naming a topic by: lower case, three letters or more, no digits, no stop words. */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !/\d/.test(w) && !STOP.has(w));
}

let documentFrequency: { names: string[]; counts: Map<string, number> } | undefined;
/**
 * A topic's distinctive words: those most frequent among its assets relative to how many assets of the whole library
 * use them (each asset counts a word once). The label is the top two.
 */
export function nameTopic(memberNames: string[], allNames: string[]): { label: string; terms: string[] } {
  if (documentFrequency?.names !== allNames) {
    const counts = new Map<string, number>();
    for (const name of allNames) for (const w of new Set(words(name))) counts.set(w, (counts.get(w) ?? 0) + 1);
    documentFrequency = { names: allNames, counts };
  }
  const inTopic = new Map<string, number>();
  for (const name of memberNames) for (const w of new Set(words(name))) inTopic.set(w, (inTopic.get(w) ?? 0) + 1);
  const total = allNames.length;
  const terms = [...inTopic]
    // A word one asset uses names nothing.
    .filter(([, n]) => n >= Math.min(2, memberNames.length))
    .map(([w, n]) => ({
      w,
      score: (n / memberNames.length) * Math.log(total / (documentFrequency!.counts.get(w) ?? 1)),
    }))
    // A word every asset of the library has says nothing about this topic.
    .filter((t) => t.score > 0)
    .sort((x, y) => y.score - x.score || (x.w < y.w ? -1 : 1))
    .slice(0, 5)
    .map((t) => t.w);
  return { label: terms.slice(0, 2).join(" · ") || "unnamed", terms };
}
