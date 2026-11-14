// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The local graph: one asset in the middle, the assets it links to and that link to it, and (dashed) the assets whose
// stored embeddings are nearest to it. Clicking an asset expands its neighbours in place; "Centre here" starts again
// from it. The layout is a live force simulation, small enough to run on the main thread.

import { Deck, LinearInterpolator, OrbitView } from "@deck.gl/core";
import { PathStyleExtension } from "@deck.gl/extensions";
import { PathLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import { forceCenter, forceLink, forceManyBody, forceSimulation } from "d3-force-3d";

const dark = matchMedia("(prefers-color-scheme: dark)").matches;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = (id) => document.getElementById(id);

const PALETTE = dark
  ? [
      [96, 165, 250],
      [248, 113, 113],
      [251, 191, 36],
      [52, 211, 153],
      [192, 132, 252],
      [34, 211, 238],
      [251, 146, 60],
      [163, 163, 175],
    ]
  : [
      [37, 99, 235],
      [220, 38, 38],
      [217, 119, 6],
      [5, 150, 105],
      [147, 51, 234],
      [8, 145, 178],
      [234, 88, 12],
      [113, 113, 122],
    ];
const INK = dark ? [236, 236, 241] : [27, 27, 31];
const PAPER = dark ? [17, 17, 20, 230] : [247, 247, 245, 230];
/** Most declared neighbours added by one expansion (the best-linked first); the rest stay counted as +N. */
const EXPAND_MAX = 24;
/** Similar assets added per expansion, and the least cosine shown. */
const SIMILAR_MAX = 6;
const SIMILAR_MIN = 0.6;

// ---- Library data: every asset and declared link, from the graph dump ----
const g = await (await fetch("/graph.json")).json();
const N = g.nodes.ref.length;
const at = new Map(g.nodes.ref.map((ref, i) => [ref, i]));
const adjacency = Array.from({ length: N }, () => []);
for (let e = 0; e < g.links.from.length; e++) {
  adjacency[g.links.from[e]].push(e);
  adjacency[g.links.to[e]].push(e);
}
const other = (e, i) => (g.links.from[e] === i ? g.links.to[e] : g.links.from[e]);
const degree = (i) => adjacency[i].length;
const name = (i) => {
  const ref = g.nodes.ref[i];
  return ref.includes("//") ? ref.slice(ref.indexOf("//") + 2) : ref;
};
const colourOf = (i) => PALETTE[Math.min(g.nodes.type[i], PALETTE.length - 1)];

// ---- The graph on screen ----
/** Shown assets by library index: { i, x, y, z, hop, expanded }. */
const shown = new Map();
/** Shown edges by key: { key, source, target, similar, kind, cosine }. */
const edges = new Map();
const similarCache = new Map();
let focus = -1;
let selected = -1;
let hovered = -1;
let showSimilar = true;
let three = true;

const edgeKey = (a, b, similar) => (similar ? `s:${Math.min(a, b)}:${Math.max(a, b)}` : `l:${a}:${b}`);
/** Declared neighbours of `i` that are not on screen. */
const hiddenCount = (i) => {
  let n = 0;
  const seen = new Set();
  for (const e of adjacency[i]) {
    const o = other(e, i);
    if (!seen.has(o) && !shown.has(o)) n++;
    seen.add(o);
  }
  return n;
};

async function similarTo(i) {
  if (!similarCache.has(i)) {
    const res = await fetch(`/api/related?ref=${encodeURIComponent(g.nodes.ref[i])}`).then((r) => r.json());
    similarCache.set(
      i,
      (res.matches ?? [])
        // An asset already joined to this one by a declared link is not repeated as similar.
        .filter(
          (m) => m.cosine >= SIMILAR_MIN && at.has(m.ref) && !adjacency[i].some((e) => other(e, i) === at.get(m.ref)),
        )
        .map((m) => ({ i: at.get(m.ref), cosine: m.cosine })),
    );
  }
  return similarCache.get(i);
}

function addNode(i, near, hop) {
  if (shown.has(i)) return;
  const jitter = () => (Math.random() - 0.5) * 20;
  const p = shown.get(near);
  shown.set(i, {
    i,
    x: (p?.x ?? 0) + jitter(),
    y: (p?.y ?? 0) + jitter(),
    z: three ? (p?.z ?? 0) + jitter() : 0,
    hop,
    expanded: false,
  });
}

/**
 * Adds up to EXPAND_MAX more of `i`'s declared neighbours (best-linked first) and, the first time, its nearest similar
 * assets. Expanding again adds the next batch.
 */
async function expand(i) {
  const node = shown.get(i);
  if (!node) return;
  const first = !node.expanded;
  node.expanded = true;
  const hop = node.hop + 1;
  const declared = [...new Set(adjacency[i])].sort((a, b) => degree(other(b, i)) - degree(other(a, i)));
  let added = 0;
  for (const e of declared) {
    const o = other(e, i);
    if (!shown.has(o)) {
      if (added >= EXPAND_MAX) continue;
      added++;
      addNode(o, i, hop);
    }
    const key = edgeKey(g.links.from[e], g.links.to[e], false);
    edges.set(key, {
      key,
      source: g.links.from[e],
      target: g.links.to[e],
      similar: false,
      kind: g.kinds[g.links.kind[e]],
    });
  }
  for (const m of first ? (await similarTo(i)).slice(0, SIMILAR_MAX) : []) {
    if (!shown.has(m.i)) addNode(m.i, i, hop);
    const key = edgeKey(i, m.i, true);
    if (!edges.has(key)) edges.set(key, { key, source: i, target: m.i, similar: true, cosine: m.cosine });
  }
  restart();
}

async function centre(i) {
  shown.clear();
  edges.clear();
  focus = i;
  selected = i;
  addNode(i, -1, 0);
  const n = shown.get(i);
  Object.assign(n, { fx: 0, fy: 0, fz: 0 });
  await expand(i);
  history.replaceState(null, "", `?ref=${encodeURIComponent(g.nodes.ref[i])}`);
  showDetail();
  fitSoon = true;
}

// ---- Layout ----
const sim = forceSimulation([], 3)
  .force(
    "link",
    forceLink([])
      .id((d) => d.i)
      .distance((e) => (e.similar ? 90 : 55))
      .strength((e) => (e.similar ? 0.25 : 0.7)),
  )
  .force("charge", forceManyBody().strength(-160).distanceMax(500))
  .force("center", forceCenter())
  .alphaDecay(0.035)
  // Stopped until the first asset is centred: a tick before the deck exists would have nothing to draw on.
  .stop()
  .on("tick", render)
  .on("end", () => {
    fitSoon = true;
    render();
  });

function visibleEdges() {
  return [...edges.values()].filter((e) => !e.similar || showSimilar);
}
function visibleNodes() {
  if (showSimilar) return [...shown.values()];
  // Without similar edges, an asset reached only by similarity has nothing joining it to the graph.
  const keep = new Set([focus]);
  for (const e of edges.values()) if (!e.similar) keep.add(e.source.i ?? e.source).add(e.target.i ?? e.target);
  return [...shown.values()].filter((n) => keep.has(n.i));
}
function restart() {
  const nodes = visibleNodes();
  const ids = new Set(nodes.map((n) => n.i));
  sim.nodes(nodes);
  sim
    .force("link")
    .links(visibleEdges().filter((e) => ids.has(e.source.i ?? e.source) && ids.has(e.target.i ?? e.target)));
  sim.alpha(0.9).restart();
  if (reduceMotion) {
    sim.stop();
    for (let k = 0; k < 300; k++) sim.tick();
    render();
  }
  updateCounts();
}
function setThree(on) {
  three = on;
  sim.numDimensions(on ? 3 : 2);
  for (const n of shown.values()) {
    if (!on) n.z = 0;
    else if (n.i !== focus) n.z = (Math.random() - 0.5) * 40;
  }
  setView({ ...viewState, rotationOrbit: 0, rotationX: on ? 15 : 0 }, 600);
  restart();
}

// ---- Camera ----
const view = new OrbitView({ id: "orbit", orbitAxis: "Y", fovy: 45, near: 0.05, far: 1e6 });
const fly = new LinearInterpolator(["target", "zoom", "rotationOrbit", "rotationX"]);
let viewState = { target: [0, 0, 0], zoom: 0, rotationOrbit: 0, rotationX: 15, minZoom: -8, maxZoom: 8 };
let fitSoon = false;
let flyingUntil = 0;
let lastInteraction = Number.NEGATIVE_INFINITY;
function setView(next, duration = 0) {
  const { transitionDuration, transitionInterpolator, ...plain } = next;
  if (!reduceMotion && duration) flyingUntil = performance.now() + duration;
  viewState =
    reduceMotion || !duration ? plain : { ...plain, transitionDuration: duration, transitionInterpolator: fly };
  deck.setProps({ viewState });
}
function fit() {
  const nodes = sim.nodes();
  if (!nodes.length) return;
  let r = 40;
  for (const n of nodes) r = Math.max(r, Math.hypot(n.x, n.y, n.z ?? 0));
  const { clientWidth: w, clientHeight: h } = $("deck");
  // Leave room for the panels either side.
  const zoom = Math.log2(Math.min(w - 640, h) / (2 * r * 1.15));
  setView({ ...viewState, target: [0, 0, 0], zoom }, 700);
}

// ---- Layers ----
const posOf = (n) => [n.x, n.y, n.z ?? 0];
const radiusOf = (n) => (n.i === focus ? 12 : 4 + 6 * Math.min(1, Math.sqrt(degree(n.i) / 30)));
const isNear = (e) => selected >= 0 && ((e.source.i ?? e.source) === selected || (e.target.i ?? e.target) === selected);

function layers() {
  const nodes = sim.nodes();
  const links = sim.force("link").links();
  const declared = links.filter((e) => !e.similar);
  const similar = links.filter((e) => e.similar);
  const lineColour = (e) => [...INK, isNear(e) ? 220 : 90];
  return [
    new PathLayer({
      id: "declared",
      data: declared,
      getPath: (e) => [posOf(e.source), posOf(e.target)],
      getColor: lineColour,
      getWidth: (e) => (isNear(e) ? 2.5 : 1.5),
      widthUnits: "pixels",
      billboard: true,
      capRounded: true,
      pickable: true,
      parameters: { depthWriteEnabled: false },
      updateTriggers: { getPath: tick, getColor: selected, getWidth: selected },
    }),
    new PathLayer({
      id: "similar",
      data: similar,
      getPath: (e) => [posOf(e.source), posOf(e.target)],
      getColor: lineColour,
      getWidth: (e) => (isNear(e) ? 2 : 1.5),
      widthUnits: "pixels",
      billboard: true,
      extensions: [new PathStyleExtension({ dash: true })],
      getDashArray: [4, 3],
      dashUnits: "pixels",
      pickable: true,
      parameters: { depthWriteEnabled: false },
      updateTriggers: { getPath: tick, getColor: selected, getWidth: selected },
    }),
    new ScatterplotLayer({
      id: "assets",
      data: nodes,
      getPosition: posOf,
      getFillColor: (n) => [...colourOf(n.i), 255],
      getRadius: radiusOf,
      radiusUnits: "pixels",
      billboard: true,
      antialiasing: true,
      pickable: true,
      autoHighlight: true,
      highlightColor: [...INK, 90],
      parameters: { depthWriteEnabled: true, depthCompare: "less-equal" },
      updateTriggers: { getPosition: tick, getRadius: focus },
      onHover: ({ object }) => {
        hovered = object?.i ?? -1;
        render();
      },
      onClick: async ({ object }) => {
        if (!object) return;
        selected = object.i;
        if (!shown.get(object.i).expanded) await expand(object.i);
        showDetail();
        render();
      },
    }),
    // A ring outside the point: the selection (solid, heavier) and every asset with links not shown yet.
    new ScatterplotLayer({
      id: "rings",
      data: nodes.filter((n) => n.i === selected || hiddenCount(n.i) > 0),
      getPosition: posOf,
      getRadius: (n) => radiusOf(n) + (n.i === selected ? 5 : 3.5),
      getLineColor: (n) => [...INK, n.i === selected ? 255 : 160],
      getLineWidth: (n) => (n.i === selected ? 2.5 : 1.25),
      lineWidthUnits: "pixels",
      radiusUnits: "pixels",
      stroked: true,
      filled: false,
      billboard: true,
      antialiasing: true,
      parameters: { depthWriteEnabled: false, depthCompare: "less-equal" },
      updateTriggers: {
        getPosition: tick,
        getRadius: [selected, focus],
        getLineColor: selected,
        getLineWidth: selected,
      },
    }),
    new TextLayer({
      id: "labels",
      data: labels,
      getPosition: (l) => posOf(l.n),
      getText: (l) => l.text,
      getSize: (l) => (l.n.i === focus ? 14 : 12),
      sizeUnits: "pixels",
      getColor: [...INK, 255],
      getPixelOffset: (l) => [radiusOf(l.n) + 6, 0],
      getTextAnchor: "start",
      getAlignmentBaseline: "center",
      background: true,
      getBackgroundColor: PAPER,
      backgroundPadding: [3, 1],
      fontFamily: "ui-sans-serif, system-ui, sans-serif",
      fontWeight: 500,
      characterSet: "auto",
      billboard: true,
      parameters: { depthCompare: "always", depthWriteEnabled: false },
      updateTriggers: { getPosition: tick },
    }),
  ];
}

// Every shown asset is a label candidate: the focus, the selection and the hovered first, then by hop and link count;
// a label is kept if its box is on screen, clear of the panels and of the labels already kept.
let labels = [];
function placeLabels() {
  if (!deck?.isInitialized) return;
  const viewport = deck.getViewports()[0];
  if (!viewport) return;
  const rank = (n) => (n.i === hovered ? -3 : n.i === selected ? -2 : n.i === focus ? -1 : n.hop * 1000 - degree(n.i));
  const order = [...sim.nodes()].sort((a, b) => rank(a) - rank(b));
  const panels = [...document.querySelectorAll(".panel:not([hidden])")].map((el) => el.getBoundingClientRect());
  const boxes = [];
  labels = [];
  for (const n of order) {
    const [x, y, z] = viewport.project(posOf(n));
    if (!(z > -1 && z < 1)) continue;
    const more = hiddenCount(n.i);
    const text = more ? `${name(n.i)}  +${more}` : name(n.i);
    const left = x + radiusOf(n) + 3;
    const box = [left, y - 9, left + text.length * 7 + 10, y + 9];
    const must = n.i === hovered || n.i === selected || n.i === focus;
    const clash = (b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1];
    if (!must && (box[2] > viewport.width || box[0] < 0 || box[1] < 0 || box[3] > viewport.height)) continue;
    if (!must && panels.some((r) => clash([r.left, r.top, r.right, r.bottom]))) continue;
    if (!must && boxes.some(clash)) continue;
    boxes.push(box);
    labels.push({ n, text });
  }
}

let tick = 0;
function render() {
  tick++;
  placeLabels();
  deck.setProps({ layers: layers() });
}

// ---- Detail panel ----
function button(text, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  b.onclick = onClick;
  return b;
}
async function showDetail() {
  const box = $("detail");
  box.hidden = selected < 0;
  if (selected < 0) return;
  const i = selected;
  const h = document.createElement("h1");
  h.textContent = g.nodes.title[i];
  const ref = document.createElement("p");
  ref.className = "muted";
  ref.textContent = `${g.nodes.ref[i]} · ${g.types[g.nodes.type[i]]}`;
  const actions = document.createElement("div");
  actions.className = "actions";
  if (i !== focus) actions.append(button("Centre here", () => centre(i)));
  if (hiddenCount(i))
    actions.append(
      button(`Show ${Math.min(EXPAND_MAX, hiddenCount(i))} more of ${hiddenCount(i)}`, async () => {
        await expand(i);
        showDetail();
      }),
    );
  box.replaceChildren(h, ref, actions);
  const groups = new Map();
  for (const e of adjacency[i]) {
    const out = g.links.from[e] === i;
    const key = `${out ? "Links to" : "Linked from"} (${g.kinds[g.links.kind[e]]})`;
    groups.set(key, [...(groups.get(key) ?? []), other(e, i)]);
  }
  const list = (title, items) => {
    const h2 = document.createElement("h2");
    h2.textContent = title;
    const ul = document.createElement("ul");
    for (const [n, note] of items.slice(0, 15)) {
      const li = document.createElement("li");
      li.append(button(note ? `${name(n)} · ${note}` : name(n), () => centre(n)));
      ul.append(li);
    }
    if (items.length > 15) {
      const li = document.createElement("li");
      li.textContent = `and ${items.length - 15} more`;
      ul.append(li);
    }
    box.append(h2, ul);
  };
  for (const [key, ns] of groups)
    list(
      `${key} · ${ns.length}`,
      ns.map((n) => [n]),
    );
  if (!adjacency[i].length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "No declared links.";
    box.append(p);
  }
  const sims = await similarTo(i);
  if (selected === i && sims.length)
    list(
      "Similar, not linked",
      sims.map((m) => [m.i, m.cosine.toFixed(2)]),
    );
}

// ---- Controls ----
$("find").addEventListener("input", (event) => {
  const q = event.target.value.trim().toLowerCase();
  const hits = [];
  if (q.length >= 2)
    for (let i = 0; i < N && hits.length < 8; i++)
      if (g.nodes.ref[i].toLowerCase().includes(q) || g.nodes.title[i].toLowerCase().includes(q)) hits.push(i);
  $("results").replaceChildren(
    ...hits.map((i) => {
      const li = document.createElement("li");
      li.append(button(name(i), () => centre(i)));
      return li;
    }),
  );
});
$("similar").addEventListener("change", (event) => {
  showSimilar = event.target.checked;
  restart();
});
$("three").addEventListener("change", (event) => setThree(event.target.checked));
$("reset").addEventListener("click", () => centre(focus));
addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    selected = -1;
    showDetail();
    render();
  }
});
function updateCounts() {
  const nodes = sim.nodes();
  const declared = sim
    .force("link")
    .links()
    .filter((e) => !e.similar).length;
  $("counts").textContent = `${nodes.length} of ${N.toLocaleString()} assets shown · ${declared} declared links · ${
    sim.force("link").links().length - declared
  } similar`;
}

// Examples: the best-linked asset, a typical one, and one from the akm-eval corpus (no declared links: similarity only).
const byDegree = Array.from({ length: N }, (_, i) => i).sort((a, b) => degree(b) - degree(a));
const examples = [
  byDegree[0],
  byDegree[Math.floor(N * 0.3)],
  g.nodes.ref.findIndex((r) => r.startsWith("akm-eval//skills/")),
].filter((i) => i >= 0);
$("examples").replaceChildren(...examples.map((i) => button(`${name(i)} · ${degree(i)} links`, () => centre(i))));
$("legend").replaceChildren(
  ...g.types.slice(0, PALETTE.length).map((type, t) => {
    const li = document.createElement("li");
    const dot = document.createElement("i");
    dot.style.background = `rgb(${PALETTE[t].join(",")})`;
    li.append(dot, type);
    return li;
  }),
);

// ---- Deck and frame loop ----
const deck = new Deck({
  parent: $("deck"),
  views: view,
  viewState,
  controller: { inertia: 250 },
  onViewStateChange: ({ viewState: next, interactionState }) => {
    if (interactionState.isDragging || interactionState.isZooming || interactionState.isPanning)
      lastInteraction = performance.now();
    viewState = next;
    deck.setProps({ viewState });
    labelsDue = true;
  },
  getTooltip: ({ layer, object }) => {
    if (!object || !layer) return null;
    if (layer.id === "assets") {
      const more = hiddenCount(object.i);
      return {
        text: `${g.nodes.title[object.i]}\n${degree(object.i)} links${more ? `, ${more} not shown: click to expand` : ""}`,
      };
    }
    const a = object.source.i;
    const b = object.target.i;
    return {
      text: object.similar
        ? `Similar, not linked · cosine ${object.cosine.toFixed(2)}`
        : `${name(a)} ${object.kind} ${name(b)}`,
    };
  },
});

let labelsDue = true;
let last = performance.now();
function loop(now) {
  const dt = Math.min(64, now - last);
  last = now;
  if (three && $("spin").checked && !reduceMotion && now - lastInteraction > 4000 && now > flyingUntil) {
    const { transitionDuration, transitionInterpolator, ...plain } = viewState;
    viewState = { ...plain, rotationOrbit: plain.rotationOrbit + dt * 0.006 };
    deck.setProps({ viewState });
    labelsDue = true;
  }
  if (fitSoon && deck.isInitialized) {
    fitSoon = false;
    fit();
  }
  if (labelsDue && deck.isInitialized) render();
  labelsDue = false;
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

const wanted = new URLSearchParams(location.search).get("ref");
await centre(at.get(wanted) ?? byDegree[Math.floor(N * 0.3)]);

// For the screenshot script.
window.local = {
  centre: (ref) => centre(at.get(ref) ?? Number(ref)),
  expandAll: async (hop) => {
    for (const n of [...shown.values()]) if (n.hop === hop) await expand(n.i);
  },
  setThree,
  setSimilar(on) {
    $("similar").checked = on;
    showSimilar = on;
    restart();
  },
  examples: examples.map((i) => g.nodes.ref[i]),
  get settled() {
    return sim.alpha() < sim.alphaMin();
  },
  get count() {
    return sim.nodes().length;
  },
  fit,
  deck,
  sim,
};
