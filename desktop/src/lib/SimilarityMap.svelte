<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  // Every asset in scope as a point in 3D (three.js), placed by akm with groups alike in meaning near each other,
  // each group named over its middle by a label that stays the same size on screen. Drag turns it, right-drag or
  // Shift-drag moves it, the wheel zooms toward the pointer (the page never scrolls over the map), and the point nearest
  // the pointer, within a fixed reach on screen, names its asset on hover. Choosing a point or a group's name picks it:
  // the pick is ringed and haloed, named by a label that stays over everything, what it is joined to is ringed and lined,
  // and the rest fades. With the map focused, the left and right arrow keys step to the previous and next asset, and the
  // other keys turn and zoom the view. `place` is where each asset is drawn: when it changes (2D to 3D or back) every mark
  // moves there over 0.6 seconds, or at once under reduced motion. `flat` draws the points in one plane, which cannot
  // be turned.
  import { LEVEL_STYLES } from "./link-levels";
  import { untrack, type Snippet } from "svelte";
  import { prefersReducedMotion } from "svelte/motion";
  import type { Group, Overview } from "./library-overview";

  let {
    o,
    place,
    flat = false,
    groupNote,
    scope,
    groups,
    colourOf,
    size = null,
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
    describe,
    label,
    legend,
  }: {
    o: Overview;
    /** Where each asset is drawn, three numbers per asset: akm's place, with the depth the page's lens gives it. */
    place: Float32Array;
    /** Every point is in one plane: the view faces it and cannot be turned. */
    flat?: boolean;
    /** What a group's name says after its count: the view's figure for that group. */
    groupNote?: (g: Group) => string;
    scope: readonly number[];
    groups: Group[];
    /** The colour token of an asset in the view. */
    colourOf: (i: number) => string;
    /** The figure a point's size stands for, per asset, with the largest in scope; null draws one size. */
    size?: { label: string; values: ArrayLike<number>; largest: number } | null;
    /** The assets drawn in full; the rest fade. Null: all in full. */
    lit: Set<number> | null;
    /** Lines, each between two assets (by index) or two groups (by key), with a weight from 0 to 1. */
    lines?: Array<{ from: number | string; to: number | string; weight: number; level?: 1 | 2 | 3 }>;
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
    /** What an asset's colour and depth stand for, said after its name on hover and on the pick. */
    describe?: (i: number) => string;
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
  /** How far one key press turns the view, in radians, and how much closer or farther it zooms. */
  const TURN = Math.PI / 12;
  const ZOOM = 0.8;
  /** How many times its plain width a point is drawn for a share (0 to 1) of the largest figure: area grows with it. */
  const grown = (share: number) => 1 + 1.5 * Math.sqrt(share);
  const growOf = (i: number) => (size?.largest ? grown(size.values[i]! / size.largest) : 1);
  /** The figures the size key shows: none, a quarter of the largest, and the largest. */
  const sizeSteps = $derived(size?.largest ? [...new Set([0, Math.round(size.largest / 4), size.largest])] : []);

  let host = $state<HTMLDivElement>();
  let tip = $state<{ x: number; y: number; i: number } | null>(null);
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

  /** The camera where every point drawn fits the frame with a margin, whatever is chosen. */
  export function reset() {
    if (!world) return;
    world.flight = null;
    const low = [Infinity, Infinity, Infinity];
    const high = [-Infinity, -Infinity, -Infinity];
    // Every asset with a place counts, drawn yet or not, so the frame holds as a replay adds points.
    for (let i = 0; i < o.count; i++)
      if (o.group[i]! >= 0)
        for (let d = 0; d < 3; d++) {
          low[d] = Math.min(low[d]!, place[i * 3 + d]!);
          high[d] = Math.max(high[d]!, place[i * 3 + d]!);
        }
    if (low[0] === Infinity) {
      world.camera.position.set(...HOME.position);
      world.controls.target.set(...HOME.target);
    } else {
      const { camera, controls } = world;
      const reach = Math.tan((camera.fov * Math.PI) / 360);
      const away =
        1.12 * Math.max((high[1]! - low[1]!) / 2 / reach, (high[0]! - low[0]!) / 2 / (reach * camera.aspect)) +
        (high[2]! - low[2]!) / 2;
      controls.target.set((low[0]! + high[0]!) / 2, (low[1]! + high[1]!) / 2, (low[2]! + high[2]!) / 2);
      camera.position.copy(controls.target).add(new THREE.Vector3(0, flat ? 0 : away * 0.18, away));
    }
    world.controls.update();
  }

  /** The camera in front of what it looks at, as far away as it is: the selection and the zoom stay. */
  export function faceFront() {
    if (!world) return;
    const { camera, controls } = world;
    fly(controls.target.clone(), new THREE.Vector3(0, 0, camera.position.distanceTo(controls.target)));
  }

  // biome-ignore lint/suspicious/noExplicitAny: three.js is loaded on demand, so its namespace is held untyped here.
  let THREE: any;
  // biome-ignore lint/suspicious/noExplicitAny: see above.
  let world: any = null;

  /** Where each asset is drawn at this moment: `place`, or on the way to it. */
  let now = new Float32Array(0);
  /** Counts each change of `now`, for what is worked out from it. */
  let moved = $state(0);
  /** The middle of each group's assets as drawn, by group key. */
  const centres = $derived.by(() => {
    void moved;
    const found = new Map<string, [number, number, number]>();
    for (const g of groups) {
      const centre: [number, number, number] = [0, 0, 0];
      for (const i of g.members) for (let d = 0; d < 3; d++) centre[d]! += now[i * 3 + d]! / g.members.length;
      found.set(g.key, centre);
    }
    return found;
  });

  /** A geometry holding the places of these assets; it keeps the list, so a move can rewrite it in place. */
  function placesOf(list: readonly number[]) {
    const at = new Float32Array(list.length * 3);
    list.forEach((i, k) => at.set(now.subarray(i * 3, i * 3 + 3), k * 3));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(at, 3));
    geometry.userData.list = list;
    return geometry;
  }
  /** Every point, ring and halo put where `now` has its asset, in the geometry it already has. */
  function redraw() {
    if (!world) return;
    for (const marks of [
      world.points,
      world.bright,
      world.focus,
      world.focusHalo,
      ...world.rings,
      world.under,
      world.underHalo,
      world.pulses,
    ]) {
      const list: readonly number[] | undefined = marks.geometry.userData.list;
      if (!list?.length) continue;
      const position = marks.geometry.getAttribute("position");
      list.forEach((i, k) => position.array.set(now.subarray(i * 3, i * 3 + 3), k * 3));
      position.needsUpdate = true;
      marks.geometry.computeBoundingSphere();
    }
  }

  // The marks move to `place` when it changes, each from where it is, so a change made during a move starts there.
  $effect(() => {
    const to = place;
    if (prefersReducedMotion.current || now.length !== to.length) {
      now = Float32Array.from(to);
      moved = untrack(() => moved) + 1;
      redraw();
      return;
    }
    const from = Float32Array.from(now);
    const start = performance.now();
    let frame = requestAnimationFrame(function step(time: number) {
      const t = Math.min(1, (time - start) / 600);
      const ease = t * (2 - t);
      for (let k = 0; k < to.length; k++) now[k] = from[k]! + (to[k]! - from[k]!) * ease;
      moved++;
      redraw();
      if (t < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  });

  /**
   * The camera moved to look at `target` from `away` beside it, over 0.7 seconds: the direction swings and the distance
   * eases. Under reduced motion it is there at once.
   */
  // biome-ignore lint/suspicious/noExplicitAny: see above.
  function fly(target: any, away: any) {
    const { camera, controls } = world;
    const from = controls.target.clone();
    const began = camera.position.clone().sub(from);
    const swing = new THREE.Quaternion().setFromUnitVectors(began.clone().normalize(), away.clone().normalize());
    const start = performance.now();
    const flight = {};
    world.flight = flight;
    const step = (time: number) => {
      if (world?.flight !== flight) return;
      const t = prefersReducedMotion.current ? 1 : Math.min(1, (time - start) / 700);
      const ease = t * (2 - t);
      controls.target.lerpVectors(from, target, ease);
      camera.position
        .copy(began)
        .applyQuaternion(new THREE.Quaternion().slerp(swing, ease))
        .setLength(began.length() + (away.length() - began.length()) * ease)
        .add(controls.target);
      if (t < 1) requestAnimationFrame(step);
    };
    if (prefersReducedMotion.current) step(start);
    else requestAnimationFrame(step);
  }

  /** The view turned about what it looks at, and moved closer or farther, by the keyboard. */
  function orbit(left: number, up: number, scale: number) {
    const { camera, controls } = world;
    world.flight = null;
    const s = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
    s.theta -= left * TURN;
    s.phi = Math.min(Math.PI - 0.01, Math.max(0.01, s.phi - up * TURN));
    s.radius = Math.min(controls.maxDistance, Math.max(controls.minDistance, s.radius * scale));
    camera.position.setFromSpherical(s).add(controls.target);
  }
  function onKey(event: KeyboardEvent) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const { key, shiftKey } = event;
    const sideways = key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : 0;
    const upward = key === "ArrowUp" ? 1 : key === "ArrowDown" ? -1 : 0;
    const zoom = key === "+" || key === "=" ? ZOOM : key === "-" ? 1 / ZOOM : 0;
    if (sideways && !shiftKey && onStep) onStep(sideways);
    else if (!world) return;
    else if (key === "0") faceFront();
    else if (zoom) orbit(0, 0, zoom);
    else if (!flat && (upward || (sideways && shiftKey))) orbit(shiftKey ? sideways : 0, upward, 1);
    else return;
    event.preventDefault();
  }

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
        // Each point's size is multiplied by its own `grow`, which the stock points shader has no place for.
        // biome-ignore lint/suspicious/noExplicitAny: see above.
        const sized = (material: any) => {
          material.onBeforeCompile = (shader: { vertexShader: string }) => {
            shader.vertexShader = `attribute float grow;\n${shader.vertexShader.replace("gl_PointSize = size;", "gl_PointSize = size * grow;")}`;
          };
          return material;
        };
        const points = new THREE.Points(
          new THREE.BufferGeometry(),
          sized(
            new THREE.PointsMaterial({
              size: SIZE.faded,
              vertexColors: true,
              map: dot,
              alphaTest: 0.5,
              sizeAttenuation: true,
            }),
          ),
        );
        scene.add(points);
        // The lit points again, larger, over the faded rest.
        const bright = new THREE.Points(
          new THREE.BufferGeometry(),
          sized(
            new THREE.PointsMaterial({
              size: SIZE.lit,
              vertexColors: true,
              map: dot,
              alphaTest: 0.5,
              sizeAttenuation: true,
            }),
          ),
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
            const grow = faded ? 1 : growOf(world.order[k]);
            const radius = ((faded ? SIZE.faded : SIZE.lit) * grow * box.height) / 2 / depth / 2;
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
        // A group's name lets the pointer through to the map, so a drag can start on it; a click that lands on a name
        // and on no point chooses its group.
        const nameAt = (clientX: number, clientY: number) =>
          groups.find((g) => {
            const el = nameEls[g.key];
            if (!el || el.style.visibility === "hidden") return false;
            const box = el.getBoundingClientRect();
            return clientX >= box.left && clientX <= box.right && clientY >= box.top && clientY <= box.bottom;
          })?.key;
        let down = { x: 0, y: 0 };
        renderer.domElement.addEventListener(
          "pointerdown",
          (e: PointerEvent) => (down = { x: e.clientX, y: e.clientY }),
        );
        renderer.domElement.addEventListener("pointerup", (e: PointerEvent) => {
          if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return; // a drag, not a click
          const h = hit(e.clientX, e.clientY);
          if (h) onPick?.(h.i);
          else if (onGroup) {
            const key = nameAt(e.clientX, e.clientY);
            if (key) onGroup(key);
          }
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
          tip = h ? { x: e.clientX - box.left, y: e.clientY - box.top + 12, i: h.i } : null;
          renderer.domElement.style.cursor = h || (onGroup && nameAt(e.clientX, e.clientY)) ? "pointer" : "grab";
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
              at.set(now[picked * 3]!, now[picked * 3 + 1]!, now[picked * 3 + 2]!).project(camera);
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
            at.set(...(centres.get(g.key) ?? [0, 0, 0])).project(camera);
            const x = ((at.x + 1) / 2) * w;
            const y = ((1 - at.y) / 2) * h;
            // A name that would lie over one already placed is tried just above and below its group's middle before
            // it is hidden, so a group goes unnamed only where there is no room at all.
            const height = el.offsetHeight + 4;
            let box: [number, number, number, number] = [0, 0, 0, 0];
            let hidden = true;
            for (const shift of [0, -1, 1, -2, 2]) {
              box = [
                x - el.offsetWidth / 2,
                y - el.offsetHeight / 2 + shift * height,
                x + el.offsetWidth / 2,
                y + el.offsetHeight / 2 + shift * height,
              ];
              const free = box;
              hidden =
                at.z >= 1 ||
                ((first(g) > 0 || !!(pickEl && picked >= 0)) &&
                  placed.some((p) => free[0] < p[2] && free[2] > p[0] && free[1] < p[3] && free[3] > p[1]));
              if (!hidden || at.z >= 1) break;
            }
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
    const colour = new Float32Array(order.length * 3);
    const shining: number[] = [];
    order.forEach((i, k) => {
      const c = rgb(colourOf(i));
      const faded = lit && !lit.has(i);
      if (lit && !faded) shining.push(i);
      const f = faded ? 0.8 : 0;
      for (let d = 0; d < 3; d++) colour[k * 3 + d] = c[d]! * (1 - f) + bg[d]! * f;
    });
    const grow = (list: number[]) => new THREE.BufferAttribute(Float32Array.from(list, growOf), 1);
    const glow = placesOf(shining);
    glow.setAttribute("grow", grow(shining));
    glow.setAttribute(
      "color",
      new THREE.BufferAttribute(Float32Array.from(shining.flatMap((i) => rgb(colourOf(i)))), 3),
    );
    world.bright.geometry.dispose();
    world.bright.geometry = glow;
    const geometry = placesOf(order);
    // A faded point is drawn at the plain size: only what is shown carries a figure.
    geometry.setAttribute(
      "grow",
      new THREE.BufferAttribute(
        Float32Array.from(order, (i) => (lit && !lit.has(i) ? 1 : growOf(i))),
        1,
      ),
    );
    geometry.setAttribute("color", new THREE.BufferAttribute(colour, 3));
    world.points.geometry.dispose();
    world.points.geometry = geometry;
    world.order = order;
    // The map opens with its points filling the frame.
    if (!world.framed) {
      world.framed = true;
      untrack(reset);
    }
  });

  // The lines between groups, in the highlight colour, fainter for lighter weights; and, from a pick, the lines of
  // each level, each in its own width and colour. They are redrawn as the marks move.
  $effect(() => {
    if (!ready || !world) return;
    void moved;
    const end = (at: number | string) => (typeof at === "number" ? now.subarray(at * 3, at * 3 + 3) : centres.get(at));
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
        const from = end(l.from);
        const to = end(l.to);
        if (!from || !to) continue;
        place.push(from[0]!, from[1]!, from[2]!, to[0]!, to[1]!, to[2]!);
        for (let k = 0; k < 2; k++) colour.push(...Array.from(colourOf(l)));
      }
      object.visible = place.length > 0;
      if (!place.length) return;
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

  // Flattened, the view faces the plane and a drag moves it, as it cannot be turned; and nothing glides under reduced
  // motion.
  $effect(() => {
    if (!ready || !world) return;
    world.controls.enableRotate = !flat;
    world.controls.mouseButtons.LEFT = flat ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
    world.controls.enableDamping = !prefersReducedMotion.current;
    if (flat) untrack(faceFront);
  });

  // A pick turns the view to it: an asset close up, a group so it fills the view. A change of depth follows it.
  $effect(() => {
    if (!ready || !world) return;
    const group = groups.find((g) => g.key === selected);
    if (picked < 0 && !group) return;
    const at = (i: number) => new THREE.Vector3(...place.subarray(i * 3, i * 3 + 3));
    const target = picked >= 0 ? at(picked) : new THREE.Vector3();
    if (picked < 0) for (const i of group!.members) target.addScaledVector(at(i), 1 / group!.members.length);
    // A pick is framed from 170 units away, so its neighbours stay in view, or farther when its first two levels reach beyond that.
    const reachOut = untrack(() =>
      Math.max(0, ...levels.slice(0, 2).flatMap((list) => list.map((i) => target.distanceTo(at(i))))),
    );
    const { camera, controls } = world;
    const away = (flat ? new THREE.Vector3(0, 0, 1) : camera.position.clone().sub(controls.target)).setLength(
      picked >= 0 ? Math.min(400, Math.max(170, 1.4 * reachOut)) : Math.max(170, 40 * Math.cbrt(group!.members.length)),
    );
    untrack(() => fly(target, away));
  });
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class="stage-3d"
  bind:this={host}
  role="group"
  aria-label={`${label}${onStep ? " The left and right arrow keys step to the previous or next asset." : ""}${flat ? "" : " The up and down arrow keys, and Shift with left and right, turn the view."} Plus and minus zoom, and 0 faces the front.`}
  tabindex="0"
  onkeydown={onKey}
>
  {#if failed}<p class="notice notice-warn">{failed}</p>{/if}
  {#snippet name(g: Group)}{g.label}<span>{g.members.length.toLocaleString()}</span>{#if groupNote?.(g)}<span
        class="note">{groupNote(g)}</span
      >{/if}{/snippet}
  {#each groups as g (g.key)}
    {#if onGroup}<button
        class="group-name"
        class:chosen={selected === g.key}
        bind:this={nameEls[g.key]}
        onclick={() => onGroup(g.key)}>{@render name(g)}</button
      >{:else}<span class="group-name" bind:this={nameEls[g.key]}>{@render name(g)}</span>{/if}
  {/each}
  {#if sizeSteps.length || legend}<div class="stage-legend">
      {#if sizeSteps.length}<div class="scale size-key">
          <span class="cap">Size: {size!.label}</span>
          <ol>
            {#each sizeSteps as step}<li>
                <i
                  style={`inline-size:${7 * grown(step / size!.largest)}px;block-size:${7 * grown(step / size!.largest)}px`}
                ></i>{step.toLocaleString()}
              </li>{/each}
          </ol>
        </div>{/if}
      {@render legend?.()}
    </div>{/if}
  <div class="view-buttons">
    <button title="Zoom in (+)" aria-label="Zoom in" onclick={() => world && orbit(0, 0, ZOOM)}>+</button>
    <button title="Zoom out (−)" aria-label="Zoom out" onclick={() => world && orbit(0, 0, 1 / ZOOM)}>−</button>
    <button title="The view back to where the map opens" onclick={reset}>Reset view</button>
  </div>
  {#snippet named(i: number)}<span class="ref">{o.ref[i]}</span>{#if describe?.(i)}<span class="value"
        >{` · ${describe(i)}`}</span
      >{/if}{/snippet}
  {#if picked >= 0}<div class="pick-label" bind:this={pickEl}>{@render named(picked)}</div>{/if}
  {#if tip}<div
      class="tip"
      style={`${tip.y > host!.clientHeight - 40 ? `bottom:${host!.clientHeight - tip.y + 24}px` : `top:${tip.y}px`};${tip.x < host!.clientWidth / 2 ? `left:${tip.x + 12}px` : `right:${host!.clientWidth - tip.x + 12}px`}`}
    >
      {@render named(tip.i)}
    </div>{/if}
</div>

<style>
  .stage-3d {
    position: relative;
    inline-size: 100%;
    block-size: var(--stage-size, min(74vh, 800px));
    min-block-size: min(420px, var(--stage-size, 420px));
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
    max-inline-size: min(44rem, calc(100% - 17rem));
    pointer-events: none;
    background: color-mix(in srgb, var(--surface) 94%, transparent);
    border: 1px solid var(--border);
    border-radius: 6px;
    empty-cells: hide;
  }
  .scale {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 12px;
    align-items: center;
    padding: 6px 10px;
    font-size: var(--text-xs);
  }
  .scale .cap {
    font-weight: 600;
  }
  .scale ol {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 12px;
    align-items: center;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .scale li {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .scale i {
    flex: none;
    border-radius: 50%;
    background: var(--muted);
  }
  .view-buttons {
    position: absolute;
    inset-block-end: 8px;
    inset-inline-end: 8px;
    z-index: 2;
    display: flex;
    gap: 4px;
  }
  .view-buttons button {
    min-inline-size: 32px;
    block-size: 32px;
    padding: 0 8px;
    font: inherit;
    font-size: var(--text-xs);
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    cursor: pointer;
  }
  .view-buttons button:hover {
    background: var(--surface-2);
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
  .value {
    font-weight: 400;
    color: var(--muted);
  }
  /* A group's name is plain text over its points, haloed in the background colour so it reads without a box that
     would hide them. The pointer passes through it to the map; the keyboard still reaches it. */
  .group-name {
    position: absolute;
    inset-block-start: 0;
    inset-inline-start: 0;
    display: flex;
    gap: 5px;
    align-items: baseline;
    padding: 0 2px;
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    line-height: 1.3;
    white-space: nowrap;
    color: var(--text);
    background: none;
    border: 0;
    border-radius: 3px;
    text-shadow:
      0 0 3px var(--bg),
      0 0 3px var(--bg),
      0 0 6px var(--bg);
    pointer-events: none;
    will-change: transform;
    transition: opacity 0.2s;
  }
  .group-name span {
    font-weight: 400;
    color: var(--muted);
  }
  .group-name .note {
    color: var(--text);
  }
  .group-name .note::before {
    content: "· ";
    color: var(--muted);
  }
  .group-name.chosen {
    text-decoration: underline;
    text-decoration-color: var(--map-highlight);
    text-decoration-thickness: 2px;
    text-underline-offset: 3px;
  }
  .group-name:focus-visible {
    outline: 2px solid var(--map-highlight);
    outline-offset: 1px;
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
