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

/** The categorical slot (0 to 7) a node is coloured with, or -1 for the use ramp. */
export function colourSlot(graph: LibraryGraph, i: number, by: Colouring): number {
  if (by === "family") return graph.family[i]!;
  if (by === "bundle") return Math.min(graph.bundle[i]!, OTHER);
  return -1;
}

// ---- Placement ----

/** Is this asset on the arrangement? By meaning an asset with no embedding has no position, so it is not drawn there. */
export const isPlaced = (graph: LibraryGraph, arrange: Arrangement, i: number) =>
  arrange === "bundle" || !graph.meaning || graph.placed[i] === 1;

/** The arrangement a map opens in: by meaning when there are positions, unless the asset to select has none. */
export function openingArrangement(graph: LibraryGraph, select = -1): Arrangement {
  if (!graph.meaning) return "bundle";
  return select >= 0 && !graph.placed[select] ? "bundle" : "meaning";
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
