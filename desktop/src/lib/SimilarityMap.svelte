<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  // Every asset in scope as a point in 3D (three.js), placed by akm so alike assets sit close, in groups by meaning,
  // each group named over its middle by a label that stays the same size on screen. Drag turns it, the wheel zooms, a point names its asset on hover; choosing a point
  // or a group's name picks it, and the lines show what the pick is joined to.
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

  let host = $state<HTMLDivElement>();
  let tip = $state<{ x: number; y: number; text: string } | null>(null);
  let failed = $state("");
  /** Set once three.js has loaded and the scene is up; the effects below draw into it. */
  let ready = $state(false);
  /** The group name labels, by group key. */
  const nameEls: Record<string, HTMLButtonElement> = $state({});
  const largest = $derived(Math.max(1, ...groups.map((g) => g.members.length)));

  // biome-ignore lint/suspicious/noExplicitAny: three.js is loaded on demand, so its namespace is held untyped here.
  let THREE: any;
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
    (async () => {
      try {
        const [three, { OrbitControls }] = await Promise.all([
          import("three"),
          import("three/examples/jsm/controls/OrbitControls.js"),
        ]);
        if (gone || !host) return;
        THREE = three;
        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
        renderer.setSize(host.clientWidth, host.clientHeight);
        host.prepend(renderer.domElement);
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(...rgb("--bg"));
        const camera = new THREE.PerspectiveCamera(50, host.clientWidth / host.clientHeight, 1, 5000);
        camera.position.set(0, 60, 330);
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        // A round dot for each point.
        const dot = document.createElement("canvas");
        dot.width = dot.height = 64;
        const ctx = dot.getContext("2d")!;
        ctx.beginPath();
        ctx.arc(32, 32, 28, 0, Math.PI * 2);
        ctx.fillStyle = "#fff";
        ctx.fill();
        const points = new THREE.Points(
          new THREE.BufferGeometry(),
          new THREE.PointsMaterial({
            size: 2.6,
            vertexColors: true,
            map: new THREE.CanvasTexture(dot),
            alphaTest: 0.5,
            sizeAttenuation: true,
          }),
        );
        scene.add(points);
        const joins = new THREE.LineSegments(
          new THREE.BufferGeometry(),
          new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 }),
        );
        scene.add(joins);
        const raycaster = new THREE.Raycaster();
        raycaster.params.Points.threshold = 1.6;
        world = {
          renderer,
          scene,
          camera,
          controls,
          points,
          joins,
          raycaster,
          order: [] as number[],
        };

        const pointer = new THREE.Vector2();
        const hit = (event: PointerEvent) => {
          const box = renderer.domElement.getBoundingClientRect();
          pointer.set(
            ((event.clientX - box.left) / box.width) * 2 - 1,
            -((event.clientY - box.top) / box.height) * 2 + 1,
          );
          raycaster.setFromCamera(pointer, camera);
          const point = raycaster.intersectObject(points)[0];
          return point ? { i: world.order[point.index] as number } : null;
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
          tip = h ? { x: e.clientX - box.left + 12, y: e.clientY - box.top + 12, text: o.ref[h.i]! } : null;
          renderer.domElement.style.cursor = h ? "pointer" : "grab";
        });
        renderer.domElement.addEventListener("pointerleave", () => (tip = null));
        resize = new ResizeObserver(() => {
          if (!host) return;
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
            el.style.opacity = selected && first(g) === 2 ? "0.45" : "1";
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
    order.forEach((i, k) => {
      place.set(o.place.subarray(i * 3, i * 3 + 3), k * 3);
      const c = rgb(colourOf(i));
      const f = lit && !lit.has(i) ? 0.85 : 0;
      for (let d = 0; d < 3; d++) colour[k * 3 + d] = c[d]! * (1 - f) + bg[d]! * f;
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(place, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colour, 3));
    world.points.geometry.dispose();
    world.points.geometry = geometry;
    world.order = order;
  });

  // The lines, in the accent colour, fainter for lighter weights.
  $effect(() => {
    if (!ready || !world) return;
    const accent = rgb("--accent");
    const bg = rgb("--bg");
    const place = new Float32Array(lines.length * 6);
    const colour = new Float32Array(lines.length * 6);
    lines.forEach((l, k) => {
      place.set([l.from[0]!, l.from[1]!, l.from[2]!, l.to[0]!, l.to[1]!, l.to[2]!], k * 6);
      const f = 0.75 * (1 - l.weight);
      for (let end = 0; end < 2; end++)
        for (let d = 0; d < 3; d++) colour[k * 6 + end * 3 + d] = accent[d]! * (1 - f) + bg[d]! * f;
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(place, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colour, 3));
    world.joins.geometry.dispose();
    world.joins.geometry = geometry;
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
    const step = (now: number) => {
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
      style={`font-size:${11 + 4 * Math.sqrt(g.members.length / largest)}px`}
      onclick={() => onGroup(g.key)}>{g.label}<span>{g.members.length.toLocaleString()}</span></button
    >{/each}
  {#if tip}<div class="tip" style={`left:${tip.x}px;top:${tip.y}px`}>{tip.text}</div>{/if}
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
    padding: 1px 6px;
    font-weight: 600;
    line-height: 1.3;
    white-space: nowrap;
    color: var(--text);
    background: color-mix(in srgb, var(--surface) 78%, transparent);
    border: 1px solid transparent;
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
    border-color: var(--accent);
    background: var(--surface);
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
