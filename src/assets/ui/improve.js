// Improve impact: what akm's improve processes proposed, what was decided and by whom, and what it cost.

import { verticalBars, wireChart } from "./chart-view.js";
import { ago, api, emptyState, fmtMs, fmtNum, fmtPct, html, proposalHref, tableWrap } from "./lib.js";

const WEEKS = 12;
const MIN_RATE_DECISIONS = 5;
const OUTCOMES = [
  { key: "judge", label: "Accepted by the judge", colorIndex: 0 },
  { key: "you", label: "Accepted by you", colorIndex: 2 },
  { key: "rejected", label: "Rejected", colorIndex: 1 },
  { key: "reverted", label: "Reverted", colorIndex: 3 },
];

/** Who decided an accept: the recorded decider, else the drain's stamp, else unknown. */
function decider(p) {
  if (p.review?.decidedBy === "triage") return "judge";
  if (p.review?.decidedBy === "human") return "you";
  if (p.gateDecision?.outcome === "auto-accepted") return "judge";
  return p.review ? "you" : "unknown";
}

function outcomeOf(p) {
  if (p.status === "reverted") return "reverted";
  if (p.status === "rejected") return "rejected";
  if (p.status === "accepted") return decider(p) === "judge" ? "judge" : "you";
  return null;
}

function decidedAt(p) {
  return p.review?.decidedAt ?? p.updatedAt;
}

/** Monday 00:00 UTC of the week holding `iso`, as YYYY-MM-DD. */
function weekStart(iso) {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

function lastWeeks(count) {
  const out = [];
  const start = new Date(`${weekStart(new Date().toISOString())}T00:00:00Z`);
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() - 7 * i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function tile(label, value, sub = "", tone = "") {
  return html`<div class="tile" ${tone ? html`data-tone="${tone}"` : ""}><span class="tile-label">${label}</span><span class="tile-value num">${value}</span>${sub ? html`<span class="tile-sub muted">${sub}</span>` : ""}</div>`;
}

function weeklyChart(ctx, decided) {
  const weeks = lastWeeks(WEEKS);
  const counts = Object.fromEntries(weeks.map((w) => [w, { judge: 0, you: 0, rejected: 0, reverted: 0 }]));
  for (const p of decided) {
    const bucket = counts[weekStart(decidedAt(p))];
    if (bucket) bucket[outcomeOf(p)]++;
  }
  const inWindow = weeks.reduce((sum, w) => sum + Object.values(counts[w]).reduce((a, b) => a + b, 0), 0);
  const label = (w) => `${w.slice(5)}${w === weeks.at(-1) ? " (so far)" : ""}`;
  wireChart(ctx, "#improve-weekly", () =>
    verticalBars(
      weeks.map(label),
      OUTCOMES.map((o) => ({
        name: o.label,
        colorIndex: o.colorIndex,
        stack: "decisions",
        data: weeks.map((w) => counts[w][o.key]),
      })),
      "Decisions",
    ),
  );
  return html`<section class="chart-card"><h2>Decisions per week</h2>
    <p class="muted small">Every decided proposal by the week it was decided (UTC, weeks start Monday). The current week is still in progress.</p>
    <p class="chart-legend">${OUTCOMES.map((o) => html`<span><i class="series-key series-${o.colorIndex + 1}" aria-hidden="true"></i>${o.label}</span>`)}</p>
    ${inWindow ? html`<div class="echarts-view" id="improve-weekly" role="img" aria-label="Decided proposals per week for the last ${WEEKS} weeks, stacked by outcome. Exact counts follow in Data and details."></div>` : emptyState(`No decisions in the last ${WEEKS} weeks.`)}
    <details><summary>Data and details</summary>${tableWrap(
      html`<table><thead><tr><th>Week of</th>${OUTCOMES.map((o) => html`<th class="r">${o.label}</th>`)}</tr></thead><tbody>${weeks
        .slice()
        .reverse()
        .map(
          (w) =>
            html`<tr><th>${w}</th>${OUTCOMES.map((o) => html`<td class="r num">${fmtNum(counts[w][o.key])}</td>`)}</tr>`,
        )}</tbody></table>`,
    )}</details>
  </section>`;
}

function byProcess(decided, pending, llm) {
  const rows = new Map();
  const row = (source) => {
    if (!rows.has(source)) rows.set(source, { source, judge: 0, you: 0, rejected: 0, reverted: 0, pending: 0 });
    return rows.get(source);
  };
  for (const p of decided) row(p.source)[outcomeOf(p)]++;
  for (const [source, count] of Object.entries(pending.bySource ?? {})) row(source).pending += count;
  const cost = llm?.byProcess ?? {};
  const list = [...rows.values()].sort(
    (a, b) => b.judge + b.you + b.rejected - (a.judge + a.you + a.rejected) || a.source.localeCompare(b.source),
  );
  if (list.length === 0)
    return emptyState("No proposals yet.", "Improve processes write proposals here when they run.");
  return tableWrap(
    html`<table><thead><tr><th>Process</th><th class="r">Accepted</th><th class="r">by judge</th><th class="r">Rejected</th><th class="r">Reverted</th><th class="r">Waiting</th><th class="r">Kept rate</th><th class="r">Model calls (30d)</th><th class="r">Call time (30d)</th></tr></thead><tbody>${list.map(
      (r) => {
        const accepted = r.judge + r.you;
        const decidedCount = accepted + r.rejected + r.reverted;
        const kept =
          decidedCount >= MIN_RATE_DECISIONS
            ? fmtPct(accepted / decidedCount)
            : html`<span class="muted" title="Fewer than ${MIN_RATE_DECISIONS} decisions">n/a</span>`;
        const c = cost[r.source];
        return html`<tr><th class="mono">${r.source}</th><td class="r num">${fmtNum(accepted)}</td><td class="r num">${fmtNum(r.judge)}</td><td class="r num">${fmtNum(r.rejected)}</td><td class="r num">${r.reverted ? html`<span class="text-warn">${fmtNum(r.reverted)}</span>` : "0"}</td><td class="r num">${fmtNum(r.pending)}</td><td class="r num">${kept}</td><td class="r num">${c ? fmtNum(c.calls) : "–"}</td><td class="r num">${c ? fmtMs(c.totalDurationMs) : "–"}</td></tr>`;
      },
    )}</tbody></table>`,
  );
}

function harmLog(decided) {
  const reverted = decided.filter((p) => p.status === "reverted").slice(0, 10);
  return html`<section class="chart-card"><h2>Reverted changes</h2>
    <p class="muted small">Accepted changes that were later undone. Each one is worth a look: it may point at a process or judge setting to tighten.</p>
    ${
      reverted.length
        ? html`<ul class="change-list">${reverted.map((p) => html`<li><a href="${proposalHref(p.id)}" class="mono">${p.ref}</a><span class="badge badge-warn">reverted</span><span class="muted small">${p.source} · ${ago(decidedAt(p))}</span></li>`)}</ul>`
        : html`<div class="attention-clear"><span class="dot dot-ok" aria-hidden="true"></span>No reverted changes.</div>`
    }
  </section>`;
}

function recentChanges(decided) {
  const accepted = decided.filter((p) => p.status === "accepted").slice(0, 12);
  return html`<section class="chart-card"><h2>Recent changes to your library</h2>
    <p class="muted small">The latest accepted proposals. Open one to see its diff and the reason it was made.</p>
    ${
      accepted.length
        ? html`<ul class="change-list">${accepted.map(
            (p) =>
              html`<li><a href="${proposalHref(p.id)}" class="mono">${p.isRetire && p.retirement ? p.retirement.retiredRef : p.ref}</a>${p.isRetire ? html`<span class="badge badge-neutral">retired</span>` : ""}<span class="badge ${decider(p) === "judge" ? "badge-info" : "badge-ok"}">${decider(p) === "judge" ? "judge" : "you"}</span><span class="muted small">${p.source} · ${ago(decidedAt(p))}</span></li>`,
          )}</ul>`
        : emptyState("No accepted changes yet.")
    }
  </section>`;
}

function runsTable(runs) {
  if (!runs?.length)
    return emptyState(
      "No improve runs recorded yet.",
      "Schedule `akm improve` or run it by hand; each run appears here.",
    );
  return tableWrap(
    html`<table><thead><tr><th>Started</th><th>Result</th><th class="r">Model calls</th><th class="r">Duration</th></tr></thead><tbody>${runs.map(
      (r) =>
        html`<tr><td>${ago(r.startedAt)}</td><td>${r.ok ? html`<span class="badge badge-ok">finished</span>` : html`<span class="badge badge-fail">failed</span>`}</td><td class="r num">${fmtNum(r.modelCalls?.total ?? 0)}${r.modelCalls?.failures ? html` <span class="text-fail small">(${fmtNum(r.modelCalls.failures)} failed)</span>` : ""}</td><td class="r num">${r.durationMs != null ? fmtMs(r.durationMs) : "–"}</td></tr>`,
    )}</tbody></table>`,
  );
}

export async function render(ctx) {
  const [recent, pending, overview] = await Promise.all([
    api("/api/proposals", { status: "recent", limit: 200 }),
    api("/api/proposals", { status: "pending", limit: 1 }),
    api("/api/overview", { metricsSince: "30d" }).catch(() => ({})),
  ]);
  const decided = (recent.proposals ?? []).filter((p) => outcomeOf(p));
  const since = Date.now() - 30 * 86_400_000;
  const last30 = decided.filter((p) => Date.parse(decidedAt(p)) >= since);
  const count = (key) => last30.filter((p) => outcomeOf(p) === key).length;
  const accepted = count("judge") + count("you");
  const rejected = count("rejected");
  const reverted = count("reverted");
  const llm = overview.metrics?.llm;
  return html`<header class="page-head"><h1>Improve impact</h1><p>What akm's improve processes proposed, what was kept, who decided, and what it cost.</p></header>
    <section aria-labelledby="impact-30d"><h2 id="impact-30d">Last 30 days</h2>
      <div class="tiles">
        ${tile("Changes kept", fmtNum(accepted), `${fmtNum(count("judge"))} by the judge · ${fmtNum(count("you"))} by you`, accepted ? "ok" : "")}
        ${tile("Rejected", fmtNum(rejected), accepted + rejected ? `${fmtPct(rejected / (accepted + rejected + reverted))} of decisions` : "no decisions yet")}
        ${tile("Reverted", fmtNum(reverted), "accepted, then undone", reverted ? "warn" : "")}
        ${tile("Waiting for review", fmtNum(pending.fullCount ?? 0), html`<a href="#/proposals">Open the queue</a>`)}
        ${tile("Model calls", llm ? fmtNum(llm.calls) : "–", llm ? (llm.failures ? `${fmtNum(llm.failures)} failed` : `${fmtMs(llm.totalDurationMs)} of call time`) : "unavailable", llm?.failures ? "fail" : "")}
      </div>
    </section>
    <div class="chart-grid">${weeklyChart(ctx, decided)}${harmLog(decided)}</div>
    <section aria-labelledby="by-process"><h2 id="by-process">By process</h2><p class="muted small">Outcomes over the last ${fmtNum(recent.fullCount ?? decided.length)} decided proposals${recent.fullCount > 200 ? " (latest 200 shown)" : ""}. "Kept rate" needs at least ${MIN_RATE_DECISIONS} decisions.</p>${byProcess(decided, pending, llm)}</section>
    <div class="chart-grid">${recentChanges(decided)}<section class="chart-card"><h2>Improve runs</h2><p class="muted small">The most recent runs, newest first.</p>${runsTable(overview.improveRuns)}</section></div>`;
}
