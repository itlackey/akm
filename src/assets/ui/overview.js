// Overview: current health and selected-window activity, retrieval and automation metrics.

import {
  api,
  badge,
  emptyState,
  fmtMs,
  fmtNum,
  fmtPct,
  getMeta,
  html,
  pageHeader,
  pretty,
  statusKind,
  tableWrap,
  when,
} from "./lib.js";
import { overviewCharts } from "./overview-charts.js";

const GROUPS = [
  { status: "fail", title: "Failing", open: false },
  { status: "warn", title: "Warnings", open: false },
  { status: "unknown", title: "Unknown", open: false },
  { status: "pass", title: "Passing", open: false },
];

function checkItem(check) {
  const evidence = check.evidence && Object.keys(check.evidence).length > 0 ? check.evidence : null;
  return html`<li class="check">
    <div class="check-head"><span class="dot dot-${statusKind(check.status)}" aria-hidden="true"></span><strong class="mono">${check.name}</strong>
      <span class="muted small">${check.kind}, ${check.confidence} confidence</span></div>
    <p class="check-msg">${check.message}</p>
    ${evidence ? html`<details><summary>Evidence</summary><pre class="code">${pretty(evidence)}</pre></details>` : ""}
  </li>`;
}

function healthSection(health) {
  const checks = [...health.hardChecks, ...health.advisories];
  return html`<section><h2>Health checks</h2>${GROUPS.map((g) => {
    const items = checks.filter((c) => c.status === g.status);
    if (items.length === 0) return "";
    return html`<details class="group" ${g.open ? html`open` : ""}><summary><span class="dot dot-${statusKind(g.status)}" aria-hidden="true"></span>${g.title} <span class="num muted">${items.length}</span></summary><ul class="checks">${items.map(checkItem)}</ul></details>`;
  })}${checks.length === 0 ? emptyState("No health checks ran.") : ""}</section>`;
}

function statusStrip(health, meta) {
  const checks = health ? [...health.hardChecks, ...health.advisories] : [];
  const count = (status) => checks.filter((c) => c.status === status).length;
  const overall = health?.status ?? "unknown";
  return html`<div class="strip">
    <div class="strip-main"><span class="strip-label">Overall health</span>${badge(health ? overall : "unavailable", statusKind(overall))}</div>
    <div class="strip-item"><span class="num big ${count("fail") > 0 ? "text-fail" : ""}">${count("fail")}</span><span class="muted">failing</span></div>
    <div class="strip-item"><span class="num big ${count("warn") > 0 ? "text-warn" : ""}">${count("warn")}</span><span class="muted">warning</span></div>
    <div class="strip-item"><span class="num big">${count("unknown")}</span><span class="muted">unknown</span></div>
    <div class="strip-item"><span class="num big">${count("pass")}</span><span class="muted">passing</span></div>
    <div class="strip-item strip-right"><span class="mono">akm ${meta ? meta.version : "?"}</span>${health ? html`<span class="muted small">window since ${when(health.since)}</span>` : ""}</div>
  </div>`;
}

function tile(label, value, sub = "") {
  return html`<div class="tile"><div class="tile-label">${label}</div><div class="tile-value num">${value}</div>${sub ? html`<div class="tile-sub muted">${sub}</div>` : ""}</div>`;
}

function metricsSection(m) {
  if (!m) return "";
  const u = m.usage;
  const day = (iso) => String(iso).slice(0, 10);
  return html`<section><h2>Metrics</h2><p class="muted">${day(m.window.since)} to ${day(m.window.until)}</p>
    <div class="tiles">
      ${tile("Searches", fmtNum(u.totals.searches), `${fmtNum(u.totals.zeroResultSearches)} with no results`)}
      ${tile("LLM calls", fmtNum(m.llm.calls), `${fmtNum(m.llm.failures)} failed, ${m.llm.calls > 0 && m.llm.usageCalls === 0 ? "unknown" : fmtNum(m.llm.totalTokens)} tokens`)}
      ${tile("Pending proposals", fmtNum(m.proposals.byStatus.pending ?? 0))}
      ${tile("Task runs", fmtNum(m.tasks.runs), `${fmtNum(m.tasks.failed)} failed`)}
    </div>
    <details><summary>Metrics details</summary><div class="tiles">
      ${tile("Shows", fmtNum(u.totals.shows), `${fmtNum(u.totals.distinctAssets)} distinct assets`)}
      ${tile("Curates", fmtNum(u.totals.curates))}
      ${tile("Selects per search", u.selectsPerSearch == null ? "—" : u.selectsPerSearch.toFixed(2), `${fmtNum(u.totals.selects)} selects / ${fmtNum(u.totals.searchesWithHits)} searches with hits`)}
      ${tile("Median search", fmtMs(u.searchMedianMs))}
      ${tile("Feedback", `+${fmtNum(m.feedback.totals.positive)} / -${fmtNum(m.feedback.totals.negative)}`, "positive / negative")}
      ${tile("Index builds", fmtNum(m.index.runs), `median ${fmtMs(m.index.medianMs)}`)}
    </div>
    ${m.proposals.acceptRateBySource.length > 0 ? html`<h3>Proposal outcomes by source</h3>${tableWrap(html`<table><thead><tr><th>Source</th><th class="r">Total</th><th class="r">Accepted</th><th class="r">Rejected</th><th class="r">Pending</th><th class="r">Accept rate</th></tr></thead><tbody>${m.proposals.acceptRateBySource.map((r) => html`<tr><td class="mono">${r.source}</td><td class="r num">${fmtNum(r.total)}</td><td class="r num">${fmtNum(r.accepted)}</td><td class="r num">${fmtNum(r.rejected)}</td><td class="r num">${fmtNum(r.pending)}</td><td class="r num">${fmtPct(r.acceptRate)}</td></tr>`)}</tbody></table>`)}` : ""}
    </details>
  </section>`;
}

export async function render(ctx) {
  const window = ["24h", "7d", "30d"].includes(ctx.query.get("window")) ? ctx.query.get("window") : "30d";
  const [data, meta] = await Promise.all([api("/api/overview", { metricsSince: window }), getMeta().catch(() => null)]);
  ctx.after.push((root) =>
    root.querySelector("[name=metric-window]").addEventListener("change", (event) => {
      location.hash = `#/overview?window=${event.target.value}`;
    }),
  );
  const errors = data.errors ? Object.entries(data.errors) : [];
  return html`${pageHeader("Overview", "Health, usage and recent improve runs.")}
    ${statusStrip(data.health, meta)}
    ${errors.length > 0 ? html`<details class="notice notice-warn"><summary>${errors.length} sections could not load</summary><ul>${errors.map(([name, message]) => html`<li><span class="mono">${name}</span>: ${message}</li>`)}</ul></details>` : ""}
    <div class="chart-controls"><label>Metrics window<select name="metric-window">${["24h", "7d", "30d"].map((value) => html`<option value="${value}" ${window === value ? html`selected` : ""}>${value}</option>`)}</select></label><span class="muted small">User-attributed activity · UTC days. Health: last 24 hours.</span></div>
    ${metricsSection(data.metrics)}
    ${data.metrics?.notes?.length ? html`<details class="chart-notes notice"><summary>Measurement coverage</summary><ul>${data.metrics.notes.map((note) => html`<li>${note}</li>`)}</ul></details>` : ""}
    ${overviewCharts(ctx, data)}
    ${data.health ? healthSection(data.health) : ""}`;
}
