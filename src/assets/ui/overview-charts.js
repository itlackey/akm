import { eventStrip, horizontalBars, lines, pChartLine, verticalBars, wireChart } from "./chart-view.js";
import {
  api,
  badge,
  emptyState,
  fmtMs,
  fmtNum,
  fmtPct,
  html,
  mount,
  pretty,
  tableWrap,
  weekStart,
  when,
} from "./lib.js";

const chart = (id, label) => html`<div class="echarts-view" id="${id}" role="img" aria-label="${label}"></div>`;
const dataTable = (content) => html`<details><summary>Data and details</summary>${tableWrap(content)}</details>`;
const tokenCount = (row) => (row.calls > 0 && !row.usageCalls ? "Unknown" : fmtNum(row.totalTokens));

function activity(ctx, metrics) {
  const days = metrics.usage.daily;
  const dayLabel = (d) => (d.partial ? `${d.day}*` : d.day);
  const labels = { search: "Search", curate: "Curate", show: "Show", feedback: "Feedback" };
  let selected = Object.keys(labels);
  ctx.after.push((root) =>
    root.querySelector("[data-activity-controls]")?.addEventListener("change", () => {
      selected = [...root.querySelectorAll("[data-activity]:checked")].map((node) => node.value);
    }),
  );
  wireChart(ctx, "#activity-chart", () =>
    verticalBars(
      days.map(dayLabel),
      selected.map((key) => ({
        name: labels[key],
        colorIndex: Object.keys(labels).indexOf(key),
        data: days.map((d) => d[key]),
      })),
      "Operations",
    ),
  );
  return html`<section class="chart-card"><h2>Feedback and use</h2><p class="muted small">Your own activity only: searches, curates, shows and feedback you made.</p><div class="chart-controls" data-activity-controls>${Object.entries(labels).map(([key, label], index) => html`<label><input type="checkbox" data-activity value="${key}" checked><i class="series-key series-${index + 1}" aria-hidden="true"></i>${label}</label>`)}</div>
    ${days.length ? chart("activity-chart", "Recorded operations by UTC day. Choose series above; exact counts follow in Data and details.") : emptyState("No recorded activity in this window.")}
    ${dataTable(html`<table><thead><tr><th>UTC day</th>${Object.values(labels).map((label) => html`<th class="r">${label}</th>`)}</tr></thead><tbody>${days.map((d) => html`<tr><th>${d.day}${d.partial ? html` <span class="muted small">(partial)</span>` : ""}</th>${Object.keys(labels).map((key) => html`<td class="r num">${fmtNum(d[key])}</td>`)}</tr>`)}</tbody></table>`)}
  </section>`;
}

function modelTable(rows) {
  return tableWrap(
    html`<table><thead><tr><th>Group</th><th class="r">Calls</th><th class="r">Failures</th><th class="r">Tokens</th><th>Token coverage</th><th>Summed call time</th></tr></thead><tbody>${rows.map(([name, row]) => html`<tr><th><button type="button" class="btn-secondary" data-model="${name}">${name}</button></th><td class="r">${fmtNum(row.calls)}</td><td class="r">${fmtNum(row.failures)}</td><td class="r">${tokenCount(row)}</td><td>${fmtNum(row.usageCalls)} / ${fmtNum(row.calls)} calls</td><td>${fmtMs(row.totalDurationMs)}</td></tr>`)}</tbody></table>`,
  );
}

function models(ctx, llm) {
  let group = "byProcess";
  let field = "calls";
  const rows = () =>
    Object.entries(llm[group] ?? {}).sort((a, b) => b[1][field] - a[1][field] || a[0].localeCompare(b[0]));
  const units = { calls: "Calls", totalTokens: "Reported tokens", totalDurationMs: "Summed milliseconds" };
  let root;
  const select = (name) => {
    const row = llm[group]?.[name];
    if (!row || !root) return;
    const detail = root.querySelector("[data-model-detail]");
    mount(
      detail,
      html`<h3>${name}</h3><p>${fmtNum(row.calls)} calls · ${fmtNum(row.failures)} failures · ${tokenCount(row)} reported tokens · ${fmtMs(row.totalDurationMs)} summed call time.</p><p class="muted">Token measurements: ${fmtNum(row.usageCalls)} of ${fmtNum(row.calls)} calls.</p>`,
    );
    detail.focus({ preventScroll: true });
  };
  ctx.after.push((element) => {
    root = element;
    root.querySelector("[data-model-controls]")?.addEventListener("change", () => {
      group = root.querySelector("[name=model-group]").value;
      field = root.querySelector("[name=model-value]").value;
      mount(root.querySelector("[data-model-table]"), modelTable(rows()));
      mount(root.querySelector("[data-model-detail]"), html``);
    });
    root.querySelector("[data-model-table]")?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-model]");
      if (button) select(button.dataset.model);
    });
  });
  wireChart(
    ctx,
    "#model-chart",
    () =>
      horizontalBars(
        rows().map(([name]) => name),
        [
          {
            name: units[field],
            // A bar whose calls only partly report tokens is drawn hollow: its length is a lower bound.
            data: rows().map(([, row]) => {
              if (field !== "totalTokens") return row[field];
              if (row.calls && !row.usageCalls) return null;
              return row.usageCalls / row.calls < 0.8
                ? { value: row[field], itemStyle: { color: "transparent", borderWidth: 2 } }
                : row[field];
            }),
          },
        ],
        units[field],
      ),
    (event) => select(rows()[event.dataIndex]?.[0]),
  );
  return html`<section class="chart-card"><h2>Model utilization</h2><div class="chart-controls" data-model-controls><label>Group by<select name="model-group"><option value="byProcess">Process</option><option value="byEngine">Execution target</option></select></label><label>Measure<select name="model-value"><option value="calls">Calls</option><option value="totalTokens">Tokens</option><option value="totalDurationMs">Time</option></select></label></div>
    ${llm.calls ? chart("model-chart", "Model utilization ranked by the chosen measure. Select a bar or its table button for counts and coverage.") : emptyState("No model calls recorded in this window.")}
    ${llm.calls ? html`<p class="muted small chart-notes">Tokens cover ${fmtNum(llm.usageCalls ?? 0)} / ${fmtNum(llm.calls)} calls, not monetary cost. Time is summed call duration, not elapsed job time. All sources: improve, tasks and agents.</p>` : ""}
    <div data-model-detail tabindex="-1" aria-live="polite"></div>
    <details><summary>Data and details</summary><div data-model-table>${modelTable(rows())}</div></details></section>`;
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
  wireChart(ctx, "#trend-rate", () =>
    pChartLine(labels, weekly, trend.centre, { name: "Found nothing", unit: "Found nothing" }),
  );
  wireChart(ctx, "#trend-events", (token) => eventStrip(labels, runs, { name: "Improve runs", token }));
  wireChart(ctx, "#trend-searches", () =>
    verticalBars(labels, [{ name: "Searches", data: weekly.map((w) => w.n) }], "Searches"),
  );
  const days = data.retrieval?.daily ?? [];
  wireChart(ctx, "#trend-latency", () =>
    lines(
      days.map((d) => d.date.slice(5)),
      [{ name: "Median search time", colorIndex: 1, data: days.map((d) => d.medianMs) }],
      "Milliseconds",
    ),
  );
  return html`<section class="chart-card chart-wide"><h2>Is search finding what you need? <span class="muted small num">${fmtNum(total)} searches · ${fmtNum(missed)} found nothing</span></h2>
    <p>${takeaway}</p>
    <p class="chart-legend"><span><i class="series-key series-1" aria-hidden="true"></i>Found nothing, by week</span><span>Band: the usual range</span><span><i class="marker-key" aria-hidden="true"></i>Improve run (below)</span></p>
    <div class="echarts-view" data-height="tall" id="trend-rate" role="img" aria-label="Share of searches that found nothing, by week, with its usual range. Weekly figures follow in Data and details."></div>
    <div class="echarts-view" data-height="strip" id="trend-events" role="img" aria-label="Improve runs by week, on the same weeks as the chart above."></div>
    <h3>Searches per week</h3>
    <div class="echarts-view" data-height="short" id="trend-searches" role="img" aria-label="Searches per week."></div>
    <h3>Search time</h3>
    <div class="echarts-view" data-height="short" id="trend-latency" role="img" aria-label="Median search time by day. A gap means no timing was recorded that day."></div>
    <p class="muted small">Your own searches only. A day or week marked as partial is still filling. Found-nothing describes retrieval, not whether an answer was right.</p>
    <details><summary>Data and details</summary>${tableWrap(html`<table><thead><tr><th>Week of</th><th class="r">Searches</th><th class="r">Found nothing</th><th class="r">Share</th><th class="r">Usual range</th></tr></thead><tbody>${weekly.map((w) => html`<tr><th>${w.week}</th><td class="r num">${fmtNum(w.n)}</td><td class="r num">${fmtNum(w.x)}</td><td class="r num">${w.rate === null ? "n/a" : fmtPct(w.rate)}${w.signal ? html` <span class="badge badge-warn">unusual</span>` : ""}</td><td class="r num">${w.lower === null ? "n/a" : `${fmtPct(w.lower)} to ${fmtPct(w.upper)}`}</td></tr>`)}</tbody></table>`)}</details>
  </section>`;
}

function automation(ctx, tasks, runs, since) {
  let root;
  let selection = 0;
  const selectTask = async (taskId) => {
    if (!root || !taskId) return;
    const mine = ++selection;
    const detail = root.querySelector("[data-task-detail]");
    mount(detail, html`<p role="status">Loading recorded runs…</p>`);
    try {
      const history = await api("/api/tasks/history", { taskId, since });
      if (mine !== selection || !detail.isConnected) return;
      mount(
        detail,
        html`<h3>${taskId}</h3>${history.available ? html`<p class="muted small">${history.count} of ${history.totalCount} recorded runs in the selected window. No rerun is triggered.</p>${tableWrap(html`<table><thead><tr><th>Started</th><th>Status</th><th>Duration</th><th>Result / failure</th></tr></thead><tbody>${history.runs.map((run) => html`<tr><td>${when(run.startedAt)}</td><td>${badge(run.status, run.status === "failed" ? "fail" : "neutral")}</td><td>${fmtMs(run.durationMs)}</td><td>${run.detail ? html`<details><summary>${run.detail.reason ?? run.detail.error ?? "Recorded details"}</summary><pre class="code">${pretty(run.detail)}</pre></details>` : "No detail recorded"}</td></tr>`)}</tbody></table>`)}` : emptyState("Task history is unavailable.")}`,
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
    return () => {
      selection++;
    };
  });
  wireChart(
    ctx,
    "#tasks-chart",
    () =>
      horizontalBars(
        (tasks ?? []).map((t) => `${t.taskId} (n=${t.runs})`),
        [
          {
            name: "Failure rate",
            data: (tasks ?? []).map((t) => (t.runs ? Math.round((t.failed / t.runs) * 1000) / 10 : 0)),
          },
        ],
        "Failure rate (%)",
      ),
    (event) => selectTask(tasks[event.dataIndex]?.taskId),
  );
  wireChart(
    ctx,
    "#improve-chart",
    () => ({
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
    }),
    (event) => selectRun(runs[event.dataIndex]?.id),
  );
  return html`<section class="chart-card" id="automation"><h2>Automation reliability</h2><p class="muted small">Scheduled task runs, ranked by failure rate. n is the number of recorded runs.</p>${tasks === null ? emptyState("Task measurements unavailable.") : tasks?.length ? chart("tasks-chart", "Failed task runs ranked by failures before any display limit. Exact recorded-run denominators and history are in the table.") : emptyState("No failed task runs recorded in this window.")}
    <p class="muted small">Failures first. Other recorded statuses are not automatically successes; missing runs do not prove a schedule ran.</p>
    <div data-task-detail tabindex="-1" aria-live="polite"></div>
    <details><summary>Task data and history</summary><div data-task-table>${tableWrap(html`<table><thead><tr><th>Task</th><th class="r">Failed / recorded</th><th>Median duration</th></tr></thead><tbody>${(tasks ?? []).map((t) => html`<tr><th><button type="button" class="btn-secondary" data-task="${t.taskId}">${t.taskId}</button></th><td class="r">${t.failed} / ${t.runs}</td><td>${fmtMs(t.medianMs)}</td></tr>`)}</tbody></table>`)}</div></details>
    <details><summary>Latest ${runs.length} improve runs (all time, not this window)</summary><p class="muted small">UTC timestamps. Circle: recorded success; triangle: failure; diamond: unknown.</p>${runs.length ? chart("improve-chart", "Duration of the latest improve runs. Circle is success, triangle failure, diamond unknown. Select a point or table button for its recorded result.") : emptyState("No improve runs recorded.")}
    <div data-run-detail tabindex="-1" aria-live="polite"></div><div data-run-table>${tableWrap(html`<table><thead><tr><th>Run</th><th>Result</th><th>Duration</th><th>Model calls / failures</th></tr></thead><tbody>${runs.map((r) => html`<tr><th><button type="button" class="btn-secondary" data-run="${r.id}">${when(r.startedAt)}</button></th><td>${badge(r.ok === true ? "ok" : r.ok === false ? "failed" : "unknown", r.ok === false ? "fail" : "neutral")}</td><td>${fmtMs(r.durationMs)}</td><td>${fmtNum(r.modelCalls?.total)} / ${fmtNum(r.modelCalls?.failures)}</td></tr>`)}</tbody></table>`)}</div></details></section>`;
}

export function overviewCharts(ctx, data, trend) {
  if (!data.metrics) return emptyState("Usage and model measurements unavailable.");
  return html`${retrievalCard(ctx, trend, data)}${activity(ctx, data.metrics)}${models(ctx, data.metrics.llm)}${automation(ctx, data.taskFailures ?? null, data.improveRuns ?? [], data.metrics.window.since)}`;
}
