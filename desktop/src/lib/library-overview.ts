// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The library as a whole, for three questions: what is in it, what is used, and what is wrong or duplicated. It is
 * drawn as a mind map: the library, its asset types, and under each type the tags its assets carry most. Everything
 * here is the payload of `assets.graph` reshaped; nothing is measured that akm did not record. The page draws it
 * (`LibraryMap.svelte`) and lists the same figures as text beside the picture.
 */

import { FAMILIES, familyOf, type GraphPayload } from "./graph-model.ts";

export interface OverviewPayload extends GraphPayload {
  nodes: GraphPayload["nodes"] & {
    lastShownAt: Array<string | null>;
    modifiedAt: Array<string | null>;
    positive: number[];
    negative: number[];
    tags: number[][];
  };
  tags: string[];
  duplicates: { threshold: number; a: number[]; b: number[]; cosine: number[]; truncated: boolean } | null;
  groups?: { count: number; group: number[]; x: number[]; y: number[]; z: number[] } | null;
}

export type View = "contents" | "use" | "problems";
export const VIEWS: Array<{ id: View; label: string; question: string }> = [
  { id: "contents", label: "Contents", question: "What is in the library?" },
  { id: "use", label: "Use", question: "What is used, and what is dead weight?" },
  { id: "problems", label: "Problems", question: "What is wrong or duplicated?" },
];

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
export const OUTDATED_LINKS = ["superseded_by", "contradicted_by"];

export interface Overview {
  count: number;
  ref: string[];
  path: (i: number) => string;
  types: string[];
  type: number[];
  family: Uint8Array;
  bundles: string[];
  bundle: number[];
  shows: number[];
  /** When each asset's file was last changed (ISO), or null. */
  modified: Array<string | null>;
  /** Positive and negative feedback each asset has had in the window. */
  positive: number[];
  negative: number[];
  tagNames: string[];
  /** Each asset's tags, as indexes into `tagNames`. */
  tags: number[][];
  use: Array<UseClass | null>;
  problems: Array<Problem[]>;
  /** Each declared link: from asset, to asset, and its kind's name. */
  links: Array<{ from: number; to: number; kind: string }>;
  /** Each asset's group by meaning (-1: no embedding) and its place in 3D, three numbers per asset. */
  group: Int32Array;
  place: Float32Array;
  groupCount: number;
  /** Duplicate pairs by asset index, most alike first. */
  duplicates: Array<{ a: number; b: number; cosine: number }>;
  duplicatesTruncated: boolean;
  duplicateThreshold: number;
  /** Whether the window's use is known (no usage history: every asset reads as not used). */
  useKnown: boolean;
  useSince: string | null;
  note: string;
}

export function useClass(lastShownAt: string | null, modifiedAt: string | null, now: number): UseClass {
  if (lastShownAt) return now - Date.parse(lastShownAt) <= RECENT_DAYS * DAY ? "recent" : "earlier";
  const edited = modifiedAt ? Date.parse(modifiedAt) : Number.NaN;
  // An asset whose edit time cannot be read is not called new.
  return now - edited <= OLD_DAYS * DAY ? "new" : "unread";
}

/** How far forward (+1) or back (-1) in its group an asset sits: recent use in front, never read and outdated behind. */
const DEPTH: Record<UseClass, number> = { recent: 1, earlier: 0.4, new: -0.7, unread: -0.7 };

/**
 * Each asset's place in 3D, three numbers per asset: akm's place by meaning, with the depth inside its group (z) set by
 * use and state, so what is read lately sits at the front of a group and what was never read in the window, or is
 * superseded, contradicted or deprecated, at the back. A fifth of the depth keeps akm's own z, so a group does not flatten into layers.
 */
function placeByUse(payload: OverviewPayload, use: Array<UseClass | null>, outdated: Uint8Array): Float32Array {
  const g = payload.groups;
  const n = payload.nodes.ref.length;
  const place = new Float32Array(n * 3);
  if (!g) return place;
  const sum = new Map<number, { n: number; z: number; r: number[] }>();
  for (let i = 0; i < n; i++) {
    place.set([g.x[i]!, g.y[i]!, g.z[i]!], i * 3);
    if (g.group[i]! < 0) continue;
    const s = sum.get(g.group[i]!) ?? { n: 0, z: 0, r: [0, 0, 0] };
    s.n++;
    s.z += g.z[i]!;
    s.r[0]! += g.x[i]!;
    s.r[1]! += g.y[i]!;
    sum.set(g.group[i]!, s);
  }
  const spread = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const s = sum.get(g.group[i]!);
    if (!s) continue;
    const d = Math.hypot(g.x[i]! - s.r[0]! / s.n, g.y[i]! - s.r[1]! / s.n, g.z[i]! - s.z / s.n);
    spread.set(g.group[i]!, (spread.get(g.group[i]!) ?? 0) + (d * d) / s.n);
  }
  for (let i = 0; i < n; i++) {
    const s = sum.get(g.group[i]!);
    if (!s) continue;
    const centre = s.z / s.n;
    const radius = Math.sqrt(spread.get(g.group[i]!)!) || 1;
    const depth = outdated[i] ? -1 : use[i] ? DEPTH[use[i]!] : 0;
    place[i * 3 + 2] = centre + radius * (0.8 * depth) + 0.2 * (g.z[i]! - centre);
  }
  return place;
}

export function buildOverview(payload: OverviewPayload, now = Date.now()): Overview {
  const n = payload.nodes.ref.length;
  const path = (i: number) => {
    const ref = payload.nodes.ref[i] ?? "";
    return ref.includes("//") ? ref.slice(ref.indexOf("//") + 2) : ref;
  };

  const useKnown = payload.use !== null;
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
    path,
    types: payload.types,
    type: payload.nodes.type,
    family: Uint8Array.from(payload.nodes.type, (t) => familyOf(payload.types[t] ?? "")),
    bundles: payload.bundles,
    bundle: payload.nodes.bundle,
    shows: payload.nodes.shows,
    modified: payload.nodes.modifiedAt ?? payload.nodes.ref.map(() => null),
    positive: payload.nodes.positive ?? payload.nodes.ref.map(() => 0),
    negative: payload.nodes.negative ?? payload.nodes.ref.map(() => 0),
    tagNames: payload.tags ?? [],
    tags: payload.nodes.tags ?? payload.nodes.ref.map(() => []),
    use,
    problems,
    links: payload.links.from.map((from, e) => ({
      from,
      to: payload.links.to[e]!,
      kind: payload.kinds[payload.links.kind[e]!] ?? "",
    })),
    group: payload.groups ? Int32Array.from(payload.groups.group) : new Int32Array(n).fill(-1),
    place: placeByUse(payload, use, outdated),
    groupCount: payload.groups?.count ?? 0,
    duplicates,
    duplicatesTruncated: payload.duplicates?.truncated ?? false,
    duplicateThreshold: payload.duplicates?.threshold ?? 0,
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

// ---- What a group of assets is, and how it relates to the rest ----

/** A duplicate pair by asset index. */
export type Pair = { a: number; b: number; cosine: number };

/** The questions the side column answers for a group of assets (a type, a tag, a bundle or the whole library). */
export interface GroupFacts {
  count: number;
  use: Record<UseClass, number>;
  /** Superseded, contradicted or deprecated, and still in the library. */
  outdated: number[];
  /** More negative feedback than positive. */
  disliked: number[];
  /** Near-duplicate pairs with both assets in the group. */
  duplicatesInside: Pair[];
  /** Near-duplicate pairs with one asset in the group and one outside it. */
  duplicatesOutside: Pair[];
  /** Assets of the group with a declared link to or from another asset. */
  linked: number;
  /** Links between the group and assets outside it. */
  linksOut: number;
  /** For each other bundle, how many near-duplicate pairs the group shares with it. */
  overlap: Array<{ bundle: string; pairs: number }>;
}

export function groupFacts(o: Overview, members: readonly number[]): GroupFacts {
  const inside = new Uint8Array(o.count);
  for (const i of members) inside[i] = 1;
  const linked = new Uint8Array(o.count);
  let linksOut = 0;
  for (const l of o.links) {
    if (inside[l.from]) linked[l.from] = 1;
    if (inside[l.to]) linked[l.to] = 1;
    if (inside[l.from] !== inside[l.to]) linksOut++;
  }
  const duplicatesInside: Pair[] = [];
  const duplicatesOutside: Pair[] = [];
  const overlap = new Map<number, number>();
  for (const d of o.duplicates) {
    if (inside[d.a] && inside[d.b]) duplicatesInside.push(d);
    else if (inside[d.a] || inside[d.b]) {
      duplicatesOutside.push(d);
      const mine = inside[d.a] ? d.a : d.b;
      const theirs = inside[d.a] ? d.b : d.a;
      if (o.bundle[theirs] !== o.bundle[mine])
        overlap.set(o.bundle[theirs]!, (overlap.get(o.bundle[theirs]!) ?? 0) + 1);
    }
  }
  return {
    count: members.length,
    use: tally(
      members,
      (i) => o.use[i] ?? null,
      USE_CLASSES.map((u) => u.id),
    ),
    outdated: members.filter((i) => o.problems[i]!.includes("outdated")),
    disliked: members.filter((i) => o.problems[i]!.includes("negative")),
    duplicatesInside,
    duplicatesOutside,
    linked: members.filter((i) => linked[i]).length,
    linksOut,
    overlap: [...overlap]
      .map(([b, pairs]) => ({ bundle: o.bundles[b]!, pairs }))
      .sort((x, y) => y.pairs - x.pairs || (x.bundle < y.bundle ? -1 : 1)),
  };
}

/** A group on the map related to the chosen one: how many links and near-duplicate pairs join them. */
export interface Relation {
  key: string;
  links: number;
  duplicates: number;
}

/**
 * The groups on the map joined to the one at `key` by declared links (either way; only of `linkKinds` when given) or
 * near-duplicate pairs, most joined first. An asset counts under each drawn tag it carries, or under its type when it carries none of them.
 */
export function relations(
  o: Overview,
  branches: readonly Branch[],
  key: string,
  linkKinds: readonly string[] | null = null,
): Relation[] {
  const groupsOf = new Map<number, string[]>();
  for (const b of branches) {
    const tagged = new Set<number>();
    for (const leaf of b.leaves)
      for (const i of leaf.members) {
        tagged.add(i);
        groupsOf.set(i, [...(groupsOf.get(i) ?? []), leaf.key]);
      }
    for (const i of b.members) if (!tagged.has(i)) groupsOf.set(i, [b.key]);
  }
  const chosen = branches.find((b) => b.key === key) ?? branches.flatMap((b) => b.leaves).find((l) => l.key === key);
  if (!chosen) return [];
  const inside = new Set(chosen.members);
  const found = new Map<string, Relation>();
  const add = (i: number, field: "links" | "duplicates") => {
    for (const k of groupsOf.get(i) ?? []) {
      if (k === key || (k.startsWith(`${key}:`) && key.indexOf(":") < 0)) continue;
      const r = found.get(k) ?? { key: k, links: 0, duplicates: 0 };
      r[field]++;
      found.set(k, r);
    }
  };
  for (const l of o.links) {
    if (linkKinds && !linkKinds.includes(l.kind)) continue;
    if (inside.has(l.from) && !inside.has(l.to)) add(l.to, "links");
    else if (inside.has(l.to) && !inside.has(l.from)) add(l.from, "links");
  }
  for (const d of o.duplicates) {
    if (inside.has(d.a) && !inside.has(d.b)) add(d.b, "duplicates");
    else if (inside.has(d.b) && !inside.has(d.a)) add(d.a, "duplicates");
  }
  return [...found.values()].sort(
    (x, y) => y.links + y.duplicates - (x.links + x.duplicates) || (x.key < y.key ? -1 : 1),
  );
}

/** The first problem of an asset (the one it is coloured by), or null. */
export const firstProblem = (o: Overview, i: number): Problem | null => o.problems[i]![0] ?? null;

// ---- The mind map ----

/**
 * Tags that name no subject, left off the map (an asset keeps them): filler words; words of akm's own layout (types,
 * folders, derived copies, ingested pages and sessions); the verbs skill names start with; years; web domains; and hashes.
 */
const NOT_SUBJECTS = new Set(
  (
    "a an and are as at be by for from in into is it of on or the to with without " +
    "agent agents article articles asset assets command commands derived fact facts instruction instructions knowledge " +
    "lesson lessons memory memories process raw reference references rule rules script scripts session sessions skill " +
    "skills task tasks template templates website wiki wikis workflow workflows " +
    "analyzing building conducting configuring creating detecting implementing performing using"
  ).split(" "),
);
const isSubject = (tag: string) =>
  tag.length > 1 && !NOT_SUBJECTS.has(tag) && !/^\d+$/.test(tag) && !/\.[a-z]{2,}$/.test(tag) && !isHash(tag);
/** A commit or content hash used as a tag: hex, with a digit. */
const isHash = (tag: string) => /^[0-9a-f]{6,}$/.test(tag) && /\d/.test(tag);

/** A tag under one asset type: the type's assets that carry it. */
export interface Leaf {
  key: string;
  label: string;
  members: number[];
}
/** An asset type, its assets, and the tags most of them carry. */
export interface Branch {
  key: string;
  family: number;
  label: string;
  members: number[];
  leaves: Leaf[];
  /** Its assets that carry none of the tags drawn. */
  untagged: number;
}

/**
 * The library as a mind map: one branch per asset type that has assets, largest first, and under each the tags its
 * assets carry most, up to `leaves` across the whole map (shared by the square root of each type's size, at least one
 * and at most ten each). An asset with several drawn tags is under each of them, as tags are. `only` maps just those
 * assets (the ones a replay's events touched). `rank` orders the tags (by default, how many assets carry them); a tag
 * it ranks at zero is not drawn.
 */
export function mindMap(
  o: Overview,
  leaves = 44,
  only?: Iterable<number>,
  rank: (members: number[]) => number = (members) => members.length,
): Branch[] {
  const byFamily = FAMILIES.map(() => [] as number[]);
  for (const i of only ?? o.ref.keys()) byFamily[o.family[i]!]!.push(i);
  const families = byFamily
    .map((members, family) => ({ family, members }))
    .filter((f) => f.members.length)
    .sort((x, y) => y.members.length - x.members.length);
  const weight = families.reduce((sum, f) => sum + Math.sqrt(f.members.length), 0);
  return families.map(({ family, members }) => {
    const carriers = new Map<number, number[]>();
    for (const i of members)
      for (const t of o.tags[i] ?? [])
        if (isSubject(o.tagNames[t] ?? "")) {
          if (!carriers.has(t)) carriers.set(t, []);
          carriers.get(t)!.push(i);
        }
    const budget = Math.max(1, Math.min(10, Math.round((leaves * Math.sqrt(members.length)) / weight)));
    const top = [...carriers]
      .filter(([, m]) => m.length >= 2 || members.length < 10)
      .map(([t, m]) => ({ t, m, r: rank(m) }))
      .filter((x) => x.r > 0)
      .sort((x, y) => y.r - x.r || y.m.length - x.m.length || (o.tagNames[x.t]! < o.tagNames[y.t]! ? -1 : 1))
      .slice(0, budget)
      .map((x) => [x.t, x.m] as const);
    const drawn = new Set(top.flatMap(([, m]) => m));
    return {
      key: `f${family}`,
      family,
      label: FAMILIES[family]!.label,
      members,
      leaves: top.map(([t, m]) => ({ key: `f${family}:${o.tagNames[t]}`, label: o.tagNames[t]!, members: m })),
      untagged: members.length - drawn.size,
    };
  });
}

// ---- Groups by meaning ----

export interface Group {
  key: string;
  id: number;
  /** Its two most particular tags, or its largest asset type when its assets carry none. */
  label: string;
  members: number[];
  /** The middle of its assets in 3D. */
  centre: [number, number, number];
}

/**
 * The groups by meaning among `scope`, largest first. A group is named by the tags its assets carry far more than the
 * rest of the scope does (count in the group times the log of how rare the tag is in the scope), so a tag every asset
 * carries names nothing; a third tag is added where two groups would share a name.
 */
export function groupsOf(o: Overview, scope: readonly number[]): Group[] {
  const members = Array.from({ length: o.groupCount }, () => [] as number[]);
  for (const i of scope) if (o.group[i]! >= 0) members[o.group[i]!]!.push(i);
  const everywhere = new Map<number, number>();
  for (const i of scope) for (const t of o.tags[i] ?? []) everywhere.set(t, (everywhere.get(t) ?? 0) + 1);
  const found = members
    .map((list, id) => {
      const here = new Map<number, number>();
      for (const i of list)
        for (const t of o.tags[i] ?? []) if (isSubject(o.tagNames[t] ?? "")) here.set(t, (here.get(t) ?? 0) + 1);
      const named = [...here]
        .filter(([, n]) => n >= Math.max(2, list.length * 0.05))
        .map(([t, n]) => ({ t, score: n * Math.log(scope.length / everywhere.get(t)!) }))
        .sort((x, y) => y.score - x.score || x.t - y.t)
        .slice(0, 3)
        .map((x) => o.tagNames[x.t]!);
      const types = tally(list, (i) => o.types[o.type[i]!]!, o.types);
      const largest = o.types.slice().sort((x, y) => types[y]! - types[x]!)[0] ?? "";
      const centre: [number, number, number] = [0, 0, 0];
      for (const i of list) for (let d = 0; d < 3; d++) centre[d]! += o.place[i * 3 + d]! / list.length;
      return { key: `g:${id}`, id, named, label: `${largest}, untagged`, members: list, centre };
    })
    .filter((g) => g.members.length)
    .sort((x, y) => y.members.length - x.members.length || x.id - y.id);
  // Two tags each; a third where two groups would otherwise share a name.
  const twice = new Map<string, number>();
  for (const g of found)
    if (g.named.length)
      twice.set(g.named.slice(0, 2).join(" · "), (twice.get(g.named.slice(0, 2).join(" · ")) ?? 0) + 1);
  return found.map(({ named, ...g }) => ({
    ...g,
    label: named.length ? named.slice(0, twice.get(named.slice(0, 2).join(" · "))! > 1 ? 3 : 2).join(" · ") : g.label,
  }));
}

/** The other groups the chosen one is joined to by declared links (of `linkKinds`, or any) and near-duplicates. */
export function groupJoins(o: Overview, id: number, linkKinds: readonly string[] | null = null): Relation[] {
  const counts = new Map<number, Relation>();
  const add = (a: number, b: number, what: "links" | "duplicates") => {
    const ga = o.group[a]!;
    const gb = o.group[b]!;
    if (ga < 0 || gb < 0 || ga === gb || (ga !== id && gb !== id)) return;
    const other = ga === id ? gb : ga;
    if (!counts.has(other)) counts.set(other, { key: `g:${other}`, links: 0, duplicates: 0 });
    counts.get(other)![what]++;
  };
  for (const l of o.links) if (!linkKinds || linkKinds.includes(l.kind)) add(l.from, l.to, "links");
  for (const d of o.duplicates) add(d.a, d.b, "duplicates");
  return [...counts.values()].sort(
    (x, y) => y.links + y.duplicates - (x.links + x.duplicates) || (x.key < y.key ? -1 : 1),
  );
}
