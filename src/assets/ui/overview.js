// Overview: current health and selected-window activity, retrieval and automation metrics.

import { sparkline } from "./charts.js";
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

const ATTENTION_MAX = 5;

/** What needs the reader, most severe first. Each row is a sentence and a verb link. */
function attentionItems(data, pulse) {
  const items = [];
  const checks = data.health ? [...data.health.hardChecks, ...data.health.advisories] : [];
  const failing = checks.filter((c) => c.status === "fail");
  const warning = checks.filter((c) => c.status === "warn");
  const plural = (n, one, many = `${one}s`) => `${fmtNum(n)} ${n === 1 ? one : many}`;
  if (failing.length)
    items.push({
      tone: "fail",
      text: `${plural(failing.length, "health check")} failing: ${failing[0].name}`,
      verb: "View",
      href: "#/overview",
      anchor: "health",
    });
  const failedRuns = (pulse?.attention.failedRuns.improve ?? 0) + (pulse?.attention.failedRuns.tasks ?? 0);
  if (failedRuns)
    items.push({
      tone: "fail",
      text: `${plural(failedRuns, "run")} failed this week`,
      verb: "View runs",
      href: "#/improve",
    });
  if (warning.length)
    items.push({
      tone: "warn",
      text: plural(warning.length, "health warning"),
      verb: "View",
      href: "#/overview",
      anchor: "health",
    });
  const pending = pulse?.attention.pending ?? { count: data.pendingNow ?? 0, oldest: null };
  if (pending.count)
    items.push({
      tone: "warn",
      text: `${plural(pending.count, "proposal")} waiting${pending.oldest ? `, oldest ${ago(pending.oldest).replace(" ago", "")}` : ""}`,
      verb: "Review",
      href: "#/proposals",
    });
  if (pulse?.attention.misses.queries)
    items.push({
      tone: "warn",
      text: `${plural(pulse.attention.misses.queries, "query", "queries")} found nothing on 2 or more days`,
      verb: "See misses",
      href: "#/search?tab=misses",
    });
  if (pulse?.attention.harm.reverted)
    items.push({
      tone: "info",
      text: `${plural(pulse.attention.harm.reverted, "change")} reverted this week`,
      verb: "View",
      href: "#/improve#harm",
    });
  if (pulse?.attention.setup)
    items.push({
      tone: "info",
      text: `Set up: connect a model so improve can run`,
      verb: "Open Config",
      href: "#/config",
    });
  return items;
}

function attention(data, pulse) {
  const items = attentionItems(data, pulse);
  const row = (item) =>
    html`<li data-tone="${item.tone}"><a href="${item.href}" ${item.anchor ? html`data-anchor="${item.anchor}"` : ""}><span class="dot dot-${item.tone}" aria-hidden="true"></span><span>${item.text}</span><span class="attention-go">${item.verb} →</span></a></li>`;
  const last = data.improveRuns?.[0];
  return html`<section class="attention" aria-labelledby="attention-title">
    <h2 id="attention-title">Needs attention</h2>
    ${
      items.length === 0
        ? html`<div class="attention-clear"><span class="dot dot-ok" aria-hidden="true"></span>Nothing needs you.${last ? ` Last improve run ${ago(last.startedAt)}: ${last.ok ? "finished" : "failed"}.` : " No improve runs recorded yet."}</div>`
        : html`<ul class="attention-list">${items.slice(0, ATTENTION_MAX).map(row)}</ul>${items.length > ATTENTION_MAX ? html`<details><summary>+${items.length - ATTENTION_MAX} more</summary><ul class="attention-list">${items.slice(ATTENTION_MAX).map(row)}</ul></details>` : ""}`
    }
  </section>`;
}

/** The share and its usual range, in a sentence. */
function usualText(usual, format) {
  if (!usual || usual.state === "low-data") return "Too little data for a usual range yet.";
  const range = `${format(usual.low)} to ${format(usual.high)}`;
  return usual.state === "within"
    ? `Within your usual ${range}.`
    : `${usual.state === "above" ? "Above" : "Below"} your usual ${range}.`;
}

function pulseTile({ title, value, lines, spark = "", tone = "" }) {
  return html`<div class="tile" ${tone ? html`data-tone="${tone}"` : ""}><span class="tile-label">${title}</span><span class="tile-value num">${value}</span>${lines.map((line) => html`<span class="tile-sub muted">${line}</span>`)}${spark}</div>`;
}

function pulseSection(pulse, trend) {
  if (!pulse)
    return html`<section aria-labelledby="pulse-title"><h2 id="pulse-title">Last 7 days against your usual</h2>${emptyState("The weekly comparison is unavailable.")}</section>`;
  const { foundNothing, negativeFeedback, runs } = pulse.tiles;
  const rates = (trend?.weekly ?? []).map((w) => w.rate);
  const fmtShare = (value) => fmtPct(value);
  const line = pulse.improveLine;
  const improveLine = line.proposed
    ? html`<p class="improve-line">Last ${line.weeks} weeks: improve proposed ${fmtNum(line.proposed)}; ${fmtNum(line.accepted)} accepted${line.acceptedThenReverted ? ` (${line.acceptedThenReverted} since reverted)` : ""}, ${fmtNum(line.rejected)} rejected${line.rejected ? ` (${line.rejectedByYou} by you)` : ""}, ${fmtNum(line.waiting)} waiting · ${fmtNum(line.calls)} model calls <a href="#/improve">Improve impact →</a></p>`
    : html`<p class="improve-line muted">Improve has proposed nothing in the last ${line.weeks} weeks. <a href="#/improve">Improve impact →</a></p>`;
  return html`<section aria-labelledby="pulse-title"><h2 id="pulse-title">Last 7 days against your usual <span class="chip-note">Last 7 days vs the 8 weeks before</span></h2>
    <div class="tiles pulse-tiles">
      ${pulseTile({
        title: "Found nothing",
        value: foundNothing.n ? fmtShare(foundNothing.rate) : "–",
        lines: [
          foundNothing.n
            ? `${fmtNum(foundNothing.x)} of ${fmtNum(foundNothing.n)} searches.`
            : "No searches recorded yet.",
          usualText(foundNothing.usual, fmtShare),
        ],
        tone: foundNothing.usual.state === "above" ? "warn" : "",
        spark: sparkline(rates),
      })}
      ${pulseTile({
        title: "Negative feedback",
        value: fmtNum(negativeFeedback.count),
        lines: [
          `${fmtNum(negativeFeedback.assets)} ${negativeFeedback.assets === 1 ? "asset" : "assets"}.`,
          negativeFeedback.usual.state === "low-data"
            ? "Too few weeks of feedback for a usual range."
            : `Usually ${negativeFeedback.usual.low} to ${negativeFeedback.usual.high} a week.`,
          negativeFeedback.latest
            ? `Latest: ${negativeFeedback.latest.ref ?? "an asset"}, ${ago(negativeFeedback.latest.at)}.`
            : "",
        ].filter(Boolean),
        tone: negativeFeedback.count ? "warn" : "",
      })}
      ${pulseTile({
        title: "Runs finishing",
        value: html`${fmtNum(runs.improve.ok + runs.tasks.ok)} <span class="muted">of ${fmtNum(runs.improve.total + runs.tasks.total)}</span>`,
        lines: [
          `Improve ${runs.improve.ok} of ${runs.improve.total} ok.`,
          `Tasks ${runs.tasks.ok} of ${runs.tasks.total} ok.`,
          ...runs.failedTasks.map((t) => `Failed: ${t.taskId}, ${ago(t.at)}.`),
        ],
        tone: runs.failedTasks.length || runs.improve.ok < runs.improve.total ? "fail" : "",
      })}
    </div>
    ${improveLine}
  </section>`;
}

function metricsCoverage(m) {
  return m?.notes?.length
    ? html`<details class="chart-notes notice"><summary>Measurement coverage</summary><ul>${m.notes.map((note) => html`<li>${note}</li>`)}</ul></details>`
    : "";
}

export async function render(ctx) {
  const window = ctx.query.get("window") === "90d" ? "90d" : "30d";
  const [data, meta, pulse, trend] = await Promise.all([
    api("/api/overview", { metricsSince: window }),
    getMeta().catch(() => null),
    api("/api/overview/pulse").catch(() => null),
    api("/api/retrieval", { since: "84d" }).catch(() => null),
  ]);
  ctx.after.push((root) => {
    for (const radio of root.querySelectorAll("input[name=metric-window]")) {
      radio.addEventListener("change", (event) => {
        location.hash = `#/overview?window=${event.target.value}`;
      });
    }
    root.querySelector(".attention")?.addEventListener("click", (event) => {
      const link = event.target.closest("a[data-anchor]");
      if (!link) return;
      event.preventDefault();
      root.querySelector(`#${link.dataset.anchor}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
  const errors = data.errors ? Object.entries(data.errors) : [];
  const choice = (value) =>
    html`<label><input type="radio" name="metric-window" value="${value}" ${window === value ? html`checked` : ""}><span>${value === "30d" ? "30 days" : "90 days"}</span></label>`;
  return html`<header class="page-head page-head-row"><div><h1>Overview</h1><p>Your akm environment. Times are UTC.</p></div></header>
    ${statusStrip(data.health, meta)}
    ${errors.length > 0 ? html`<details class="notice notice-warn"><summary>${errors.length} sections could not load</summary><ul>${errors.map(([name, message]) => html`<li><span class="mono">${name}</span>: ${message}</li>`)}</ul></details>` : ""}
    ${attention(data, pulse)}
    ${pulseSection(pulse, trend)}
    <section aria-labelledby="trends-title"><div class="trends-head"><h2 id="trends-title">Trends <span class="chip-note">Last ${window === "30d" ? "30" : "90"} days</span></h2><fieldset class="segmented trend-window" aria-label="Trend window">${choice("30d")}${choice("90d")}</fieldset></div>
    <p class="muted small">${data.metrics ? `${data.metrics.window.since.slice(0, 16).replace("T", " ")} to now, UTC. ` : ""}Today is partial. Health covers the last 24 hours.</p>
    <div class="chart-grid">${overviewCharts(ctx, data, trend)}</div></section>
    ${metricsCoverage(data.metrics)}
    ${data.health ? healthSection(data.health) : ""}`;
}
