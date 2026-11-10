<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { countAxis } from "./client";
  let {
    heading,
    description,
    labels = [],
    series = [],
  }: {
    heading: string;
    description: string;
    labels?: string[];
    series?: Array<{ name: string; values: number[]; color: string }>;
  } = $props();
  const axis = $derived(countAxis(Math.max(1, ...series.flatMap((s) => s.values))));
  const maximum = $derived(axis.maximum);
  const hasData = $derived(series.some((s) => s.values.some((value) => value > 0)));
  const step = $derived(640 / Math.max(1, labels.length));
</script>

<section class="trend-section">
  <h2>{heading}</h2>
  <p class="muted">{description}</p>
  {#if hasData}
    <div class="chart-legend">
      {#each series as s}<span><i style:background={s.color}></i>{s.name}</span>{/each}
    </div>
    <svg
      class="trend-chart"
      viewBox="0 0 730 220"
      role="img"
      aria-label={`${heading}. ${labels.length} time periods. Exact values available in the data table.`}
    >
      <title>{heading}</title>
      {#each axis.ticks as tick}<line
          x1="55"
          x2="695"
          y1={175 - (tick / maximum) * 150}
          y2={175 - (tick / maximum) * 150}
          stroke="#e1e7e2"
        /><text x="45" y={180 - (tick / maximum) * 150} text-anchor="end">{tick}</text>{/each}
      {#each labels as label, i}{#each series as s, j}<rect
            x={55 + i * step + (j * step * 0.72) / series.length + step * 0.08}
            y={175 - ((s.values[i] ?? 0) / maximum) * 150}
            width={Math.max(1, (step * 0.68) / series.length)}
            height={((s.values[i] ?? 0) / maximum) * 150}
            fill={s.color}><title>{label}: {s.name} {s.values[i] ?? 0}</title></rect
          >{/each}{/each}
      {#if labels.length}<text x="55" y="205">{labels[0]}</text><text x="695" y="205" text-anchor="end"
          >{labels[labels.length - 1]}</text
        >{/if}
    </svg>
    <details>
      <summary>View exact chart data</summary>
      <table>
        <thead
          ><tr
            ><th>Period</th>{#each series as s}<th>{s.name}</th>{/each}</tr
          ></thead
        ><tbody
          >{#each labels as label, i}<tr
              ><td>{label}</td>{#each series as s}<td>{s.values[i] ?? 0}</td>{/each}</tr
            >{/each}</tbody
        >
      </table>
    </details>
  {:else}<p class="quiet-empty">
      No recorded activity in this window. A chart will appear when measurements are available.
    </p>{/if}
</section>
