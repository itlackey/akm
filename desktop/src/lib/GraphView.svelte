<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

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
  }: {
    /** What `createGraphView` draws; the page keeps a reference and changes it through the view. */
    data: Record<string, unknown>;
    label: string;
    onReady: (view: View) => void;
    /** Called with the token colours on mount and whenever the appearance changes, so the page can recolour. */
    onTheme?: (read: (token: string) => number[]) => void;
  } = $props();
  let canvas = $state<HTMLCanvasElement>();
  let labels = $state<HTMLCanvasElement>();
  let failed = $state("");
  let view: View;
  let probe: HTMLSpanElement;

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
      onReady(view);
    } catch {
      failed = "This view needs WebGL 2, which this window does not have. The table lists the same assets.";
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

<div class="graph-stage">
  <span class="probe" bind:this={probe} aria-hidden="true"></span>
  {#if failed}<p class="notice notice-warn">{failed}</p>{/if}
  <canvas bind:this={canvas} aria-label={label} hidden={!!failed}></canvas>
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
