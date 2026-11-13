<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts" module>
  let instances = 0;
</script>

<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { createGraphView } from "./ui/graph-gl.js";

  export type Theme = { dark: boolean; background: number[]; ink: string; paper: string };
  // biome-ignore lint/suspicious/noExplicitAny: the renderer is untyped presentation code.
  type View = any;
  let {
    data,
    label,
    onReady,
    onTheme,
    fallback = "This view needs WebGL 2, which this window does not have. The table lists the same assets.",
  }: {
    /** What `createGraphView` draws; the page keeps a reference and changes it through the view. */
    data: Record<string, unknown>;
    label: string;
    onReady: (view: View) => void;
    /** Called with the token colours on mount and whenever the appearance changes, so the page can recolour. */
    onTheme?: (read: (token: string) => number[]) => void;
    /** What the page says when the window has no WebGL 2: what still works without the drawing. */
    fallback?: string;
  } = $props();
  let canvas = $state<HTMLCanvasElement>();
  let labels = $state<HTMLCanvasElement>();
  let failed = $state("");
  /** What a screen reader is told as the keyboard cursor moves and the selection changes. */
  let live = $state("");
  let view: View;
  let probe: HTMLSpanElement;
  let stage: HTMLDivElement;
  const hintId = `graph-keys-${++instances}`;

  /** Select an asset as a click on it would, and put the camera on it: for a table row's "show on map". */
  export function select(index: number) {
    view?.onPick(index);
    if (index >= 0) view?.focus(index);
  }
  /** Fly to an asset and put the keyboard cursor on it without selecting it. */
  export function focus(index: number) {
    view?.focus(index);
  }
  /** Frame the drawn assets (or just these) in the view. */
  export function fit(indices?: number[]) {
    return view?.fit(indices);
  }

  /** Overlays the page lays over the canvas (legend, hint): labels keep clear of them. */
  function overlays(): number[][] {
    const at = canvas!.getBoundingClientRect();
    const out: number[][] = [];
    for (const el of stage.parentElement?.children ?? []) {
      if (el === stage || el.hasAttribute("hidden")) continue;
      const style = getComputedStyle(el);
      if (style.position !== "absolute" || style.pointerEvents === "none") continue;
      const r = el.getBoundingClientRect();
      out.push([r.left - at.left - 4, r.top - at.top - 4, r.right - at.left + 4, r.bottom - at.top + 4]);
    }
    return out;
  }

  /** A design token's colour as [r, g, b], read the way chart-view.js reads one: through a probe element. */
  function read(token: string): number[] {
    probe.style.color = `var(${token})`;
    const match = getComputedStyle(probe).color.match(/[\d.]+/g) ?? ["0", "0", "0"];
    return match.slice(0, 3).map(Number);
  }
  function theme(): Theme {
    const background = read("--bg");
    const ink = read("--text");
    const dark = background[0]! + background[1]! + background[2]! < 384;
    return {
      dark,
      background,
      ink: `rgb(${ink.join(",")})`,
      paper: `rgba(${background.join(",")},0.82)`,
    };
  }
  function retheme() {
    view?.setTheme(theme());
    onTheme?.(read);
  }
  const scheme = matchMedia("(prefers-color-scheme: dark)");
  const appearance = new MutationObserver(retheme);

  onMount(() => {
    try {
      onTheme?.(read);
      view = createGraphView({ canvas, labels, data, theme: theme() });
      view.avoid = overlays;
      view.onAnnounce = (text: string) => (live = text);
      onReady(view);
    } catch {
      failed = fallback;
    }
    scheme.addEventListener("change", retheme);
    appearance.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  });
  onDestroy(() => {
    scheme.removeEventListener("change", retheme);
    appearance.disconnect();
    view?.destroy();
  });
</script>

<div class="graph-stage" bind:this={stage}>
  <span class="probe" bind:this={probe} aria-hidden="true"></span>
  <span id={hintId} class="sr-only"
    >Press [ and ] to move between assets, Enter to select the one in focus, Escape to clear the selection.</span
  >
  <span class="sr-only" role="status" aria-live="polite">{live}</span>
  {#if failed}<p class="notice notice-warn">{failed}</p>{/if}
  <canvas bind:this={canvas} aria-label={label} aria-describedby={hintId} hidden={!!failed}></canvas>
  <canvas class="labels" bind:this={labels} aria-hidden="true" hidden={!!failed}></canvas>
</div>

<style>
  .graph-stage {
    position: relative;
    inline-size: 100%;
    block-size: 100%;
    min-block-size: 0;
  }
  canvas {
    position: absolute;
    inset: 0;
    inline-size: 100%;
    block-size: 100%;
    display: block;
    cursor: grab;
    touch-action: none;
  }
  canvas.labels {
    pointer-events: none;
  }
  .probe {
    position: absolute;
    visibility: hidden;
    pointer-events: none;
  }
</style>
