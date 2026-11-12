<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { onDestroy, tick, untrack, type Snippet } from "svelte";
  import { chart } from "./ui/chart-view.js";
  import { mount } from "./ui/lib.js";
  let {
    id,
    heading,
    description = "",
    option,
    height = undefined,
    rows = undefined,
    onSelect = undefined,
    legend = [],
    initialView = "chart",
    controls,
    children,
  }: {
    id: string;
    heading: string;
    description?: string;
    option: (token: (name: string) => string) => Record<string, unknown>;
    height?: "short" | "strip";
    /** As tall as this many category rows, for a chart with one row per thing. */
    rows?: number;
    onSelect?: (event: { dataIndex: number; seriesIndex: number; data?: unknown }) => void;
    legend?: Array<{ name: string; index: number; marker?: boolean; band?: boolean }>;
    initialView?: "chart" | "table";
    /** Controls beside the Chart / Table switch. */
    controls?: Snippet;
    /** The table of the same figures. */
    children?: Snippet;
  } = $props();
  let view = $state(untrack(() => initialView));
  let root = $state<HTMLDivElement>();
  let dispose: Array<() => void> = [];
  function draw(build: typeof option) {
    const element = root;
    if (!element) return;
    dispose.forEach((stop) => stop());
    const context = { after: [] as Array<(element: HTMLElement) => (() => void) | void> };
    mount(
      element,
      chart(context, id, `${heading}. ${description} Use Table for exact values and record links.`, build, {
        height,
        rows,
        onSelect,
      }),
    );
    dispose = context.after
      .map((callback) => callback(element))
      .filter((value): value is () => void => typeof value === "function");
  }
  // Draw once the element exists, and again whenever the builder or the number of rows changes.
  $effect(() => {
    const build = option;
    void rows;
    untrack(() => draw(build));
  });
  async function changeView(next: "chart" | "table") {
    view = next;
    await tick();
    if (next === "chart") draw(option);
  }
  onDestroy(() => dispose.forEach((stop) => stop()));
</script>

<section class="chart-card" aria-label={heading}>
  <header class="chart-heading">
    <h2>{heading}</h2>
    <div class="chart-tools">
      {@render controls?.()}
      <div class="chart-views" role="group" aria-label={`${heading} view`}>
        <button class="btn-quiet" aria-pressed={view === "chart"} onclick={() => changeView("chart")}>Chart</button
        ><button class="btn-quiet" aria-pressed={view === "table"} onclick={() => changeView("table")}>Table</button>
      </div>
    </div>
  </header>
  {#if description}<p class="muted small">{description}</p>{/if}
  <div hidden={view !== "chart"}>
    {#if legend.length}<ul class="chart-legend" aria-label={`${heading} legend`}>
        {#each legend as item}<li>
            <span
              class="legend-swatch"
              class:band={item.band}
              style={`background:var(${item.marker ? "--marker" : `--s${item.index + 1}`})`}
              aria-hidden="true"
            ></span>{item.name}
          </li>{/each}
      </ul>{/if}
    <div bind:this={root}></div>
  </div>
  <div class="table-wrap chart-data" hidden={view !== "table"}>{@render children?.()}</div>
</section>

<style>
  .chart-card {
    min-width: 0;
  }
  .chart-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }
  .chart-heading h2 {
    margin: 0;
    font-size: 1.125rem;
  }
  .chart-tools {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 1rem;
  }
  .chart-views {
    display: flex;
    gap: 0.25rem;
  }
  .chart-views button {
    color: var(--muted);
    font-size: 0.8125rem;
  }
  .chart-views button[aria-pressed="true"] {
    color: var(--text);
    background: var(--surface-2);
  }
  [hidden] {
    display: none;
  }
  .table-wrap {
    overflow-x: auto;
  }
  .chart-data {
    margin-top: 1rem;
  }
  .chart-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1.25rem;
    list-style: none;
    margin: 0.75rem 0;
    padding: 0;
    font-size: 0.8125rem;
    color: var(--muted);
  }
  .chart-legend li {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }
  .legend-swatch {
    display: inline-block;
    inline-size: 0.75rem;
    block-size: 0.45rem;
    flex: none;
  }
  .legend-swatch.band {
    opacity: 0.25;
    block-size: 0.65rem;
  }
</style>
