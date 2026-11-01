// Overview: current health and selected-window activity, retrieval and automation metrics.

import { ago, api, badge, emptyState, fmtMs, fmtNum, fmtPct, getMeta, html, pretty, statusKind, when } from "./lib.js";
import { overviewCharts } from "./overview-charts.js";

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
    ${evidence ? html`<details><summary>Evidence</summary><pre class="code" data-volatile tabindex="0" role="group" aria-label="Evidence, scrolls sideways">${pretty(evidence)}</pre></details>` : ""}
  </li>`;
}

function healthSection(health) {
  const checks = [...health.hardChecks, ...health.advisories];
  return html`<section id="health"><h2>Health checks</h2>${GROUPS.map((g) => {
    const items = checks.filter((c) => c.status === g.status);
    if (items.length === 0) return "";
    return html`<details class="group" ${g.open ? html`open` : ""}><summary><span class="dot dot-${statusKind(g.status)}" aria-hidden="true"></span>${g.title} <span class="num muted">${items.length}</span></summary><ul class="checks">${items.map(checkItem)}</ul></details>`;
  })}${checks.length === 0 ? emptyState("No health checks ran.") : ""}</section>`;
}

function statusStrip(health, meta) {
  const checks = health ? [...health.hardChecks, ...health.advisories] : [];
  const count = (status) => checks.filter((c) => c.status === status).length;
  const overall = health?.status ?? "unknown";
  const unknown = count("unknown");
  const label = !health
    ? "unavailable"
    : overall === "pass" && unknown > 0
      ? `healthy · ${unknown} could not run`
      : overall;
  return html`<div class="strip">
    <div class="strip-main"><span class="strip-label">Overall health</span>${badge(label, statusKind(overall))}<span class="muted small">last 24 hours</span></div>
    <div class="strip-item"><span class="num big ${count("fail") > 0 ? "text-fail" : ""}">${count("fail")}</span><span class="muted">failing</span></div>
    <div class="strip-item"><span class="num big ${count("warn") > 0 ? "text-warn" : ""}">${count("warn")}</span><span class="muted">warning</span></div>
    <div class="strip-item"><span class="num big">${count("unknown")}</span><span class="muted">unknown</span></div>
    <div class="strip-item"><span class="num big">${count("pass")}</span><span class="muted">passing</span></div>
    <div class="strip-item strip-right"><span class="mono" data-volatile>akm ${meta ? meta.version : "?"}</span>${health ? html`<span class="muted small">window since ${when(health.since)}</span>` : ""}</div>
  </div>`;
}

function tile(label, value, sub = "", { href = "", tone = "" } = {}) {
  const body = html`<span class="tile-label">${label}</span><span class="tile-value num">${value}</span>${sub ? html`<span class="tile-sub muted">${sub}</span>` : ""}`;
  return href
    ? html`<a class="tile" href="${href}" ${tone ? html`data-tone="${tone}"` : ""}>${body}</a>`
    : html`<div class="tile" ${tone ? html`data-tone="${tone}"` : ""}>${body}</div>`;
}

function attentionItems(data) {
  const items = [];
  const checks = data.health ? [...data.health.hardChecks, ...data.health.advisories] : [];
  const failing = checks.filter((c) => c.status === "fail").length;
  const warning = checks.filter((c) => c.status === "warn").length;
  if (failing)
    items.push({
      tone: "fail",
      text: `${failing} health check${failing === 1 ? "" : "s"} failing`,
      href: "#/overview",
      anchor: "health",
    });
  if (warning)
    items.push({
      tone: "warn",
      text: `${warning} health warning${warning === 1 ? "" : "s"}`,
      href: "#/overview",
      anchor: "health",
    });
  const pending = data.health?.report?.pendingProposals ?? [];
  if (pending.length) {
    const oldest = pending.map((p) => p.createdAt).sort()[0];
    items.push({
      tone: "info",
      text: `${pending.length} proposal${pending.length === 1 ? "" : "s"} waiting for review`,
      detail: oldest ? `oldest ${ago(oldest)}` : "",
      href: "#/proposals",
    });
  }
  const failedTasks = (data.taskFailures ?? []).reduce((sum, t) => sum + (t.failed ?? 0), 0);
  if (failedTasks)
    items.push({
      tone: "fail",
      text: `${failedTasks} failed task run${failedTasks === 1 ? "" : "s"}`,
      href: "#/overview",
      anchor: "automation",
    });
  const misses = data.retrieval?.zeroResultQueries?.length ?? 0;
  if (misses)
    items.push({
      tone: "warn",
      text: `${misses} search${misses === 1 ? "" : "es"} found nothing`,
      detail: "add knowledge for them",
      href: "#/search",
    });
  const llmFail = data.metrics?.llm?.failures ?? 0;
  if (llmFail)
    items.push({ tone: "warn", text: `${llmFail} model call${llmFail === 1 ? "" : "s"} failed`, href: "#/improve" });
  return items;
}

function attention(data) {
  const items = attentionItems(data);
  return html`<section class="attention" aria-labelledby="attention-title">
    <h2 id="attention-title">Needs attention</h2>
    ${
      items.length === 0
        ? html`<div class="attention-clear"><span class="dot dot-ok" aria-hidden="true"></span>Nothing needs you right now.</div>`
        : html`<ul class="attention-list">${items.map(
            (item) =>
              html`<li data-tone="${item.tone}"><a href="${item.href}" ${item.anchor ? html`data-anchor="${item.anchor}"` : ""}><span class="dot dot-${item.tone}" aria-hidden="true"></span><span>${item.text}</span>${item.detail ? html`<span class="muted small">${item.detail}</span>` : ""}<span class="attention-go" aria-hidden="true">→</span></a></li>`,
          )}</ul>`
    }
  </section>`;
}

function improveLine(runs) {
  const last = runs?.[0];
  if (!last)
    return html`<p class="improve-line muted">No improve runs recorded yet. <a href="#/improve">How improve works</a></p>`;
  return html`<p class="improve-line"><span class="dot dot-${last.ok ? "ok" : "fail"}" aria-hidden="true"></span><span>Last improve run ${ago(last.startedAt)}: ${last.ok ? "finished" : "failed"}, ${fmtNum(last.modelCalls?.total ?? 0)} model calls${last.durationMs != null ? html`, ${fmtMs(last.durationMs)}` : ""}.</span> <a href="#/improve">See what improve changed</a></p>`;
}

function metricsSection(m, pendingCount) {
  if (!m) return "";
  const u = m.usage;
  const searches = u.totals.searches;
  const zero = u.totals.zeroResultSearches;
  return html`<section aria-labelledby="metrics-title"><h2 id="metrics-title">At a glance</h2>
    <div class="tiles">
      ${tile("Searches", fmtNum(searches), searches ? `${fmtPct(zero / searches)} found nothing` : "none yet", { href: "#/search", tone: searches && zero / searches > 0.2 ? "warn" : "" })}
      ${tile("Waiting for review", fmtNum(pendingCount), pendingCount ? "proposals" : "queue is empty", { href: "#/proposals", tone: pendingCount ? "warn" : "ok" })}
      ${tile("Model calls", fmtNum(m.llm.calls), m.llm.failures ? `${fmtNum(m.llm.failures)} failed` : `${m.llm.calls > 0 && m.llm.usageCalls === 0 ? "unknown" : fmtNum(m.llm.totalTokens)} tokens`, { href: "#/improve", tone: m.llm.failures ? "fail" : "" })}
      ${tile("Task runs", fmtNum(m.tasks.runs), m.tasks.failed ? `${fmtNum(m.tasks.failed)} failed` : "all succeeded", { tone: m.tasks.failed ? "fail" : "" })}
      ${tile("Feedback", html`+${fmtNum(m.feedback.totals.positive)} <span class="muted">/</span> −${fmtNum(m.feedback.totals.negative)}`, "positive / negative")}
      ${tile("Median search", fmtMs(u.searchMedianMs), `${fmtNum(u.totals.shows)} assets opened`)}
    </div>
  </section>`;
}

export async function render(ctx) {
  const window = ["24h", "7d", "30d"].includes(ctx.query.get("window")) ? ctx.query.get("window") : "30d";
  const [data, meta] = await Promise.all([api("/api/overview", { metricsSince: window }), getMeta().catch(() => null)]);
  ctx.after.push((root) => {
    root.querySelector("[name=metric-window]")?.addEventListener("change", (event) => {
      location.hash = `#/overview?window=${event.target.value}`;
    });
    root.querySelector(".attention-list")?.addEventListener("click", (event) => {
      const link = event.target.closest("a[data-anchor]");
      if (!link) return;
      event.preventDefault();
      root.querySelector(`#${link.dataset.anchor}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
  const errors = data.errors ? Object.entries(data.errors) : [];
  const pendingCount = data.health?.report?.pendingProposals?.length ?? data.metrics?.proposals?.byStatus?.pending ?? 0;
  return html`<header class="page-head page-head-row"><div><h1>Overview</h1><p>How your akm environment is doing, and what needs you.</p></div>
      <label class="window-control">Window<select name="metric-window">${["24h", "7d", "30d"].map((value) => html`<option value="${value}" ${window === value ? html`selected` : ""}>${value === "24h" ? "Last 24 hours" : `Last ${value.replace("d", " days")}`}</option>`)}</select></label></header>
    ${statusStrip(data.health, meta)}
    ${errors.length > 0 ? html`<details class="notice notice-warn"><summary>${errors.length} sections could not load</summary><ul>${errors.map(([name, message]) => html`<li><span class="mono">${name}</span>: ${message}</li>`)}</ul></details>` : ""}
    <div class="overview-top">${attention(data)}<section aria-labelledby="improve-title"><h2 id="improve-title">Improve</h2>${improveLine(data.improveRuns)}</section></div>
    ${metricsSection(data.metrics, pendingCount)}
    <section aria-labelledby="trends-title"><h2 id="trends-title">Trends</h2><p class="muted small">Your activity in UTC days. Health covers the last 24 hours.</p>
    <div class="chart-grid">${overviewCharts(ctx, data)}</div></section>
    ${data.metrics?.notes?.length ? html`<details class="chart-notes notice"><summary>Measurement coverage</summary><ul>${data.metrics.notes.map((note) => html`<li>${note}</li>`)}</ul></details>` : ""}
    ${data.health ? healthSection(data.health) : ""}`;
}
