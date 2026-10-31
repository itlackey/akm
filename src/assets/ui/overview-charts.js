import { horizontalBars, verticalBars, wireChart } from "./chart-view.js";
import { api, badge, emptyState, fmtMs, fmtNum, html, mount, pretty, tableWrap, when } from "./lib.js";

const chart = (id, label) => html`<div class="echarts-view" id="${id}" role="img" aria-label="${label}"></div>`;
const dataTable = (content) => html`<details><summary>Data and details</summary>${tableWrap(content)}</details>`;
const tokenCount = (row) => (row.calls > 0 && !row.usageCalls ? "Unknown" : fmtNum(row.totalTokens));

function activity(ctx, metrics) {
  const days = metrics.usage.daily;
  const labels = { search: "Search", curate: "Curate", show: "Show", feedback: "Feedback" };
  let selected = Object.keys(labels);
  ctx.after.push((root) =>
    root.querySelector("[data-activity-controls]")?.addEventListener("change", () => {
      selected = [...root.querySelectorAll("[data-activity]:checked")].map((node) => node.value);
    }),
  );
  wireChart(ctx, "#activity-chart", () =>
    verticalBars(
      days.map((d) => d.day),
      selected.map((key) => ({
        name: labels[key],
        colorIndex: Object.keys(labels).indexOf(key),
        data: days.map((d) => d[key]),
      })),
      "Operations",
    ),
  );
  return html`<section class="chart-card"><h2>Activity</h2><div class="chart-controls" data-activity-controls>${Object.entries(labels).map(([key, label], index) => html`<label><input type="checkbox" data-activity value="${key}" checked><i class="series-key series-${index + 1}" aria-hidden="true"></i>${label}</label>`)}</div>
    ${days.length ? chart("activity-chart", "Recorded operations by UTC day. Choose series above; exact counts follow in Data and details.") : emptyState("No recorded activity in this window.")}
    ${dataTable(html`<table><thead><tr><th>UTC day</th>${Object.values(labels).map((label) => html`<th class="r">${label}</th>`)}</tr></thead><tbody>${days.map((d) => html`<tr><th>${d.day}</th>${Object.keys(labels).map((key) => html`<td class="r num">${fmtNum(d[key])}</td>`)}</tr>`)}</tbody></table>`)}
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
            data: rows().map(([, row]) =>
              field === "totalTokens" && row.calls && !row.usageCalls ? null : row[field],
            ),
          },
        ],
        units[field],
      ),
    (event) => select(rows()[event.dataIndex]?.[0]),
  );
  return html`<section class="chart-card"><h2>Model utilization</h2><div class="chart-controls" data-model-controls><label>Group by<select name="model-group"><option value="byProcess">Process</option><option value="byEngine">Execution target</option></select></label><label>Measure<select name="model-value"><option value="calls">Calls</option><option value="totalTokens">Tokens</option><option value="totalDurationMs">Time</option></select></label></div>
    ${llm.calls ? chart("model-chart", "Model utilization ranked by the chosen measure. Select a bar or its table button for counts and coverage.") : emptyState("No model calls recorded in this window.")}
    <p class="muted small chart-notes">Tokens cover ${fmtNum(llm.usageCalls)} / ${fmtNum(llm.calls)} calls, not monetary cost. Time is summed call duration, not elapsed job time.</p>
    <div data-model-detail tabindex="-1" aria-live="polite"></div>
    <details><summary>Data and details</summary><div data-model-table>${modelTable(rows())}</div></details></section>`;
}

function retrieval(ctx, data) {
  if (!data)
    return html`<section class="chart-card"><h2>Retrieval health</h2>${emptyState("Retrieval measurements unavailable.")}</section>`;
  const days = data.daily;
  let root;
  const select = (day) => {
    if (!root || !day) return;
    const queries = data.zeroResultQueries.filter((q) => q.date === day);
    const detail = root.querySelector("[data-retrieval-detail]");
    mount(
      detail,
      html`<h3>No-result queries · ${day} UTC</h3>${queries.length ? tableWrap(html`<table><thead><tr><th>Query</th><th class="r">Count</th></tr></thead><tbody>${queries.map((q) => html`<tr><td class="wrap">${q.query}</td><td class="r">${q.count}</td></tr>`)}</tbody></table>`) : html`<p>No unsuccessful query was recorded for this day.</p>`}`,
    );
    detail.focus({ preventScroll: true });
  };
  ctx.after.push((element) => {
    root = element;
    root.querySelector("[data-retrieval-table]")?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-day]");
      if (button) select(button.dataset.day);
    });
  });
  wireChart(
    ctx,
    "#retrieval-results",
    () =>
      verticalBars(
        days.map((d) => d.date),
        [
          { name: "All searches", data: days.map((d) => d.searches) },
          { name: "No results", data: days.map((d) => d.zeroResults) },
        ],
        "Searches",
      ),
    (event) => select(days[event.dataIndex]?.date),
  );
  wireChart(
    ctx,
    "#retrieval-latency",
    () => ({
      ...verticalBars(
        days.map((d) => d.date),
        [],
        "Milliseconds",
      ),
      series: [
        {
          type: "line",
          name: "Median latency",
          connectNulls: false,
          data: days.map((d) => d.medianMs),
          symbol: "circle",
          symbolSize: 7,
        },
      ],
    }),
    (event) => select(days[event.dataIndex]?.date),
  );
  return html`<section class="chart-card"><h2>Retrieval health</h2>${days.length ? html`<p class="chart-legend"><span><i class="series-key series-1" aria-hidden="true"></i>All searches</span><span><i class="series-key series-2" aria-hidden="true"></i>No results</span></p>${chart("retrieval-results", "Total searches and no-result searches by UTC day. Select a day to inspect unsuccessful queries.")}<h3>Median search latency</h3>${chart("retrieval-latency", "Median recorded search latency by UTC day on its own millisecond scale. Missing samples are gaps.")}` : emptyState("No searches recorded in this window.")}
    <p class="muted small">No-result counts describe retrieval, not answer quality. Missing latency samples are unknown.</p>
    <div data-retrieval-detail tabindex="-1" aria-live="polite"></div>
    <details><summary>Data and details</summary><div data-retrieval-table>${tableWrap(html`<table><thead><tr><th>UTC day / queries</th><th class="r">Searches</th><th class="r">No results</th><th>Median latency</th><th class="r">Latency samples</th></tr></thead><tbody>${days.map((d) => html`<tr><th><button type="button" class="btn-secondary" data-day="${d.date}">${d.date}</button></th><td class="r">${d.searches}</td><td class="r">${d.zeroResults}</td><td>${d.medianMs === null ? "Unknown" : fmtMs(d.medianMs)}</td><td class="r">${d.latencySamples} / ${d.searches}</td></tr>`)}</tbody></table>`)}</div></details></section>`;
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
    mount(detail, html`<h3>Run ${run.id}</h3><pre class="code">${pretty(run)}</pre>`);
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
        (tasks ?? []).map((t) => t.taskId),
        [{ name: "Failed runs", data: (tasks ?? []).map((t) => t.failed) }],
        "Failures",
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
      yAxis: { type: "value", name: "Milliseconds", min: 0 },
      series: [
        {
          type: "scatter",
          name: "Run duration",
          data: runs.map((r, i) => ({
            value: [i, r.durationMs],
            symbol: r.ok === false ? "triangle" : r.ok === true ? "circle" : "diamond",
            symbolSize: 11,
          })),
        },
      ],
    }),
    (event) => selectRun(runs[event.dataIndex]?.id),
  );
  return html`<section class="chart-card"><h2>Automation reliability</h2>${tasks === null ? emptyState("Task measurements unavailable.") : tasks?.length ? chart("tasks-chart", "Failed task runs ranked by failures before any display limit. Exact recorded-run denominators and history are in the table.") : emptyState("No failed task runs recorded in this window.")}
    <p class="muted small">Failures first. Other recorded statuses are not automatically successes; missing runs do not prove a schedule ran.</p>
    <div data-task-detail tabindex="-1" aria-live="polite"></div>
    <details><summary>Task data and history</summary><div data-task-table>${tableWrap(html`<table><thead><tr><th>Task</th><th class="r">Failed / recorded</th><th>Median duration</th></tr></thead><tbody>${(tasks ?? []).map((t) => html`<tr><th><button type="button" class="btn-secondary" data-task="${t.taskId}">${t.taskId}</button></th><td class="r">${t.failed} / ${t.runs}</td><td>${fmtMs(t.medianMs)}</td></tr>`)}</tbody></table>`)}</div></details>
    <details><summary>Recent improve runs · latest ${runs.length}, all time</summary><p class="muted small">UTC timestamps. Circle: recorded success; triangle: failure; diamond: unknown.</p>${runs.length ? chart("improve-chart", "Duration of the latest improve runs. Circle is success, triangle failure, diamond unknown. Select a point or table button for its recorded result.") : emptyState("No improve runs recorded.")}
    <div data-run-detail tabindex="-1" aria-live="polite"></div><div data-run-table>${tableWrap(html`<table><thead><tr><th>Run</th><th>Result</th><th>Duration</th><th>Model calls / failures</th></tr></thead><tbody>${runs.map((r) => html`<tr><th><button type="button" class="btn-secondary" data-run="${r.id}">${when(r.startedAt)}</button></th><td>${badge(r.ok === true ? "ok" : r.ok === false ? "failed" : "unknown", r.ok === false ? "fail" : "neutral")}</td><td>${fmtMs(r.durationMs)}</td><td>${fmtNum(r.modelCalls?.total)} / ${fmtNum(r.modelCalls?.failures)}</td></tr>`)}</tbody></table>`)}</div></details></section>`;
}

export function overviewCharts(ctx, data) {
  if (!data.metrics) return emptyState("Usage and model measurements unavailable.");
  return html`${activity(ctx, data.metrics)}${models(ctx, data.metrics.llm)}${retrieval(ctx, data.retrieval)}${automation(ctx, data.taskFailures ?? null, data.improveRuns ?? [], data.metrics.window.since)}`;
}
