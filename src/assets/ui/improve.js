// Improve impact: what akm's improve processes proposed, changed and cost over the weeks, and what went wrong.

import { chart, lines, stackedColumns, stepLine } from "./chart-view.js";
import {
  ago,
  api,
  assetHref,
  badge,
  barList,
  dataTable,
  emptyState,
  fmtNum,
  fmtPct,
  html,
  legend,
  mount,
  pageHeader,
  proposalHref,
  sectionErrors,
  tableWrap,
  weekStart,
  windowToggle,
} from "./lib.js";

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

const TREND_DAYS = 90;
const ROLLING_DAYS = 7;
const MIN_ROLLING_SEARCHES = 5;

/** The last `count` UTC days, oldest first, as YYYY-MM-DD. */
function lastDays(count) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return Array.from({ length: count }, (_, i) =>
    new Date(today.getTime() - (count - 1 - i) * 86_400_000).toISOString().slice(0, 10),
  );
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

/** The improve changes kept, by `key` (a day or a week start), and the processes that made them. */
function keptBy(changed, key) {
  const out = new Map();
  for (const change of changed) {
    if (change.outcome === "reverted") continue;
    const at = key(change.decidedAt);
    const entry = out.get(at) ?? { count: 0, sources: new Set() };
    entry.count++;
    entry.sources.add(change.source);
    out.set(at, entry);
  }
  return out;
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

/** The rolling found-something rate with a mark on each day improve changes were kept; the weekly figures are the server's. */
function searchSection(ctx, retrieval, changed) {
  const head = html`<h2 id="trend-title">Did improve help search?</h2>`;
  if (!retrieval)
    return html`<section class="chart-card" id="search" aria-labelledby="trend-title">${head}${emptyState("Search measurements are unavailable.")}</section>`;
  const days = lastDays(TREND_DAYS);
  const rates = rollingFoundRate(retrieval.daily, days);
  const keptDays = keptBy(changed, (at) => at.slice(0, 10));
  const keptWeeks = keptBy(changed, weekStart);
  const known = rates.filter((rate) => rate !== null);
  const floor = known.length ? Math.max(0, Math.floor((Math.min(...known) * 100 - 10) / 10) * 10) : 0;
  const markedDays = days.filter((day) => keptDays.has(day)).length;
  return html`<section class="chart-card" id="search" aria-labelledby="trend-title">${head}
    <p class="muted small">The share of your searches that returned something, over a rolling ${ROLLING_DAYS} days and the last ${TREND_DAYS} days. An amber line marks a day when improve changes were kept. It measures retrieval, not whether answers were right.</p>
    ${trendHeadline(rates, days)}
    ${legend([["Searches that found something", 1], [html`<i class="marker-key" aria-hidden="true"></i>Improve changes kept`]])}
    ${
      known.length
        ? chart(
            ctx,
            "improve-trend",
            `Share of searches that found something, rolling ${ROLLING_DAYS} days, over the last ${TREND_DAYS} days, with ${markedDays} days marked when improve changes were kept. Weekly figures follow in Data and details.`,
            (token) => ({
              xAxis: {
                type: "category",
                data: days,
                axisLabel: { hideOverlap: true, formatter: (day) => day.slice(5) },
              },
              yAxis: {
                type: "value",
                name: "Found something",
                min: floor,
                max: 100,
                axisLabel: { formatter: "{value}%" },
              },
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
                  silent: true,
                  barWidth: 2,
                  z: 1,
                  itemStyle: { color: token("--marker") },
                  data: days.map((day) => (keptDays.has(day) ? 100 : null)),
                },
              ],
            }),
          )
        : emptyState(
            `No searches recorded in the last ${TREND_DAYS} days.`,
            "The trend appears once you have searched at least a few times a week.",
          )
    }
    ${dataTable(
      tableWrap(
        html`<table><thead><tr><th>Week of</th><th class="r">Searches</th><th class="r">Found nothing</th><th class="r">Found something</th><th class="r">Changes kept</th><th>By</th></tr></thead><tbody>${(
          retrieval.weekly ?? []
        )
          .slice()
          .reverse()
          .map((w) => {
            const changes = keptWeeks.get(w.week);
            return html`<tr><th>${w.week}</th><td class="r num">${fmtNum(w.n)}</td><td class="r num">${fmtNum(w.x)}</td><td class="r num">${w.n ? fmtPct(1 - w.x / w.n) : "n/a"}</td><td class="r num">${fmtNum(changes?.count ?? 0)}</td><td class="mono">${[...(changes?.sources ?? [])].join(", ")}</td></tr>`;
          })}</tbody></table>`,
      ),
    )}
  </section>`;
}

const sectionHead = (id, title, note) =>
  html`<h2 id="${id}">${title}</h2>${note ? html`<p class="muted small">${note}</p>` : ""}`;

function summaryLine(impact) {
  const s = impact.summary;
  const harm = s.reverted + s.flags;
  const tokens = s.tokens >= 1000 ? `${Math.round(s.tokens / 1000)}k` : String(s.tokens);
  return html`<p class="impact-summary"><strong>${impact.since === "365d" ? "Last year" : "Last 90 days"}:</strong> <a href="#/improve" data-anchor="outcomes">${fmtNum(s.kept)} kept</a> · <a href="#/improve" data-anchor="harm" ${harm ? html`class="text-warn"` : ""}>${fmtNum(s.reverted)} reverted</a> · <a href="#/improve" data-anchor="harm" ${s.flags ? html`class="text-warn"` : ""}>${fmtNum(s.flags)} ${s.flags === 1 ? "flag" : "flags"} after a change</a> · <a href="#/improve" data-anchor="cost">${tokens} tokens${s.tokenCoverage === null ? "" : ` (${fmtPct(s.tokenCoverage)} of calls reported)`}</a></p>`;
}

function outcomesSection(impact) {
  const outcomes = impact.outcomes ?? [];
  const sum = (process, keys) => process.weeks.reduce((n, w) => n + keys.reduce((m, key) => m + w[key], 0), 0);
  const rows = outcomes.map((process) => {
    const parts = CLASSES.map((c) => ({ ...c, n: sum(process, [c.key]) }));
    const total = sum(
      process,
      CLASSES.map((c) => c.key),
    );
    return {
      name: html`<span class="mono">${process.source}</span>`,
      value: total,
      text: `${fmtNum(sum(process, ["judge", "you", "unknown"]))} of ${fmtNum(total)} kept`,
      note: parts
        .filter((p) => p.n)
        .map((p) => `${p.label.toLowerCase()} ${p.n}`)
        .join(" · "),
      parts: parts.map((p) => ({ n: p.n, cls: `series-${p.colorIndex + 1}`, title: `${p.label}: ${p.n}` })),
    };
  });
  const max = Math.max(0, ...rows.map((r) => r.value));
  return html`<section class="chart-card" aria-labelledby="outcomes">${sectionHead("outcomes", "Who decided what", "Each process's decisions in this window, by who decided and what became of them.")}
    ${legend(CLASSES.map((c) => [c.label, c.colorIndex + 1]))}
    ${
      outcomes.length === 0
        ? emptyState("No proposals decided in this window.", "Improve processes write proposals that are decided here.")
        : barList(rows, { max, label: "Decisions by process" })
    }
    ${dataTable(html`${tableWrap(html`<table><thead><tr><th>Process</th><th>Week of</th>${CLASSES.map((c) => html`<th class="r">${c.label}</th>`)}</tr></thead><tbody>${outcomes.flatMap((process) => process.weeks.filter((w) => CLASSES.some((c) => w[c.key])).map((w) => html`<tr><th class="mono">${process.source}</th><td><button type="button" class="btn-secondary" data-drill data-source="${process.source}" data-week="${w.week}">${w.week}</button></td>${CLASSES.map((c) => html`<td class="r num">${w[c.key] ? html`<button type="button" class="btn-secondary" data-drill data-source="${process.source}" data-week="${w.week}" data-class="${c.key}">${w[c.key]}</button>` : "0"}</td>`)}</tr>`))}</tbody></table>`)}
    <div data-drill-panel tabindex="-1" aria-live="polite"></div>`)}
  </section>`;
}

/** The proposals behind a figure in the outcomes table, listed in the panel beside it. */
function wireDrill(root) {
  const panel = root.querySelector("[data-drill-panel]");
  let selection = 0;
  panel?.parentElement.addEventListener("click", async (event) => {
    const drill = event.target.closest("[data-drill]");
    if (!drill) return;
    const mine = ++selection;
    mount(panel, html`<p role="status">Loading...</p>`);
    try {
      const { proposals } = await api("/api/proposals", {
        status: "recent",
        source: drill.dataset.source,
        week: drill.dataset.week,
        class: drill.dataset.class,
        limit: 50,
      });
      if (mine !== selection) return;
      mount(
        panel,
        html`<h3>${drill.dataset.source}, week of ${drill.dataset.week}${drill.dataset.class ? `, ${drill.dataset.class}` : ""}</h3>${proposals.length ? html`<ul class="change-list">${proposals.map((p) => html`<li><a class="mono wrap" href="${proposalHref(p.id)}">${p.ref}</a>${badge(p.status, p.status === "reverted" ? "warn" : "neutral")}<span class="muted small">${ago(p.review?.decidedAt ?? p.updatedAt)}</span></li>`)}</ul>` : html`<p>No proposals match.</p>`}`,
      );
    } catch (error) {
      if (mine !== selection) return;
      mount(panel, html`<p role="alert">${error.message}</p>`);
    }
    panel.focus({ preventScroll: true });
  });
}

function flowSection(ctx, impact) {
  const flow = impact.reviewFlow ?? [];
  const labels = impact.weeks.map((w) => w.slice(5));
  const last = flow.at(-1);
  return html`<section class="chart-card" aria-labelledby="flow">${sectionHead("flow", "Is review keeping up?", last ? `This week: ${last.created} made, ${last.decided} decided, ${last.waiting} waiting at the end of it.` : "")}
    <h3>Waiting for review, at the end of each week</h3>
    ${chart(
      ctx,
      "flow-waiting",
      "Proposals waiting for review at the end of each week.",
      () =>
        stepLine(
          labels,
          flow.map((w) => w.waiting),
          { name: "Waiting for review", unit: "Waiting" },
        ),
      { height: "short" },
    )}
    <h3>Made and decided each week</h3>
    ${legend([
      ["Made", 1],
      ["Decided", 3],
    ])}
    ${chart(
      ctx,
      "flow-rate",
      "Proposals made and decided each week.",
      () =>
        lines(
          labels,
          [
            { name: "Made", colorIndex: 0, data: flow.map((w) => w.created) },
            { name: "Decided", colorIndex: 2, data: flow.map((w) => w.decided) },
          ],
          "Proposals",
        ),
      { height: "short" },
    )}
    ${dataTable(tableWrap(html`<table><thead><tr><th>Week of</th><th class="r">Made</th><th class="r">Decided</th><th class="r">Waiting at the end</th></tr></thead><tbody>${flow.map((w) => html`<tr><th>${w.week}</th><td class="r num">${w.created}</td><td class="r num">${w.decided}</td><td class="r num">${w.waiting}</td></tr>`)}</tbody></table>`))}
  </section>`;
}

function librarySection(ctx, impact) {
  const library = impact.library ?? [];
  const known = library.filter((w) => w.entries !== null);
  const labels = impact.weeks.map((w) => w.slice(5));
  const first = known[0];
  const last = known.at(-1);
  return html`<section class="chart-card" aria-labelledby="library">${sectionHead("library", "How has the library changed?", known.length >= 2 ? `${fmtNum(first.entries)} assets in the week of ${first.week}, ${fmtNum(last.entries)} in the week of ${last.week}.` : "")}
    ${
      known.length < 2
        ? emptyState(
            "The library size is recorded each time akm indexes.",
            "Two or more indexes in the window draw this line.",
          )
        : chart(
            ctx,
            "library-size",
            "Assets in the library at the end of each week.",
            () =>
              stepLine(
                labels,
                library.map((w) => w.entries),
                { name: "Assets in the library", unit: "Assets" },
              ),
            { height: "short" },
          )
    }
  </section>`;
}

function harmSection(impact) {
  const harm = impact.harm ?? [];
  return html`<section class="chart-card" aria-labelledby="harm">${sectionHead("harm", `Harm log${harm.length ? ` (${harm.length})` : ""}`, "Changes that were undone, rejections that were reopened, retirements with a risk flagged, and feedback that came after a change. Never collapsed.")}
    ${
      harm.length === 0
        ? html`<div class="attention-clear"><span class="dot dot-ok" aria-hidden="true"></span>No reverts, reopened rejections or risky retirements, and no flags after a change, in this window. Checked ${fmtNum(impact.summary.checked)} decisions.</div>`
        : html`<ul class="change-list">${harm.map((item) => html`<li>${badge(HARM_LABEL[item.kind] ?? item.kind, item.kind === "flag-after-change" ? "warn" : "neutral")} <a class="mono wrap" href="${assetHref(item.ref)}">${item.ref}</a><span class="muted small">${item.detail} · ${ago(item.at)}</span>${item.proposalId ? html`<a class="small" href="${proposalHref(item.proposalId)}">Proposal</a>` : ""}</li>`)}</ul>`
    }
  </section>`;
}

function costSection(ctx, impact) {
  const cost = impact.cost ?? [];
  const labels = impact.weeks.map((w) => w.slice(5));
  const processes = [...new Set(cost.flatMap((w) => Object.keys(w.byProcess)))].sort();
  const calls = cost.reduce((sum, w) => sum + w.calls, 0);
  const reported = cost.reduce((sum, w) => sum + w.usageCalls, 0);
  return html`<section class="chart-card" aria-labelledby="cost">${sectionHead("cost", "What does improve cost?", calls ? `${fmtNum(calls)} model calls; tokens are reported for ${fmtNum(reported)} of them. Tokens are not money.` : "")}
    ${
      calls === 0
        ? emptyState("No model calls recorded in this window.")
        : html`${legend(processes.map((name, i) => [name, (i % 5) + 1]))}${chart(
            ctx,
            "cost-calls",
            "Model calls per week by process.",
            () =>
              stackedColumns(
                labels,
                processes.map((name, i) => ({
                  name,
                  colorIndex: i % 5,
                  data: cost.map((w) => w.byProcess[name] ?? 0),
                })),
                "Calls",
              ),
          )}`
    }
    ${dataTable(tableWrap(html`<table><thead><tr><th>Week of</th><th class="r">Calls</th><th class="r">Tokens</th><th class="r">Calls reporting tokens</th></tr></thead><tbody>${cost.map((w) => html`<tr><th>${w.week}</th><td class="r num">${fmtNum(w.calls)}</td><td class="r num">${w.usageCalls ? fmtNum(w.tokens) : "not reported"}</td><td class="r num">${fmtNum(w.usageCalls)} / ${fmtNum(w.calls)}</td></tr>`)}</tbody></table>`))}
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
            html`<table><thead><tr><th>Asset</th><th>Process</th><th>Changed</th><th class="r">Found</th><th class="r">Negative</th><th>After</th></tr></thead><tbody>${changed.map((c) => html`<tr><th><a class="mono wrap" href="${assetHref(c.ref)}">${c.ref}</a></th><td class="mono">${c.source}</td><td>${ago(c.decidedAt)}${c.outcome === "reverted" ? html` ${badge("reverted", "warn")}` : ""}</td><td class="r">${arrow(c.before.hits, c.after.hits)}</td><td class="r">${arrow(c.before.negative, c.after.negative)}</td><td>${c.complete ? "28 days" : `${c.afterDays} days so far`}</td></tr>`)}</tbody></table>`,
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
  if (!impact.available)
    return html`${pageHeader("Improve impact", "What akm's improve processes did in your environment. Times are UTC.")}${emptyState("Improve has not run in this environment yet.", html`It runs with <code>akm improve</code> or on a schedule.`)}`;
  ctx.after.push(wireDrill);
  const harmCount = (impact.harm ?? []).length;
  const sinceToggle = windowToggle({
    route: "improve",
    param: "since",
    label: "Window",
    current: since,
    choices: [
      ["90d", "90 days"],
      ["all", "1 year"],
    ],
  });
  return html`${pageHeader("Improve impact", "What akm's improve processes did in your environment. Times are UTC.", sinceToggle)}
    ${summaryLine(impact)}
    <details class="how-to-read"><summary>How to read this page</summary><p>Weeks start on Monday, UTC. A change is "kept" when a proposal was accepted and not reverted. A flag after a change is negative feedback on the same asset within 14 days. Before-and-after counts show what happened next to a change, not that the change caused it.</p></details>
    <div class="impact-layout">
      <nav class="impact-toc" aria-label="On this page"><ul>${SECTIONS.map(([id, label]) => html`<li><a href="#/improve" data-anchor="${id}">${label}${id === "harm" && harmCount ? html` <span class="num">(${harmCount})</span>` : ""}</a></li>`)}</ul></nav>
      <div class="impact-sections">
        ${searchSection(ctx, retrieval, impact.changedAssets ?? [])}
        ${outcomesSection(impact)}
        ${flowSection(ctx, impact)}
        ${librarySection(ctx, impact)}
        ${harmSection(impact)}
        ${costSection(ctx, impact)}
        ${changedSection(impact)}
        ${judgeSection(impact)}
      </div>
    </div>
    ${sectionErrors(impact.errors)}`;
}
