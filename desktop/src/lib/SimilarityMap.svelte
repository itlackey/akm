<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  // Every asset in scope as a point in 3D (three.js), placed by akm so alike assets sit close, in groups by meaning,
  // each group named over its middle by a label that stays the same size on screen. Drag turns it, right-drag or
  // Shift-drag moves it, the wheel zooms toward the pointer (the page never scrolls over the map), and the point nearest
  // the pointer, within a fixed reach on screen, names its asset on hover. Choosing a point or a group's name picks it:
  // the pick is ringed, what it is joined to is ringed and lined, and the rest fades.
  import type { Group, Overview } from "./library-overview";

  let {
    o,
    scope,
    groups,
    colourOf,
    lit,
    lines,
    picked,
    selected,
    related,
    onPick,
    onGroup,
    label,
  }: {
    o: Overview;
    scope: readonly number[];
    groups: Group[];
    /** The colour token of an asset in the view. */
    colourOf: (i: number) => string;
    /** The assets drawn in full; the rest fade. Null: all in full. */
    lit: Set<number> | null;
    /** Lines from point to point, each a pair of places and a weight from 0 to 1. */
    lines: Array<{ from: ArrayLike<number>; to: ArrayLike<number>; weight: number }>;
    picked: number;
    /** The chosen group's key, or "", and the keys of the groups joined to it. */
    selected: string;
    related: string[];
    onPick: (i: number) => void;
    onGroup: (key: string) => void;
    label: string;
  } = $props();

  /** Where the camera starts, and returns to on reset. */
  const HOME = { position: [0, 60, 330], target: [0, 0, 0] } as const;
  /** How far from a point, in screen pixels, the pointer still chooses it, at any zoom. */
  const REACH = 14;

  let host = $state<HTMLDivElement>();
  let tip = $state<{ x: number; y: number; text: string } | null>(null);
  let failed = $state("");
  /** Set once three.js has loaded and the scene is up; the effects below draw into it. */
  let ready = $state(false);
  /** The group name labels, by group key. */
  const nameEls: Record<string, HTMLButtonElement> = $state({});
  /** The groups with no lit asset: their names fade like the points. */
  const dimmed = $derived(
    new Set(lit ? groups.filter((g) => !g.members.some((i) => lit.has(i))).map((g) => g.key) : []),
  );
  const largest = $derived(Math.max(1, ...groups.map((g) => g.members.length)));

  /** The camera back where it started, whatever is chosen. */
  export function reset() {
    if (!world) return;
    world.flight = null;
    world.camera.position.set(...HOME.position);
    world.controls.target.set(...HOME.target);
    world.controls.update();
  }

  // biome-ignore lint/suspicious/noExplicitAny: three.js is loaded on demand, so its namespace is held untyped here.
  let THREE: any;
  /** A geometry holding the places of these assets. */
  function placesOf(list: readonly number[]) {
    const place = new Float32Array(list.length * 3);
    list.forEach((i, k) => place.set(o.place.subarray(i * 3, i * 3 + 3), k * 3));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(place, 3));
    return geometry;
  }
  // biome-ignore lint/suspicious/noExplicitAny: see above.
  let world: any = null;

  /** A CSS colour token resolved to [r, g, b] from 0 to 1 (three.js cannot read light-dark()). */
  const resolved = new Map<string, [number, number, number]>();
  function rgb(token: string): [number, number, number] {
    const hit = resolved.get(token);
    if (hit) return hit;
    const probe = document.createElement("span");
    probe.style.color = token.startsWith("--") ? `var(${token})` : token;
    host!.appendChild(probe);
    const m = getComputedStyle(probe).color.match(/[\d.]+/g) ?? ["128", "128", "128"];
    probe.remove();
    const value: [number, number, number] = [+m[0]! / 255, +m[1]! / 255, +m[2]! / 255];
    resolved.set(token, value);
    return value;
  }

  $effect(() => {
    if (!host) return;
    let gone = false;
    let frame = 0;
    let resize: ResizeObserver | null = null;
    // The wheel belongs to the map from the first moment, wherever over it: on a group's name or while three.js is
    // still loading as much as on the canvas, so the page behind never scrolls. A wheel over a name is handed on.
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const canvas = world?.renderer.domElement;
      if (canvas && event.target !== canvas) canvas.dispatchEvent(new WheelEvent("wheel", event));
    };
    host.addEventListener("wheel", wheel, { passive: false });
    const element = host;
    (async () => {
      try {
        const [three, { OrbitControls }, { LineSegments2 }, { LineSegmentsGeometry }, { LineMaterial }] =
          await Promise.all([
            import("three"),
            import("three/examples/jsm/controls/OrbitControls.js"),
            import("three/examples/jsm/lines/LineSegments2.js"),
            import("three/examples/jsm/lines/LineSegmentsGeometry.js"),
            import("three/examples/jsm/lines/LineMaterial.js"),
          ]);
        if (gone || !host) return;
        THREE = three;
        // The colours are read from CSS as sRGB and drawn as they are: three.js would otherwise treat them as linear
        // and lighten them, which turned the dark theme's background grey and washed out every faded point.
        THREE.ColorManagement.enabled = false;
        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
        renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
        renderer.setSize(host.clientWidth, host.clientHeight);
        host.prepend(renderer.domElement);
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(...rgb("--bg"));
        const camera = new THREE.PerspectiveCamera(50, host.clientWidth / host.clientHeight, 1, 5000);
        camera.position.set(...HOME.position);
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.zoomToCursor = true;
        controls.minDistance = 15;
        controls.maxDistance = 1500;
        // A round dot for each point, and a ring for the marks drawn over it.
        const sprite = (draw: (ctx: CanvasRenderingContext2D) => void) => {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 64;
          draw(canvas.getContext("2d")!);
          return new THREE.CanvasTexture(canvas);
        };
        const dot = sprite((ctx) => {
          ctx.beginPath();
          ctx.arc(32, 32, 28, 0, Math.PI * 2);
          ctx.fillStyle = "#fff";
          ctx.fill();
        });
        const ring = sprite((ctx) => {
          ctx.beginPath();
          ctx.arc(32, 32, 26, 0, Math.PI * 2);
          ctx.lineWidth = 7;
          ctx.strokeStyle = "#fff";
          ctx.stroke();
        });
        const points = new THREE.Points(
          new THREE.BufferGeometry(),
          new THREE.PointsMaterial({
            size: 8,
            vertexColors: true,
            map: dot,
            alphaTest: 0.5,
            sizeAttenuation: true,
          }),
        );
        scene.add(points);
        // The lit points again, larger, over the faded rest.
        const bright = new THREE.Points(
          new THREE.BufferGeometry(),
          new THREE.PointsMaterial({
            size: 12,
            vertexColors: true,
            map: dot,
            alphaTest: 0.5,
            sizeAttenuation: true,
          }),
        );
        scene.add(bright);
        // Rings of a fixed size on screen, drawn over everything: the pick, what it is joined to, and the point under
        // the pointer.
        const mark = (size: number, token: string) => {
          const marks = new THREE.Points(
            new THREE.BufferGeometry(),
            new THREE.PointsMaterial({
              size,
              color: new THREE.Color(...rgb(token)),
              map: ring,
              alphaTest: 0.5,
              sizeAttenuation: false,
              depthTest: false,
            }),
          );
          marks.renderOrder = 2;
          scene.add(marks);
          return marks;
        };
        const focus = mark(26, "--map-highlight");
        const near = mark(18, "--map-highlight");
        const under = mark(20, "--text");
        const joins = new LineSegments2(
          new LineSegmentsGeometry(),
          new LineMaterial({
            linewidth: 2.5,
            vertexColors: true,
            depthTest: false,
            resolution: new THREE.Vector2(host.clientWidth, host.clientHeight),
          }),
        );
        joins.renderOrder = 1;
        scene.add(joins);
        world = {
          renderer,
          scene,
          camera,
          controls,
          points,
          bright,
          joins,
          focus,
          near,
          under,
          order: [] as number[],
          flight: null,
        };

        // The point nearest the pointer on screen, within REACH pixels, so a click lands whatever the zoom; a faded
        // point must be that much nearer than a lit one.
        const probe = new THREE.Vector3();
        const hit = (event: PointerEvent) => {
          const position = points.geometry.getAttribute("position");
          if (!position) return null;
          const box = renderer.domElement.getBoundingClientRect();
          const x = event.clientX - box.left;
          const y = event.clientY - box.top;
          let best = -1;
          let nearest = REACH;
          for (let k = 0; k < position.count; k++) {
            probe.fromBufferAttribute(position, k).project(camera);
            if (probe.z < -1 || probe.z > 1) continue;
            const d =
              Math.hypot(((probe.x + 1) / 2) * box.width - x, ((1 - probe.y) / 2) * box.height - y) +
              (lit && !lit.has(world.order[k]) ? REACH / 2 : 0);
            if (d < nearest) {
              nearest = d;
              best = k;
            }
          }
          return best < 0 ? null : { k: best, i: world.order[best] as number };
        };
        let down = { x: 0, y: 0 };
        renderer.domElement.addEventListener(
          "pointerdown",
          (e: PointerEvent) => (down = { x: e.clientX, y: e.clientY }),
        );
        renderer.domElement.addEventListener("pointerup", (e: PointerEvent) => {
          if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return; // a drag, not a click
          const h = hit(e);
          if (h) onPick(h.i);
        });
        renderer.domElement.addEventListener("pointermove", (e: PointerEvent) => {
          if (e.buttons) return;
          const h = hit(e);
          const box = host!.getBoundingClientRect();
          tip = h ? { x: e.clientX - box.left, y: e.clientY - box.top + 12, text: o.ref[h.i]! } : null;
          renderer.domElement.style.cursor = h ? "pointer" : "grab";
          under.geometry.dispose();
          under.geometry = placesOf(h ? [h.i] : []);
        });
        renderer.domElement.addEventListener("pointerleave", () => {
          tip = null;
          under.geometry.dispose();
          under.geometry = placesOf([]);
        });
        resize = new ResizeObserver(() => {
          if (!host) return;
          joins.material.resolution.set(host.clientWidth, host.clientHeight);
          renderer.setSize(host.clientWidth, host.clientHeight);
          camera.aspect = host.clientWidth / host.clientHeight;
          camera.updateProjectionMatrix();
        });
        resize.observe(host);
        const at = new THREE.Vector3();
        const loop = () => {
          controls.update();
          renderer.render(scene, camera);
          // Each group's name stays the same size on screen, over its middle. The chosen group and those joined to it
          // are placed first, then the largest; a name that would overlap one already placed, or is behind the
          // camera, is hidden, and names unrelated to a choice are dimmed.
          const w = host!.clientWidth;
          const h = host!.clientHeight;
          const placed: Array<[number, number, number, number]> = [];
          const first = (g: Group) => (g.key === selected ? 0 : related.includes(g.key) ? 1 : 2);
          for (const g of [...groups].sort((a, b) => first(a) - first(b))) {
            const el = nameEls[g.key];
            if (!el) continue;
            at.set(g.centre[0], g.centre[1], g.centre[2]).project(camera);
            const x = ((at.x + 1) / 2) * w;
            const y = ((1 - at.y) / 2) * h;
            const box: [number, number, number, number] = [
              x - el.offsetWidth / 2,
              y - el.offsetHeight / 2,
              x + el.offsetWidth / 2,
              y + el.offsetHeight / 2,
            ];
            const hidden =
              at.z >= 1 ||
              (first(g) > 0 && placed.some((p) => box[0] < p[2] && box[2] > p[0] && box[1] < p[3] && box[3] > p[1]));
            el.style.visibility = hidden ? "hidden" : "visible";
            el.style.opacity = dimmed.has(g.key) ? "0.3" : selected && first(g) === 2 ? "0.45" : "1";
            el.style.transform = `translate(${box[0]}px, ${box[1]}px)`;
            if (!hidden) placed.push(box);
          }
          frame = requestAnimationFrame(loop);
        };
        loop();
        ready = true;
      } catch (cause) {
        failed = `The 3D map could not start: ${(cause as Error).message}`;
      }
    })();
    return () => {
      gone = true;
      element.removeEventListener("wheel", wheel);
      cancelAnimationFrame(frame);
      resize?.disconnect();
      if (world) {
        world.controls.dispose();
        world.renderer.dispose();
        world.renderer.domElement.remove();
      }
      world = null;
      ready = false;
    };
  });

  // The points: every asset in scope, in its view colour, the unlit ones faded toward the background.
  $effect(() => {
    if (!ready || !world) return;
    const order = scope.filter((i) => o.group[i]! >= 0);
    const bg = rgb("--bg");
    const place = new Float32Array(order.length * 3);
    const colour = new Float32Array(order.length * 3);
    const shining: number[] = [];
    order.forEach((i, k) => {
      place.set(o.place.subarray(i * 3, i * 3 + 3), k * 3);
      const c = rgb(colourOf(i));
      const faded = lit && !lit.has(i);
      if (lit && !faded) shining.push(i);
      const f = faded ? 0.8 : 0;
      for (let d = 0; d < 3; d++) colour[k * 3 + d] = c[d]! * (1 - f) + bg[d]! * f;
    });
    const glow = placesOf(shining);
    glow.setAttribute(
      "color",
      new THREE.BufferAttribute(Float32Array.from(shining.flatMap((i) => rgb(colourOf(i)))), 3),
    );
    world.bright.geometry.dispose();
    world.bright.geometry = glow;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(place, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colour, 3));
    world.points.geometry.dispose();
    world.points.geometry = geometry;
    world.order = order;
  });

  // The lines, in the highlight colour, fainter for lighter weights.
  $effect(() => {
    if (!ready || !world) return;
    const highlight = rgb("--map-highlight");
    const bg = rgb("--bg");
    const place: number[] = [];
    const colour: number[] = [];
    for (const l of lines) {
      place.push(l.from[0]!, l.from[1]!, l.from[2]!, l.to[0]!, l.to[1]!, l.to[2]!);
      const f = 0.6 * (1 - l.weight);
      for (let end = 0; end < 2; end++) for (let d = 0; d < 3; d++) colour.push(highlight[d]! * (1 - f) + bg[d]! * f);
    }
    world.joins.visible = lines.length > 0;
    if (!lines.length) return;
    world.joins.geometry.setPositions(place);
    world.joins.geometry.setColors(colour);
  });

  // A pick is ringed, and so is what it is joined to; the group chosen is told by the fade and the lines alone.
  $effect(() => {
    if (!ready || !world) return;
    const joined = picked >= 0 && lit ? [...lit].filter((i) => i !== picked && o.group[i]! >= 0) : [];
    world.focus.geometry.dispose();
    world.focus.geometry = placesOf(picked >= 0 ? [picked] : []);
    world.near.geometry.dispose();
    world.near.geometry = placesOf(joined);
  });

  // A pick turns the view to it: an asset close up, a group so it fills the view.
  $effect(() => {
    if (!ready || !world) return;
    const group = groups.find((g) => g.key === selected);
    if (picked < 0 && !group) return;
    const target =
      picked >= 0
        ? new THREE.Vector3(...o.place.subarray(picked * 3, picked * 3 + 3))
        : new THREE.Vector3(...group!.centre);
    const { camera, controls } = world;
    const from = controls.target.clone();
    const away = camera.position
      .clone()
      .sub(controls.target)
      .setLength(picked >= 0 ? 90 : 60 + 12 * Math.cbrt(group!.members.length));
    const start = performance.now();
    const flight = {};
    world.flight = flight;
    const step = (now: number) => {
      if (world?.flight !== flight) return;
      const t = Math.min(1, (now - start) / 700);
      const ease = t * (2 - t);
      controls.target.lerpVectors(from, target, ease);
      camera.position.copy(controls.target).add(away);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
</script>

<div class="stage-3d" bind:this={host} role="group" aria-label={label}>
  {#if failed}<p class="notice notice-warn">{failed}</p>{/if}
  {#each groups as g (g.key)}<button
      class="group-name"
      class:chosen={selected === g.key}
      bind:this={nameEls[g.key]}
      style={`font-size:${13 + 4 * Math.sqrt(g.members.length / largest)}px`}
      onclick={() => onGroup(g.key)}>{g.label}<span>{g.members.length.toLocaleString()}</span></button
    >{/each}
  {#if tip}<div
      class="tip"
      style={`top:${tip.y}px;${tip.x < host!.clientWidth / 2 ? `left:${tip.x + 12}px` : `right:${host!.clientWidth - tip.x + 12}px`}`}
    >
      {tip.text}
    </div>{/if}
</div>

<style>
  .stage-3d {
    position: relative;
    inline-size: 100%;
    block-size: min(74vh, 800px);
    min-block-size: 420px;
    border-radius: 8px;
    overflow: hidden;
    background: var(--bg);
    cursor: grab;
  }
  .group-name {
    position: absolute;
    inset-block-start: 0;
    inset-inline-start: 0;
    display: flex;
    gap: 6px;
    align-items: baseline;
    padding: 2px 8px;
    font-weight: 600;
    line-height: 1.3;
    white-space: nowrap;
    color: var(--text);
    background: color-mix(in srgb, var(--surface) 92%, transparent);
    border: 1px solid var(--border);
    border-radius: 4px;
    cursor: pointer;
    will-change: transform;
    transition: opacity 0.2s;
  }
  .group-name span {
    font-weight: 400;
    font-size: 0.85em;
    color: var(--muted);
  }
  .group-name:hover,
  .group-name.chosen {
    border-color: var(--map-highlight);
    background: var(--surface);
  }
  .group-name.chosen {
    box-shadow: 0 0 0 1px var(--map-highlight);
  }
  .tip {
    position: absolute;
    pointer-events: none;
    max-inline-size: 60%;
    padding: 2px 6px;
    font-size: var(--text-xs);
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 4px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
