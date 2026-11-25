<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { api, appHref, date } from "./client";
  import { duration } from "./activity-presenter";
  import Outcome from "./Outcome.svelte";
  import { statusOutcome } from "./run-model";
  import type { ActivityTaskHistory, ActivityTaskLog } from "./activity-types";

  let { taskId, run }: { taskId: string; run: ActivityTaskHistory["runs"][number] } = $props();
  const detail = $derived(run.detail ?? {});
  const workflowRunId = $derived(typeof detail.runId === "string" ? detail.runId : "");
  let log = $state<ActivityTaskLog | null>(null);
  let logError = $state("");
  async function loadLog() {
    logError = "";
    try {
      log = await api<ActivityTaskLog>("/tasks/log", { taskId, startedAt: run.startedAt });
    } catch (cause) {
      logError = (cause as Error).message;
    }
  }
  const ran = $derived(
    run.targetKind === "workflow"
      ? `Workflow ${run.targetRef ?? ""}`
      : run.targetKind
        ? `${run.targetKind[0].toUpperCase()}${run.targetKind.slice(1)}${run.engine ? ` on ${run.engine}` : ""}`
        : "Not recorded",
  );
  const recorded = $derived(["reason", "error", "exitCode"].filter((key) => detail[key] != null));
</script>

<div class="run" aria-label={`Run of ${taskId} started ${run.startedAt}`} role="group">
  <header>
    <h4>Run started {date(run.startedAt)}</h4>
    <Outcome
      outcome={statusOutcome(run.status)}
      detail={run.status === "completed" || run.status === "failed" ? "" : run.status}
    />
  </header>
  <dl>
    <dt>Took</dt>
    <dd>{duration(run.durationMs)}</dd>
    <dt>Ran</dt>
    <dd>{ran}</dd>
    <dt>Started by</dt>
    <dd>
      {run.trigger === "schedule" ? "The schedule" : run.trigger === "manual" ? "A person or a script" : "Not recorded"}
    </dd>
    {#each recorded as key}<dt>{key === "exitCode" ? "Exit code" : key[0].toUpperCase() + key.slice(1)}</dt>
      <dd>
        {String(detail[key])}
      </dd>{/each}
  </dl>
  {#if run.steps?.length}<h5>Steps</h5>
    <ol>
      {#each run.steps as step}<li>
          {step.name} ({step.kind}): {step.status}{step.attempts > 1 ? `, ${step.attempts} attempts` : ""}, {duration(
            step.durationMs,
          )}{step.reason ? `. ${step.reason}` : ""}
        </li>{/each}
    </ol>{/if}
  {#if run.status === "active"}<p>
      This run has no recorded end. It may still be running or it may have been stopped without recording one: akm does
      not say which, so it is unknown, not succeeded.
    </p>{:else if run.status === "failed" && !recorded.length}<p>
      No error detail is recorded for this failed run.
    </p>{/if}
  <details ontoggle={(event) => event.currentTarget.open && !log && !logError && void loadLog()}>
    <summary>Log output</summary>
    {#if logError}<p class="notice notice-warn" role="alert">{logError}</p>
    {:else if !log}<p class="muted" role="status">Loading…</p>
    {:else if !log.available}<p class="muted">AKM has no task log database, so this run's output is not available.</p>
    {:else if !log.lines?.length}<p class="muted">No output is recorded for this run.</p>
    {:else}<pre class="code">{log.lines.map((entry) => entry.line).join("\n")}</pre>
      {#if log.truncated}<p class="muted small">Only the first {log.lines.length} lines are shown.</p>{/if}{/if}
  </details>
  {#if workflowRunId}<p>
      <span class="badge" data-tone="ok">Matched by run id</span>
      <a href={appHref(`/activity/overview?view=runs&run=${encodeURIComponent(workflowRunId)}&anchor=workflow-trace`)}
        >Open the workflow run this task ran</a
      >.
    </p>{/if}
</div>

<style>
  .run {
    border-block-start: 1px solid var(--border);
    padding-block: 0.75rem;
  }
  header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.75rem;
  }
  h4 {
    margin: 0;
  }
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.25rem 1rem;
    margin-block: 0.5rem;
  }
  dt {
    color: var(--muted);
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
</style>
