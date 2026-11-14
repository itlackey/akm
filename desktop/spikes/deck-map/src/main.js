// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The library map on deck.gl: every asset of `assets.graph()` as a point in 3D, every declared link as a line, labels
// that keep out of each other's way, picking, a camera that flies to a selection, a force layout streamed from a worker,
// and simulated activity (pulses and ripples) to test several real-time animations at once.

import { Deck, LinearInterpolator, OrbitView } from "@deck.gl/core";
import { LineLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";

const dark = matchMedia("(prefers-color-scheme: dark)").matches;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = (id) => document.getElementById(id);

// Eight categorical colours, one per type family; the ninth is everything else.
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
const PAPER = dark ? [17, 17, 20, 220] : [247, 247, 245, 220];
const PULSE = [255, 214, 10];

// ---- Data ----
const g = await (await fetch("/graph.json")).json();
const N = g.nodes.ref.length;
const typeSlot = g.types.map((_, t) => Math.min(t, PALETTE.length - 1));
const pairs = new Uint32Array(g.links.from.length * 2);
for (let e = 0; e < g.links.from.length; e++) {
  pairs[e * 2] = g.links.from[e];
  pairs[e * 2 + 1] = g.links.to[e];
}
const E = g.links.from.length;
const degree = new Uint32Array(N);
const adjacency = Array.from({ length: N }, () => []);
for (let e = 0; e < E; e++) {
  const a = pairs[e * 2];
  const b = pairs[e * 2 + 1];
  degree[a]++;
  degree[b]++;
  adjacency[a].push(e);
  adjacency[b].push(e);
}
const maxDegree = Math.max(1, ...degree);
const name = (i) => {
  const ref = g.nodes.ref[i];
  return ref.includes("//") ? ref.slice(ref.indexOf("//") + 2) : ref;
};

// Position by meaning: the embeddings' projection. An asset with no embedding starts beside the assets it links to, or,
// linking nothing, on a shell outside the cloud, so it reads as not placed.
const seed = new Float32Array(N * 3);
const placed = new Uint8Array(N);
const xyz = g.meaning?.xyz ?? [];
let radius = 1;
for (let i = 0; i < N; i++) {
  if (xyz[i * 3] === null || xyz[i * 3] === undefined) continue;
  placed[i] = 1;
  seed.set([xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2]], i * 3);
  radius = Math.max(radius, Math.hypot(xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2]));
}
let rnd = 7;
const random = () => {
  rnd = (rnd * 1664525 + 1013904223) >>> 0;
  return rnd / 2 ** 32;
};
for (let i = 0; i < N; i++) {
  if (placed[i]) continue;
  const near = adjacency[i].map((e) => (pairs[e * 2] === i ? pairs[e * 2 + 1] : pairs[e * 2])).filter((n) => placed[n]);
  if (near.length) {
    for (const n of near) for (let a = 0; a < 3; a++) seed[i * 3 + a] += seed[n * 3 + a] / near.length;
    continue;
  }
  const u = random() * 2 - 1;
  const t = random() * Math.PI * 2;
  const s = Math.sqrt(1 - u * u);
  seed.set([Math.cos(t) * s * radius * 1.25, u * radius * 1.25, Math.sin(t) * s * radius * 1.25], i * 3);
}

// What is drawn: one position buffer the point, line, label and pulse layers all read.
let pos = Float32Array.from(seed);
let version = 0;
const colors = new Uint8Array(N * 4);
const radii = new Float32Array(N);
for (let i = 0; i < N; i++) {
  colors.set([...PALETTE[typeSlot[g.nodes.type[i]]], 230], i * 4);
  // Size by link count in the spike: the synthetic library has no usage events, so times shown is zero everywhere.
  radii[i] = 2 + 7 * Math.sqrt(degree[i] / maxDegree);
}
const edgeEnds = new Float32Array(E * 6);
function updateEdgeEnds() {
  for (let e = 0; e < E; e++) {
    const a = pairs[e * 2] * 3;
    const b = pairs[e * 2 + 1] * 3;
    edgeEnds[e * 6] = pos[a];
    edgeEnds[e * 6 + 1] = pos[a + 1];
    edgeEnds[e * 6 + 2] = pos[a + 2];
    edgeEnds[e * 6 + 3] = pos[b];
    edgeEnds[e * 6 + 4] = pos[b + 1];
    edgeEnds[e * 6 + 5] = pos[b + 2];
  }
}
updateEdgeEnds();

// Labels compete for room by link count; the collision pass keeps the winners apart on screen.
const labelPool = Array.from({ length: N }, (_, i) => i)
  .sort((a, b) => degree[b] - degree[a])
  .slice(0, 400);

// ---- State ----
let selected = -1;
let hovered = -1;
let neighbours = [];
let matches = [];
let animatePositions = false;
const pulses = [];
const ripples = [];
let activity = false;
let rate = 200;

// ---- Camera ----
const view = new OrbitView({ id: "orbit", orbitAxis: "Y", fovy: 45, near: 0.05, far: 1e6 });
const fly = new LinearInterpolator(["target", "zoom", "rotationOrbit", "rotationX"]);
function fitZoom(r) {
  const { clientWidth: w, clientHeight: h } = $("deck");
  return Math.log2(Math.min(w, h) / (2 * r * 1.15));
}
function boundingRadius(indices) {
  const c = [0, 0, 0];
  for (const i of indices) for (let a = 0; a < 3; a++) c[a] += pos[i * 3 + a] / indices.length;
  let r = 1;
  for (const i of indices) r = Math.max(r, Math.hypot(pos[i * 3] - c[0], pos[i * 3 + 1] - c[1], pos[i * 3 + 2] - c[2]));
  return { c, r };
}
const everyone = Array.from({ length: N }, (_, i) => i);
let viewState = { target: [0, 0, 0], zoom: 0, rotationOrbit: 30, rotationX: 15, minZoom: -10, maxZoom: 12 };
function fit(indices = everyone, duration = 700) {
  const { c, r } = boundingRadius(indices);
  setView({ ...viewState, target: c, zoom: fitZoom(r) }, duration);
}
let flyingUntil = 0;
function setView(next, duration = 0) {
  const { transitionDuration, transitionInterpolator, ...plain } = next;
  if (!reduceMotion && duration) flyingUntil = performance.now() + duration;
  viewState =
    reduceMotion || !duration ? plain : { ...plain, transitionDuration: duration, transitionInterpolator: fly };
  deck.setProps({ viewState });
}

// ---- Layers ----
const positionOf = (i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
const OPAQUE = { depthWriteEnabled: true, depthCompare: "less-equal" };
const TRANSLUCENT = { depthWriteEnabled: false, depthCompare: "less-equal" };

function layers() {
  const dim = selected >= 0 || matches.length > 0;
  const transition = animatePositions && !reduceMotion ? { duration: 900, easing: (t) => t * t * (3 - 2 * t) } : 0;
  const out = [
    new LineLayer({
      id: "links",
      // Accessors rather than binary attributes: deck.gl animates position changes only for attributes it computes.
      data: { length: E },
      getSourcePosition: (_, { index }) => edgeEnds.subarray(index * 6, index * 6 + 3),
      getTargetPosition: (_, { index }) => edgeEnds.subarray(index * 6 + 3, index * 6 + 6),
      getColor: dark ? [200, 200, 220, 34] : [60, 60, 80, 30],
      getWidth: 1,
      widthUnits: "pixels",
      opacity: dim ? 0.25 : 1,
      parameters: TRANSLUCENT,
      updateTriggers: { getSourcePosition: version, getTargetPosition: version },
      transitions: { getSourcePosition: transition, getTargetPosition: transition },
    }),
    new ScatterplotLayer({
      id: "assets",
      data: { length: N },
      getPosition: (_, { index }) => pos.subarray(index * 3, index * 3 + 3),
      getFillColor: (_, { index }) => colors.subarray(index * 4, index * 4 + 4),
      getRadius: (_, { index }) => radii[index],
      radiusUnits: "pixels",
      billboard: true,
      antialiasing: true,
      pickable: true,
      autoHighlight: true,
      highlightColor: [...INK, 255],
      opacity: dim ? 0.18 : 1,
      parameters: OPAQUE,
      updateTriggers: { getPosition: version },
      transitions: { getPosition: transition },
      onHover: ({ index }) => {
        hovered = index;
        render();
      },
      onClick: ({ index }) => select(index),
    }),
  ];

  // The selection: its links drawn strong, it and its neighbours drawn full and ringed, over the dimmed library.
  if (selected >= 0) {
    const ids = adjacency[selected];
    out.push(
      new LineLayer({
        id: "selection-links",
        data: ids,
        getSourcePosition: (e) => positionOf(pairs[e * 2]),
        getTargetPosition: (e) => positionOf(pairs[e * 2 + 1]),
        getColor: [...INK, 200],
        getWidth: 2,
        widthUnits: "pixels",
        parameters: TRANSLUCENT,
        updateTriggers: { getSourcePosition: version, getTargetPosition: version },
      }),
    );
  }
  const lit = selected >= 0 ? [selected, ...neighbours] : matches;
  if (lit.length)
    out.push(
      new ScatterplotLayer({
        id: "lit",
        data: lit,
        getPosition: positionOf,
        getFillColor: (i) => colors.subarray(i * 4, i * 4 + 4),
        getLineColor: [...INK, 255],
        getRadius: (i) => radii[i] + (i === selected ? 4 : 2),
        radiusUnits: "pixels",
        lineWidthUnits: "pixels",
        getLineWidth: (i) => (i === selected ? 2.5 : 1.5),
        stroked: true,
        billboard: true,
        pickable: true,
        parameters: OPAQUE,
        updateTriggers: { getPosition: version },
        onClick: ({ object }) => select(object),
      }),
    );

  // Real-time layers: pulses fly to an asset as it is used; a ripple spreads where one lands.
  if (pulses.length)
    out.push(
      new ScatterplotLayer({
        id: "pulses",
        data: pulses,
        getPosition: (p) => p.at,
        getFillColor: [...PULSE, 255],
        getRadius: 3,
        radiusUnits: "pixels",
        billboard: true,
        parameters: TRANSLUCENT,
        updateTriggers: { getPosition: frame },
      }),
    );
  if (ripples.length)
    out.push(
      new ScatterplotLayer({
        id: "ripples",
        data: ripples,
        getPosition: (r) => positionOf(r.i),
        getLineColor: (r) => [...PULSE, Math.round(255 * (1 - r.age))],
        getRadius: (r) => 4 + r.age * 22,
        radiusUnits: "pixels",
        lineWidthUnits: "pixels",
        getLineWidth: 1.5,
        stroked: true,
        filled: false,
        billboard: true,
        parameters: TRANSLUCENT,
        updateTriggers: { getLineColor: frame, getRadius: frame },
      }),
    );

  out.push(
    new TextLayer({
      id: "labels",
      data: labels,
      getPosition: (l) => positionOf(l.i),
      getText: (l) => l.text,
      getSize: (l) => (l.i === selected || l.i === hovered ? 13 : 11),
      sizeUnits: "pixels",
      getColor: [...INK, 255],
      getPixelOffset: (l) => [radii[l.i] + 6, 0],
      getTextAnchor: "start",
      getAlignmentBaseline: "center",
      background: true,
      getBackgroundColor: PAPER,
      backgroundPadding: [3, 1],
      fontFamily: "ui-sans-serif, system-ui, sans-serif",
      characterSet: "auto",
      billboard: true,
      parameters: { depthCompare: "always", depthWriteEnabled: false },
      updateTriggers: { getPosition: version, getSize: [hovered, selected] },
    }),
  );
  return out;
}

let frame = 0;
let labels = [];
function render() {
  placeLabels();
  deck.setProps({ layers: layers() });
}

// Labels are placed on the CPU: project the candidates, most important first, and keep each one whose box is on screen,
// clear of the panels and clear of the labels already kept. deck.gl's CollisionFilterExtension hid every label in this
// 3D view, so the spike does not use it.
const LABEL_MAX = 60;
function placeLabels() {
  // deck.gl asserts if asked for viewports before its first frame.
  if (!deck?.isInitialized) return;
  const viewport = deck.getViewports()[0];
  if (!viewport) return;
  const candidates = selected >= 0 ? [selected, ...neighbours] : matches.length ? matches : labelPool;
  const order = hovered >= 0 ? [hovered, ...candidates] : candidates;
  const panels = [...document.querySelectorAll(".panel:not([hidden])")].map((el) => el.getBoundingClientRect());
  const kept = [];
  const boxes = [];
  const seen = new Set();
  for (const i of order) {
    if (kept.length >= LABEL_MAX || seen.has(i)) continue;
    seen.add(i);
    const [x, y, z] = viewport.project(positionOf(i));
    if (!(z > -1 && z < 1)) continue;
    const text = name(i);
    const left = x + radii[i] + 3;
    const box = [left, y - 9, left + text.length * 6.4 + 10, y + 9];
    if (box[0] < 0 || box[2] > viewport.width || box[1] < 0 || box[3] > viewport.height) continue;
    const must = i === hovered || i === selected;
    if (!must && panels.some((r) => box[0] < r.right && box[2] > r.left && box[1] < r.bottom && box[3] > r.top))
      continue;
    if (!must && boxes.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
    boxes.push(box);
    kept.push({ i, text });
  }
  labels = kept;
}

// ---- Selection, search, detail ----
function select(i, flyTo = true) {
  selected = i ?? -1;
  neighbours = [];
  if (selected >= 0) {
    const set = new Set();
    for (const e of adjacency[selected]) set.add(pairs[e * 2] === selected ? pairs[e * 2 + 1] : pairs[e * 2]);
    neighbours = [...set];
    if (flyTo) {
      const { c, r } = boundingRadius([selected, ...neighbours]);
      setView({ ...viewState, target: c, zoom: Math.min(viewState.maxZoom, fitZoom(Math.max(r, 40))) }, 800);
    }
  }
  showDetail();
  render();
}
function showDetail() {
  const box = $("detail");
  box.hidden = selected < 0;
  if (selected < 0) return;
  const groups = new Map();
  for (const e of adjacency[selected]) {
    const out = pairs[e * 2] === selected;
    const other = out ? pairs[e * 2 + 1] : pairs[e * 2];
    const key = `${out ? "Links to" : "Linked from"} · ${g.kinds[g.links.kind[e]]}`;
    groups.set(key, [...(groups.get(key) ?? []), other]);
  }
  box.replaceChildren();
  const h = document.createElement("h1");
  h.textContent = g.nodes.title[selected];
  const ref = document.createElement("p");
  ref.className = "muted";
  ref.textContent = `${g.nodes.ref[selected]} · ${g.types[g.nodes.type[selected]]} · ${placed[selected] ? "embedded" : "no embedding"}`;
  box.append(h, ref);
  for (const [key, list] of groups) {
    const p = document.createElement("p");
    p.textContent = `${key} (${list.length})`;
    const ul = document.createElement("ul");
    for (const n of list.slice(0, 12)) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.textContent = name(n);
      a.onclick = () => select(n);
      li.append(a);
      ul.append(li);
    }
    box.append(p, ul);
  }
}
$("find").addEventListener("input", (event) => {
  const q = event.target.value.trim().toLowerCase();
  matches =
    q.length < 2
      ? []
      : everyone.filter((i) => g.nodes.ref[i].toLowerCase().includes(q) || g.nodes.title[i].toLowerCase().includes(q));
  if (matches.length) fit(matches);
  render();
});
$("fit").addEventListener("click", () => fit());
addEventListener("keydown", (event) => {
  if (event.key === "Escape") select(-1, false);
});

// ---- Arrangement: by meaning (the projection) or by meaning and links (the force layout) ----
const worker = new Worker(new URL("./layout.worker.js", import.meta.url), { type: "module" });
let forced = null;
const layout = { tick: 0, tickMs: 0, done: false, started: 0, totalMs: 0 };
let mode = "meaning";
worker.onmessage = ({ data }) => {
  forced = data.pos;
  Object.assign(layout, { tick: data.tick, tickMs: data.tickMs, done: data.done });
  if (data.done) layout.totalMs = performance.now() - layout.started;
  if (mode === "links") {
    // While the layout streams, positions move a little each update; no transition, or they would lag behind.
    animatePositions = false;
    setPositions(forced);
  }
};
function startLayout() {
  layout.started = performance.now();
  worker.postMessage({ count: N, seed, edges: pairs });
}
function setPositions(next) {
  pos = Float32Array.from(next);
  updateEdgeEnds();
  version++;
  render();
}
for (const input of document.querySelectorAll('input[name="mode"]'))
  input.addEventListener("change", () => {
    mode = input.value;
    animatePositions = true;
    if (mode === "links" && !forced) startLayout();
    setPositions(mode === "links" && forced ? forced : seed);
  });

// ---- Simulated activity: a search lands pulses on its hits; a read ripples the asset it read ----
$("activity").addEventListener("change", (event) => {
  activity = event.target.checked;
});
$("rate").addEventListener("input", (event) => {
  rate = Number(event.target.value);
  $("rate-out").value = rate;
});
const heavy = Array.from({ length: N }, (_, i) => i).filter((i) => degree[i] > 0);
function spawn(dt) {
  let due = (rate * dt) / 1000;
  while (due > 0 && pulses.length < 4000) {
    if (random() > due) break;
    due -= 1;
    const target = random() < 0.7 ? heavy[Math.floor(random() * heavy.length)] : Math.floor(random() * N);
    const from = viewState.target;
    pulses.push({ i: target, from: [...from], t: 0, at: [...from], speed: 0.9 + random() * 0.6 });
  }
}
function step(dt) {
  for (let k = pulses.length - 1; k >= 0; k--) {
    const p = pulses[k];
    p.t += (dt / 1000) * p.speed;
    if (p.t >= 1) {
      ripples.push({ i: p.i, age: 0 });
      pulses.splice(k, 1);
      continue;
    }
    const to = positionOf(p.i);
    const s = p.t * p.t * (3 - 2 * p.t);
    for (let a = 0; a < 3; a++) p.at[a] = p.from[a] + (to[a] - p.from[a]) * s;
  }
  for (let k = ripples.length - 1; k >= 0; k--) {
    ripples[k].age += dt / 900;
    if (ripples[k].age >= 1) ripples.splice(k, 1);
  }
}

// ---- Frame loop: idle rotation and activity; deck redraws only when layers or the view change ----
let lastInteraction = -Infinity;
let labelsDue = true;
let last = performance.now();
const fps = { frames: 0, since: performance.now(), value: 0, renderMs: 0 };
let renderStart = 0;
function loop(now) {
  const dt = Math.min(64, now - last);
  last = now;
  frame++;
  if ($("spin").checked && !reduceMotion && now - lastInteraction > 4000 && now > flyingUntil) {
    const { transitionDuration, transitionInterpolator, ...plain } = viewState;
    viewState = { ...plain, rotationOrbit: plain.rotationOrbit + dt * 0.004 };
    deck.setProps({ viewState });
    labelsDue = true;
  }
  if (activity) spawn(dt);
  if (activity || pulses.length || ripples.length) {
    step(dt);
    render();
  } else if (labelsDue) render();
  labelsDue = false;
  if (now - fps.since > 500) {
    fps.value = (fps.frames * 1000) / (now - fps.since);
    fps.frames = 0;
    fps.since = now;
    showStats();
  }
  requestAnimationFrame(loop);
}

function showStats() {
  const rows = [
    ["Frames/s", fps.value.toFixed(0)],
    ["Draw (CPU)", `${fps.renderMs.toFixed(1)} ms`],
    ["Pulses", pulses.length],
    ["Ripples", ripples.length],
    ["Layout ticks", layout.tick],
    ["Layout tick", `${layout.tickMs.toFixed(0)} ms`],
    ["Layout total", layout.done ? `${(layout.totalMs / 1000).toFixed(1)} s` : layout.tick ? "running" : "not run"],
  ];
  $("stats").replaceChildren(
    ...rows.flatMap(([k, v]) => {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      return [dt, dd];
    }),
  );
}

const deck = new Deck({
  parent: $("deck"),
  views: view,
  viewState,
  controller: { inertia: 250 },
  onViewStateChange: ({ viewState: next, interactionState }) => {
    if (
      interactionState.isDragging ||
      interactionState.isZooming ||
      interactionState.isPanning ||
      interactionState.isRotating
    )
      lastInteraction = performance.now();
    viewState = next;
    deck.setProps({ viewState });
    labelsDue = true;
  },
  onBeforeRender: () => {
    renderStart = performance.now();
  },
  onAfterRender: () => {
    fps.frames++;
    fps.renderMs = fps.renderMs * 0.9 + (performance.now() - renderStart) * 0.1;
  },
  getTooltip: ({ layer, index, object }) => {
    if (!layer) return null;
    if (layer.id === "assets" || layer.id === "lit") {
      const i = layer.id === "lit" ? object : index;
      return { text: `${g.nodes.title[i]}\n${g.nodes.ref[i]}\n${degree[i]} links` };
    }
    return null;
  },
  onWebGLInitialized: () => {},
  onError: (error) => console.error(error),
});

// ---- Legend, counts, start ----
$("legend").replaceChildren(
  ...g.types.slice(0, PALETTE.length).map((type, t) => {
    const li = document.createElement("li");
    const dot = document.createElement("i");
    dot.style.background = `rgb(${PALETTE[typeSlot[t]].join(",")})`;
    li.append(dot, type);
    return li;
  }),
);
const embedded = placed.reduce((a, b) => a + b, 0);
$("counts").textContent =
  `${N.toLocaleString()} assets · ${E.toLocaleString()} links · ${embedded.toLocaleString()} embedded · ${g.bundles.length} bundles`;
render();
fit(everyone, 0);
requestAnimationFrame(loop);

// For the measurement script.
window.spike = {
  N,
  E,
  get fps() {
    return fps.value;
  },
  get renderMs() {
    return fps.renderMs;
  },
  layout,
  select,
  fit,
  setMode(next) {
    document.querySelector(`input[name="mode"][value="${next}"]`).click();
  },
  setActivity(on, perSecond = rate) {
    rate = perSecond;
    activity = on;
  },
  get pulses() {
    return pulses.length;
  },
  pick: (x, y) => deck.pickObject({ x, y, radius: 4 }),
  degree,
  deck,
};
