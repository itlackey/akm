<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { api, date } from "./client";
  import { duration } from "./activity-presenter";
  import Icon from "./Icon.svelte";
  import Outcome from "./Outcome.svelte";
  import { improveOutcome, tasksAroundImprove, MATCH_WINDOW_MS } from "./run-model";
  import type { ActivityRun, ActivityTaskHistory, ActivityTaskRun } from "./activity-types";

  let { run, onClose, panel = $bindable() }: { run: ActivityRun; onClose: () => void; panel?: HTMLElement } = $props();
  type Around = { task: ActivityTaskRun; detail: ActivityTaskHistory["runs"][number] | null };
  let around = $state<Around[] | null>(null);
  let aroundFailed = $state(false);
  let request = 0;
  // An improve run carries no id of the scheduled task run that started it, so the task rows within five minutes of its
  // start are read, and shown as a match by time.
  $effect(() => {
    const mine = ++request;
    const start = Date.parse(run.startedAt);
    const since = new Date(start - MATCH_WINDOW_MS - 1000).toISOString();
    around = null;
    aroundFailed = false;
    api<{ runs: ActivityTaskRun[] }>("/tasks/runs", { since })
      .then(async ({ runs }) => {
        const matches = tasksAroundImprove(run, runs);
        const found: Around[] = [];
        for (const task of matches) {
          const history = await api<ActivityTaskHistory>("/tasks/history", { taskId: task.taskId, since });
          found.push({ task, detail: history.runs.find((row) => row.startedAt === task.startedAt) ?? null });
        }
        if (mine === request) around = found;
      })
      .catch(() => {
        if (mine === request) aroundFailed = true;
      });
  });
  const processes = $derived(Object.entries(run.modelCalls.byProcess).sort((a, b) => b[1].calls - a[1].calls));
  const failing = $derived(processes.filter(([, row]) => row.failures > 0));
  const most = $derived(Math.max(1, ...processes.map(([, row]) => row.calls)));
  const outcome = $derived(improveOutcome(run));
</script>

<section class="drill-panel" tabindex="-1" bind:this={panel} aria-label="Improve run details" aria-live="polite">
  <button class="btn-quiet return-action" onclick={onClose}
    ><Icon name="arrow-left" size={16} /> Back to run records</button
  >
  <header class="run-head">
    <h2>Run {run.id}</h2>
    <Outcome {outcome} />
  </header>
  <dl class="run-facts">
    <dt>Started</dt>
    <dd>{date(run.startedAt)}</dd>
    <dt>Ended</dt>
    <dd>{run.completedAt ? date(run.completedAt) : "Not recorded"}</dd>
    <dt>Took</dt>
    <dd>{duration(run.durationMs)}</dd>
    <dt>Strategy</dt>
    <dd>{run.strategy}</dd>
    <dt>Scope</dt>
    <dd>{run.scope?.mode ?? "Not recorded"} {run.scope?.value ?? ""}</dd>
  </dl>
  <h3>What ran, and what failed</h3>
  {#if processes.length}<table>
      <caption>Run calls by process</caption><thead
        ><tr><th>Process</th><th>Calls</th><th>Failures</th><th>Share of calls</th></tr></thead
      ><tbody
        >{#each processes as [name, row]}<tr
            ><th>{name}</th><td>{row.calls}</td><td>{row.failures > 0 ? `▲ ${row.failures}` : row.failures}</td><td
              ><span class="split" style={`--p:${row.calls / most}; --f:${row.calls ? row.failures / row.calls : 0}`}
                ><span class="split-ok"></span><span class="split-fail"></span></span
              ></td
            ></tr
          >{/each}</tbody
      >
    </table>
    <p class="muted small">
      {run.modelCalls.total} calls, {run.modelCalls.failures} failed.{failing.length
        ? ` Failures: ${failing.map(([name, row]) => `${name} ${row.failures} of ${row.calls}`).join("; ")}.`
        : ""}
      akm reports calls by process here: this view cannot show the model, the execution target or the tokens of each call,
      and it does not make a call count into a cost.
    </p>{:else}<p>
      No model calls are recorded for this run. A run from before akm kept a usage report has none, and so does a run
      that made no call; the record does not say which.
    </p>{/if}
  {#if outcome === "failed" && !failing.length}<p>
      The run is recorded as failed, and no process of it recorded a failed call. akm records a run that was stopped
      before it finished as failed too, so this does not say which happened.
    </p>{/if}
  <h3>Recorded error details</h3>
  <p class="muted small">
    No record of an improve run carries the id of the scheduled task run that started it. The task runs below started
    within {MATCH_WINDOW_MS / 60000} minutes of this run and are matched by time, so they may not be its own.
  </p>
  {#if aroundFailed}<p class="notice notice-warn">The scheduled task runs around this run could not be read.</p>
  {:else if around === null}<p role="status" class="muted">Reading the task runs around this run…</p>
  {:else if !around.length}<p>
      No scheduled task run started within {MATCH_WINDOW_MS / 60000} minutes of this run (a run started by hand has none),
      so no error detail is recorded here.
    </p>{:else}{#each around as { task, detail }}<div class="matched">
        <p>
          <strong>{task.taskId}</strong>, started {date(task.startedAt)}: {task.status}.
          <span class="badge" data-tone="info">Matched by time</span>
        </p>
        {#if detail}<dl class="run-facts">
            <dt>Reason</dt>
            <dd>{String(detail.detail?.reason ?? "Not recorded")}</dd>
            <dt>Error</dt>
            <dd>{String(detail.detail?.error ?? "Not recorded")}</dd>
            <dt>Exit code</dt>
            <dd>{String(detail.detail?.exitCode ?? "Not recorded")}</dd>
          </dl>{/if}
      </div>{/each}{/if}
  {#each [{ name: "Before-run sync", value: run.preRunSync }, { name: "Sync result", value: run.sync }, { name: "Triage result", value: run.triage }] as detail}<details
    >
      <summary>{detail.name}</summary>
      <pre class="code">{detail.value == null ? "Not recorded" : JSON.stringify(detail.value, null, 2)}</pre>
    </details>{/each}
</section>

<style>
  .run-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.75rem;
  }
  .run-head h2 {
    margin: 0;
  }
  .run-facts {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.25rem 1rem;
    margin-block: 0.75rem;
  }
  .run-facts dt {
    color: var(--muted);
  }
  .run-facts dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  h3 {
    margin: 1.25rem 0 0.5rem;
    font-size: 1rem;
  }
  .split {
    display: flex;
    inline-size: calc(var(--p) * 10rem);
    min-inline-size: 2px;
    block-size: 0.5rem;
    gap: 2px;
  }
  .split-ok {
    flex: calc(1 - var(--f));
    background: var(--s1);
  }
  .split-fail {
    flex: var(--f);
    background: var(--fail);
  }
</style>
