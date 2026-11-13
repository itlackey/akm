// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The library graph `assets.graph` returns, made into the arrays the map draws, and the two ways to place it. */

export interface GraphPayload {
  available: boolean;
  note: string;
  types: string[];
  /** Largest first, so the biggest bundles take the first colour slots. */
  bundles: string[];
  /** Distinct belief states present, e.g. "superseded"; `nodes.belief` indexes it (-1: none). */
  beliefs: string[];
  emptyBundles: string[];
  /** The window the use figures cover: reads by people and their agents since `since`, not scheduled tasks or Improve. */
  use: { since: string; source: "user" } | null;
  /** Declared links from a drawn asset that are not an edge (missing target, hidden type, bundle not enabled). */
  unresolvedLinks: number;
  kinds: string[];
  nodes: {
    ref: string[];
    title: string[];
    type: number[];
    bundle: number[];
    belief: number[];
    shows: number[];
    searches: number[];
  };
  links: { from: number[]; to: number[]; kind: number[] };
  meaning: { embedded: number; xyz: Array<number | null> } | null;
}

/**
 * Asset types fold into eight colour families: eight is the most a categorical palette separates. A type akm does not
 * list (a custom type) is Other.
 */
export const FAMILIES = [
  { label: "Knowledge", types: ["knowledge"] },
  { label: "Memories and facts", types: ["memory", "fact"] },
  { label: "Skills", types: ["skill"] },
  { label: "Lessons", types: ["lesson"] },
  { label: "Commands and scripts", types: ["command", "script"] },
  { label: "Workflows and tasks", types: ["workflow", "task"] },
  { label: "Agents, instructions, rules", types: ["agent", "instruction", "rule"] },
  { label: "Other", types: [] as string[] },
] as const;
const OTHER = FAMILIES.length - 1;
export const familyOf = (type: string) => {
  const at = FAMILIES.findIndex((family) => (family.types as readonly string[]).includes(type));
  return at === -1 ? OTHER : at;
};

export type Arrangement = "meaning" | "bundle";
export type Colouring = "family" | "bundle" | "use";
export type Lens = "" | "never" | "outdated";

/** Belief states that make an asset "outdated": the highlight's meaning, besides the links that say so. */
const OUTDATED_BELIEFS = ["superseded", "contradicted", "deprecated"];
const OUTDATED_LINKS = ["superseded_by", "contradicted_by"];

export interface LibraryGraph {
  count: number;
  ref: string[];
  title: string[];
  /** The name the map labels a node with: its path inside the bundle, and the bundle too when there is more than one. */
  name: (i: number) => string;
  /** An asset's path inside its bundle. */
  path: (i: number) => string;
  type: Uint16Array;
  family: Uint8Array;
  bundle: Uint16Array;
  bundles: string[];
  types: string[];
  kinds: string[];
  /** Times shown to an agent in the use window. Also what a point's size means (the renderer maps it to pixels). */
  shows: Uint32Array;
  searches: Uint32Array;
  size: Float32Array;
  /** Positions by meaning, or null when akm has none; `placed[i]` is 0 for an asset with no embedding. */
  meaning: Float32Array | null;
  placed: Uint8Array;
  byBundle: Float32Array;
  bundleAnchors: Array<{ text: string; x: number; y: number; z: number }>;
  /** Every link, as node pairs, and each link's kind. */
  from: Uint32Array;
  to: Uint32Array;
  kind: Uint16Array;
  /** Both directions of every link, in compressed rows: node i's links are `adj[offsets[i]]..adj[offsets[i+1]]`. */
  offsets: Uint32Array;
  adj: Uint32Array;
  adjLink: Uint32Array;
  /** How many distinct other assets each asset is linked with, in either direction. */
  linked: Uint32Array;
  index: Map<string, number>;
  /** Nodes with a superseded, contradicted or deprecated belief, or that declare a `superseded_by`/`contradicted_by` link. */
  outdated: Uint8Array;
  /** Declared links the payload could not draw as edges. */
  unresolvedLinks: number;
  /** The use window and the bundles that are enabled but hold nothing, as the payload gave them. */
  use: GraphPayload["use"];
  emptyBundles: string[];
  /** Bundles that hold at least one asset. */
  bundlesInUse: number;
  note: string;
}

export function buildGraph(payload: GraphPayload): LibraryGraph {
  const count = payload.nodes.ref.length;
  const type = Uint16Array.from(payload.nodes.type);
  const family = Uint8Array.from(type, (t) => familyOf(payload.types[t] ?? ""));
  const bundle = Uint16Array.from(payload.nodes.bundle);
  const shows = Uint32Array.from(payload.nodes.shows);
  const searches = Uint32Array.from(payload.nodes.searches);
  // Size means shows only; the renderer draws it area-proportional between its own pixel limits.
  const size = Float32Array.from(shows);
  const from = Uint32Array.from(payload.links.from);
  const to = Uint32Array.from(payload.links.to);
  const kind = Uint16Array.from(payload.links.kind);

  let meaning: Float32Array | null = null;
  const placed = new Uint8Array(count);
  if (payload.meaning && payload.meaning.xyz.length === count * 3) {
    meaning = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const [x, y, z] = payload.meaning.xyz.slice(i * 3, i * 3 + 3);
      if (x === null || y === null || z === null || x === undefined || y === undefined || z === undefined) continue;
      placed[i] = 1;
      meaning.set([x, y, z], i * 3);
    }
  }

  const offsets = new Uint32Array(count + 1);
  for (let e = 0; e < from.length; e++) {
    offsets[from[e]! + 1]!++;
    offsets[to[e]! + 1]!++;
  }
  for (let i = 0; i < count; i++) offsets[i + 1]! += offsets[i]!;
  const fill = offsets.slice(0, count);
  const adj = new Uint32Array(from.length * 2);
  const adjLink = new Uint32Array(from.length * 2);
  const outdated = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const state = payload.beliefs[payload.nodes.belief[i] ?? -1] ?? "";
    if (OUTDATED_BELIEFS.includes(state)) outdated[i] = 1;
  }
  for (let e = 0; e < from.length; e++) {
    const a = from[e]!;
    const b = to[e]!;
    adj[fill[a]!] = b;
    adjLink[fill[a]!++] = e;
    adj[fill[b]!] = a;
    adjLink[fill[b]!++] = e;
    if (OUTDATED_LINKS.includes(payload.kinds[kind[e]!] ?? "")) outdated[a] = 1;
  }
  // Distinct neighbours: stamp each neighbour with the row's asset, so a pair linked twice (or both ways) counts once.
  const linked = new Uint32Array(count);
  const stamp = new Int32Array(count).fill(-1);
  for (let i = 0; i < count; i++)
    for (let a = offsets[i]!; a < offsets[i + 1]!; a++) {
      const n = adj[a]!;
      if (n === i || stamp[n] === i) continue;
      stamp[n] = i;
      linked[i]!++;
    }

  const { positions: byBundle, anchors: bundleAnchors } = bundleLayout(
    count,
    bundle,
    family,
    payload.bundles,
    payload.nodes.ref,
  );
  const bundlesInUse = new Set(bundle).size;
  const pathOf = (i: number) => {
    const ref = payload.nodes.ref[i] ?? "";
    return ref.includes("//") ? ref.slice(ref.indexOf("//") + 2) : ref;
  };
  return {
    count,
    ref: payload.nodes.ref,
    title: payload.nodes.title,
    path: pathOf,
    // The bundle is part of the label as soon as there is more than one, because the same path can exist in each.
    name: (i) => (bundlesInUse > 1 ? `${payload.bundles[bundle[i]!] ?? ""}/${pathOf(i)}` : pathOf(i)),
    type,
    family,
    bundle,
    bundles: payload.bundles,
    types: payload.types,
    kinds: payload.kinds,
    shows,
    searches,
    size,
    meaning,
    placed,
    byBundle,
    bundleAnchors,
    from,
    to,
    kind,
    offsets,
    adj,
    adjLink,
    linked,
    index: new Map(payload.nodes.ref.map((ref, i) => [ref, i])),
    outdated,
    unresolvedLinks: payload.unresolvedLinks,
    use: payload.use,
    emptyBundles: payload.emptyBundles,
    bundlesInUse,
    note: payload.note,
  };
}

/**
 * A flat layout that needs no embeddings: one disc per bundle, its assets in a sunflower spiral sorted by colour family
 * and then by ref (so the files of one folder sit together), so families form rings. The largest bundle sits in the
 * middle and the rest share a ring around it, each given arc in proportion to its size.
 */
export function bundleLayout(count: number, bundle: Uint16Array, family: Uint8Array, names: string[], ref: string[]) {
  const positions = new Float32Array(count * 3);
  const members: number[][] = names.map(() => []);
  for (let i = 0; i < count; i++) members[bundle[i]!]?.push(i);
  const spacing = 5.5 * Math.sqrt(30000 / Math.max(count, 2000));
  const radii = members.map((list) => spacing * Math.sqrt(list.length) + 30);
  const order = names.map((_, b) => b).sort((p, q) => radii[q]! - radii[p]!);
  const outer = order.slice(1);
  const arc = outer.reduce((sum, b) => sum + radii[b]!, 0);
  const ring = outer.length ? Math.max(radii[order[0]!]! + radii[outer[0]!]! + 40, arc / Math.PI) : 0;
  let angle = -Math.PI / 2;
  const anchors: Array<{ text: string; x: number; y: number; z: number }> = [];
  order.forEach((b, rank) => {
    const list = members[b] ?? [];
    const half = rank && arc ? (Math.PI * radii[b]!) / arc : 0;
    angle += half;
    const cx = rank ? Math.cos(angle) * ring : 0;
    const cz = rank ? Math.sin(angle) * ring : 0;
    angle += half;
    list.sort((p, q) => family[p]! - family[q]! || (ref[p]! < ref[q]! ? -1 : ref[p]! > ref[q]! ? 1 : p - q));
    list.forEach((i, k) => {
      const radius = spacing * Math.sqrt(k + 0.5);
      const theta = k * 2.399963;
      positions.set([cx + Math.cos(theta) * radius, 0, cz + Math.sin(theta) * radius], i * 3);
    });
    anchors.push({ text: `${names[b]} · ${list.length}`, x: cx, y: 0, z: cz - radii[b]! - 20 });
  });
  return { positions, anchors };
}

/** Node pairs for the links whose kind is switched on, one per pair of assets: A to B and B to A make one line. */
export function edgePairs(graph: LibraryGraph, enabled: (kind: number) => boolean): Uint32Array {
  const out = new Uint32Array(graph.from.length * 2);
  const seen = new Set<number>();
  let n = 0;
  for (let e = 0; e < graph.from.length; e++) {
    if (!enabled(graph.kind[e]!)) continue;
    const a = graph.from[e]!;
    const b = graph.to[e]!;
    const key = Math.min(a, b) * graph.count + Math.max(a, b);
    if (seen.has(key)) continue;
    seen.add(key);
    out[n++] = a;
    out[n++] = b;
  }
  return out.subarray(0, n);
}

/** One asset's links, grouped by kind and direction, in the order akm listed them; kinds in `off` are left out. */
export function linksOf(graph: LibraryGraph, i: number, off: readonly number[] = []) {
  const groups = new Map<string, { kind: string; outgoing: boolean; nodes: number[] }>();
  for (let a = graph.offsets[i]!; a < graph.offsets[i + 1]!; a++) {
    const e = graph.adjLink[a]!;
    if (off.includes(graph.kind[e]!)) continue;
    const kind = graph.kinds[graph.kind[e]!] ?? "";
    const outgoing = graph.from[e] === i;
    const key = `${outgoing ? "out" : "in"}:${kind}`;
    const group = groups.get(key) ?? { kind, outgoing, nodes: [] };
    group.nodes.push(graph.adj[a]!);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** The categorical slot (0 to 7) a node is coloured with, or -1 for the use ramp. */
export function colourSlot(graph: LibraryGraph, i: number, by: Colouring): number {
  if (by === "family") return graph.family[i]!;
  if (by === "bundle") return Math.min(graph.bundle[i]!, OTHER);
  return -1;
}

// ---- Placement, filters and counts: the one place that decides what is drawn, listed and counted. ----

/** Is this asset on the arrangement? By meaning an asset with no embedding has no position, so it is not drawn there. */
export const isPlaced = (graph: LibraryGraph, arrange: Arrangement, i: number) =>
  arrange === "bundle" || !graph.meaning || graph.placed[i] === 1;

/** The arrangement a map opens in: by meaning when there are positions, unless the asset to select has none. */
export function openingArrangement(graph: LibraryGraph, select = -1): Arrangement {
  if (!graph.meaning) return "bundle";
  return select >= 0 && !graph.placed[select] ? "bundle" : "meaning";
}

export interface Filters {
  arrange: Arrangement;
  colourBy: Colouring;
  lens: Lens;
  query: string;
  /** Colour slots switched off in the legend. They apply to the colour-by-type and by-bundle views only. */
  hidden: readonly number[];
}
export const LENS_LABELS: Record<Exclude<Lens, "">, string> = {
  never: "Never shown",
  outdated: "Superseded, contradicted or deprecated",
};

const inHiddenGroup = (graph: LibraryGraph, f: Filters, i: number) =>
  f.colourBy !== "use" && f.hidden.includes(colourSlot(graph, i, f.colourBy));
const lensMatches = (graph: LibraryGraph, lens: Lens, i: number) =>
  lens === "never" ? !graph.shows[i] : lens === "outdated" ? graph.outdated[i] === 1 : true;
const queryMatches = (graph: LibraryGraph, q: string, i: number) =>
  !q || graph.ref[i]!.toLowerCase().includes(q) || graph.title[i]!.toLowerCase().includes(q);
const narrows = (f: Filters) => !!f.query.trim() || !!f.lens;

/**
 * The assets the table, the count and the side list use: the whole library, narrowed only by the search, the highlight
 * and hidden groups (never by placement), most shown first.
 */
export function listed(graph: LibraryGraph, f: Filters): number[] {
  const q = f.query.trim().toLowerCase();
  const out: number[] = [];
  for (let i = 0; i < graph.count; i++)
    if (!inHiddenGroup(graph, f, i) && lensMatches(graph, f.lens, i) && queryMatches(graph, q, i)) out.push(i);
  return out.sort((a, b) => graph.shows[b]! - graph.shows[a]! || graph.searches[b]! - graph.searches[a]! || a - b);
}

/**
 * The renderer state of every asset: 3 hidden (not on the arrangement, or in a hidden group), 2 emphasised (the search or
 * highlight matches, or the selection), 1 normal, 0 dimmed. With a selection and no search or highlight, only the
 * selection and the neighbours it reaches through link kinds that are on stay normal.
 */
export function drawState(graph: LibraryGraph, f: Filters, selected: number, kindsOff: readonly number[]): Uint8Array {
  const state = new Uint8Array(graph.count);
  const q = f.query.trim().toLowerCase();
  const narrowing = narrows(f);
  const neighbours = new Set<number>();
  const pick = selected >= 0 && isPlaced(graph, f.arrange, selected);
  if (pick && !narrowing)
    for (const group of linksOf(graph, selected, kindsOff)) for (const n of group.nodes) neighbours.add(n);
  for (let i = 0; i < graph.count; i++) {
    if (!isPlaced(graph, f.arrange, i) || inHiddenGroup(graph, f, i)) {
      state[i] = 3;
      continue;
    }
    if (!lensMatches(graph, f.lens, i) || !queryMatches(graph, q, i)) continue;
    if (pick && !narrowing && i !== selected && !neighbours.has(i)) continue;
    state[i] = narrowing ? 2 : 1;
  }
  if (pick && state[selected] !== 3) state[selected] = 2;
  return state;
}

/** Why an asset cannot be shown on the map right now, or null when it can. */
export function offMapReason(graph: LibraryGraph, f: Filters, i: number): string | null {
  if (!isPlaced(graph, f.arrange, i)) return "Not placed: it has no position by meaning. Arrange by bundle to see it.";
  if (inHiddenGroup(graph, f, i)) return "In a hidden group: show the group in the legend first.";
  return null;
}

export interface CountSummary {
  shown: number;
  total: number;
  /** Assets in groups hidden in the legend. */
  hidden: number;
  /** Matching assets with no position on this arrangement: listed, not drawn. */
  notPlaced: number;
  narrowed: boolean;
  text: string;
}
/** "N of M assets" and every narrowing next to it. M is always the whole library. */
export function countSummary(graph: LibraryGraph, f: Filters, matches: readonly number[]): CountSummary {
  let hidden = 0;
  for (let i = 0; i < graph.count; i++) if (inHiddenGroup(graph, f, i)) hidden++;
  const notPlaced = matches.filter((i) => !isPlaced(graph, f.arrange, i)).length;
  const narrowed = narrows(f) || hidden > 0;
  const parts = [`${matches.length} of ${graph.count} assets`];
  if (narrows(f) && f.query.trim()) parts.push(`matching “${f.query.trim()}”`);
  if (f.lens) parts.push(LENS_LABELS[f.lens].toLowerCase());
  if (hidden) parts.push(`${hidden} hidden`);
  if (notPlaced) parts.push(`${notPlaced} not placed`);
  return { shown: matches.length, total: graph.count, hidden, notPlaced, narrowed, text: parts.join(" · ") };
}

/** How many assets the highlight marks (the legend row's number). */
export function highlightCount(graph: LibraryGraph, lens: Lens): number {
  let n = 0;
  for (let i = 0; i < graph.count; i++) if (lens && lensMatches(graph, lens, i)) n++;
  return n;
}

/** What the side list shows: a title for what it lists, the assets, and what to say when there are none. */
export function sideList(graph: LibraryGraph, f: Filters, matches: readonly number[], sinceText: string) {
  const limit = 8;
  if (f.lens) return { title: LENS_LABELS[f.lens], items: matches.slice(0, limit), empty: "No assets." };
  if (f.query.trim()) return { title: "Matching assets", items: matches.slice(0, limit), empty: "No assets match." };
  const used = matches.filter((i) => graph.shows[i]! > 0);
  return {
    title: "Most shown",
    items: used.slice(0, limit),
    empty: `No asset has been shown since ${sinceText}.`,
  };
}

/** The legend rows of the colour-by-type and by-bundle views: slot, label and how many assets, over the whole library. */
export function legendRows(graph: LibraryGraph, by: Exclude<Colouring, "use">) {
  const counts = new Array(8).fill(0);
  for (let i = 0; i < graph.count; i++) counts[colourSlot(graph, i, by)]++;
  const labels =
    by === "family"
      ? FAMILIES.map((family) => family.label)
      : [...graph.bundles.slice(0, 7), graph.bundles.length > 8 ? "Other bundles" : (graph.bundles[7] ?? "")];
  return labels.map((label, slot) => ({ label, slot, count: counts[slot] as number })).filter((row) => row.count);
}

// ---- Use colouring ----

/** Used assets fall in this many steps, each with a colour of its own; never shown has one more, the quietest. */
export const USE_STEPS = 4;
export interface UseStep {
  /** The fewest shows in this step. */
  from: number;
  /** The most shows in this step, or null for the last one. */
  to: number | null;
  count: number;
  label: string;
}
/**
 * Steps for the "Use" colouring. Step 1 starts at one show; steps 2 to 4 start at the 25th, 50th and 75th percentile of the
 * non-zero show counts (nearest rank), each at least one above the step before. A step that would start above the largest
 * count is left out. The legend prints these bounds.
 */
export function useSteps(shows: ArrayLike<number>) {
  const used: number[] = [];
  for (let i = 0; i < shows.length; i++) if (shows[i]! > 0) used.push(shows[i]!);
  used.sort((a, b) => a - b);
  const max = used.at(-1) ?? 0;
  const lows: number[] = [];
  if (max > 0) {
    lows.push(1);
    for (let k = 1; k < USE_STEPS; k++) {
      const low = Math.max(lows[k - 1]! + 1, used[Math.floor((k * used.length) / USE_STEPS)]!);
      if (low > max) break;
      lows.push(low);
    }
  }
  /** 0 for never shown, else 1 to `steps.length`. */
  const stepOf = (value: number) => {
    if (!(value > 0)) return 0;
    let step = 0;
    while (step < lows.length && value >= lows[step]!) step++;
    return step;
  };
  const steps: UseStep[] = lows.map((from, k) => {
    const to = k + 1 < lows.length ? lows[k + 1]! - 1 : null;
    return { from, to, count: 0, label: to === null ? `${from}+` : to === from ? `${from}` : `${from}–${to}` };
  });
  for (const value of used) steps[stepOf(value) - 1]!.count++;
  return { steps, stepOf };
}

/** Show counts for the size key: none shown, a quarter of the largest, the largest (fewer when they coincide). */
export function sizeKey(maxShows: number): number[] {
  if (!(maxShows > 0)) return [0];
  return [...new Set([0, Math.max(1, Math.round(maxShows / 4)), maxShows])];
}

/** The colour tokens the map paints with, in the order `markOf` indexes them. */
export const PALETTE_TOKENS = [
  "--map-1",
  "--map-2",
  "--map-3",
  "--map-4",
  "--map-5",
  "--map-6",
  "--map-7",
  "--map-8",
  "--map-highlight",
  "--use-0",
  "--use-1",
  "--use-2",
  "--use-3",
  "--use-4",
] as const;
export const MARK_HIGHLIGHT = 8;
export const MARK_USE = 9;
/** Which of `PALETTE_TOKENS` an asset is painted with: the highlight if it is marked, else its group or use step. */
export function markOf(graph: LibraryGraph, i: number, f: Pick<Filters, "colourBy" | "lens">, stepOf: (v: number) => number) {
  if (f.lens && lensMatches(graph, f.lens, i)) return MARK_HIGHLIGHT;
  const slot = colourSlot(graph, i, f.colourBy);
  return slot >= 0 ? slot : MARK_USE + stepOf(graph.shows[i]!);
}

// ---- Words ----

const times = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** "Shown 3 times, in 12 searches": what a tooltip and the selection panel say about use. */
export const useLine = (shows: number, searches: number) =>
  `Shown ${times(shows, "time", "times")}, in ${times(searches, "search", "searches")}`;
export const useWindowText = (since: string) =>
  `Reads by you and your agents since ${since}; scheduled tasks and Improve are not counted.`;

/** What the hint under the map says: the gestures that work in this mode and with this input. */
export function mapHint(flat: boolean, touch: boolean): string {
  if (touch) return flat ? "Drag to pan · Pinch to zoom · Tap an asset" : "Drag to turn · Pinch to zoom · Tap an asset";
  return `${flat ? "Drag to pan" : "Drag to turn · Shift-drag to pan"} · Scroll to zoom · Click an asset · Keys: arrows move, + − zoom, [ ] step, Enter selects, Esc clears`;
}

/** Links lines drawn at full strength: faint on the bundle arrangement until an asset is selected. */
export const EDGE_FAINT = 0.2;
export const edgeStrength = (arrange: Arrangement, selected: number) =>
  arrange === "bundle" && selected < 0 ? EDGE_FAINT : 1;

/** A tooltip's top-left corner for a pointer at (x, y): beside it, flipped or clamped to stay inside the stage. */
export function placeTip(
  at: { x: number; y: number },
  tip: { w: number; h: number },
  stage: { w: number; h: number },
  gap = 14,
) {
  let x = at.x + gap;
  let y = at.y + gap;
  if (x + tip.w > stage.w) x = at.x - gap - tip.w;
  if (y + tip.h > stage.h) y = at.y - gap - tip.h;
  return { x: Math.max(0, Math.min(x, stage.w - tip.w)), y: Math.max(0, Math.min(y, stage.h - tip.h)) };
}

// ---- Link counts ----

/** Distinct linked pairs drawn, and the declared links behind them, for the links whose kind is on and whose ends are drawn. */
export function linkSummary(graph: LibraryGraph, state: Uint8Array, kindsOff: readonly number[]) {
  const seen = new Set<number>();
  let declared = 0;
  for (let e = 0; e < graph.from.length; e++) {
    const a = graph.from[e]!;
    const b = graph.to[e]!;
    if (kindsOff.includes(graph.kind[e]!) || state[a] === 3 || state[b] === 3) continue;
    declared++;
    seen.add(Math.min(a, b) * graph.count + Math.max(a, b));
  }
  return { pairs: seen.size, declared };
}

// ---- The table ----

export const PAGE_SIZE = 100;
export type TableKey = "ref" | "type" | "bundle" | "shows" | "links";
export type SortDirection = "ascending" | "descending";
/** Rows in a table column's order; ties fall back to ref. */
export function sortRows(graph: LibraryGraph, rows: readonly number[], key: TableKey, direction: SortDirection) {
  const sign = direction === "ascending" ? 1 : -1;
  const text = (i: number) =>
    key === "type" ? (graph.types[graph.type[i]!] ?? "") : key === "bundle" ? (graph.bundles[graph.bundle[i]!] ?? "") : "";
  const number = (i: number) => (key === "shows" ? graph.shows[i]! : graph.linked[i]!);
  const refOrder = (a: number, b: number) => (graph.ref[a]! < graph.ref[b]! ? -1 : graph.ref[a]! > graph.ref[b]! ? 1 : 0);
  return [...rows].sort((a, b) => {
    let by = 0;
    if (key === "shows" || key === "links") by = number(a) - number(b);
    else if (key === "ref") by = refOrder(a, b);
    else by = text(a) < text(b) ? -1 : text(a) > text(b) ? 1 : 0;
    return sign * by || refOrder(a, b);
  });
}
/** The page `page` (from 0, clamped) of `total` rows: its first and last row numbers (from 1) and how many pages there are. */
export function pageOf(total: number, page: number, size = PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(total / size));
  const at = Math.min(Math.max(0, page), pages - 1);
  return { page: at, pages, start: at * size, end: Math.min(total, (at + 1) * size), label: total ? `Rows ${at * size + 1}–${Math.min(total, (at + 1) * size)} of ${total}` : "No rows" };
}
