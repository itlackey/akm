<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { api, date } from "./client";
  import { duration } from "./activity-presenter";
  import type { WorkflowTrace } from "./activity-types";
  import { traceRows, type TraceRow } from "./workflow-trace-model";
  import { statusOutcome } from "./run-model";
  import Outcome from "./Outcome.svelte";
  import RunFacts from "./RunFacts.svelte";

  let { id }: { id: string } = $props();
  let trace = $state<WorkflowTrace | null>(null);
  let error = $state("");
  let selected = $state<TraceRow | null>(null);
  let width = $state(720);
  let request = 0;

  $effect(() => {
    const mine = ++request;
    const runId = id;
    trace = null;
    error = "";
    selected = null;
    api<WorkflowTrace>("/workflows/run", { id: runId }).then(
      (next) => {
        if (mine === request) trace = next;
      },
      (cause) => {
        if (mine === request) error = (cause as Error).message;
      },
    );
  });

  const layout = $derived(trace ? traceRows(trace) : null);
  const LEFT = 230;
  const ROW = 24;
  const x = (ms: number) =>
    layout
      ? LEFT + ((ms - layout.start) / Math.max(1, layout.end - layout.start)) * (Math.max(width, 600) - LEFT - 16)
      : 0;
  const ticks = $derived.by(() => {
    if (!layout) return [];
    const span = layout.end - layout.start;
    const step = [1, 5, 10, 30, 60, 300, 600, 1800, 3600].map((s) => s * 1000).find((s) => span / s <= 10) ?? 7200_000;
    return Array.from({ length: Math.floor(span / step) + 1 }, (_, k) => layout.start + k * step);
  });
  const mmss = (ms: number) => {
    const s = Math.round(ms / 1000);
    return s >= 3600
      ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
      : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const WORD: Record<string, string> = {
    completed: "Completed",
    failed: "Failed",
    running: "Running",
    pending: "Not started",
    skipped: "Skipped",
    active: "Running",
    blocked: "Blocked",
  };
</script>

<section id="workflow-trace" class="activity-section trace" tabindex="-1" aria-label="Workflow run trace">
  {#if error}<div class="notice notice-warn" role="alert">{error}</div>
  {:else if !trace || !layout}<p class="muted" role="status">Loading the run…</p>
  {:else}
    <header class="trace-head">
      <h2>{trace.run.workflowTitle || trace.run.workflowRef}</h2>
      <Outcome
        outcome={statusOutcome(trace.run.status)}
        detail={trace.run.status === "completed" || trace.run.status === "failed"
          ? ""
          : (WORD[trace.run.status] ?? trace.run.status).toLowerCase()}
      />
      <span class="mono muted small">{trace.run.workflowRef} · {trace.run.id}</span>
    </header>
    <p class="muted small">
      Started {date(trace.run.createdAt)}{trace.run.agentHarness ? ` by ${trace.run.agentHarness}` : ""}. {layout.done}
      of {layout.units} units finished, {layout.tokens} tokens. A step has no start time of its own in akm: its span is its
      units'.
    </p>
    <RunFacts {trace} />
    <ol class="steps">
      {#each layout.steps as step, i}<li data-status={step.status}>
          <span class="muted small">Step {i + 1}</span>
          <strong>{step.title}</strong>
          <span class="small"
            >{WORD[step.status] ?? step.status}{step.failed ? ` · ${step.failed} unit failed` : ""}</span
          >
          <span class="muted small"
            >{step.units} unit{step.units === 1 ? "" : "s"}{step.span === null ? "" : ` · ${mmss(step.span)}`}</span
          >
        </li>{/each}
    </ol>
    <div class="trace-chart" bind:clientWidth={width}>
      {#if trace.units.length}<svg
          width={Math.max(width, 600)}
          height={layout.rows.length * ROW + 40}
          role="group"
          aria-label="Every unit and attempt of this run on one clock"
        >
          <defs
            ><pattern id="trace-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"
              ><rect width="2" height="5" class="hatch" /></pattern
            ></defs
          >
          {#each ticks as tick}<line
              class="grid"
              x1={x(tick)}
              x2={x(tick)}
              y1="20"
              y2={layout.rows.length * ROW + 30}
            /><text class="tick" x={x(tick)} y="12" text-anchor="middle">{mmss(tick - layout.start)}</text>{/each}
          {#each layout.rows as row, r}
            {@const y = 24 + r * ROW}
            {#if row.kind === "step"}<rect class="band" x="0" {y} width={Math.max(width, 600)} height={ROW - 4} /><text
                class="step-name"
                x="8"
                y={y + 14}>{row.label}</text
              >{:else}<g
                class="row"
                class:sel={selected === row}
                role="button"
                tabindex="0"
                aria-label={`${row.label}, ${WORD[row.status] ?? row.status}`}
                onclick={() => (selected = row)}
                onkeydown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    selected = row;
                  }
                }}
                ><rect class="hit" x="0" y={y - 2} width={Math.max(width, 600)} height={ROW} /><text x="22" y={y + 13}
                  >{row.label.length > 30 ? `${row.label.slice(0, 29)}…` : row.label}</text
                >{#each row.attempts as attempt}<rect
                    class={`bar ${attempt.cls}`}
                    x={x(attempt.from)}
                    y={y + 3}
                    width={Math.max(3, x(attempt.to) - x(attempt.from))}
                    height={ROW - 10}
                    rx="2"><title>{attempt.title}</title></rect
                  >{/each}</g
              >{/if}
          {/each}
        </svg>{:else}<p>No units recorded for this run yet.</p>{/if}
    </div>
    <ul class="key">
      <li><span class="swatch ok"></span>Completed attempt</li>
      <li><span class="swatch fail"></span>Failed attempt (hatched)</li>
      <li><span class="swatch running"></span>Running</li>
      <li><span class="swatch gate"></span>Gate check by a judge</li>
    </ul>
    {#if selected && selected.kind === "unit"}<div class="unit-detail" aria-live="polite">
        <h3>{selected.label}</h3>
        <dl>
          <dt>Status</dt>
          <dd>{WORD[selected.status] ?? selected.status}</dd>
          <dt>Runner</dt>
          <dd>{selected.unit.runtimeKind ?? "Not recorded"}{selected.unit.phase === "gate" ? " (gate)" : ""}</dd>
          <dt>Engine</dt>
          <dd>{selected.unit.engine ?? "None"}</dd>
          <dt>Tokens</dt>
          <dd>{selected.unit.tokens ?? "Not reported"}</dd>
        </dl>
        <table>
          <caption>Attempts</caption>
          <thead><tr><th>#</th><th>Started</th><th>Took</th><th>Outcome</th></tr></thead>
          <tbody
            >{#each selected.unit.attempts as attempt}<tr
                ><td>{attempt.attempt}</td><td>{date(attempt.startedAt)}</td><td
                  >{attempt.finishedAt
                    ? duration(Date.parse(attempt.finishedAt) - Date.parse(attempt.startedAt))
                    : "Running"}</td
                ><td
                  >{WORD[attempt.status] ?? attempt.status}{attempt.failureReason
                    ? ` · ${attempt.failureReason}`
                    : ""}</td
                ></tr
              >{/each}</tbody
          >
        </table>
        {#if selected.unit.diagnostic}<details>
            <summary>What the unit reported</summary>
            <pre class="code">{selected.unit.diagnostic}</pre>
          </details>{/if}
      </div>{/if}
    {#if trace.children.length}<p class="muted small">
        Child runs: {#each trace.children as child, i}{i ? ", " : ""}<a
            href={`/activity/overview?view=runs&run=${encodeURIComponent(child.runId)}&anchor=workflow-trace`}
            >{child.workflowRef}</a
          >{/each}
      </p>{/if}
  {/if}
</section>

<style>
  .trace-head {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 12px;
    align-items: baseline;
  }
  .trace-head h2 {
    margin: 0;
  }
  .steps {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    list-style: none;
    padding: 0;
    margin: 12px 0;
  }
  .steps li {
    flex: 1 1 0;
    min-inline-size: 9rem;
    display: grid;
    gap: 2px;
    padding: 10px;
    border: 1px solid var(--border);
    background: var(--surface);
    box-shadow: var(--edge-accent);
  }
  .steps li[data-status="completed"] {
    box-shadow: var(--edge-ok);
  }
  .steps li[data-status="failed"],
  .steps li[data-status="blocked"] {
    box-shadow: var(--edge-fail);
  }
  .steps li[data-status="pending"] {
    box-shadow: none;
    border-style: dashed;
    color: var(--muted);
  }
  .trace-chart {
    overflow-x: auto;
  }
  svg text {
    font-size: 12px;
    fill: var(--text);
  }
  .tick {
    fill: var(--muted);
  }
  .grid {
    stroke: var(--border);
  }
  .band {
    fill: var(--surface-2);
  }
  .step-name {
    font-weight: 600;
  }
  .hit {
    fill: transparent;
    cursor: pointer;
  }
  .row:hover .hit,
  .row.sel .hit {
    fill: var(--accent-bg);
  }
  .row:focus-visible {
    outline: 2px solid var(--link);
  }
  .bar.ok {
    fill: var(--ok);
  }
  .bar.fail {
    fill: url(#trace-hatch);
    stroke: var(--fail);
  }
  .hatch {
    fill: var(--fail);
  }
  .bar.running {
    fill: var(--accent);
  }
  .bar.gate {
    fill: var(--s2);
  }
  .bar.other {
    fill: none;
    stroke: var(--border-strong);
    stroke-dasharray: 3 3;
  }
  .key {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 18px;
    list-style: none;
    padding: 0;
    font-size: 13px;
    color: var(--muted);
  }
  .key li {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .swatch {
    inline-size: 16px;
    block-size: 9px;
  }
  .swatch.ok {
    background: var(--ok);
  }
  .swatch.fail {
    background: repeating-linear-gradient(45deg, var(--fail) 0 2px, transparent 2px 5px);
    outline: 1px solid var(--fail);
  }
  .swatch.running {
    background: var(--accent);
  }
  .swatch.gate {
    background: var(--s2);
  }
  .unit-detail dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px 12px;
  }
  .unit-detail dd {
    margin: 0;
  }
</style>
