// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// @ts-nocheck -- presentation code: deck.gl layers and views, not type-checked here.
// A deck.gl canvas, flat (top-down: pan and zoom) or 3D (orbit), that the library map draws its views on. The page
// gives layers, labels and what to frame; this places the labels so none overlaps another or the page's overlays,
// frames the camera, turns a 3D view slowly while nobody touches it (never under reduced motion), and reports failure.
//
// createDeckStage({ host, three, tooltip, onError }) -> stage
//   stage.draw(layers, labels, { ink, paper })   labels: [{ position, text, priority, size? }]
//   stage.setThree(bool)                          flat or 3D; the next frame() frames the new view
//   stage.frame({ centre, radius }, duration?)    frames a sphere (3D) or circle (flat) about centre
//   stage.destroy()

import { Deck, LinearInterpolator, OrbitView, OrthographicView } from "@deck.gl/core";
import { TextLayer } from "@deck.gl/layers";

/** The labels that fit: most important first, each kept if its box is on the canvas and clear of the others. */
export function fitLabels(labels, project, width, height, blocked = []) {
  const boxes = [...blocked];
  const kept = [];
  for (const l of [...labels].sort((a, b) => b.priority - a.priority)) {
    const [x, y, z] = project(l.position);
    if (!(z > -1 && z < 1)) continue;
    const w = l.text.length * ((l.size ?? 12) * 0.58) + 10;
    const box = [x - w / 2, y - 18, x + w / 2, y + 2];
    if (box[0] < 0 || box[2] > width || box[1] < 0 || box[3] > height) continue;
    if (boxes.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
    boxes.push(box);
    kept.push(l);
  }
  return kept;
}

export function createDeckStage({ host, three, tooltip, onError }) {
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const fly = new LinearInterpolator(["target", "zoom", "rotationOrbit", "rotationX"]);
  let is3d = three;
  let viewState = {};
  let layers = [];
  let labels = [];
  let style = { ink: [0, 0, 0], paper: [255, 255, 255] };
  let lastTouch = Number.NEGATIVE_INFINITY;
  let flyingUntil = 0;
  let due = true;
  let placedFor = "";
  let raf = 0;
  const makeView = () =>
    is3d
      ? new OrbitView({ id: "view", orbitAxis: "Y", fovy: 40, near: 0.05, far: 1e6 })
      : new OrthographicView({ id: "view" });

  const deck = new Deck({
    parent: host,
    views: makeView(),
    viewState,
    controller: { inertia: 250, doubleClickZoom: false },
    style: { position: "absolute", inset: "0" },
    onViewStateChange: ({ viewState: next, interactionState }) => {
      if (interactionState.isDragging || interactionState.isZooming || interactionState.isPanning)
        lastTouch = performance.now();
      viewState = next;
      deck.setProps({ viewState });
      due = true;
    },
    getTooltip: (info) => {
      const text = tooltip(info);
      return text ? { text } : null;
    },
    onError,
  });

  function render() {
    if (!deck.isInitialized) return;
    const viewport = deck.getViewports()[0];
    if (!viewport) return;
    // The page's overlays (legend and the like) sit over the canvas: labels keep clear of them.
    const at = host.getBoundingClientRect();
    const blocked = [...(host.parentElement?.children ?? [])]
      .filter((el) => el !== host && getComputedStyle(el).position === "absolute" && !el.hasAttribute("hidden"))
      .map((el) => {
        const r = el.getBoundingClientRect();
        return [r.left - at.left, r.top - at.top, r.right - at.left, r.bottom - at.top];
      });
    const placed = fitLabels(labels, (p) => viewport.project(p), viewport.width, viewport.height, blocked);
    deck.setProps({
      layers: [
        ...layers,
        new TextLayer({
          id: "labels",
          data: placed,
          getPosition: (l) => l.position,
          getText: (l) => l.text,
          getSize: (l) => l.size ?? 12,
          sizeUnits: "pixels",
          getColor: [...style.ink, 255],
          getTextAnchor: "middle",
          getAlignmentBaseline: "bottom",
          getPixelOffset: [0, -2],
          background: true,
          getBackgroundColor: [...style.paper, 225],
          backgroundPadding: [4, 2],
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          fontWeight: 500,
          characterSet: "auto",
          billboard: true,
          parameters: { depthCompare: "always", depthWriteEnabled: false },
        }),
      ],
    });
  }

  function loop(now) {
    raf = requestAnimationFrame(loop);
    if (is3d && !motion.matches && now - lastTouch > 5000 && now > flyingUntil && deck.isInitialized) {
      const { transitionDuration, transitionInterpolator, ...plain } = viewState;
      viewState = { ...plain, rotationOrbit: (plain.rotationOrbit ?? 0) + 0.06 };
      deck.setProps({ viewState });
      due = true;
    }
    // Labels are placed for one viewport: place them again whenever its size or camera has changed, however that
    // happened (a resize, a camera flight, the first real layout of the canvas).
    const viewport = deck.isInitialized ? deck.getViewports()[0] : null;
    if (viewport) {
      const key = [viewport.width, viewport.height, ...viewport.viewProjectionMatrix].map((v) => v.toFixed(3)).join();
      if (key !== placedFor) {
        placedFor = key;
        due = true;
      }
    }
    if (due && deck.isInitialized) {
      due = false;
      render();
    }
  }
  raf = requestAnimationFrame(loop);

  return {
    draw(nextLayers, nextLabels, nextStyle) {
      layers = nextLayers;
      labels = nextLabels;
      style = nextStyle;
      due = true;
    },
    setThree(next) {
      if (next === is3d) return;
      is3d = next;
      viewState = {};
      deck.setProps({ views: makeView() });
    },
    frame({ centre, radius }, duration = 0) {
      const w = host.clientWidth || 800;
      const h = host.clientHeight || 600;
      const zoom = Math.log2(Math.min(w, h) / (2 * Math.max(radius, 1) * 1.08));
      const next = is3d
        ? { target: centre, zoom, rotationOrbit: viewState.rotationOrbit ?? 20, rotationX: 18 }
        : { target: [centre[0], centre[1], 0], zoom };
      const animate = duration && !motion.matches;
      if (animate) flyingUntil = performance.now() + duration;
      viewState = animate ? { ...next, transitionDuration: duration, transitionInterpolator: fly } : next;
      deck.setProps({ viewState });
      due = true;
    },
    destroy() {
      cancelAnimationFrame(raf);
      deck.finalize();
    },
  };
}
