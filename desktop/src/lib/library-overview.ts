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
const OUTDATED_LINKS = ["superseded_by", "contradicted_by"];

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
  tagNames: string[];
  /** Each asset's tags, as indexes into `tagNames`. */
  tags: number[][];
  use: Array<UseClass | null>;
  problems: Array<Problem[]>;
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

export function buildOverview(payload: OverviewPayload, now = Date.now()): Overview {
  const n = payload.nodes.ref.length;
  const path = (i: number) => {
    const ref = payload.nodes.ref[i] ?? "";
    return ref.includes("//") ? ref.slice(ref.indexOf("//") + 2) : ref;
  };

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
    path,
    types: payload.types,
    type: payload.nodes.type,
    family: Uint8Array.from(payload.nodes.type, (t) => familyOf(payload.types[t] ?? "")),
    bundles: payload.bundles,
    bundle: payload.nodes.bundle,
    shows: payload.nodes.shows,
    tagNames: payload.tags ?? [],
    tags: payload.nodes.tags ?? payload.nodes.ref.map(() => []),
    use,
    problems,
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
 * assets (the ones a replay's events touched).
 */
export function mindMap(o: Overview, leaves = 44, only?: Iterable<number>): Branch[] {
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
      .sort((x, y) => y[1].length - x[1].length || (o.tagNames[x[0]]! < o.tagNames[y[0]]! ? -1 : 1))
      .slice(0, budget);
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
