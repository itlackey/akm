<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import Icon from "./Icon.svelte";
  import { OUTCOME_LABEL, OUTCOMES, type OutcomeRow } from "./run-model";

  /** How the recorded runs of each kind ended, as one bar of the outcomes per kind. The counts are in the text. */
  let { rows, oninspect }: { rows: OutcomeRow[]; oninspect: (task: string) => void } = $props();
  const total = (row: OutcomeRow) => OUTCOMES.reduce((sum, key) => sum + row.counts[key], 0);
  const shown = $derived(OUTCOMES.filter((key) => rows.some((row) => row.counts[key] > 0)));
</script>

<section class="outcomes" aria-labelledby="outcomes-title">
  <h2 id="outcomes-title">How runs ended in this window</h2>
  <ul class="outcome-list">
    {#each rows as row}{@const n = total(row)}
      <li>
        <span class="outcome-name">{row.label}</span>
        {#if n}<span
            class="bar"
            role="img"
            aria-label={`${row.label}: ${OUTCOMES.filter((key) => row.counts[key])
              .map((key) => `${row.counts[key]} ${OUTCOME_LABEL[key].toLowerCase()}`)
              .join(", ")}`}
            >{#each OUTCOMES as key}{#if row.counts[key]}<span class={`seg ${key}`} style={`flex:${row.counts[key]}`}
                ></span>{/if}{/each}</span
          >
          <span class="outcome-counts num"
            >{OUTCOMES.filter((key) => row.counts[key])
              .map((key) => `${row.counts[key]} ${OUTCOME_LABEL[key].toLowerCase()}`)
              .join(" · ")}</span
          >{:else}<span class="muted">No runs recorded</span>{/if}
        {#if row.failed?.length}<span class="outcome-failed"
            >{#each row.failed as task}<button class="btn-quiet" onclick={() => oninspect(task)}
                >Inspect failed task {task}<Icon name="arrow-right" size={16} /></button
              >{/each}</span
          >{/if}
        {#if row.note}<span class="muted small outcome-note">{row.note}</span>{/if}
      </li>{/each}
  </ul>
  <ul class="outcome-key" aria-label="Outcome key">
    {#each shown as key}<li><span class={`swatch ${key}`} aria-hidden="true"></span>{OUTCOME_LABEL[key]}</li>{/each}
  </ul>
  <p class="muted small">
    No error recorded is Unknown, not Completed: a run still active, blocked, or with no recorded end is Unknown.
  </p>
</section>

<style>
  .outcomes {
    margin-block: 1rem 2rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--border);
  }
  .outcomes h2 {
    font-size: 1.125rem;
    margin: 0 0 0.75rem;
  }
  .outcome-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.75rem;
  }
  .outcome-list li {
    display: grid;
    grid-template-columns: 8rem minmax(8rem, 1fr) minmax(10rem, max-content);
    align-items: center;
    gap: 0.25rem 1rem;
  }
  .outcome-name {
    font-weight: 600;
  }
  .bar {
    display: flex;
    gap: 2px;
    block-size: 0.75rem;
  }
  .seg {
    border-radius: 0 3px 3px 0;
    min-inline-size: 4px;
  }
  .seg:first-child {
    border-radius: 3px;
  }
  .seg.completed,
  .swatch.completed {
    background: var(--ok);
  }
  .seg.failed,
  .swatch.failed {
    background: var(--fail);
  }
  .seg.terminated,
  .swatch.terminated {
    background: var(--warn);
  }
  .seg.unknown,
  .swatch.unknown {
    background: repeating-linear-gradient(135deg, var(--muted) 0 2px, transparent 2px 5px);
    outline: 1px solid var(--muted);
    outline-offset: -1px;
  }
  .outcome-failed,
  .outcome-note {
    grid-column: 2 / -1;
  }
  .outcome-failed {
    display: flex;
    flex-wrap: wrap;
    gap: 0 1rem;
  }
  .outcome-key {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 1.25rem;
    list-style: none;
    margin: 0.75rem 0 0;
    padding: 0;
    font-size: 0.8125rem;
    color: var(--muted);
  }
  .outcome-key li {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .swatch {
    inline-size: 0.9rem;
    block-size: 0.5rem;
  }
  @media (max-width: 760px) {
    .outcome-list li {
      grid-template-columns: 1fr;
    }
    .outcome-failed,
    .outcome-note {
      grid-column: 1;
    }
  }
</style>
