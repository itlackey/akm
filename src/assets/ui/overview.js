// Overview: health status, check results, metrics, recent improve runs and the 14-day usage chart.

import { miniBar, usageChart } from "./charts.js";
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

const GROUPS = [
  { status: "fail", title: "Failing", open: true },
  { status: "warn", title: "Warnings", open: true },
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
      ${tile("Shows", fmtNum(u.totals.shows), `${fmtNum(u.totals.distinctAssets)} distinct assets`)}
      ${tile("Curates", fmtNum(u.totals.curates))}
      ${tile("Select rate", fmtPct(u.selectRate), `${fmtNum(u.totals.selects)} selects`)}
      ${tile("Median search", fmtMs(u.searchMedianMs))}
      ${tile("Feedback", `+${fmtNum(m.feedback.totals.positive)} / -${fmtNum(m.feedback.totals.negative)}`, "positive / negative")}
      ${tile("LLM calls", fmtNum(m.llm.calls), `${fmtNum(m.llm.failures)} failed, ${fmtNum(m.llm.totalTokens)} tokens`)}
      ${tile("Pending proposals", fmtNum(m.proposals.byStatus.pending ?? 0))}
      ${tile("Task runs", fmtNum(m.tasks.runs), `${fmtNum(m.tasks.failed)} failed`)}
      ${tile("Index builds", fmtNum(m.index.runs), `median ${fmtMs(m.index.medianMs)}`)}
    </div>
    ${m.proposals.acceptRateBySource.length > 0 ? html`<h3>Proposal outcomes by source</h3>${tableWrap(html`<table><thead><tr><th>Source</th><th class="r">Total</th><th class="r">Accepted</th><th class="r">Rejected</th><th class="r">Pending</th><th class="r">Accept rate</th></tr></thead><tbody>${m.proposals.acceptRateBySource.map((r) => html`<tr><td class="mono">${r.source}</td><td class="r num">${fmtNum(r.total)}</td><td class="r num">${fmtNum(r.accepted)}</td><td class="r num">${fmtNum(r.rejected)}</td><td class="r num">${fmtNum(r.pending)}</td><td class="r num">${fmtPct(r.acceptRate)}</td></tr>`)}</tbody></table>`)}` : ""}
  </section>`;
}

function syncText(sync) {
  if (!sync) return "-";
  if (sync.skipped) return sync.reason ? `skipped (${sync.reason})` : "skipped";
  return [sync.committed ? "committed" : "no changes", sync.pushed ? "pushed" : ""].filter(Boolean).join(", ");
}

function triageText(t) {
  if (!t) return "-";
  const parts = [
    [t.promoted, "promoted"],
    [t.rejected, "rejected"],
    [t.deferred, "deferred"],
    [t.failed, "failed"],
    [t.skippedByCap, "capped"],
  ]
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${label}`);
  return parts.length > 0 ? parts.join(", ") : "none";
}

function runsSection(runs) {
  if (runs.length === 0) {
    return html`<section><h2>Recent improve runs</h2>${emptyState("No improve runs yet.", "Runs appear here after akm improve completes.")}</section>`;
  }
  const maxDuration = Math.max(0, ...runs.map((r) => r.durationMs ?? 0));
  const maxCalls = Math.max(0, ...runs.map((r) => r.modelCalls?.total ?? 0));
  return html`<section><h2>Recent improve runs</h2><p class="muted">Last ${runs.length}, newest first. Bars share one scale per column.</p>
    ${tableWrap(
      html`<table class="runs"><thead><tr><th>Started</th><th>Result</th><th colspan="2">Duration</th><th colspan="2">Model calls</th><th>Sync</th><th>Triage</th></tr></thead><tbody>${runs.map(
        (r) => {
          const calls = r.modelCalls?.total ?? 0;
          const failed = r.modelCalls?.failures ?? 0;
          return html`<tr>
        <td>${when(r.startedAt)}<div class="muted small mono">${r.id}</div></td>
        <td>${r.ok ? badge("ok", "ok") : badge("failed", "fail")}</td>
        <td class="r num">${fmtMs(r.durationMs)}</td><td>${miniBar(r.durationMs ?? 0, maxDuration, 0, `duration ${fmtMs(r.durationMs)}`)}</td>
        <td class="r num">${calls}${failed > 0 ? html` <span class="text-fail">(${failed} failed)</span>` : ""}</td><td>${miniBar(calls, maxCalls, failed, `${calls} model calls, ${failed} failed`)}</td>
        <td>${syncText(r.sync)}</td>
        <td>${triageText(r.triage)}</td>
      </tr>`;
        },
      )}</tbody></table>`,
    )}</section>`;
}

function usageSection(days) {
  const any = days.some((d) => d.search + d.curate + d.show + d.feedbackPositive + d.feedbackNegative > 0);
  return html`<section><h2>Usage, last 14 days</h2>${any ? usageChart(days) : emptyState("No usage events in the last 14 days.", "Searches, shows, curates and feedback you make with akm are counted here.")}</section>`;
}

export async function render() {
  const [data, meta] = await Promise.all([api("/api/overview"), getMeta().catch(() => null)]);
  const errors = data.errors ? Object.entries(data.errors) : [];
  return html`${pageHeader("Overview", "Health, usage and recent improve runs.")}
    ${statusStrip(data.health, meta)}
    ${errors.length > 0 ? html`<div class="notice notice-warn" role="alert"><strong>Some sections could not load.</strong><ul>${errors.map(([name, message]) => html`<li><span class="mono">${name}</span>: ${message}</li>`)}</ul></div>` : ""}
    ${data.health ? healthSection(data.health) : ""}
    ${metricsSection(data.metrics)}
    ${runsSection(data.improveRuns ?? [])}
    ${usageSection(data.usageByDay ?? [])}`;
}
