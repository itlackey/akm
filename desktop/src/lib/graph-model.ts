// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The library graph `assets.graph` returns, made into the arrays the map draws, and the two ways to place it. */

export interface GraphPayload {
  available: boolean;
  note: string;
  types: string[];
  bundles: string[];
  kinds: string[];
  nodes: {
    ref: string[];
    title: string[];
    type: number[];
    bundle: number[];
    shows: number[];
    searches: number[];
    lastUsedAt: Array<string | null>;
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

export const LINK_LABELS: Record<string, string> = {
  links_to: "Link",
  xref: "Cross-reference",
  cites: "Citation",
  derived_from: "Derived from",
  uses: "Uses",
  belief_peer: "Related belief",
  superseded_by: "Superseded by",
  contradicted_by: "Contradicted by",
};
export const linkLabel = (kind: string) => LINK_LABELS[kind] ?? kind.replaceAll("_", " ");

export interface LibraryGraph {
  count: number;
  ref: string[];
  title: string[];
  /** The name the map labels a node with: its path inside the bundle. */
  name: (i: number) => string;
  type: Uint16Array;
  family: Uint8Array;
  bundle: Uint16Array;
  bundles: string[];
  types: string[];
  kinds: string[];
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
  index: Map<string, number>;
  /** Nodes that declare a `superseded_by` or `contradicted_by` link: the old or losing side of a belief. */
  outdated: Uint8Array;
}

export function buildGraph(payload: GraphPayload): LibraryGraph {
  const count = payload.nodes.ref.length;
  const type = Uint16Array.from(payload.nodes.type);
  const family = Uint8Array.from(type, (t) => familyOf(payload.types[t] ?? ""));
  const bundle = Uint16Array.from(payload.nodes.bundle);
  const shows = Uint32Array.from(payload.nodes.shows);
  const searches = Uint32Array.from(payload.nodes.searches);
  // Size grows with use, on a log scale, so a few heavily used assets do not swamp the rest. A small library spreads
  // its assets further apart (see bundleLayout), so its points are drawn larger in step.
  const spread = Math.min(3, Math.sqrt(30000 / Math.max(count, 2000)));
  const size = Float32Array.from(shows, (s, i) => (2.6 + 1.5 * Math.log2(1 + s + (searches[i] ?? 0) * 0.3)) * spread);
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
  const belief = new Set(["superseded_by", "contradicted_by"]);
  for (let e = 0; e < from.length; e++) {
    const a = from[e]!;
    const b = to[e]!;
    adj[fill[a]!] = b;
    adjLink[fill[a]!++] = e;
    adj[fill[b]!] = a;
    adjLink[fill[b]!++] = e;
    if (belief.has(payload.kinds[kind[e]!] ?? "")) outdated[a] = 1;
  }

  const { positions: byBundle, anchors: bundleAnchors } = bundleLayout(count, bundle, family, payload.bundles);
  return {
    count,
    ref: payload.nodes.ref,
    title: payload.nodes.title,
    name: (i) => {
      const ref = payload.nodes.ref[i] ?? "";
      return ref.includes("//") ? ref.slice(ref.indexOf("//") + 2) : ref;
    },
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
    index: new Map(payload.nodes.ref.map((ref, i) => [ref, i])),
    outdated,
  };
}

/**
 * A flat layout that needs no embeddings: one disc per bundle, its assets in a sunflower spiral sorted by colour family,
 * so families form rings. The largest bundle sits in the middle and the rest share a ring around it, each given arc in
 * proportion to its size.
 */
export function bundleLayout(count: number, bundle: Uint16Array, family: Uint8Array, names: string[]) {
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
    list.sort((p, q) => family[p]! - family[q]! || p - q);
    list.forEach((i, k) => {
      const radius = spacing * Math.sqrt(k + 0.5);
      const theta = k * 2.399963;
      positions.set([cx + Math.cos(theta) * radius, 0, cz + Math.sin(theta) * radius], i * 3);
    });
    anchors.push({ text: `${names[b]} · ${list.length}`, x: cx, y: 0, z: cz - radii[b]! - 20 });
  });
  return { positions, anchors };
}

/** Node pairs for the links whose kind is switched on. */
export function edgePairs(graph: LibraryGraph, enabled: (kind: number) => boolean): Uint32Array {
  const out = new Uint32Array(graph.from.length * 2);
  let n = 0;
  for (let e = 0; e < graph.from.length; e++)
    if (enabled(graph.kind[e]!)) {
      out[n++] = graph.from[e]!;
      out[n++] = graph.to[e]!;
    }
  return out.subarray(0, n);
}

/** One asset's links, grouped by kind and direction, in the order akm listed them. */
export function linksOf(graph: LibraryGraph, i: number) {
  const groups = new Map<string, { kind: string; outgoing: boolean; nodes: number[] }>();
  for (let a = graph.offsets[i]!; a < graph.offsets[i + 1]!; a++) {
    const e = graph.adjLink[a]!;
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
export function colourSlot(graph: LibraryGraph, i: number, by: "family" | "bundle" | "use"): number {
  if (by === "family") return graph.family[i]!;
  if (by === "bundle") return Math.min(graph.bundle[i]!, OTHER);
  return -1;
}
