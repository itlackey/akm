<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import { api, date } from "./client";
  import ActivityChart from "./ActivityChart.svelte";
  import Icon from "./Icon.svelte";
  import { healthCheckAnchor } from "./home-model";
  import { verticalBars, lines, pChartLine, eventStrip } from "./ui/chart-view.js";
  import { weekStart } from "./ui/lib.js";
  import { number, percent, duration, tokens, healthGroup, attentionItems } from "./activity-presenter";
  import type {
    ActivityOverview,
    ActivityRetrieval,
    ActivityPulse,
    ActivityTaskHistory,
    ActivityRun,
  } from "./activity-types";
  export let data: ActivityOverview;
  export let retrieval: ActivityRetrieval | null;
  export let pulse: ActivityPulse | null;
  export let probed = false;
  export let mode: "health" | "runs" | "usage" = "health";
  export let requestedTask = "";
  export let refreshedAt = "";
  export let probedAt = "";
  let inspectedTask = "";
  $: attention = attentionItems(data, pulse);
  $: if (mode === "runs" && requestedTask && requestedTask !== inspectedTask) {
    inspectedTask = requestedTask;
    void inspectTask(requestedTask);
  }
  let taskPanel: HTMLElement,
    runPanel: HTMLElement,
    runTrigger: HTMLElement | null = null,
    taskTrigger: HTMLElement | null = null;
  function inspectRun(run: ActivityRun | null) {
    runTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    selectedRun = run;
  }
  async function closeRun() {
    selectedRun = null;
    await tick();
    runTrigger?.focus();
  }
  async function closeTask() {
    selection++;
    history = null;
    taskBusy = false;
    await tick();
    taskTrigger?.focus();
  }
  $: if (selectedRun) revealRun(selectedRun);
  async function revealRun(_run: ActivityRun) {
    await tick();
    runPanel?.focus();
  }
  export let probe: () => Promise<void>;
  let taskId = "",
    history: ActivityTaskHistory | null = null,
    taskError = "",
    taskBusy = false,
    selectedRun: ActivityRun | null = null,
    selection = 0,
    probing = false;
  const groups = [
    { key: "fail", label: "Failing" },
    { key: "warn", label: "Warnings" },
    { key: "off", label: "Turned off" },
    { key: "unchecked", label: "Not checked" },
    { key: "idle", label: "No data yet" },
    { key: "pass", label: "Passing" },
  ];
  $: checks = [...(data.health?.hardChecks ?? []), ...(data.health?.advisories ?? [])];
  $: classified = checks.map((check) => ({ check, group: healthGroup(check, checks, probed) }));
  $: metrics = data.metrics;
  $: weekly = retrieval?.weekly ?? [];
  $: activity = metrics?.usage.daily ?? [];
  $: processes = Object.entries(metrics?.llm.byProcess ?? {}).sort((a, b) => b[1].calls - a[1].calls);
  $: tasks = metrics?.tasks.byTask ?? data.taskFailures ?? [];
  $: runs = data.improveRuns;
  async function inspectTask(id = taskId) {
    taskTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const mine = ++selection;
    taskId = id;
    taskBusy = true;
    taskError = "";
    history = null;
    try {
      const result = await api<ActivityTaskHistory>("/tasks/history", {
        taskId: id,
        since: metrics?.window.since ?? "30d",
      });
      if (mine === selection) history = result;
    } catch (error) {
      if (mine === selection) taskError = (error as Error).message;
    } finally {
      if (mine === selection) {
        taskBusy = false;
        await tick();
        taskPanel?.focus();
      }
    }
  }
  async function runChecks() {
    probing = true;
    try {
      await probe();
    } finally {
      probing = false;
    }
  }
  onDestroy(() => {
    selection++;
  });
</script>

{#if data.errors && Object.keys(data.errors).length}<div class="notice notice-warn" role="status">
    <h2>Some measurements are unavailable</h2>
    <ul>
      {#each Object.entries(data.errors) as [name, message]}<li>{name}: {message}</li>{/each}
    </ul>
  </div>{/if}
{#if mode === "health"}
  <div class="health-overview">
    <strong>AKM diagnostic status: {data.health?.status ?? "Unavailable"}</strong>
    <p>
      Observation window: last 24 hours{#if classified.some((item) => item.group === "off" || item.group === "unchecked")}
        · {classified.filter((item) => item.group === "off").length} checks turned off · {classified.filter(
          (item) => item.group === "unchecked",
        ).length} not checked{/if}
    </p>
  </div>
  <p class="muted small view-note">
    View refreshed: {refreshedAt ? date(refreshedAt) : "Not recorded"}. {probedAt
      ? `Connection checks requested: ${date(probedAt)}.`
      : "Connection checks have not been requested in this view."} Individual check timestamps are not reported by AKM.
  </p>
  <section class="attention" aria-labelledby="attention-title">
    <h2 id="attention-title">Needs attention</h2>
    {#if attention.length}{#each [{ label: "Issues", items: attention.filter((item) => item.tone !== "work") }, { label: "Work to review", items: attention.filter((item) => item.tone === "work") }] as group}{#if group.items.length}<div
            class="attention-group"
          >
            <h3>{group.label}</h3>
            <ul class="attention-list">
              {#each group.items as item}<li>
                  <a href={item.href}
                    ><i
                      class="signal"
                      class:fail={item.tone === "fail"}
                      class:warn={item.tone === "warn"}
                      aria-hidden="true"
                    ></i><span>{item.text}</span><span>{item.action}<Icon name="arrow-right" size={16} /></span></a
                  >
                </li>{/each}
            </ul>
          </div>{/if}{/each}
    {:else}<p class="muted">
        {data.health && pulse
          ? "No attention items in the available records. Inspect check coverage below."
          : "Attention coverage is incomplete; unavailable measurements are not an all-clear."}
      </p>{/if}
  </section>
  <section id="health" class="activity-section">
    <div class="trends-head">
      <h2>Health checks</h2>
      <button on:click={runChecks} disabled={probing}>{probing ? "Checking…" : "Run all checks"}</button>
    </div>
    <p class="muted small">Includes connection, release-source and scheduler probes. May contact the network.</p>
    {#each groups as group}{@const items = classified.filter(
        (item) => item.group === group.key,
      )}{#if items.length}<section id={`health-${group.key}`} class="check-group" aria-label={group.label}>
          <h3>
            {probed && group.key === "unchecked" ? "Could not check" : group.label}<span class="muted"
              >{items.length}</span
            >
          </h3>
          <ul class="checks">
            {#each items as { check }}<li class="check" id={healthCheckAnchor(check.name)}>
                <strong>{check.name}</strong>
                <p>{check.message}</p>
                {#if check.evidence}<details class="check-evidence">
                    <summary>Evidence for {check.name}</summary>
                    <pre class="code">{JSON.stringify(check.evidence, null, 2)}</pre>
                  </details>{/if}
              </li>{/each}
          </ul>
        </section>{/if}{/each}{#if !data.health}<p>Health checks unavailable.</p>{/if}
  </section>
{:else if mode === "usage"}
  {#if metrics}<div class="metric-summary" aria-label="Selected-window activity">
      <span><strong>{number(metrics.usage.totals.searches)}</strong> searches</span><span
        ><strong>{number(metrics.usage.totals.shows)}</strong> asset opens</span
      ><span><strong>{number(metrics.proposals.byStatus.pending)}</strong> pending proposals</span><span
        >Median search time <strong>{duration(metrics.usage.searchMedianMs)}</strong></span
      >
    </div>{/if}
  <section class="weekly-context" aria-labelledby="pulse-title">
    <h2 id="pulse-title">Last 7 days</h2>
    {#if pulse}<div class="weekly-values">
        <p>
          <span
            >Found nothing: <strong
              >{pulse.tiles.foundNothing.n ? percent(pulse.tiles.foundNothing.rate) : "No searches"}</strong
            >
            ({pulse.tiles.foundNothing.x}/{pulse.tiles.foundNothing.n} searches)</span
          ><span class="muted"
            >{pulse.tiles.foundNothing.usual.state === "low-data"
              ? "Too little data for a usual range."
              : `${pulse.tiles.foundNothing.usual.state} your usual ${percent(pulse.tiles.foundNothing.usual.low)} to ${percent(pulse.tiles.foundNothing.usual.high)}.`}</span
          >
        </p>
        <p>
          <span
            >Negative feedback: <strong>{pulse.tiles.negativeFeedback.count}</strong> across {pulse.tiles
              .negativeFeedback.assets} assets</span
          ><span class="muted"
            >{pulse.tiles.negativeFeedback.usual.state === "low-data"
              ? "Too few weeks for a usual range."
              : `Usually ${number(pulse.tiles.negativeFeedback.usual.low)} to ${number(pulse.tiles.negativeFeedback.usual.high)} a week.`}</span
          >
        </p>
      </div>{:else}<p class="muted">Weekly comparison unavailable; not a zero count.</p>{/if}
  </section>

  {#if !metrics}<p class="notice">Usage and model measurements unavailable.</p>{:else}
    <section id="activity-trends" aria-label="Search and model trends">
      <div class="chart-grid">
        {#if weekly.some((row) => row.n > 0)}<div class="chart-wide">
            <ActivityChart
              id="activity-retrieval-rate"
              legend={[
                { name: "Found nothing, by week", index: 0 },
                { name: "Band: usual range", index: 0, band: true },
                { name: "Centre", index: 5 },
              ]}
              heading="Is search finding what you need?"
              description="Weekly share that found nothing, with the usual control range. Retrieval does not measure whether an answer was right."
              option={() =>
                pChartLine(
                  weekly.map((row) => row.week.slice(5)),
                  weekly,
                  retrieval?.centre,
                  { name: "Found nothing", unit: "Found nothing" },
                )}
            >
              <table>
                <caption>Weekly retrieval and control bands</caption><thead
                  ><tr
                    ><th>Week of</th><th>Searches</th><th>Found nothing</th><th>Share</th><th>Usual range</th><th
                      >Signal</th
                    ></tr
                  ></thead
                ><tbody
                  >{#each weekly as row}<tr
                      ><th>{row.week}</th><td>{row.n}</td><td>{row.x}</td><td>{percent(row.rate)}</td><td
                        >{row.lower === null || row.upper === null
                          ? "Not measured"
                          : `${percent(row.lower)} to ${percent(row.upper)}`}</td
                      ><td>{row.signal ? "Unusual" : row.n ? "Within range" : "No searches"}</td></tr
                    >{/each}</tbody
                >
              </table>
            </ActivityChart>
            <ActivityChart
              id="activity-retrieval-events"
              heading="Improve runs alongside retrieval"
              description="Finished or failed runs, shown on the same weeks. Co-occurrence is not evidence of causation."
              height="strip"
              option={(token) =>
                eventStrip(
                  weekly.map((row) => row.week.slice(5)),
                  runs
                    .filter((run) => run.ok !== null)
                    .map((run) => ({
                      index: weekly.findIndex((row) => row.week === weekStart(run.startedAt)),
                      tone: run.ok === false ? "fail" : "ok",
                    }))
                    .filter((event) => event.index >= 0),
                  { name: "Improve runs", token },
                )}
              ><table>
                <caption>Improve run events</caption><thead
                  ><tr><th>Started</th><th>Outcome</th><th>Inspect</th></tr></thead
                ><tbody
                  >{#each runs as run}<tr
                      ><td>{date(run.startedAt)}</td><td
                        >{run.ok === true ? "Finished" : run.ok === false ? "Failed" : "Unknown"}</td
                      ><td
                        ><button class="btn-quiet" aria-label={`Inspect run ${run.id}`} on:click={() => inspectRun(run)}
                          >Inspect run <Icon name="arrow-right" size={16} /></button
                        ></td
                      ></tr
                    >{/each}</tbody
                >
              </table></ActivityChart
            >
            <ActivityChart
              id="activity-retrieval-searches"
              heading="Searches per week"
              height="short"
              option={() =>
                verticalBars(
                  weekly.map((row) => row.week.slice(5)),
                  [{ name: "Searches", data: weekly.map((row) => row.n) }],
                  "Searches",
                )}
              ><table>
                <caption>Weekly search volume</caption><thead><tr><th>Week</th><th>Searches</th></tr></thead><tbody
                  >{#each weekly as row}<tr><th>{row.week}</th><td>{row.n}</td></tr>{/each}</tbody
                >
              </table></ActivityChart
            >
            <ActivityChart
              id="activity-latency"
              heading="Median search time by day"
              description="A gap means no timing was recorded; it is not zero milliseconds."
              height="short"
              option={() =>
                lines(
                  (retrieval?.daily ?? []).map((row) => row.date.slice(5)),
                  [{ name: "Median search time", data: (retrieval?.daily ?? []).map((row) => row.medianMs) }],
                  "Milliseconds",
                )}
              ><table>
                <caption>Daily search latency</caption><thead
                  ><tr><th>UTC day</th><th>Searches</th><th>Median time</th></tr></thead
                ><tbody
                  >{#each retrieval?.daily ?? [] as row}<tr
                      ><th>{row.date}</th><td>{row.searches}</td><td>{duration(row.medianMs)}</td></tr
                    >{/each}</tbody
                >
              </table></ActivityChart
            >
          </div>{:else}<section class="chart-card chart-wide">
            <h2>Is search finding what you need?</h2>
            <p>
              {retrieval ? "No searches recorded in this retrieval window." : "Retrieval measurements unavailable."}
            </p>
          </section>{/if}
        <ActivityChart
          id="activity-operations"
          legend={["Search", "Curate", "Show", "Feedback"].map((name, index) => ({ name, index }))}
          heading="Feedback and use"
          description="Your searches, curates, shows and feedback by UTC day. Today is partial."
          option={() =>
            verticalBars(
              activity.map((row) => row.day.slice(5)),
              ["search", "curate", "show", "feedback"].map((key, index) => ({
                name: ["Search", "Curate", "Show", "Feedback"][index],
                stack: "total",
                colorIndex: index,
                data: activity.map((row) => row[key as "search" | "curate" | "show" | "feedback"]),
              })),
              "Operations",
            )}
          ><table>
            <caption>Recorded daily operations</caption><thead
              ><tr><th>UTC day</th><th>Search</th><th>Curate</th><th>Show</th><th>Feedback</th></tr></thead
            ><tbody
              >{#each activity as row}<tr
                  ><th>{row.day}{row.partial ? " (partial)" : ""}</th><td>{row.search}</td><td>{row.curate}</td><td
                    >{row.show}</td
                  ><td>{row.feedback}</td></tr
                >{/each}</tbody
            >
          </table></ActivityChart
        >
        <ActivityChart
          id="activity-models"
          legend={[
            { name: "Model calls", index: 0 },
            { name: "Failures", index: 3 },
          ]}
          heading="Model calls"
          description={`By process. Tokens cover ${number(metrics.llm.usageCalls)} of ${number(metrics.llm.calls)} calls; tokens are not money. Time is summed call duration.`}
          option={() =>
            verticalBars(
              processes.map(([name]) => name),
              [
                { name: "Calls", data: processes.map(([, row]) => row.calls) },
                { name: "Failures", data: processes.map(([, row]) => row.failures), colorIndex: 3 },
              ],
              "Calls",
            )}
        >
          {#each [{ name: "By process", rows: processes }, { name: "By execution target", rows: Object.entries(metrics.llm.byEngine) }, { name: "By stage", rows: Object.entries(metrics.llm.byStage) }] as group}<table
            >
              <caption>{group.name}</caption><thead
                ><tr
                  ><th>Group</th><th>Calls</th><th>Failures</th><th>Tokens</th><th>Token coverage</th><th
                    >Summed time</th
                  ></tr
                ></thead
              ><tbody
                >{#each group.rows as [name, row]}<tr
                    ><th>{name}</th><td>{row.calls}</td><td>{row.failures}</td><td>{tokens(row)}</td><td
                      >{number(row.usageCalls)} / {row.calls} calls</td
                    ><td>{duration(row.totalDurationMs)}</td></tr
                  >{/each}</tbody
              >
            </table>
            {#if !group.rows.length}<p>No calls recorded for this dimension.</p>{/if}{/each}
          <table>
            <caption>Workflow tokens by model</caption><thead><tr><th>Model</th><th>Reported tokens</th></tr></thead
            ><tbody
              >{#each Object.entries(metrics.workflows?.byModel ?? {}) as [model, count]}<tr
                  ><th>{model}</th><td>{number(count)}</td></tr
                >{/each}</tbody
            >
          </table>
          <p class="muted small">
            Individual model IDs for other calls are not exposed by this metrics response. Empty workflow totals do not
            establish zero model usage.
          </p>
        </ActivityChart>
      </div>
    </section>
    {#if metrics.notes?.length}<aside class="coverage" aria-label="Measurement coverage">
        <h3>Measurement coverage</h3>
        <ul>
          {#each metrics.notes as note}<li>{note}</li>{/each}
        </ul>
      </aside>{/if}
  {/if}
  {#if pulse}<p class="improve-line">
      Last {pulse.improveLine.weeks} weeks: {pulse.improveLine.proposed} proposed; {pulse.improveLine.accepted} accepted ({pulse
        .improveLine.acceptedThenReverted} since reverted), {pulse.improveLine.rejected} rejected, {pulse.improveLine
        .waiting} waiting · {pulse.improveLine.calls} model calls.
      <a href="/activity/improve">Improve impact <Icon name="arrow-right" size={16} /></a>
    </p>{/if}
{:else if mode === "runs"}
  {#if pulse}<section class="run-summary" aria-label="Last seven days">
      <div class="tile">
        <span class="tile-label">Runs finishing</span><strong class="tile-value num"
          >{pulse.tiles.runs.improve.ok + pulse.tiles.runs.tasks.ok} of {pulse.tiles.runs.improve.total +
            pulse.tiles.runs.tasks.total}</strong
        ><span class="tile-sub"
          >Improve {pulse.tiles.runs.improve.ok}/{pulse.tiles.runs.improve.total} · Tasks {pulse.tiles.runs.tasks
            .ok}/{pulse.tiles.runs.tasks.total}</span
        >{#each pulse.tiles.runs.failedTasks as task}<button
            class="btn-secondary"
            on:click={() => inspectTask(task.taskId)}>Inspect failed task {task.taskId}</button
          >{/each}
      </div>
    </section>{/if}
  <section id="automation" class="activity-section">
    <h2>Scheduled tasks</h2>
    <p class="muted small">Read-only recorded runs. Inspecting never triggers a rerun.</p>
    {#if data.taskFailures === null}<p>Task failure measurements unavailable.</p>{/if}
    {#if tasks.length}<div class="table-wrap">
        <table>
          <caption>Task runs in the selected window</caption><thead
            ><tr><th>Task</th><th>Failed / recorded</th><th>Median duration</th></tr></thead
          ><tbody
            >{#each tasks as task}<tr
                ><th
                  ><button class="btn-quiet" on:click={() => inspectTask(task.taskId)}
                    >{task.taskId}<Icon name="arrow-right" size={16} /></button
                  ></th
                ><td>{task.failed} / {task.runs}</td><td>{duration(task.medianMs)}</td></tr
              >{/each}</tbody
          >
        </table>
      </div>{:else if data.taskFailures !== null}<p>No task runs recorded in this window.</p>{/if}
    <form class="task-lookup" on:submit|preventDefault={() => inspectTask()}>
      <label>Task ID<input bind:value={taskId} required placeholder="tasks/daily-review" /></label><button
        disabled={taskBusy}>View runs</button
      >
    </form>
    {#if taskBusy}<p role="status">Loading recorded runs…</p>{/if}{#if taskError}<p role="alert">{taskError}</p>{/if}
    {#if history}<section
        class="drill-panel"
        tabindex="-1"
        bind:this={taskPanel}
        aria-label="Task run details"
        aria-live="polite"
      >
        <button class="btn-quiet return-action" on:click={closeTask}
          ><Icon name="arrow-left" size={16} /> Back to tasks</button
        >
        <h3>{taskId}</h3>
        {#if !history.available}<p>Task history unavailable.</p>{:else}<p>
            {history.count} of {history.totalCount} recorded runs.
          </p>
          <div class="table-wrap">
            <table>
              <caption>Recorded task runs</caption><thead
                ><tr><th>Started</th><th>Status</th><th>Duration</th><th>Result / failure</th></tr></thead
              ><tbody
                >{#each history.runs as run}<tr
                    ><td>{date(run.startedAt)}</td><td>{run.status}</td><td>{duration(run.durationMs)}</td><td
                      >{#if run.detail}<details>
                          <summary>{String(run.detail.reason ?? run.detail.error ?? "Recorded result")}</summary>
                          <pre class="code">{JSON.stringify(run.detail, null, 2)}</pre>
                        </details>{:else}No detail recorded{/if}</td
                    ></tr
                  >{/each}</tbody
              >
            </table>
          </div>{/if}
      </section>{/if}
  </section>
  <section id="run-history" class="activity-section" aria-label="Improve run history">
    <ActivityChart
      id="activity-run-duration"
      heading="Latest improve runs"
      initialView="table"
      description="Latest recorded runs, across all time. The chart shows duration; circle means success, triangle failure and diamond unknown."
      option={() => ({
        xAxis: {
          type: "category",
          data: runs.map((run) => run.startedAt.slice(5, 16).replace("T", " ")),
          axisLabel: { hideOverlap: true },
        },
        yAxis: { type: "value", name: "Minutes", min: 0 },
        series: [
          {
            type: "scatter",
            name: "Run duration",
            data: runs.map((run, i) => ({
              value: [i, run.durationMs === null ? null : Math.round(run.durationMs / 6000) / 10],
              symbol: run.ok === true ? "circle" : run.ok === false ? "triangle" : "diamond",
              symbolSize: 11,
            })),
          },
        ],
      })}
      onSelect={(event) => inspectRun(runs[event.dataIndex] ?? null)}
      ><table>
        <caption>Improve run records</caption><thead
          ><tr><th>Run</th><th>Outcome</th><th>Strategy</th><th>Duration</th><th>Calls / failures</th></tr></thead
        ><tbody
          >{#each runs as run}<tr
              ><th
                ><button class="btn-quiet" aria-label={`Inspect run ${run.id}`} on:click={() => inspectRun(run)}
                  >{run.id}<Icon name="arrow-right" size={16} /></button
                >
                <div class="muted small">{date(run.startedAt)}</div></th
              ><td>{run.ok === true ? "Finished" : run.ok === false ? "Failed" : "Unknown"}</td><td>{run.strategy}</td
              ><td>{duration(run.durationMs)}</td><td>{run.modelCalls.total} / {run.modelCalls.failures}</td></tr
            >{/each}</tbody
        >
      </table>
      {#if !runs.length}<p>No improve runs recorded.</p>{/if}</ActivityChart
    >
  </section>
{/if}
{#if selectedRun}<section
    class="drill-panel"
    tabindex="-1"
    bind:this={runPanel}
    aria-label="Improve run details"
    aria-live="polite"
  >
    <button class="btn-quiet return-action" on:click={closeRun}
      ><Icon name="arrow-left" size={16} /> Back to run records</button
    >
    <h2>Run {selectedRun.id}</h2>
    <p>
      {selectedRun.strategy} · {date(selectedRun.startedAt)} · {duration(selectedRun.durationMs)} · {selectedRun.scope
        ?.mode ?? "Scope not recorded"}
      {selectedRun.scope?.value ?? ""}
    </p>
    <table>
      <caption>Run calls by process</caption><thead><tr><th>Process</th><th>Calls</th><th>Failures</th></tr></thead
      ><tbody
        >{#each Object.entries(selectedRun.modelCalls.byProcess) as [name, row]}<tr
            ><th>{name}</th><td>{row.calls}</td><td>{row.failures}</td></tr
          >{/each}</tbody
      >
    </table>
    {#each [{ name: "Before-run sync", value: selectedRun.preRunSync }, { name: "Sync result", value: selectedRun.sync }, { name: "Triage result", value: selectedRun.triage }] as detail}<details
      >
        <summary>{detail.name}</summary>
        <pre class="code">{detail.value == null ? "Not recorded" : JSON.stringify(detail.value, null, 2)}</pre>
      </details>{/each}
  </section>{/if}

<style>
  .health-overview {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    padding-block: 1rem;
    border-bottom: 1px solid var(--border);
  }
  .health-overview strong {
    font-size: 1.125rem;
  }
  .health-overview p {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--muted);
  }
  /* Prose keeps a readable measure on a wide monitor instead of running edge to edge. */
  .view-note,
  .check p,
  .coverage {
    max-width: 75ch;
  }
  .attention {
    margin-block: 2rem;
  }
  .attention h2 {
    font-size: 1.125rem;
    margin-block: 0 1rem;
  }
  .attention-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .attention-list li {
    border-bottom: 1px solid var(--border);
  }
  .attention-list a {
    display: grid;
    grid-template-columns: 0.65rem minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.875rem;
    padding: 1rem 0;
    text-decoration: none;
    color: var(--text);
    font-size: 0.875rem;
  }
  .attention-list a:hover {
    color: var(--accent);
  }
  .attention-list a span:last-child {
    color: var(--accent);
    font-size: 0.8125rem;
  }
  .attention-list a span:last-child {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .attention-group {
    margin-block: 1.5rem;
  }
  .attention-group h3 {
    font-size: 0.8125rem;
    color: var(--muted);
    margin: 0;
  }
  .check-group {
    margin-block: 1.5rem;
  }
  .check-group h3 {
    font-size: 0.875rem;
    display: flex;
    gap: 0.75rem;
    margin: 0 0 0.5rem;
  }
  .checks {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .check {
    display: grid;
    grid-template-columns: minmax(10rem, 24%) minmax(0, 1fr);
    gap: 0.5rem 1.5rem;
    padding: 0.75rem 0;
    border-bottom: 1px solid var(--border);
    font-size: 0.8125rem;
  }
  .check strong {
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  .check p {
    margin: 0;
    color: var(--muted);
  }
  .check-evidence {
    grid-column: 2;
    margin: 0;
  }
  .coverage {
    color: var(--muted);
    font-size: 0.8125rem;
    margin-block: 2rem;
  }
  .coverage h3 {
    font-size: inherit;
    margin: 0;
  }
  .coverage ul {
    padding-left: 1.25rem;
  }
  .return-action {
    margin-bottom: 1rem;
  }
  .signal {
    block-size: 0.5rem;
    inline-size: 0.5rem;
    border-radius: 50%;
    background: var(--muted);
  }
  .signal.fail {
    background: var(--fail);
  }
  .signal.warn {
    background: var(--warn);
  }
  .metric-summary {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem 2rem;
    padding: 1rem 0;
    margin-bottom: 1.5rem;
    border-block: 1px solid var(--border);
    font-size: 0.875rem;
  }
  .metric-summary strong {
    font-variant-numeric: tabular-nums;
  }
  .weekly-context {
    margin: 0 0 1.5rem;
    display: grid;
    grid-template-columns: 7rem minmax(0, 1fr);
    gap: 1rem;
    font-size: 0.8125rem;
  }
  .weekly-context h2 {
    font-size: inherit;
    margin: 0;
    color: var(--muted);
  }
  .weekly-values {
    display: flex;
    gap: 1rem 2rem;
    flex-wrap: wrap;
  }
  .weekly-values p {
    display: grid;
    gap: 0.25rem;
    margin: 0;
  }
  .improve-line {
    font-size: 0.8125rem;
    color: var(--muted);
    margin-block: 1rem 2rem;
    border: 0;
    padding: 0;
    background: none;
    box-shadow: none;
  }
  .run-summary {
    margin-block: 1rem 2rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--border);
  }
  .run-summary :global(.tile) {
    padding: 0;
    border: 0;
    background: none;
  }
  .run-summary :global(.tile-value) {
    font-size: 1.25rem;
  }
  .task-lookup {
    display: flex;
    gap: 0.75rem;
    align-items: end;
    margin: 1.5rem 0;
    flex-wrap: wrap;
  }
  .task-lookup label {
    display: grid;
    gap: 0.4rem;
  }
  .activity-section {
    margin-block: 2rem;
  }
  .activity-section h2 {
    font-size: 1.125rem;
  }
  .drill-panel {
    padding: 1.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    margin-block: 1.5rem;
  }
  .table-wrap {
    overflow-x: auto;
  }
  pre {
    max-width: 100%;
    overflow: auto;
  }
  .chart-grid {
    gap: 2rem;
  }
  .chart-wide {
    display: grid;
    gap: 2rem;
  }
  @media (max-width: 760px) {
    .attention-list a {
      grid-template-columns: 0.65rem minmax(0, 1fr);
    }
    .attention-list a span:last-child {
      grid-column: 2;
    }
    .check {
      grid-template-columns: 1fr;
      gap: 0.35rem;
    }
    .check-evidence {
      grid-column: 1;
    }
    .weekly-context {
      grid-template-columns: 1fr;
      gap: 0.5rem;
    }
  }
</style>
