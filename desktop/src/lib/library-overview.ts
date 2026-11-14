// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The library as a whole, for four questions: what is in it (topics), what is used, what is wrong or duplicated, and how
 * its parts relate. Everything here is the payload of `assets.graph` reshaped; nothing is measured that akm did not
 * record. The page draws it (`LibraryMap.svelte`) and lists the same figures as text beside each picture.
 */

import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, forceZ } from "d3-force-3d";
import { FAMILIES, familyOf, type GraphPayload } from "./graph-model.ts";

export interface OverviewPayload extends GraphPayload {
  nodes: GraphPayload["nodes"] & {
    lastShownAt: Array<string | null>;
    modifiedAt: Array<string | null>;
    positive: number[];
    negative: number[];
    topic: number[];
  };
  topics: Array<{ label: string; terms: string[]; size: number; related: Array<{ topic: number; cosine: number }> }>;
  duplicates: { threshold: number; a: number[]; b: number[]; cosine: number[]; truncated: boolean } | null;
}

export type View = "contents" | "use" | "problems" | "relations";
export const VIEWS: Array<{ id: View; label: string; question: string }> = [
  { id: "contents", label: "Contents", question: "What is in the library?" },
  { id: "use", label: "Use", question: "What is used, and what is dead weight?" },
  { id: "problems", label: "Problems", question: "What is wrong or duplicated?" },
  { id: "relations", label: "Relations", question: "How do its parts relate?" },
];

/** A part of the library: a topic akm found from the embeddings, or, without embeddings, a folder. */
export interface Group {
  label: string;
  /** What the topic is about, most particular first; a folder's is its path. */
  terms: string[];
  kind: "topic" | "folder" | "unembedded";
  members: number[];
  /** Topics whose content is nearest, with the cosine of their centres (topics only). */
  related: Array<{ group: number; cosine: number }>;
}

export const DAY = 86_400_000;
/** Read within this many days counts as recent use. */
export const RECENT_DAYS = 30;
/** An unread asset last edited longer ago than this is dead weight; one edited since may simply be new. */
export const OLD_DAYS = 180;

/** How an asset is used: read lately, read only earlier in the window, unread but recently edited, unread and old. */
export type UseClass = "recent" | "earlier" | "new" | "unread";
export const USE_CLASSES: Array<{ id: UseClass; label: string; token: string }> = [
  { id: "recent", label: `Read in the last ${RECENT_DAYS} days`, token: "--use-4" },
  { id: "earlier", label: "Read earlier in the window, not since", token: "--use-2" },
  { id: "new", label: `Not read, edited in the last ${OLD_DAYS} days`, token: "--use-0" },
  { id: "unread", label: `Not read, last edited over ${OLD_DAYS} days ago`, token: "--warn" },
];

/** What is wrong with an asset, most serious first. */
export type Problem = "outdated" | "negative" | "duplicate";
export const PROBLEMS: Array<{ id: Problem; label: string; token: string }> = [
  { id: "outdated", label: "Superseded, contradicted or deprecated", token: "--map-highlight" },
  { id: "negative", label: "More negative feedback than positive", token: "--fail" },
  { id: "duplicate", label: "Nearly the same as another asset", token: "--warn" },
];
const OUTDATED_BELIEFS = ["superseded", "contradicted", "deprecated"];
const OUTDATED_LINKS = ["superseded_by", "contradicted_by"];

export interface Overview {
  count: number;
  ref: string[];
  title: string[];
  path: (i: number) => string;
  types: string[];
  type: number[];
  family: Uint8Array;
  bundles: string[];
  bundle: number[];
  shows: number[];
  groups: Group[];
  /** Each asset's group. */
  groupOf: Int32Array;
  use: Array<UseClass | null>;
  problems: Array<Problem[]>;
  /** Duplicate pairs by asset index, most alike first. */
  duplicates: Array<{ a: number; b: number; cosine: number }>;
  duplicatesTruncated: boolean;
  duplicateThreshold: number;
  links: { from: number[]; to: number[]; kind: number[] };
  kinds: string[];
  /** Whether the window's use is known (no usage history: every asset reads as not used). */
  useKnown: boolean;
  useSince: string | null;
  note: string;
}

/** The folder an asset sits in, for grouping without embeddings: the first two parts of its path below the bundle. */
export function folderOf(ref: string): string {
  const concept = ref.includes("//") ? ref.slice(ref.indexOf("//") + 2) : ref;
  const parts = concept.split("/");
  return parts.length > 2 ? parts.slice(0, 2).join("/") : (parts[0] ?? concept);
}

export function useClass(lastShownAt: string | null, modifiedAt: string | null, now: number): UseClass {
  if (lastShownAt) return now - Date.parse(lastShownAt) <= RECENT_DAYS * DAY ? "recent" : "earlier";
  const edited = modifiedAt ? Date.parse(modifiedAt) : Number.NaN;
  // An asset whose edit time cannot be read is not called new.
  return now - edited <= OLD_DAYS * DAY ? "new" : "unread";
}

export function buildOverview(payload: OverviewPayload, now = Date.now()): Overview {
  const n = payload.nodes.ref.length;
  const path = (i: number) => {
    const ref = payload.nodes.ref[i] ?? "";
    return ref.includes("//") ? ref.slice(ref.indexOf("//") + 2) : ref;
  };

  // Groups: akm's topics, plus one for assets with no embedding; or, with no topics at all, folders.
  const groupOf = new Int32Array(n).fill(-1);
  const groups: Group[] = [];
  if (payload.topics?.length) {
    for (const topic of payload.topics)
      groups.push({
        label: topic.label,
        terms: topic.terms,
        kind: "topic",
        members: [],
        related: topic.related.map((r) => ({ group: r.topic, cosine: r.cosine })),
      });
    for (let i = 0; i < n; i++) {
      const t = payload.nodes.topic[i] ?? -1;
      groupOf[i] = t >= 0 ? t : -1;
    }
    if (groupOf.some((g) => g === -1)) {
      groups.push({ label: "No embedding", terms: [], kind: "unembedded", members: [], related: [] });
      for (let i = 0; i < n; i++) if (groupOf[i] === -1) groupOf[i] = groups.length - 1;
    }
  } else {
    const at = new Map<string, number>();
    const folders = payload.nodes.ref.map(folderOf);
    const sizes = new Map<string, number>();
    for (const f of folders) sizes.set(f, (sizes.get(f) ?? 0) + 1);
    for (const f of [...sizes.keys()].sort((x, y) => sizes.get(y)! - sizes.get(x)! || (x < y ? -1 : 1))) {
      at.set(f, groups.length);
      groups.push({ label: f, terms: [f], kind: "folder", members: [], related: [] });
    }
    for (let i = 0; i < n; i++) groupOf[i] = at.get(folders[i]!)!;
  }
  for (let i = 0; i < n; i++) groups[groupOf[i]!]!.members.push(i);

  const useKnown = payload.use !== null && !payload.note.includes("no usage history");
  const use = Array.from({ length: n }, (_, i) =>
    useKnown ? useClass(payload.nodes.lastShownAt?.[i] ?? null, payload.nodes.modifiedAt?.[i] ?? null, now) : null,
  );

  const problems: Problem[][] = Array.from({ length: n }, () => []);
  const outdated = new Uint8Array(n);
  for (let i = 0; i < n; i++)
    if (OUTDATED_BELIEFS.includes(payload.beliefs[payload.nodes.belief[i] ?? -1] ?? "")) outdated[i] = 1;
  for (let e = 0; e < payload.links.from.length; e++)
    if (OUTDATED_LINKS.includes(payload.kinds[payload.links.kind[e]!] ?? "")) outdated[payload.links.from[e]!] = 1;
  const duplicates = (payload.duplicates?.a ?? []).map((a, k) => ({
    a,
    b: payload.duplicates!.b[k]!,
    cosine: payload.duplicates!.cosine[k]!,
  }));
  const duplicated = new Uint8Array(n);
  for (const d of duplicates) duplicated[d.a] = duplicated[d.b] = 1;
  for (let i = 0; i < n; i++) {
    if (outdated[i]) problems[i]!.push("outdated");
    if ((payload.nodes.negative?.[i] ?? 0) > (payload.nodes.positive?.[i] ?? 0)) problems[i]!.push("negative");
    if (duplicated[i]) problems[i]!.push("duplicate");
  }

  return {
    count: n,
    ref: payload.nodes.ref,
    title: payload.nodes.title,
    path,
    types: payload.types,
    type: payload.nodes.type,
    family: Uint8Array.from(payload.nodes.type, (t) => familyOf(payload.types[t] ?? "")),
    bundles: payload.bundles,
    bundle: payload.nodes.bundle,
    shows: payload.nodes.shows,
    groups,
    groupOf,
    use,
    problems,
    duplicates,
    duplicatesTruncated: payload.duplicates?.truncated ?? false,
    duplicateThreshold: payload.duplicates?.threshold ?? 0,
    links: payload.links,
    kinds: payload.kinds,
    useKnown,
    useSince: payload.use?.since ?? null,
    note: payload.note,
  };
}

// ---- Counting ----

/** How many of `indices` fall in each class `classOf` gives, in the order of `ids`. */
export function tally<T extends string>(indices: readonly number[], classOf: (i: number) => T | null, ids: T[]) {
  const counts = Object.fromEntries(ids.map((id) => [id, 0])) as Record<T, number>;
  for (const i of indices) {
    const c = classOf(i);
    if (c !== null) counts[c]++;
  }
  return counts;
}

/** Assets by type family, then by bundle: the library's make-up as rows of { label, count }, largest first. */
export function makeUp(o: Overview, indices: readonly number[] = o.ref.map((_, i) => i)) {
  const byFamily = new Array(FAMILIES.length).fill(0);
  const byBundle = new Array(o.bundles.length).fill(0);
  for (const i of indices) {
    byFamily[o.family[i]!]++;
    byBundle[o.bundle[i]!]++;
  }
  const rows = (labels: readonly string[], counts: number[]) =>
    labels
      .map((label, k) => ({ label, count: counts[k]!, slot: k }))
      .filter((r) => r.count > 0)
      .sort((x, y) => y.count - x.count);
  return {
    families: rows(
      FAMILIES.map((f) => f.label),
      byFamily,
    ),
    bundles: rows(o.bundles, byBundle),
  };
}

/** The first problem of an asset (the one it is coloured by), or null. */
export const firstProblem = (o: Overview, i: number): Problem | null => o.problems[i]![0] ?? null;

/**
 * Declared links between groups: for each pair of different groups the number of links joining them, and for each
 * group the links that stay inside it. Pairs run strongest first.
 */
export function groupLinks(o: Overview) {
  const inside = new Array(o.groups.length).fill(0);
  const between = new Map<string, { a: number; b: number; count: number }>();
  for (let e = 0; e < o.links.from.length; e++) {
    const a = o.groupOf[o.links.from[e]!]!;
    const b = o.groupOf[o.links.to[e]!]!;
    if (a === b) {
      inside[a]++;
      continue;
    }
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    const pair = between.get(key) ?? { a: Math.min(a, b), b: Math.max(a, b), count: 0 };
    pair.count++;
    between.set(key, pair);
  }
  const pairs = [...between.values()].sort((x, y) => y.count - x.count || x.a - y.a || x.b - y.b);
  const across = new Array(o.groups.length).fill(0);
  for (const p of pairs) {
    across[p.a] += p.count;
    across[p.b] += p.count;
  }
  return { inside, across, pairs };
}

// ---- Layout ----

/** Distance between neighbouring assets inside a region, in layout units. */
export const SPACING = 6;
const GOLDEN = 2.399963;

/** A region's radius for `n` assets: they sit in a sunflower spiral, packed about SPACING apart. */
export const regionRadius = (n: number) => (SPACING / Math.sqrt(Math.PI)) * Math.sqrt(Math.max(n, 1)) + SPACING;

/**
 * Where each group's region sits: a circle whose area follows its size, kept clear of the others, and pulled toward the
 * groups it is most like or most linked to, so related parts of the library are neighbours. The same input gives the
 * same layout.
 */
export function regionLayout(o: Overview, linkPairs = groupLinks(o).pairs) {
  const nodes = o.groups.map((g, k) => {
    const angle = k * GOLDEN;
    const r = 40 * Math.sqrt(k + 1);
    return { k, x: Math.cos(angle) * r, y: Math.sin(angle) * r, radius: regionRadius(g.members.length) };
  });
  const ties = new Map<string, { source: number; target: number; strength: number }>();
  const tie = (a: number, b: number, strength: number) => {
    if (a === b) return;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    const t = ties.get(key) ?? { source: a, target: b, strength: 0 };
    t.strength = Math.min(1, t.strength + strength);
    ties.set(key, t);
  };
  for (const [k, g] of o.groups.entries()) for (const r of g.related) tie(k, r.group, Math.max(0, r.cosine - 0.5));
  const most = linkPairs[0]?.count ?? 1;
  for (const p of linkPairs) tie(p.a, p.b, 0.6 * (p.count / most));
  const sim = forceSimulation(nodes, 2)
    .force(
      "tie",
      forceLink([...ties.values()])
        .id((d: { k: number }) => d.k)
        .distance(
          (t: { source: { radius: number }; target: { radius: number } }) => t.source.radius + t.target.radius + 30,
        )
        .strength((t: { strength: number }) => 0.05 + 0.4 * t.strength),
    )
    .force("charge", forceManyBody().strength(-30))
    .force("collide", forceCollide((d: { radius: number }) => d.radius + 14).iterations(3))
    .force("x", forceX(0).strength(0.04))
    .force("y", forceY(0).strength(0.04))
    .stop();
  for (let t = 0; t < 400; t++) sim.tick();
  return nodes.map((d) => ({ x: d.x, y: d.y, radius: d.radius }));
}

/**
 * Each asset's place inside its group's region: a sunflower spiral from the centre outwards, in the order `rank` sorts
 * them (lowest first, at the centre), so a region reads as proportions: what comes first fills the middle.
 */
export function assetLayout(
  o: Overview,
  regions: Array<{ x: number; y: number }>,
  rank: (i: number) => number,
): Float32Array {
  const pos = new Float32Array(o.count * 2);
  const c = SPACING / Math.sqrt(Math.PI);
  for (const [k, g] of o.groups.entries()) {
    const ordered = [...g.members].sort((a, b) => rank(a) - rank(b) || a - b);
    const centre = regions[k]!;
    ordered.forEach((i, s) => {
      const r = c * Math.sqrt(s + 0.5);
      pos[i * 2] = centre.x + Math.cos(s * GOLDEN) * r;
      pos[i * 2 + 1] = centre.y + Math.sin(s * GOLDEN) * r;
    });
  }
  return pos;
}

/** How each view orders a region's assets, centre first. */
export function rankFor(o: Overview, view: View): (i: number) => number {
  if (view === "use") {
    const order: Record<UseClass, number> = { recent: 0, earlier: 1, new: 2, unread: 3 };
    return (i) => (o.use[i] ? order[o.use[i]!] * 1e6 : 0) - Math.min(o.shows[i]!, 999_999);
  }
  if (view === "problems") {
    const order: Record<Problem, number> = { outdated: 0, negative: 1, duplicate: 2 };
    return (i) => {
      const p = firstProblem(o, i);
      return p ? order[p] : 3;
    };
  }
  return (i) => o.family[i]! * 1e6 - Math.min(o.shows[i]!, 999_999);
}

/** The groups as a 3D graph: one node per group, sized by its assets, joined by declared links and by likeness. */
export function relationLayout(o: Overview, pairs = groupLinks(o).pairs) {
  const nodes = o.groups.map((g, k) => ({
    k,
    x: Math.cos(k * GOLDEN) * 60 * Math.sqrt(k + 1),
    y: ((k % 7) - 3) * 20,
    z: Math.sin(k * GOLDEN) * 60 * Math.sqrt(k + 1),
    radius: 4 + 2.5 * Math.sqrt(g.members.length),
  }));
  const most = pairs[0]?.count ?? 1;
  const links = pairs.map((p) => ({ source: p.a, target: p.b, strength: p.count / most }));
  const sim = forceSimulation(nodes, 3)
    .force(
      "link",
      forceLink(links)
        .id((d: { k: number }) => d.k)
        .distance(
          (l: { source: { radius: number }; target: { radius: number }; strength: number }) =>
            l.source.radius + l.target.radius + 40 + 60 * (1 - l.strength),
        )
        .strength((l: { strength: number }) => 0.1 + 0.6 * l.strength),
    )
    .force("charge", forceManyBody().strength(-160))
    .force(
      "collide",
      forceCollide((d: { radius: number }) => d.radius + 10),
    )
    .force("x", forceX(0).strength(0.03))
    .force("y", forceY(0).strength(0.03))
    .force("z", forceZ(0).strength(0.03))
    .stop();
  for (let t = 0; t < 300; t++) sim.tick();
  return nodes.map((d, k) => ({
    x: d.x,
    y: d.y,
    z: d.z,
    radius: d.radius,
    pixels: 5 + 0.6 * Math.sqrt(o.groups[k]!.members.length),
  }));
}
