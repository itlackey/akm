<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { date } from "./client";
  import { duration } from "./activity-presenter";
  import Icon from "./Icon.svelte";
  import Outcome from "./Outcome.svelte";
  import { improveOutcome } from "./run-model";
  import type { ActivityRun, ActivityRunUsage } from "./activity-types";

  let { run, onClose, panel = $bindable() }: { run: ActivityRun; onClose: () => void; panel?: HTMLElement } = $props();
  const processes = $derived(Object.entries(run.modelCalls.byProcess).sort((a, b) => b[1].calls - a[1].calls));
  const failing = $derived(processes.filter(([, row]) => row.failures > 0));
  const most = $derived(
    Math.max(1, ...(run.usage?.length ? run.usage : processes.map(([, row]) => row)).map((row) => row.calls)),
  );
  const outcome = $derived(improveOutcome(run));
  // Tokens are the provider's report: a call that reported none is unknown, not zero.
  function tokenText(row: ActivityRunUsage) {
    if (row.usageCalls === 0 || (row.usageCalls === null && !row.totalTokens)) return "Not reported";
    const partial =
      row.usageCalls !== null && row.usageCalls < row.calls ? ` (${row.usageCalls} of ${row.calls} calls)` : "";
    return `${row.totalTokens.toLocaleString()}${partial}`;
  }
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
  {#if run.usage?.length}<table>
      <caption>Run usage by process, execution target and model</caption><thead
        ><tr
          ><th>Process</th><th>Execution target</th><th>Model</th><th>Calls</th><th>Failures</th><th>Tokens</th><th
            >Share of calls</th
          ></tr
        ></thead
      ><tbody
        >{#each run.usage as row}<tr
            ><th>{row.process}</th><td>{row.engine ?? "Not recorded"}</td><td>{row.model ?? "Not recorded"}</td><td
              >{row.calls}</td
            ><td>{row.failures > 0 ? `▲ ${row.failures}` : row.failures}</td><td>{tokenText(row)}</td><td
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
      Tokens are what the provider reported; a call that reported none is not counted as zero. akm does not turn a call count
      into a cost.
    </p>{:else if processes.length}<table>
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
      This run's record has calls by process only; it names no model, execution target or tokens.
    </p>{:else}<p>
      No model calls are recorded for this run. A run from before akm kept a usage report has none, and so does a run
      that made no call or was stopped before it finished.
    </p>{/if}
  {#if run.noCalls?.length}<p class="muted small">
      Made no call: {run.noCalls.map((row) => `${row.process} (${row.reason})`).join("; ")}.
    </p>{/if}
  {#if run.terminated}<p class="notice notice-warn">
      <strong>Terminated</strong> ({run.terminated.reason}{run.terminated.at ? `, ${date(run.terminated.at)}` : ""}):
      the run was stopped before it finished.{run.terminated.errorMessage ? ` ${run.terminated.errorMessage}` : ""}
    </p>{/if}
  {#if outcome === "failed" && !failing.length}<p>
      The run is recorded as failed, and no process of it recorded a failed call. akm records a run that was stopped
      before it finished as failed too, so this does not say which happened.
    </p>{/if}
  <h3>Recorded error details</h3>
  {#if run.errors?.count}<table>
      <caption>Failed actions of this run, with the error recorded for each</caption><thead
        ><tr><th>Ref</th><th>Action</th><th>Error</th></tr></thead
      ><tbody
        >{#each run.errors.shown as row}<tr><th>{row.ref}</th><td>{row.mode}</td><td>{row.error}</td></tr>{/each}</tbody
      >
    </table>
    {#if run.errors.count > run.errors.shown.length}<p class="muted small">
        {run.errors.shown.length} of {run.errors.count} shown.
      </p>{/if}{:else if !run.terminated}<p class="muted small">This run recorded no failed action.</p>{/if}
  <p class="muted small">
    No record ties this run to the scheduled task run that started it, so none is shown here. A failed task run's error
    detail is under its task in Task runs.
  </p>
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
