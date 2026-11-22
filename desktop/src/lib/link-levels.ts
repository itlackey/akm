// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * What a selected asset is joined to, three steps out. The links are the ones `assets.graph` reports (declared links
 * and, when asked, its near-duplicate pairs); nothing is joined here that akm did not report.
 */

import type { Overview } from "./library-overview.ts";

/** A join between two assets, either way, and what kind it is. */
export interface Join {
  a: number;
  b: number;
  what: string;
}

/** Every join akm reports as one list: declared links (only of `linkKinds` when given) and near-duplicate pairs. */
export function joinsOf(o: Pick<Overview, "links" | "duplicates">, linkKinds: readonly string[] | null = null): Join[] {
  return [
    ...o.links
      .filter((l) => !linkKinds || linkKinds.includes(l.kind))
      .map((l) => ({ a: l.from, b: l.to, what: l.kind.replaceAll("_", " ") })),
    ...o.duplicates.map((d) => ({ a: d.a, b: d.b, what: `near-duplicate ${d.cosine.toFixed(3)}` })),
  ];
}

/** One step out from the selection: the assets first reached at this step. */
export interface Level {
  /** The assets reached at this step and shown (at most `cap`). */
  nodes: number[];
  /** Assets reached at this step that are not shown, because the step reached more than `cap`. */
  cut: number;
}

export interface Reach {
  /** Levels 1, 2 and 3, in order. */
  levels: [Level, Level, Level];
  /** Each join once, at the nearest level it belongs to: level 1 joins the selection to its neighbours, level 2 a
   * neighbour to anything, level 3 an asset two steps out to anything. */
  links: Array<{ a: number; b: number; level: 1 | 2 | 3; what: string }>;
}

/** The most assets any one level shows; a level that reaches more says how many it left out. */
export const LEVEL_CAP = 300;

/**
 * The assets within three joins of `start`, level by level, and the joins between them. A level that reaches more than
 * `cap` assets keeps the `cap` most joined (ties by index) and counts the rest in `cut`; the next level is walked from
 * the kept ones only. An asset belongs to the nearest level that reaches it, and a join is drawn once, at the level of
 * the nearer of its two ends: a join between two assets of one level belongs to the next.
 */
export function reach(joins: readonly Join[], count: number, start: number, cap = LEVEL_CAP): Reach {
  // Adjacency in column form: the joins of asset i are `peer[offset[i] .. offset[i + 1])`.
  const offset = new Uint32Array(count + 1);
  for (const j of joins) {
    offset[j.a + 1]!++;
    offset[j.b + 1]!++;
  }
  for (let i = 0; i < count; i++) offset[i + 1]! += offset[i]!;
  const fill = offset.slice(0, count);
  const peer = new Uint32Array(offset[count]!);
  for (const j of joins) {
    peer[fill[j.a]!++] = j.b;
    peer[fill[j.b]!++] = j.a;
  }
  const degree = (i: number) => offset[i + 1]! - offset[i]!;

  const depth = new Int8Array(count).fill(-1);
  depth[start] = 0;
  let frontier = [start];
  const levels: Level[] = [];
  for (let step = 1; step <= 3; step++) {
    const reached = new Set<number>();
    for (const i of frontier)
      for (let k = offset[i]!; k < offset[i + 1]!; k++) if (depth[peer[k]!]! < 0) reached.add(peer[k]!);
    const kept = [...reached].sort((x, y) => degree(y) - degree(x) || x - y).slice(0, cap);
    for (const i of kept) depth[i] = step;
    levels.push({ nodes: kept, cut: reached.size - kept.length });
    frontier = kept;
  }

  const seen = new Set<number>();
  const links: Reach["links"] = [];
  for (const j of joins) {
    if (j.a === j.b || depth[j.a]! < 0 || depth[j.b]! < 0) continue;
    const level = Math.min(depth[j.a]!, depth[j.b]!) + 1;
    if (level > 3) continue;
    const key = Math.min(j.a, j.b) * count + Math.max(j.a, j.b);
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ a: j.a, b: j.b, level: level as 1 | 2 | 3, what: j.what });
  }
  return { levels: levels as Reach["levels"], links };
}

/**
 * How each level is drawn, in the map and in its key: width in pixels, how far its colour is mixed toward the map
 * background (0 is the highlight itself), whether it is dashed, and the size of the ring marking its assets.
 * `tests/map-palette.test.mjs` holds each colour at 3:1 against the background in both themes.
 */
export const LEVEL_STYLES = [
  { level: 1, label: "1st level", width: 3, mute: 0, dash: false, ring: 24 },
  { level: 2, label: "2nd level", width: 1.8, mute: 0.28, dash: false, ring: 20 },
  { level: 3, label: "3rd level", width: 1.1, mute: 0.4, dash: true, ring: 16 },
] as const;
