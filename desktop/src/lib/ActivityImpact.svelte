<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import { api, date } from "./client";
  import { navigate } from "./navigation";
  import ActivityChart from "./ActivityChart.svelte";
  import { verticalBars, lines, stepLine } from "./ui/chart-view.js";
  import { number, percent, rollingSearch, outcomeClasses } from "./activity-presenter";
  import type { ActivityImpact, ActivityRetrieval } from "./activity-types";
  import type { Proposal } from "./types";
  let {
    impact,
    retrieval,
    selectedProcess = $bindable(""),
  }: { impact: ActivityImpact; retrieval: ActivityRetrieval | null; selectedProcess?: string } = $props();
  let drillPanel = $state<HTMLElement>(),
    drillTrigger: HTMLElement | null = null;
  const availableProcesses = $derived((impact.outcomes ?? []).map((row) => row.source));
  // The process shown: the selection when the data has it, else the first one.
  const activeProcess = $derived(
    availableProcesses.includes(selectedProcess) ? selectedProcess : (availableProcesses[0] ?? ""),
  );
  const weeklyOutcomes = $derived(impact.outcomes.find((row) => row.source === activeProcess)?.weeks ?? []);
  // A chart is drawn again when it is given another builder, so this one is made anew whenever its weeks change.
  const weeklyOption = $derived.by(() => {
    const weeks = weeklyOutcomes;
    return () =>
      verticalBars(
        weeks.map((row) => row.week.slice(5)),
        outcomeClasses.map((item, index) => ({
          name: item.label,
          stack: "total",
          colorIndex: [0, 2, 4, 1, 3][index],
          data: weeks.map((row) => row[item.key]),
        })),
        "Decisions",
      );
  });
  let drill = $state<{ source: string; week: string; kind: string } | null>(null),
    proposals = $state<Proposal[]>([]),
    drillError = $state(""),
    drilling = $state(false),
    generation = 0;
  const flow = $derived(impact.reviewFlow ?? []);
  const cost = $derived(impact.cost ?? []);
  const library = $derived(impact.library ?? []);
  const processes = $derived([...new Set(cost.flatMap((row) => Object.keys(row.byProcess)))].sort());
  const rolling = $derived(retrieval ? rollingSearch(retrieval, impact.changedAssets ?? []) : null);
  const outcomeRows = $derived(
    (impact.outcomes ?? []).flatMap((process) =>
      process.weeks
        .filter((row) => outcomeClasses.some((item) => row[item.key] > 0))
        .map((row) => ({ source: process.source, ...row })),
    ),
  );
  const costCalls = $derived(cost.reduce((sum, row) => sum + row.calls, 0));
  const reportedCalls = $derived(cost.reduce((sum, row) => sum + row.usageCalls, 0));
  const assetHref = (ref: string) => `/library/asset?ref=${encodeURIComponent(ref)}`;
  function proposalHref(id: string, scoped = false) {
    const params = new URLSearchParams({
      status: "recent",
      returnTo: `/activity/improve?since=${impact.since}&process=${encodeURIComponent(activeProcess)}&anchor=${scoped ? "impact-drill" : "harm"}`,
    });
    if (scoped && drill) {
      params.set("source", drill.source);
      params.set("week", drill.week);
      if (drill.kind) params.set("class", drill.kind);
    }
    return `/review/${encodeURIComponent(id)}?${params}`;
  }
  async function closeDrill() {
    generation++;
    drill = null;
    await tick();
    drillTrigger?.focus({ preventScroll: true });
  }
  function changeProcess(value: string) {
    selectedProcess = value;
    void navigate(`/activity/improve?since=${impact.since}&process=${encodeURIComponent(value)}`);
  }
  function libraryOption() {
    const option = stepLine(
      library.map((row) => row.week.slice(5)),
      library.map((row) => row.entries),
      { name: "Assets in the library", unit: "Assets" },
    );
    option.series[0].connectNulls = false;
    return option;
  }
  function inspectMark(event: { dataIndex: number; seriesIndex: number }) {
    const row = weeklyOutcomes[event.dataIndex],
      outcome = outcomeClasses[event.seriesIndex];
    if (row && outcome && row[outcome.key] > 0) void inspect(activeProcess, row.week, outcome.key);
  }
  const harmLabels: Record<string, string> = {
    reverted: "Reverted",
    reopened: "Rejection reopened",
    "risky-retirement": "Retired with a risk flagged",
    "flag-after-change": "Flag after a change",
  };
  async function inspect(source: string, week: string, kind = "") {
    drillTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const mine = ++generation;
    drill = { source, week, kind };
    drilling = true;
    proposals = [];
    drillError = "";
    try {
      const result = await api<{ proposals: Proposal[] }>("/proposals", {
        status: "recent",
        source,
        week,
        class: kind,
        limit: "50",
      });
      if (mine === generation) proposals = result.proposals;
    } catch (error) {
      if (mine === generation) drillError = (error as Error).message;
    } finally {
      if (mine === generation) {
        drilling = false;
        await tick();
        drillPanel?.focus({ preventScroll: true });
        drillPanel?.scrollIntoView({ block: "nearest" });
      }
    }
  }
  onDestroy(() => {
    generation++;
  });
</script>

{#if !impact.available}<div class="empty">
    <h2>Improve measurements unavailable</h2>
    <p>No readable state database was found. This is not a measured zero.</p>
  </div>{:else}
  <p class="impact-summary">
    <strong>{impact.since === "365d" ? "Last year" : "Last 90 days"}:</strong>
    {number(impact.summary.kept)} kept · {number(impact.summary.reverted)} reverted · {number(impact.summary.flags)} flags
    after a change · {number(impact.summary.tokens)} reported tokens. Token coverage: {percent(
      impact.summary.tokenCoverage,
    )}.
  </p>
  <p class="measurement-note">
    Weeks start Monday, UTC. Kept means accepted and not reverted. Flags are negative feedback within 14 days. These are
    observed signals, not proof of causation.
  </p>
  {#if impact.errors}<div class="notice notice-warn" role="status">
      <h2>Partial measurements</h2>
      <ul>
        {#each Object.entries(impact.errors) as [name, error]}<li>
            {name}: {error}. Dependent figures may be incomplete.
          </li>{/each}
      </ul>
    </div>{/if}
  <nav class="impact-links" aria-label="Improve sections" data-sveltekit-reset="false">
    {#each [["outcomes", "Outcomes"], ["search", "Retrieval after changes"], ["flow", "Review flow"], ["library", "Library"], ["harm", "Harm log"], ["cost", "Cost"], ["changed", "Changed assets"], ["judge", "Judge and you"]] as [id, label]}<a
        href={`/activity/improve?since=${impact.since}&anchor=${id}`}>{label}</a
      >{/each}
  </nav>
  <div class="impact-sections">
    <section id="outcomes">
      <ActivityChart
        id="impact-weekly-outcomes"
        heading="Decisions by week"
        legend={outcomeClasses.map((item, index) => ({ name: item.label, index: [0, 2, 4, 1, 3][index] }))}
        description="Select a nonzero segment or table value to inspect its proposals. Decisions are not a quality score."
        option={weeklyOption}
        empty={weeklyOutcomes.some((row) => outcomeClasses.some((item) => row[item.key] > 0))
          ? ""
          : "No decisions recorded for this process in this window."}
        onSelect={inspectMark}
      >
        {#snippet controls()}<label class="process-control"
            >Process<select value={activeProcess} onchange={(event) => changeProcess(event.currentTarget.value)}
              >{#each availableProcesses as process}<option value={process}>{process}</option>{/each}</select
            ></label
          >{/snippet}
        <table>
          <caption>Weekly decisions for the selected process</caption><thead
            ><tr
              ><th>Week of</th>{#each outcomeClasses as item}<th>{item.label}</th>{/each}</tr
            ></thead
          ><tbody
            >{#each weeklyOutcomes as row}<tr
                ><th>{row.week}</th>{#each outcomeClasses as item}<td
                    >{#if row[item.key] > 0}<button
                        class="btn-secondary"
                        aria-label={`${item.label}: ${row[item.key]}, ${activeProcess}, ${row.week}`}
                        onclick={() => inspect(activeProcess, row.week, item.key)}>{row[item.key]}</button
                      >{:else}0{/if}</td
                  >{/each}</tr
              >{/each}</tbody
          >
        </table>
        {#if !weeklyOutcomes.length}<p>No weekly decisions recorded for this process.</p>{/if}
      </ActivityChart>
      <section class="process-comparison" aria-label="Compare all process totals">
        <ActivityChart
          id="impact-outcomes"
          legend={outcomeClasses.map((item, index) => ({ name: item.label, index: [0, 2, 4, 1, 3][index] }))}
          heading="Who decided what"
          empty={(impact.outcomes ?? []).some((process) =>
            process.weeks.some((row) => outcomeClasses.some((item) => row[item.key] > 0)),
          )
            ? ""
            : "No decisions recorded in this window."}
          description="Decisions by improvement process, preserving the judge, human and unrecorded decider distinctions. Reverted is not kept."
          option={() =>
            verticalBars(
              (impact.outcomes ?? []).map((process) => process.source),
              outcomeClasses.map((item, index) => ({
                name: item.label,
                stack: "total",
                colorIndex: [0, 2, 4, 1, 3][index],
                data: (impact.outcomes ?? []).map((process) =>
                  process.weeks.reduce((sum, row) => sum + row[item.key], 0),
                ),
              })),
              "Decisions",
            )}
        >
          <table>
            <caption>Decision outcomes by process and week</caption><thead
              ><tr
                ><th>Process</th><th>Week of</th>{#each outcomeClasses as item}<th>{item.label}</th>{/each}</tr
              ></thead
            ><tbody
              >{#each outcomeRows as row}<tr
                  ><th>{row.source}</th><td
                    ><button class="btn-secondary" onclick={() => inspect(row.source, row.week)}>{row.week}</button></td
                  >{#each outcomeClasses as item}<td
                      >{#if row[item.key]}<button
                          class="btn-secondary"
                          aria-label={`${item.label}: ${row[item.key]}, ${row.source}, ${row.week}`}
                          onclick={() => inspect(row.source, row.week, item.key)}>{row[item.key]}</button
                        >{:else}0{/if}</td
                    >{/each}</tr
                >{/each}</tbody
            >
          </table>
          {#if !outcomeRows.length}<p>No proposals decided in this window.</p>{/if}
        </ActivityChart>
      </section>
      {#if drill}<section
          id="impact-drill"
          class="drill-panel"
          tabindex="-1"
          bind:this={drillPanel}
          aria-label="Decision proposal details"
          aria-live="polite"
        >
          <h3>{drill.source}, week of {drill.week}{drill.kind ? `, ${drill.kind}` : ""}</h3>
          {#if drilling}<p role="status">Loading matching proposals…</p>{:else if drillError}<p role="alert">
              {drillError}
            </p>{:else}<p class="muted small">Up to 50 matching proposals, not an exhaustive inventory.</p>
            <ul class="change-list">
              {#each proposals as proposal}<li>
                  <a href={proposalHref(proposal.id, true)}>{proposal.ref}</a><span>{proposal.status}</span><a
                    href={assetHref(proposal.ref)}>Open asset</a
                  >
                </li>{/each}
            </ul>
            {#if !proposals.length}<p>No matching proposals.</p>{/if}{/if}<button
            class="btn-secondary"
            onclick={closeDrill}>Close decision details</button
          >
        </section>{/if}
    </section>
    <section id="search">
      {#if rolling && rolling.rates.some((value) => value !== null)}
        <ActivityChart
          id="impact-search"
          legend={[
            { name: "Searches that found something", index: 0 },
            { name: "Improve changes kept", index: 0, marker: true },
          ]}
          heading="Did improve help search?"
          description={`Rolling seven-day share of searches that returned something over 90 days; five searches required. Visible percent axis: ${rolling.floor}% to 100%. Markers show days when changes were kept; retrieval does not measure answer correctness.`}
          option={(token) => ({
            xAxis: {
              type: "category",
              data: rolling?.labels ?? [],
              axisLabel: { hideOverlap: true, formatter: (day: string) => day.slice(5) },
            },
            yAxis: {
              type: "value",
              name: "Found something",
              min: rolling?.floor ?? 0,
              max: 100,
              axisLabel: { formatter: "{value}%" },
            },
            series: [
              {
                type: "line",
                name: "Searches that found something",
                connectNulls: false,
                symbol: "none",
                lineStyle: { width: 2.5 },
                z: 3,
                data: rolling?.rates ?? [],
              },
              {
                type: "bar",
                name: "Improve changes kept",
                silent: true,
                barWidth: 2,
                z: 1,
                itemStyle: { color: token("--marker") },
                data: (rolling?.labels ?? []).map((day) => (rolling?.marked.has(day) ? 100 : null)),
              },
            ],
          })}
        >
          <table>
            <caption>Rolling retrieval figures</caption><thead
              ><tr><th>UTC day</th><th>Found something</th><th>Change kept</th></tr></thead
            ><tbody
              >{#each rolling.labels as day, i}<tr
                  ><th>{day}</th><td>{rolling.rates[i] === null ? "Insufficient searches" : `${rolling.rates[i]}%`}</td
                  ><td>{rolling.marked.has(day) ? "Yes" : "No"}</td></tr
                >{/each}</tbody
            >
          </table>
        </ActivityChart>{:else}<section class="chart-card">
          <h2>Did improve help search?</h2>
          <p>
            {retrieval
              ? "Too few searches to show a rolling trend. It needs at least five searches in a week."
              : "Search measurements unavailable."}
          </p>
        </section>{/if}
    </section>
    <section id="flow">
      <h2>Is review keeping up?</h2>
      <ActivityChart
        id="impact-waiting"
        heading="Waiting for review"
        description="Proposals still waiting at each week’s end."
        height="short"
        option={() =>
          stepLine(
            flow.map((row) => row.week.slice(5)),
            flow.map((row) => row.waiting),
            { name: "Waiting for review", unit: "Waiting" },
          )}
        ><table>
          <caption>Weekly queue size</caption><thead><tr><th>Week</th><th>Waiting at end</th></tr></thead><tbody
            >{#each flow as row}<tr><th>{row.week}</th><td>{row.waiting}</td></tr>{/each}</tbody
          >
        </table></ActivityChart
      >
      <ActivityChart
        id="impact-review-rate"
        legend={[
          { name: "Made", index: 0 },
          { name: "Decided", index: 2 },
        ]}
        heading="Made and decided each week"
        height="short"
        option={() =>
          lines(
            flow.map((row) => row.week.slice(5)),
            [
              { name: "Made", data: flow.map((row) => row.created), colorIndex: 0 },
              { name: "Decided", data: flow.map((row) => row.decided), colorIndex: 2 },
            ],
            "Proposals",
          )}
        ><table>
          <caption>Review throughput</caption><thead
            ><tr><th>Week</th><th>Made</th><th>Decided</th><th>Waiting</th></tr></thead
          ><tbody
            >{#each flow as row}<tr
                ><th>{row.week}</th><td>{row.created}</td><td>{row.decided}</td><td>{row.waiting}</td></tr
              >{/each}</tbody
          >
        </table></ActivityChart
      >
    </section>
    <section id="library">
      {#if library.filter((row) => row.entries !== null).length >= 2}<ActivityChart
          id="impact-library-size"
          heading="How has the library changed?"
          description="Assets at each week’s end. Missing index snapshots remain gaps, not zero assets."
          height="short"
          option={libraryOption}
          ><table>
            <caption>Library snapshots</caption><thead><tr><th>Week</th><th>Assets</th></tr></thead><tbody
              >{#each library as row}<tr
                  ><th>{row.week}</th><td>{row.entries === null ? "Not recorded" : number(row.entries)}</td></tr
                >{/each}</tbody
            >
          </table></ActivityChart
        >{:else}<section class="chart-card">
          <h2>How has the library changed?</h2>
          <p>Two or more index snapshots in this window are needed to draw the library-size line.</p>
        </section>{/if}
    </section>
    <section id="harm" class="chart-card">
      <h2>Harm log{impact.harm?.length ? ` (${impact.harm.length})` : ""}</h2>
      <p class="muted small">
        Reversions, reopened rejections, flagged retirements and negative feedback after a change. These records are
        never collapsed.
      </p>
      {#if impact.harm?.length}<ul class="change-list">
          {#each impact.harm as item}<li>
              <strong>{harmLabels[item.kind] ?? item.kind}</strong><a class="mono wrap" href={assetHref(item.ref)}
                >{item.ref}</a
              ><span>{item.detail} · {date(item.at)}</span>{#if item.proposalId}<a href={proposalHref(item.proposalId)}
                  >Review proposal</a
                >{/if}
            </li>{/each}
        </ul>{:else}<p>
          No harm signals recorded in this window. Checked {number(impact.summary.checked)} decisions; absence of a flag is
          not proof of correctness.
        </p>{/if}
    </section>
    <section id="cost">
      <ActivityChart
        id="impact-cost"
        legend={processes.map((name, index) => ({ name, index: index % 5 }))}
        heading="What does improve cost?"
        empty={costCalls ? "" : "No model calls recorded in this window."}
        description={`${costCalls} model calls; ${reportedCalls} calls reported tokens. Unreported tokens are unknown, not zero. Tokens are not money.`}
        option={() =>
          verticalBars(
            cost.map((row) => row.week.slice(5)),
            processes.map((name, index) => ({
              name,
              stack: "total",
              colorIndex: index % 5,
              data: cost.map((row) => row.byProcess[name] ?? 0),
            })),
            "Calls",
          )}
        ><table>
          <caption>Calls and reported tokens by week</caption><thead
            ><tr
              ><th>Week</th><th>Calls</th><th>Tokens</th><th>Calls reporting tokens</th>{#each processes as process}<th
                  >{process}</th
                >{/each}</tr
            ></thead
          ><tbody
            >{#each cost as row}<tr
                ><th>{row.week}</th><td>{row.calls}</td><td
                  >{row.usageCalls ? number(row.tokens) : row.calls ? "Not reported" : "0 (no calls)"}</td
                ><td>{row.usageCalls} / {row.calls}</td>{#each processes as process}<td
                    >{row.byProcess[process] ?? 0}</td
                  >{/each}</tr
              >{/each}</tbody
          >
        </table>
        {#if !costCalls}<p>No model calls recorded in this window.</p>{/if}</ActivityChart
      >
    </section>
    <section id="changed" class="chart-card">
      <h2>Changed assets, before and after</h2>
      <p class="measurement-note">
        Found and negatively rated in the 28 days before/after a change. Changes under 28 days old are partial. These
        are observations, not causal attribution.
      </p>
      <!-- svelte-ignore a11y_no_noninteractive_tabindex (This horizontally scrolling table needs keyboard access.) -->
      <div class="table-wrap" role="region" aria-label="Changed assets, before and after" tabindex="0">
        <table>
          <caption>Changed-asset follow-up</caption><thead
            ><tr
              ><th>Asset</th><th>Process</th><th>Changed</th><th>Found before → after</th><th
                >Negative before → after</th
              ><th>After coverage</th></tr
            ></thead
          ><tbody
            >{#each impact.changedAssets ?? [] as item}<tr
                ><th><a class="wrap" href={assetHref(item.ref)}>{item.ref}</a></th><td>{item.source}</td><td
                  >{date(item.decidedAt)}{item.outcome === "reverted" ? " · Reverted" : ""}</td
                ><td>{item.before.hits} → {item.after.hits}</td><td>{item.before.negative} → {item.after.negative}</td
                ><td>{item.complete ? "28 days" : `${item.afterDays} days so far (partial)`}</td></tr
              >{/each}</tbody
          >
        </table>
      </div>
      {#if !impact.changedAssets?.length}<p>No changes kept in this window.</p>{/if}
    </section>
    <section id="judge" class="chart-card">
      <h2>Judge and you</h2>
      <!-- svelte-ignore a11y_no_noninteractive_tabindex (This horizontally scrolling table needs keyboard access.) -->
      <div class="table-wrap" role="region" aria-label="Decider outcomes" tabindex="0">
        <table>
          <caption>Decider outcomes</caption><thead
            ><tr><th>Decided by</th><th>Accepted</th><th>Rejected</th><th>Later reverted</th><th>Kept</th></tr></thead
          ><tbody
            >{#each Object.entries(impact.judgeAndYou ?? {}) as [who, row]}<tr
                ><th>{who === "judge" ? "The judge" : who === "you" ? "You" : "Decider not recorded"}</th><td
                  >{row.accepted}</td
                ><td>{row.rejected}</td><td>{row.reverted}</td><td
                  >{row.accepted + row.rejected + row.reverted
                    ? percent(row.accepted / (row.accepted + row.rejected + row.reverted))
                    : "No decisions"}</td
                ></tr
              >{/each}</tbody
          >
        </table>
      </div>
      {#if !Object.keys(impact.judgeAndYou ?? {}).length}<p>No decisions recorded.</p>{/if}
    </section>
  </div>
{/if}

<style>
  .process-control {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8125rem;
  }
  .process-comparison {
    margin-top: 2rem;
  }
  .measurement-note {
    color: var(--muted);
    font-size: 0.8125rem;
    max-width: 85ch;
    line-height: 1.6;
  }
  .impact-links {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem 1.25rem;
    margin-block: 1rem;
  }
  .impact-sections {
    display: grid;
    gap: 2.5rem;
  }
  .table-wrap {
    overflow-x: auto;
  }
  .drill-panel {
    border: 1px solid var(--border);
    background: var(--surface);
    border-radius: var(--radius);
    padding: 1rem;
  }
  .change-list li {
    flex-wrap: wrap;
  }
  .impact-summary {
    line-height: 1.8;
  }
</style>
