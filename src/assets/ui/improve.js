// Improve impact: what akm's improve processes proposed, changed and cost over the weeks, and what went wrong.

import { lines, stackedColumns, stepLine, wireChart } from "./chart-view.js";
import { ago, api, badge, emptyState, fmtNum, fmtPct, html, mount, proposalHref, tableWrap, weekStart } from "./lib.js";

const TREND_DAYS = 90;
const ROLLING_DAYS = 7;
const MIN_ROLLING_SEARCHES = 5;
const CLASSES = [
  { key: "judge", label: "Accepted by the judge", colorIndex: 0 },
  { key: "you", label: "Accepted by you", colorIndex: 2 },
  { key: "unknown", label: "Accepted, decider not recorded", colorIndex: 4 },
  { key: "rejected", label: "Rejected", colorIndex: 1 },
  { key: "reverted", label: "Reverted", colorIndex: 3 },
];
const HARM_LABEL = {
  reverted: "Reverted",
  reopened: "Rejection reopened",
  "risky-retirement": "Retired with a risk flagged",
  "flag-after-change": "Flag after a change",
};

/** The last `count` ISO week starts (Mondays, UTC), oldest first. */
function lastWeeks(count) {
  const start = new Date(`${weekStart(new Date().toISOString())}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() - 7 * (count - 1 - i));
    return d.toISOString().slice(0, 10);
  });
}

/** The last `count` UTC days, oldest first, as YYYY-MM-DD. */
function lastDays(count) {
  const out = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = count - 1; i >= 0; i--) out.push(new Date(today.getTime() - i * 86_400_000).toISOString().slice(0, 10));
  return out;
}

/** Per day: the share of searches in the trailing 7 days that returned something. Null until there are enough searches. */
function rollingFoundRate(daily, days) {
  const byDay = new Map(daily.map((d) => [d.date, d]));
  return days.map((_, index) => {
    let searches = 0;
    let misses = 0;
    for (const day of days.slice(Math.max(0, index - ROLLING_DAYS + 1), index + 1)) {
      const row = byDay.get(day);
      if (!row) continue;
      searches += row.searches;
      misses += row.zeroResults;
    }
    return searches >= MIN_ROLLING_SEARCHES ? 1 - misses / searches : null;
  });
}

/** Days on which improve changes were kept, from the changed-assets list. */
function keptChangeDays(changed, days) {
  const first = days[0];
  const byDay = new Map();
  for (const change of changed) {
    if (change.outcome === "reverted") continue;
    const day = change.decidedAt.slice(0, 10);
    if (day < first) continue;
    const entry = byDay.get(day) ?? { day, count: 0, sources: new Set() };
    entry.count++;
    entry.sources.add(change.source);
    byDay.set(day, entry);
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

function trendHeadline(rates, days) {
  const points = rates.map((rate, i) => ({ rate, day: days[i] })).filter((p) => p.rate !== null);
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last || Date.parse(last.day) - Date.parse(first.day) < 14 * 86_400_000)
    return html`<p class="trend-summary muted">Not enough searches yet to show a trend. It needs ${MIN_ROLLING_SEARCHES} searches in a week, across at least two weeks.</p>`;
  const change = Math.round((last.rate - first.rate) * 100);
  const tone = change > 0 ? "text-ok" : change < 0 ? "text-fail" : "";
  return html`<p class="trend-summary"><span class="trend-figure num">${fmtPct(last.rate)}</span> of searches found something, <span class="${tone}">${change > 0 ? "up" : change < 0 ? "down" : "unchanged,"} ${change === 0 ? "" : `${Math.abs(change)} points`}</span> <span class="muted">since ${first.day} (${fmtPct(first.rate)}).</span></p>`;
}

function searchTrend(ctx, retrieval, changed) {
  if (!retrieval)
    return html`<section class="chart-card" id="search" aria-labelledby="trend-title"><h2 id="trend-title">Did improve help search?</h2>${emptyState("Search measurements are unavailable.")}</section>`;
  const days = lastDays(TREND_DAYS);
  const rates = rollingFoundRate(retrieval.daily, days);
  const kept = keptChangeDays(changed, days);
  const keptDays = new Set(kept.map((entry) => entry.day));
  const known = rates.filter((rate) => rate !== null);
  const floor = known.length ? Math.max(0, Math.floor((Math.min(...known) * 100 - 10) / 10) * 10) : 0;
  wireChart(ctx, "#improve-trend", (token) => {
    const marker = token("--marker");
    return {
      xAxis: { type: "category", data: days, axisLabel: { hideOverlap: true, formatter: (day) => day.slice(5) } },
      yAxis: { type: "value", name: "Found something", min: floor, max: 100, axisLabel: { formatter: "{value}%" } },
      series: [
        {
          type: "line",
          name: "Searches that found something",
          colorIndex: 0,
          connectNulls: false,
          symbol: "none",
          lineStyle: { width: 2.5 },
          z: 3,
          data: rates.map((rate) => (rate === null ? null : Math.round(rate * 1000) / 10)),
        },
        {
          // A thin bar to the top of the chart on each day improve changes were kept.
          type: "bar",
          name: "Improve changes kept",
          colorIndex: 1,
          silent: true,
          barWidth: 2,
          z: 1,
          itemStyle: { color: marker },
          data: days.map((day) => (keptDays.has(day) ? 100 : null)),
        },
      ],
    };
  });
  const weeks = lastWeeks(Math.ceil(TREND_DAYS / 7));
  const weekRows = weeks.map((week) => {
    const inWeek = (day) => day >= week && weekStart(`${day}T00:00:00Z`) === week;
    const rows = retrieval.daily.filter((d) => inWeek(d.date));
    const searches = rows.reduce((sum, d) => sum + d.searches, 0);
    const misses = rows.reduce((sum, d) => sum + d.zeroResults, 0);
    const changes = kept.filter((entry) => inWeek(entry.day));
    return {
      week,
      searches,
      misses,
      changes: changes.reduce((sum, c) => sum + c.count, 0),
      sources: [...new Set(changes.flatMap((c) => [...c.sources]))],
    };
  });
  return html`<section class="chart-card" id="search" aria-labelledby="trend-title"><h2 id="trend-title">Did improve help search?</h2>
    <p class="muted small">The share of your searches that returned something, over a rolling 7 days and the last ${TREND_DAYS} days. An amber line marks a day when improve changes were kept. It measures retrieval, not whether answers were right.</p>
    ${trendHeadline(rates, days)}
    <p class="chart-legend"><span><i class="series-key series-1" aria-hidden="true"></i>Searches that found something</span><span><i class="marker-key" aria-hidden="true"></i>Improve changes kept</span></p>
    ${known.length ? html`<div class="echarts-view" id="improve-trend" role="img" aria-label="Share of searches that found something, rolling 7 days, over the last ${TREND_DAYS} days, with ${kept.length} days marked when improve changes were kept. Weekly figures follow in Data and details."></div>` : emptyState("No searches recorded in the last 90 days.", "The trend appears once you have searched at least a few times a week.")}
    <details><summary>Data and details</summary>${tableWrap(
      html`<table><thead><tr><th>Week of</th><th class="r">Searches</th><th class="r">Found nothing</th><th class="r">Found something</th><th class="r">Changes kept</th><th>By</th></tr></thead><tbody>${weekRows
        .slice()
        .reverse()
        .map(
          (r) =>
            html`<tr><th>${r.week}</th><td class="r num">${fmtNum(r.searches)}</td><td class="r num">${fmtNum(r.misses)}</td><td class="r num">${r.searches ? fmtPct(1 - r.misses / r.searches) : "n/a"}</td><td class="r num">${fmtNum(r.changes)}</td><td class="mono">${r.sources.join(", ")}</td></tr>`,
        )}</tbody></table>`,
    )}</details>
  </section>`;
}

const sectionHead = (id, title, note) =>
  html`<h2 id="${id}">${title}</h2>${note ? html`<p class="muted small">${note}</p>` : ""}`;

function summaryLine(impact) {
  const s = impact.summary;
  const harm = s.reverted + s.flags;
  const tokens = s.tokens >= 1000 ? `${Math.round(s.tokens / 1000)}k` : String(s.tokens);
  return html`<p class="impact-summary"><strong>${impact.since === "all" ? "Last year" : "Last 90 days"}:</strong> <a href="#/improve" data-anchor="outcomes">${fmtNum(s.kept)} kept</a> · <a href="#/improve" data-anchor="harm" ${harm ? html`class="text-warn"` : ""}>${fmtNum(s.reverted)} reverted</a> · <a href="#/improve" data-anchor="harm" ${s.flags ? html`class="text-warn"` : ""}>${fmtNum(s.flags)} ${s.flags === 1 ? "flag" : "flags"} after a change</a> · <a href="#/improve" data-anchor="cost">${tokens} tokens${s.tokenCoverage === null ? "" : ` (${fmtPct(s.tokenCoverage)} of calls reported)`}</a></p>`;
}

function outcomesSection(impact) {
  const outcomes = impact.outcomes ?? [];
  const sum = (process, keys) => process.weeks.reduce((n, w) => n + keys.reduce((m, key) => m + w[key], 0), 0);
  const rows = outcomes.map((process) => ({
    source: process.source,
    total: sum(
      process,
      CLASSES.map((c) => c.key),
    ),
    kept: sum(process, ["judge", "you", "unknown"]),
    parts: CLASSES.map((c) => ({ ...c, n: sum(process, [c.key]) })),
  }));
  const max = Math.max(0, ...rows.map((r) => r.total));
  return html`<section class="chart-card" aria-labelledby="outcomes">${sectionHead("outcomes", "Who decided what", "Each process's decisions in this window, by who decided and what became of them.")}
    <p class="chart-legend">${CLASSES.map((c) => html`<span><i class="series-key series-${c.colorIndex + 1}" aria-hidden="true"></i>${c.label}</span>`)}</p>
    ${
      outcomes.length === 0
        ? emptyState("No proposals decided in this window.", "Improve processes write proposals that are decided here.")
        : html`<ul class="bar-list" aria-label="Decisions by process">${rows.map(
            (row) =>
              html`<li><span class="bar-name mono">${row.source}</span><span class="bar-track" aria-hidden="true"><span class="bar-stack" style="--w:${max ? row.total / max : 0}">${row.parts.filter((p) => p.n).map((p) => html`<span class="series-${p.colorIndex + 1}" style="--w:${p.n}" title="${p.label}: ${p.n}"></span>`)}</span></span><span class="bar-value num">${fmtNum(row.kept)} of ${fmtNum(row.total)} kept</span><span class="bar-note muted small">${row.parts
                .filter((p) => p.n)
                .map((p) => `${p.label.toLowerCase()} ${p.n}`)
                .join(" · ")}</span></li>`,
          )}</ul>`
    }
    <details><summary>Data and details</summary>${tableWrap(html`<table><thead><tr><th>Process</th><th>Week of</th>${CLASSES.map((c) => html`<th class="r">${c.label}</th>`)}</tr></thead><tbody>${outcomes.flatMap((process) => process.weeks.filter((w) => CLASSES.some((c) => w[c.key])).map((w) => html`<tr><th class="mono">${process.source}</th><td><button type="button" class="btn-secondary" data-drill data-source="${process.source}" data-week="${w.week}">${w.week}</button></td>${CLASSES.map((c) => html`<td class="r num">${w[c.key] ? html`<button type="button" class="btn-secondary" data-drill data-source="${process.source}" data-week="${w.week}" data-class="${c.key}">${w[c.key]}</button>` : "0"}</td>`)}</tr>`))}</tbody></table>`)}
    <div data-drill-panel tabindex="-1" aria-live="polite"></div></details>
  </section>`;
}

function flowSection(ctx, impact) {
  const flow = impact.reviewFlow ?? [];
  const labels = impact.weeks.map((w) => w.slice(5));
  wireChart(ctx, "#flow-waiting", () =>
    stepLine(
      labels,
      flow.map((w) => w.waiting),
      { name: "Waiting for review", unit: "Waiting" },
    ),
  );
  wireChart(ctx, "#flow-rate", () =>
    lines(
      labels,
      [
        { name: "Made", colorIndex: 0, data: flow.map((w) => w.created) },
        { name: "Decided", colorIndex: 2, data: flow.map((w) => w.decided) },
      ],
      "Proposals",
    ),
  );
  const last = flow.at(-1);
  return html`<section class="chart-card" aria-labelledby="flow">${sectionHead("flow", "Is review keeping up?", last ? `This week: ${last.created} made, ${last.decided} decided, ${last.waiting} waiting at the end of it.` : "")}
    <h3>Waiting for review, at the end of each week</h3>
    <div class="echarts-view" data-height="short" id="flow-waiting" role="img" aria-label="Proposals waiting for review at the end of each week."></div>
    <h3>Made and decided each week</h3>
    <p class="chart-legend"><span><i class="series-key series-1" aria-hidden="true"></i>Made</span><span><i class="series-key series-3" aria-hidden="true"></i>Decided</span></p>
    <div class="echarts-view" data-height="short" id="flow-rate" role="img" aria-label="Proposals made and decided each week."></div>
    <details><summary>Data and details</summary>${tableWrap(html`<table><thead><tr><th>Week of</th><th class="r">Made</th><th class="r">Decided</th><th class="r">Waiting at the end</th></tr></thead><tbody>${flow.map((w) => html`<tr><th>${w.week}</th><td class="r num">${w.created}</td><td class="r num">${w.decided}</td><td class="r num">${w.waiting}</td></tr>`)}</tbody></table>`)}</details>
  </section>`;
}

function librarySection(ctx, impact) {
  const library = impact.library ?? [];
  const known = library.filter((w) => w.entries !== null);
  const labels = impact.weeks.map((w) => w.slice(5));
  wireChart(ctx, "#library-size", () =>
    stepLine(
      labels,
      library.map((w) => w.entries),
      { name: "Assets in the library", unit: "Assets" },
    ),
  );
  const first = known[0];
  const last = known.at(-1);
  return html`<section class="chart-card" aria-labelledby="library">${sectionHead("library", "How has the library changed?", known.length >= 2 ? `${fmtNum(first.entries)} assets in the week of ${first.week}, ${fmtNum(last.entries)} in the week of ${last.week}.` : "")}
    ${known.length < 2 ? emptyState("The library size is recorded each time akm indexes.", "Two or more indexes in the window draw this line.") : html`<div class="echarts-view" data-height="short" id="library-size" role="img" aria-label="Assets in the library at the end of each week."></div>`}
  </section>`;
}

function harmSection(impact) {
  const harm = impact.harm ?? [];
  return html`<section class="chart-card" aria-labelledby="harm">${sectionHead("harm", `Harm log${harm.length ? ` (${harm.length})` : ""}`, "Changes that were undone, rejections that were reopened, retirements with a risk flagged, and feedback that came after a change. Never collapsed.")}
    ${
      harm.length === 0
        ? html`<div class="attention-clear"><span class="dot dot-ok" aria-hidden="true"></span>No reverts, reopened rejections or risky retirements, and no flags after a change, in this window. Checked ${fmtNum(impact.summary.checked)} decisions.</div>`
        : html`<ul class="change-list">${harm.map((item) => html`<li>${badge(HARM_LABEL[item.kind] ?? item.kind, item.kind === "flag-after-change" ? "warn" : "neutral")} <a class="mono wrap" href="#/asset/${encodeURIComponent(item.ref)}">${item.ref}</a><span class="muted small">${item.detail} · ${ago(item.at)}</span>${item.proposalId ? html`<a class="small" href="${proposalHref(item.proposalId)}">Proposal</a>` : ""}</li>`)}</ul>`
    }
  </section>`;
}

function costSection(ctx, impact) {
  const cost = impact.cost ?? [];
  const labels = impact.weeks.map((w) => w.slice(5));
  const processes = [...new Set(cost.flatMap((w) => Object.keys(w.byProcess)))].sort();
  wireChart(ctx, "#cost-calls", () =>
    stackedColumns(
      labels,
      processes.map((name, i) => ({ name, colorIndex: i % 5, data: cost.map((w) => w.byProcess[name] ?? 0) })),
      "Calls",
    ),
  );
  const calls = cost.reduce((sum, w) => sum + w.calls, 0);
  const reported = cost.reduce((sum, w) => sum + w.usageCalls, 0);
  return html`<section class="chart-card" aria-labelledby="cost">${sectionHead("cost", "What does improve cost?", calls ? `${fmtNum(calls)} model calls; tokens are reported for ${fmtNum(reported)} of them. Tokens are not money.` : "")}
    ${calls === 0 ? emptyState("No model calls recorded in this window.") : html`<p class="chart-legend">${processes.map((name, i) => html`<span><i class="series-key series-${(i % 5) + 1}" aria-hidden="true"></i>${name}</span>`)}</p><div class="echarts-view" id="cost-calls" role="img" aria-label="Model calls per week by process."></div>`}
    <details><summary>Data and details</summary>${tableWrap(html`<table><thead><tr><th>Week of</th><th class="r">Calls</th><th class="r">Tokens</th><th class="r">Calls reporting tokens</th></tr></thead><tbody>${cost.map((w) => html`<tr><th>${w.week}</th><td class="r num">${fmtNum(w.calls)}</td><td class="r num">${w.usageCalls ? fmtNum(w.tokens) : "not reported"}</td><td class="r num">${fmtNum(w.usageCalls)} / ${fmtNum(w.calls)}</td></tr>`)}</tbody></table>`)}</details>
  </section>`;
}

function changedSection(impact) {
  const changed = impact.changedAssets ?? [];
  const arrow = (before, after) => html`<span class="num">${before} → ${after}</span>`;
  return html`<section class="chart-card" aria-labelledby="changed">${sectionHead("changed", "Changed assets, before and after", "How often each changed asset was found and rated in the 28 days before and after the change. A change under 28 days old is still filling, so its after side is partial.")}
    ${
      changed.length === 0
        ? emptyState("No changes kept in this window.")
        : tableWrap(
            html`<table><thead><tr><th>Asset</th><th>Process</th><th>Changed</th><th class="r">Found</th><th class="r">Negative</th><th>After</th></tr></thead><tbody>${changed.map((c) => html`<tr><th><a class="mono wrap" href="#/asset/${encodeURIComponent(c.ref)}">${c.ref}</a></th><td class="mono">${c.source}</td><td>${ago(c.decidedAt)}${c.outcome === "reverted" ? html` ${badge("reverted", "warn")}` : ""}</td><td class="r">${arrow(c.before.hits, c.after.hits)}</td><td class="r">${arrow(c.before.negative, c.after.negative)}</td><td>${c.complete ? "28 days" : `${c.afterDays} days so far`}</td></tr>`)}</tbody></table>`,
          )
    }
  </section>`;
}

function judgeSection(impact) {
  const table = impact.judgeAndYou ?? {};
  const rows = ["judge", "you", "unknown"].filter((who) => table[who]);
  const names = { judge: "The judge", you: "You", unknown: "Decider not recorded" };
  return html`<section class="chart-card" aria-labelledby="judge">${sectionHead("judge", "Judge and you", "How the judge's decisions and yours compare.")}
    ${
      rows.length === 0
        ? emptyState("No decisions yet.")
        : tableWrap(
            html`<table><thead><tr><th>Decided by</th><th class="r">Accepted</th><th class="r">Rejected</th><th class="r">Later reverted</th><th class="r">Kept</th></tr></thead><tbody>${rows.map(
              (who) => {
                const r = table[who];
                const total = r.accepted + r.rejected + r.reverted;
                return html`<tr><th>${names[who]}</th><td class="r num">${r.accepted}</td><td class="r num">${r.rejected}</td><td class="r num">${r.reverted}</td><td class="r num">${total ? fmtPct(r.accepted / total) : "n/a"}</td></tr>`;
              },
            )}</tbody></table>`,
          )
    }
  </section>`;
}

const SECTIONS = [
  ["search", "Search quality"],
  ["outcomes", "Outcomes"],
  ["flow", "Review flow"],
  ["library", "Library"],
  ["harm", "Harm log"],
  ["cost", "Cost"],
  ["changed", "Changed assets"],
  ["judge", "Judge and you"],
];

export async function render(ctx) {
  const since = ctx.query.get("since") === "all" ? "all" : "90d";
  const [impact, retrieval] = await Promise.all([
    api("/api/improve/impact", { since }),
    api("/api/retrieval", { since: `${TREND_DAYS}d` }).catch(() => null),
  ]);
  ctx.after.push((root) => {
    for (const radio of root.querySelectorAll("input[name=impact-since]")) {
      radio.addEventListener("change", (event) => {
        location.hash = `#/improve?since=${event.target.value}`;
      });
    }
    root.addEventListener("click", async (event) => {
      const jump = event.target.closest("a[data-anchor]");
      if (jump) {
        event.preventDefault();
        const target = root.querySelector(`#${jump.dataset.anchor}`);
        target?.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      const drill = event.target.closest("[data-drill]");
      if (!drill) return;
      const panel = root.querySelector("[data-drill-panel]");
      mount(panel, html`<p role="status">Loading...</p>`);
      try {
        const { proposals } = await api("/api/proposals", {
          status: "recent",
          source: drill.dataset.source,
          week: drill.dataset.week,
          class: drill.dataset.class,
          limit: 50,
        });
        mount(
          panel,
          html`<h3>${drill.dataset.source}, week of ${drill.dataset.week}${drill.dataset.class ? `, ${drill.dataset.class}` : ""}</h3>${proposals.length ? html`<ul class="change-list">${proposals.map((p) => html`<li><a class="mono wrap" href="${proposalHref(p.id)}">${p.ref}</a>${badge(p.status, p.status === "reverted" ? "warn" : "neutral")}<span class="muted small">${ago(p.review?.decidedAt ?? p.updatedAt)}</span></li>`)}</ul>` : html`<p>No proposals match.</p>`}`,
        );
      } catch (error) {
        mount(panel, html`<p role="alert">${error.message}</p>`);
      }
      panel.focus({ preventScroll: true });
    });
  });
  const choice = (value, label) =>
    html`<label><input type="radio" name="impact-since" value="${value}" ${since === value ? html`checked` : ""}><span>${label}</span></label>`;
  if (!impact.available)
    return html`<header class="page-head"><h1>Improve impact</h1><p>What akm's improve processes did in your environment. Times are UTC.</p></header>${emptyState("Improve has not run in this environment yet.", html`It runs with <code>akm improve</code> or on a schedule.`)}`;
  const harmCount = (impact.harm ?? []).length;
  return html`<header class="page-head page-head-row"><div><h1>Improve impact</h1><p>What akm's improve processes did in your environment. Times are UTC.</p></div>
      <fieldset class="segmented trend-window" aria-label="Window">${choice("90d", "90 days")}${choice("all", "All")}</fieldset></header>
    ${summaryLine(impact)}
    <details class="how-to-read"><summary>How to read this page</summary><p>Weeks start on Monday, UTC. A change is "kept" when a proposal was accepted and not reverted. A flag after a change is negative feedback on the same asset within 14 days. Before-and-after counts show what happened next to a change, not that the change caused it.</p></details>
    <div class="impact-layout">
      <nav class="impact-toc" aria-label="On this page"><ul>${SECTIONS.map(([id, label]) => html`<li><a href="#/improve" data-anchor="${id}">${label}${id === "harm" && harmCount ? html` <span class="num">(${harmCount})</span>` : ""}</a></li>`)}</ul></nav>
      <div class="impact-sections">
        ${searchTrend(ctx, retrieval, impact.changedAssets ?? [])}
        ${outcomesSection(impact)}
        ${flowSection(ctx, impact)}
        ${librarySection(ctx, impact)}
        ${harmSection(impact)}
        ${costSection(ctx, impact)}
        ${changedSection(impact)}
        ${judgeSection(impact)}
      </div>
    </div>
    ${impact.errors ? html`<details class="notice notice-warn"><summary>${Object.keys(impact.errors).length} sections could not load</summary><ul>${Object.entries(impact.errors).map(([name, message]) => html`<li><span class="mono">${name}</span>: ${message}</li>`)}</ul></details>` : ""}`;
}
