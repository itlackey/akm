import { chart, eventStrip, lines, pChartLine, verticalBars } from "./chart-view.js";
import {
  api,
  badge,
  barList,
  dataTable,
  emptyState,
  fmtMs,
  fmtNum,
  fmtPct,
  html,
  legend,
  mount,
  pretty,
  tableWrap,
  weekStart,
  when,
} from "./lib.js";

const tokenCount = (row) => (row.calls > 0 && !row.usageCalls ? "Unknown" : fmtNum(row.totalTokens));

function activity(ctx, metrics) {
  const days = metrics.usage.daily;
  const dayLabel = (d) => (d.partial ? `${d.day.slice(5)}*` : d.day.slice(5));
  const labels = { search: "Search", curate: "Curate", show: "Show", feedback: "Feedback" };
  const keys = Object.keys(labels);
  return html`<section class="chart-card"><h2>Feedback and use</h2><p class="muted small">Your own searches, curates, shows and feedback, by UTC day.</p>
    ${legend(keys.map((key, index) => [labels[key], index + 1]))}
    ${
      days.length
        ? chart(
            ctx,
            "activity-chart",
            "Recorded operations by UTC day, stacked by kind. Exact counts follow in Data and details.",
            () =>
              verticalBars(
                days.map(dayLabel),
                keys.map((key, index) => ({
                  name: labels[key],
                  stack: "total",
                  colorIndex: index,
                  data: days.map((d) => d[key]),
                })),
                "Operations",
              ),
          )
        : emptyState("No recorded activity in this window.")
    }
    ${dataTable(tableWrap(html`<table><thead><tr><th>UTC day</th>${Object.values(labels).map((label) => html`<th class="r">${label}</th>`)}</tr></thead><tbody>${days.map((d) => html`<tr><th>${d.day}${d.partial ? html` <span class="muted small">(partial)</span>` : ""}</th>${keys.map((key) => html`<td class="r num">${fmtNum(d[key])}</td>`)}</tr>`)}</tbody></table>`))}
  </section>`;
}

function modelTable(rows) {
  return tableWrap(
    html`<table><thead><tr><th>Group</th><th class="r">Calls</th><th class="r">Failures</th><th class="r">Tokens</th><th>Token coverage</th><th>Summed call time</th></tr></thead><tbody>${rows.map(([name, row]) => html`<tr><th>${name}</th><td class="r">${fmtNum(row.calls)}</td><td class="r">${fmtNum(row.failures)}</td><td class="r">${tokenCount(row)}</td><td>${fmtNum(row.usageCalls)} / ${fmtNum(row.calls)} calls</td><td>${fmtMs(row.totalDurationMs)}</td></tr>`)}</tbody></table>`,
  );
}

function models(llm) {
  const sorted = (group) =>
    Object.entries(llm[group] ?? {}).sort((a, b) => b[1].calls - a[1].calls || a[0].localeCompare(b[0]));
  const byProcess = sorted("byProcess");
  const max = Math.max(0, ...byProcess.map(([, row]) => row.calls));
  return html`<section class="chart-card"><h2>Model calls</h2><p class="muted small">By process. Tokens cover ${fmtNum(llm.usageCalls ?? 0)} of ${fmtNum(llm.calls ?? 0)} calls and are not a cost. Time is summed call duration.</p>
    ${
      llm.calls
        ? barList(
            byProcess.map(([name, row]) => ({
              name,
              value: row.calls,
              text: `${fmtNum(row.calls)} calls`,
              tone: row.failures ? "fail" : "",
              note: `${row.failures ? `${fmtNum(row.failures)} failed · ` : ""}${tokenCount(row)} tokens · ${fmtMs(row.totalDurationMs)}`,
            })),
            { max, label: "Model calls by process" },
          )
        : emptyState("No model calls recorded in this window.")
    }
    ${dataTable(html`<h3>By process</h3>${modelTable(byProcess)}<h3>By execution target</h3>${modelTable(sorted("byEngine"))}`)}</section>`;
}

/** "Is search finding what you need?": the weekly share that found nothing as a p-chart, with improve runs under it. */
function retrievalCard(ctx, trend, data) {
  const weekly = trend?.weekly ?? [];
  const searched = weekly.filter((w) => w.n > 0);
  if (!trend || searched.length === 0)
    return html`<section class="chart-card chart-wide"><h2>Is search finding what you need?</h2>${emptyState("No searches in the last 12 weeks.", "Searches from you and your agents appear here.")}</section>`;
  const labels = weekly.map((w) => w.week.slice(5));
  const total = weekly.reduce((sum, w) => sum + w.n, 0);
  const missed = weekly.reduce((sum, w) => sum + w.x, 0);
  const odd = weekly.filter((w) => w.signal);
  const takeaway = odd.length
    ? `Unusual: ${odd.map((w) => `the week of ${w.week} (${fmtPct(w.rate)})`).join(", ")} fell outside the usual range.`
    : "No week stands out: the share that found nothing stays within its usual range.";
  const runs = (data.improveRuns ?? [])
    .map((run) => ({
      index: weekly.findIndex((w) => w.week === weekStart(run.startedAt)),
      tone: run.ok === false ? "fail" : "ok",
    }))
    .filter((event) => event.index >= 0);
  const days = trend.daily ?? [];
  return html`<section class="chart-card chart-wide"><h2>Is search finding what you need? <span class="muted small num">${fmtNum(total)} searches · ${fmtNum(missed)} found nothing</span></h2>
    <p>${takeaway}</p>
    ${legend([
      ["Found nothing, by week", 1],
      ["Band: the usual range"],
      [
        html`Dots below: improve runs, <i class="dot dot-ok" aria-hidden="true"></i>finished or <i class="dot dot-fail" aria-hidden="true"></i>failed`,
      ],
    ])}
    ${chart(
      ctx,
      "trend-rate",
      "Share of searches that found nothing, by week, with its usual range. Weekly figures follow in Data and details.",
      () => pChartLine(labels, weekly, trend.centre, { name: "Found nothing", unit: "Found nothing" }),
    )}
    ${chart(
      ctx,
      "trend-events",
      "Improve runs by week, on the same weeks as the chart above.",
      (token) => eventStrip(labels, runs, { name: "Improve runs", token }),
      { height: "strip" },
    )}
    <h3>Searches per week</h3>
    ${chart(
      ctx,
      "trend-searches",
      "Searches per week.",
      () => {
        const option = verticalBars(labels, [{ name: "Searches", data: weekly.map((w) => w.n) }], "Searches");
        option.yAxis.splitNumber = 2;
        return option;
      },
      { height: "short" },
    )}
    <h3>Median search time by day, last 12 weeks</h3>
    ${chart(
      ctx,
      "trend-latency",
      "Median search time by day. A gap means no timing was recorded that day.",
      () =>
        lines(
          days.map((d) => d.date.slice(5)),
          [{ name: "Median search time", colorIndex: 1, data: days.map((d) => d.medianMs) }],
          "Milliseconds",
        ),
      { height: "short" },
    )}
    <p class="muted small">Your own searches only. A day or week marked as partial is still filling. Found-nothing describes retrieval, not whether an answer was right.</p>
    ${dataTable(tableWrap(html`<table><thead><tr><th>Week of</th><th class="r">Searches</th><th class="r">Found nothing</th><th class="r">Share</th><th class="r">Usual range</th></tr></thead><tbody>${weekly.map((w) => html`<tr><th>${w.week}</th><td class="r num">${fmtNum(w.n)}</td><td class="r num">${fmtNum(w.x)}</td><td class="r num">${w.rate === null ? "n/a" : fmtPct(w.rate)}${w.signal ? html` ${badge("unusual", "warn")}` : ""}</td><td class="r num">${w.lower === null ? "n/a" : `${fmtPct(w.lower)} to ${fmtPct(w.upper)}`}</td></tr>`)}</tbody></table>`))}
  </section>`;
}

function automation(ctx, tasks, runs, since) {
  let root;
  let selection = 0;
  const selectTask = async (taskId) => {
    if (!taskId) return;
    const mine = ++selection;
    const detail = root.querySelector("[data-task-detail]");
    mount(detail, html`<p role="status">Loading recorded runs…</p>`);
    try {
      const history = await api("/api/tasks/history", { taskId, since });
      if (mine !== selection || !detail.isConnected) return;
      mount(
        detail,
        html`<h3>${taskId}</h3>${history.available ? html`<p class="muted small">${history.count} of ${history.totalCount} recorded runs in the selected window. No rerun is triggered.</p>${tableWrap(html`<table><thead><tr><th>Started</th><th>Status</th><th>Duration</th><th>Result / failure</th></tr></thead><tbody>${history.runs.map((run) => html`<tr><td>${when(run.startedAt)}</td><td>${badge(run.status, run.status === "failed" ? "fail" : "neutral")}</td><td>${fmtMs(run.durationMs)}</td><td>${run.detail ? html`<details class="toggle"><summary>${run.detail.reason ?? run.detail.error ?? "Recorded details"}</summary><pre class="code">${pretty(run.detail)}</pre></details>` : "No detail recorded"}</td></tr>`)}</tbody></table>`)}` : emptyState("Task history is unavailable.")}`,
      );
    } catch (error) {
      if (mine === selection) mount(detail, html`<p role="alert">${error.message}</p>`);
    }
    detail.focus({ preventScroll: true });
  };
  const selectRun = (id) => {
    const run = runs.find((r) => r.id === id);
    if (!run || !root) return;
    const detail = root.querySelector("[data-run-detail]");
    mount(
      detail,
      html`<h3>Run ${run.id}</h3><pre class="code" tabindex="0" role="group" aria-label="Run record, scrolls sideways">${pretty(run)}</pre>`,
    );
    detail.focus({ preventScroll: true });
  };
  ctx.after.push((element) => {
    root = element;
    root.querySelector("[data-task-table]")?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-task]");
      if (button) selectTask(button.dataset.task);
    });
    root.querySelector("[data-run-table]")?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-run]");
      if (button) selectRun(button.dataset.run);
    });
  });
  const runChart = () => ({
    xAxis: {
      type: "category",
      data: runs.map((r) => r.startedAt),
      axisLabel: { formatter: (value) => value.slice(5, 16).replace("T", " "), hideOverlap: true },
    },
    yAxis: { type: "value", name: "Minutes", min: 0 },
    series: [
      {
        type: "scatter",
        name: "Run duration",
        data: runs.map((r, i) => ({
          value: [i, r.durationMs == null ? null : Math.round((r.durationMs / 60000) * 10) / 10],
          symbol: r.ok === false ? "triangle" : r.ok === true ? "circle" : "diamond",
          symbolSize: 11,
        })),
      },
    ],
  });
  return html`<section class="chart-card" id="automation"><h2>Scheduled tasks</h2><p class="muted small">Recorded runs in this window, highest failure rate first.</p>${
    tasks === null
      ? emptyState("Task measurements unavailable.")
      : tasks?.length
        ? barList(
            tasks.map((t) => ({
              name: t.taskId,
              value: t.runs ? t.failed / t.runs : 0,
              text: `${t.failed} of ${t.runs} failed`,
              tone: t.failed ? "fail" : "",
              note: t.medianMs == null ? "" : `median ${fmtMs(t.medianMs)}`,
            })),
            { max: 1, label: "Failed runs by scheduled task" },
          )
        : emptyState("No failed task runs recorded in this window.")
  }
    <div data-task-detail tabindex="-1" aria-live="polite"></div>
    <details><summary>Run history by task</summary><div data-task-table>${tableWrap(html`<table><thead><tr><th>Task</th><th class="r">Failed / recorded</th><th>Median duration</th></tr></thead><tbody>${(tasks ?? []).map((t) => html`<tr><th><button type="button" class="btn-secondary" data-task="${t.taskId}">${t.taskId}</button></th><td class="r">${t.failed} / ${t.runs}</td><td>${fmtMs(t.medianMs)}</td></tr>`)}</tbody></table>`)}</div></details>
    <details><summary>Latest ${runs.length} improve runs (all time, not this window)</summary><p class="muted small">UTC timestamps. Circle: recorded success; triangle: failure; diamond: unknown.</p>${runs.length ? chart(ctx, "improve-chart", "Duration of the latest improve runs. Circle is success, triangle failure, diamond unknown. Select a point or table button for its recorded result.", runChart, { onSelect: (event) => selectRun(runs[event.dataIndex]?.id) }) : emptyState("No improve runs recorded.")}
    <div data-run-detail tabindex="-1" aria-live="polite"></div><div data-run-table>${tableWrap(html`<table><thead><tr><th>Run</th><th>Result</th><th>Duration</th><th>Model calls / failures</th></tr></thead><tbody>${runs.map((r) => html`<tr><th><button type="button" class="btn-secondary" data-run="${r.id}">${when(r.startedAt)}</button></th><td>${badge(r.ok === true ? "ok" : r.ok === false ? "failed" : "unknown", r.ok === false ? "fail" : "neutral")}</td><td>${fmtMs(r.durationMs)}</td><td>${fmtNum(r.modelCalls?.total)} / ${fmtNum(r.modelCalls?.failures)}</td></tr>`)}</tbody></table>`)}</div></details></section>`;
}

export function overviewCharts(ctx, data, trend) {
  if (!data.metrics) return emptyState("Usage and model measurements unavailable.");
  return html`${retrievalCard(ctx, trend, data)}${activity(ctx, data.metrics)}${models(data.metrics.llm)}${automation(ctx, data.taskFailures ?? null, data.improveRuns ?? [], data.metrics.window.since)}`;
}
