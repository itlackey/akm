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
  // the pick is ringed and haloed, named by a label that stays over everything, what it is joined to is ringed and lined,
  // and the rest fades. With the map focused, the left and right arrow keys step to the previous and next asset.
  import { LEVEL_STYLES } from "./link-levels";
  import { untrack, type Snippet } from "svelte";
  import type { Group, Overview } from "./library-overview";

  let {
    o,
    scope,
    groups,
    colourOf,
    lit,
    lines = [],
    levels = [[], [], []],
    emphasis = [],
    picked = -1,
    selected = "",
    related = [],
    onPick,
    onGroup,
    onStep,
    label,
    legend,
  }: {
    o: Overview;
    scope: readonly number[];
    groups: Group[];
    /** The colour token of an asset in the view. */
    colourOf: (i: number) => string;
    /** The assets drawn in full; the rest fade. Null: all in full. */
    lit: Set<number> | null;
    /** Lines from point to point, each a pair of places and a weight from 0 to 1. */
    lines?: Array<{ from: ArrayLike<number>; to: ArrayLike<number>; weight: number; level?: 1 | 2 | 3 }>;
    /** The assets one, two and three joins from the pick, each ringed to match its lines. */
    levels?: [number[], number[], number[]];
    /** Assets ringed in a colour of their own, for a moment: what an event just touched. */
    emphasis?: Array<{ i: number; token: string }>;
    picked?: number;
    /** The chosen group's key, or "", and the keys of the groups joined to it. */
    selected?: string;
    related?: string[];
    /** Without these the map only shows: a point or a group's name is not chosen. */
    onPick?: (i: number) => void;
    onGroup?: (key: string) => void;
    /** The arrow keys on the focused map: -1 for the previous asset, 1 for the next. */
    onStep?: (direction: -1 | 1) => void;
    label: string;
    /** What the map's corner says: the key to what is drawn. */
    legend?: Snippet;
  } = $props();

  /** Where the camera starts, and returns to on reset. */
  const HOME = { position: [0, 60, 330], target: [0, 0, 0] } as const;
  /** A point is chosen from this far outside its drawn disc, at least this far from its middle, in screen pixels. */
  const SLACK = 6;
  const LEAST_REACH = 10;
  /** The drawn size of a point, in world units: the lit ones are larger. */
  const SIZE = { faded: 8, lit: 12 };

  let host = $state<HTMLDivElement>();
  let tip = $state<{ x: number; y: number; text: string } | null>(null);
  /** The label over the pick, which stays whatever is in front of it. */
  let pickEl = $state<HTMLDivElement>();
  let failed = $state("");
  /** Set once three.js has loaded and the scene is up; the effects below draw into it. */
  let ready = $state(false);
  /** The group name labels, by group key. */
  const nameEls: Record<string, HTMLElement> = $state({});
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

  /** The highlight, mixed toward the background by `mute` (0 is the highlight itself): how a level is drawn. */
  const muted = (mute: number): [number, number, number] => {
    const highlight = rgb("--map-highlight");
    const bg = rgb("--bg");
    return [0, 1, 2].map((d) => highlight[d]! * (1 - mute) + bg[d]! * mute) as [number, number, number];
  };

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
        const glow = sprite((ctx) => {
          const g = ctx.createRadialGradient(32, 32, 4, 32, 32, 31);
          g.addColorStop(0, "#fff");
          g.addColorStop(1, "rgba(255,255,255,0)");
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, 64, 64);
        });
        const points = new THREE.Points(
          new THREE.BufferGeometry(),
          new THREE.PointsMaterial({
            size: SIZE.faded,
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
            size: SIZE.lit,
            vertexColors: true,
            map: dot,
            alphaTest: 0.5,
            sizeAttenuation: true,
          }),
        );
        scene.add(bright);
        // Rings of a fixed size on screen, drawn over everything: the pick, what it is joined to, and the point under
        // the pointer.
        const mark = (size: number, colour: [number, number, number] | string) => {
          const marks = new THREE.Points(
            new THREE.BufferGeometry(),
            new THREE.PointsMaterial({
              size,
              color: new THREE.Color(...(typeof colour === "string" ? rgb(colour) : colour)),
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
        // A soft disc of a fixed size on screen, behind the rings and over the points.
        const halo = (size: number, token: string, opacity: number) => {
          const marks = new THREE.Points(
            new THREE.BufferGeometry(),
            new THREE.PointsMaterial({
              size,
              color: new THREE.Color(...rgb(token)),
              map: glow,
              transparent: true,
              opacity,
              sizeAttenuation: false,
              depthTest: false,
              depthWrite: false,
            }),
          );
          marks.renderOrder = 1;
          scene.add(marks);
          return marks;
        };
        const focusHalo = halo(60, "--map-highlight", 0.55);
        const underHalo = halo(40, "--text", 0.3);
        const focus = mark(34, "--map-highlight");
        const rings = LEVEL_STYLES.map((style) => mark(style.ring, muted(style.mute)));
        const under = mark(28, "--text");
        // Rings in a colour per point, over every other mark: what an event has just touched.
        const pulses = mark(28, "--text");
        pulses.material.vertexColors = true;
        pulses.renderOrder = 3;
        // The lines of each level, strongest drawn last so it stays on top: its own width, colour and dash.
        const levelJoins = LEVEL_STYLES.map((style, k) => {
          const lines = new LineSegments2(
            new LineSegmentsGeometry(),
            new LineMaterial({
              linewidth: style.width,
              vertexColors: true,
              depthTest: false,
              dashed: style.dash,
              dashSize: 4,
              gapSize: 3,
              resolution: new THREE.Vector2(host!.clientWidth, host!.clientHeight),
            }),
          );
          lines.renderOrder = 0.8 - 0.2 * k;
          lines.visible = false;
          scene.add(lines);
          return lines;
        });
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
          levelJoins,
          focus,
          rings,
          under,
          focusHalo,
          underHalo,
          pulses,
          order: [] as number[],
          flight: null,
        };

        // The point the pointer is on: the one whose drawn disc (plus a few pixels of slack, and at least LEAST_REACH
        // from its middle) holds the pointer, the nearest to the camera first, so a click lands on what is drawn there
        // at any zoom; a faded point must be that much nearer than a lit one.
        const probe = new THREE.Vector3();
        const hit = (clientX: number, clientY: number) => {
          const position = points.geometry.getAttribute("position");
          if (!position) return null;
          const box = renderer.domElement.getBoundingClientRect();
          const x = clientX - box.left;
          const y = clientY - box.top;
          camera.updateMatrixWorld();
          const view = camera.matrixWorldInverse;
          const p = camera.projectionMatrix.elements;
          let best = -1;
          let nearest = Infinity;
          for (let k = 0; k < position.count; k++) {
            probe.fromBufferAttribute(position, k).applyMatrix4(view);
            const depth = -probe.z;
            if (depth < camera.near || depth > camera.far) continue;
            const sx = ((probe.x * p[0]!) / depth + 1) * (box.width / 2);
            const sy = (1 - (probe.y * p[5]!) / depth) * (box.height / 2);
            const faded = lit && !lit.has(world.order[k]);
            const radius = ((faded ? SIZE.faded : SIZE.lit) * box.height) / 2 / depth / 2;
            const d = Math.hypot(sx - x, sy - y);
            if (d > Math.max(LEAST_REACH, radius + SLACK)) continue;
            const score = d - radius + (faded ? LEAST_REACH / 2 : 0);
            if (score < nearest) {
              nearest = score;
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
          const h = hit(e.clientX, e.clientY);
          if (h) onPick?.(h.i);
        });
        // Hover is worked out once a frame at most: a library of thousands of points is searched on each look.
        let moved: PointerEvent | null = null;
        let hover = 0;
        const look = () => {
          hover = 0;
          const e = moved;
          if (!world || !e || e.buttons) return;
          const h = hit(e.clientX, e.clientY);
          const box = host!.getBoundingClientRect();
          tip = h ? { x: e.clientX - box.left, y: e.clientY - box.top + 12, text: o.ref[h.i]! } : null;
          renderer.domElement.style.cursor = h ? "pointer" : "grab";
          for (const mark of [under, world.underHalo]) {
            mark.geometry.dispose();
            mark.geometry = placesOf(h ? [h.i] : []);
          }
        };
        renderer.domElement.addEventListener("pointermove", (e: PointerEvent) => {
          moved = e;
          hover ||= requestAnimationFrame(look);
        });
        renderer.domElement.addEventListener("pointerleave", () => {
          moved = null;
          tip = null;
          for (const mark of [under, world.underHalo]) {
            mark.geometry.dispose();
            mark.geometry = placesOf([]);
          }
        });
        resize = new ResizeObserver(() => {
          if (!host) return;
          for (const lines of [joins, ...levelJoins])
            lines.material.resolution.set(host.clientWidth, host.clientHeight);
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
          // The pick's label goes first, so no group name lies over it; it is held inside the view, and hidden only
          // while the pick is behind the camera.
          if (pickEl) {
            if (picked < 0) pickEl.style.visibility = "hidden";
            else {
              at.set(o.place[picked * 3]!, o.place[picked * 3 + 1]!, o.place[picked * 3 + 2]!).project(camera);
              const x = Math.min(
                w - pickEl.offsetWidth / 2 - 4,
                Math.max(pickEl.offsetWidth / 2 + 4, ((at.x + 1) / 2) * w),
              );
              const above = ((1 - at.y) / 2) * h - 30;
              const y = Math.min(h - pickEl.offsetHeight - 4, Math.max(4, above));
              const box: [number, number, number, number] = [
                x - pickEl.offsetWidth / 2,
                y,
                x + pickEl.offsetWidth / 2,
                y + pickEl.offsetHeight,
              ];
              pickEl.style.visibility = at.z >= 1 ? "hidden" : "visible";
              pickEl.style.transform = `translate(${box[0]}px, ${box[1]}px)`;
              if (at.z < 1) placed.push(box);
            }
          }
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
              ((first(g) > 0 || (pickEl && picked >= 0)) &&
                placed.some((p) => box[0] < p[2] && box[2] > p[0] && box[1] < p[3] && box[3] > p[1]));
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

  // The lines between groups, in the highlight colour, fainter for lighter weights; and, from a pick, the lines of
  // each level, each in its own width and colour.
  $effect(() => {
    if (!ready || !world) return;
    const highlight = rgb("--map-highlight");
    const bg = rgb("--bg");
    const draw = (
      object: { visible: boolean; geometry: any; computeLineDistances: () => void },
      list: typeof lines,
      colourOf: (l: (typeof lines)[number]) => ArrayLike<number>,
    ) => {
      object.visible = list.length > 0;
      if (!list.length) return;
      const place: number[] = [];
      const colour: number[] = [];
      for (const l of list) {
        place.push(l.from[0]!, l.from[1]!, l.from[2]!, l.to[0]!, l.to[1]!, l.to[2]!);
        for (let end = 0; end < 2; end++) colour.push(...Array.from(colourOf(l)));
      }
      object.geometry.setPositions(place);
      object.geometry.setColors(colour);
      object.computeLineDistances();
    };
    draw(
      world.joins,
      lines.filter((l) => !l.level),
      (l) => {
        const f = 0.6 * (1 - l.weight);
        return [0, 1, 2].map((d) => highlight[d]! * (1 - f) + bg[d]! * f);
      },
    );
    LEVEL_STYLES.forEach((style, k) =>
      draw(
        world.levelJoins[k],
        lines.filter((l) => l.level === style.level),
        () => muted(style.mute),
      ),
    );
  });

  // What an event has just touched is ringed, each in its kind's colour.
  $effect(() => {
    if (!ready || !world) return;
    const shown = emphasis.filter((e) => o.group[e.i]! >= 0);
    const geometry = placesOf(shown.map((e) => e.i));
    geometry.setAttribute("color", new THREE.BufferAttribute(Float32Array.from(shown.flatMap((e) => rgb(e.token))), 3));
    world.pulses.geometry.dispose();
    world.pulses.geometry = geometry;
  });

  // A pick is ringed, and so is what it is joined to, a ring of a size and colour for each level; the group chosen is
  // told by the fade and the lines alone.
  $effect(() => {
    if (!ready || !world) return;
    for (const mark of [world.focus, world.focusHalo]) {
      mark.geometry.dispose();
      mark.geometry = placesOf(picked >= 0 ? [picked] : []);
    }
    LEVEL_STYLES.forEach((_, k) => {
      world.rings[k].geometry.dispose();
      world.rings[k].geometry = placesOf(picked >= 0 ? levels[k]!.filter((i) => o.group[i]! >= 0) : []);
    });
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
    // A pick is framed from 90 units away, or farther when its first two levels reach beyond that.
    const reachOut = untrack(() =>
      Math.max(
        0,
        ...levels
          .slice(0, 2)
          .flatMap((list) =>
            list.map((i) => target.distanceTo(new THREE.Vector3(...o.place.subarray(i * 3, i * 3 + 3)))),
          ),
      ),
    );
    const away = camera.position
      .clone()
      .sub(controls.target)
      .setLength(
        picked >= 0 ? Math.min(400, Math.max(90, 1.4 * reachOut)) : 60 + 12 * Math.cbrt(group!.members.length),
      );
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

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class="stage-3d"
  bind:this={host}
  role="group"
  aria-label={onStep ? `${label} Arrow keys step to the previous or next asset.` : label}
  tabindex={onStep ? 0 : undefined}
  onkeydown={(event) => {
    if (!onStep || (event.key !== "ArrowRight" && event.key !== "ArrowLeft")) return;
    event.preventDefault();
    onStep(event.key === "ArrowRight" ? 1 : -1);
  }}
>
  {#if failed}<p class="notice notice-warn">{failed}</p>{/if}
  {#snippet name(g: Group)}{g.label}<span>{g.members.length.toLocaleString()}</span>{/snippet}
  {#each groups as g (g.key)}
    {#if onGroup}<button
        class="group-name"
        class:chosen={selected === g.key}
        bind:this={nameEls[g.key]}
        style={`font-size:${13 + 4 * Math.sqrt(g.members.length / largest)}px`}
        onclick={() => onGroup(g.key)}>{@render name(g)}</button
      >{:else}<span
        class="group-name"
        bind:this={nameEls[g.key]}
        style={`font-size:${13 + 4 * Math.sqrt(g.members.length / largest)}px`}>{@render name(g)}</span
      >{/if}
  {/each}
  {#if legend}<div class="stage-legend">{@render legend()}</div>{/if}
  {#if picked >= 0}<div class="pick-label" bind:this={pickEl}>{o.ref[picked]}</div>{/if}
  {#if tip}<div
      class="tip"
      style={`${tip.y > host!.clientHeight - 40 ? `bottom:${host!.clientHeight - tip.y + 24}px` : `top:${tip.y}px`};${tip.x < host!.clientWidth / 2 ? `left:${tip.x + 12}px` : `right:${host!.clientWidth - tip.x + 12}px`}`}
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
  .stage-3d:focus-visible {
    outline: 2px solid var(--map-highlight);
    outline-offset: -2px;
  }
  .stage-legend {
    position: absolute;
    inset-block-end: 8px;
    inset-inline-start: 8px;
    z-index: 2;
    max-inline-size: min(34rem, calc(100% - 16px));
    pointer-events: none;
    background: color-mix(in srgb, var(--surface) 94%, transparent);
    border: 1px solid var(--border);
    border-radius: 6px;
    empty-cells: hide;
  }
  .stage-legend:empty {
    display: none;
  }
  .pick-label {
    position: absolute;
    inset-block-start: 0;
    inset-inline-start: 0;
    z-index: 2;
    max-inline-size: calc(100% - 16px);
    padding: 3px 10px;
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text);
    background: var(--surface);
    border: 2px solid var(--map-highlight);
    border-radius: 6px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    pointer-events: none;
    will-change: transform;
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
  span.group-name {
    cursor: default;
  }
  button.group-name:hover,
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
