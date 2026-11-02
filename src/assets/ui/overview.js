// Overview: current health and selected-window activity, retrieval and automation metrics.

import { sparkline } from "./charts.js";
import {
  ago,
  announce,
  api,
  badge,
  emptyState,
  fmtNum,
  fmtPct,
  html,
  mount,
  pageHeader,
  pretty,
  sectionErrors,
  statusKind,
  windowToggle,
} from "./lib.js";
import { overviewCharts } from "./overview-charts.js";

const GROUPS = [
  { state: "fail", title: "Failing", open: true },
  { state: "warn", title: "Warnings", open: true },
  { state: "off", title: "Turned off", open: false },
  { state: "unchecked", title: "Not checked", open: false },
  { state: "idle", title: "No data yet", open: false },
  { state: "pass", title: "Passing", open: false },
];

/** Checks that report "unknown" because a feature is off, not because something is wrong. */
const OFF_WHEN_UNKNOWN = new Set(["connections-and-harnesses", "proposal-queue"]);

/**
 * Where a check belongs on this page. A check the server could not decide is either a feature that is turned off (no
 * model connected, learning off) or a probe this page skipped because it reaches the network.
 */
function checkState(check, checks, probed = false) {
  if (check.status !== "unknown") return check.status;
  if (OFF_WHEN_UNKNOWN.has(check.name)) return "off";
  // Extraction needs a model; with none connected it cannot have run.
  const noModel = checks.some((c) => c.name === "connections-and-harnesses" && c.status === "unknown");
  if (check.name === "session-extraction" && noModel) return "off";
  // A probe this page skips unless asked says so in its message; anything else simply has nothing recorded yet.
  if (probed) return "unchecked";
  return /not probed/i.test(check.message ?? "") ? "unchecked" : "idle";
}

const allChecks = (health) => (health ? [...health.hardChecks, ...health.advisories] : []);

/** Every check with the group it belongs in, decided once per render. */
function classified(health, probed) {
  const checks = allChecks(health);
  return checks.map((check) => ({ check, state: checkState(check, checks, probed) }));
}

function checkItem(check) {
  const evidence = check.evidence && Object.keys(check.evidence).length > 0 ? check.evidence : null;
  return html`<li class="check">
    <div class="check-head"><strong class="mono">${check.name}</strong></div>
    <p class="check-msg">${check.message}</p>
    ${evidence ? html`<details><summary>Evidence</summary><pre class="code" data-volatile tabindex="0" role="group" aria-label="Evidence, scrolls sideways">${pretty(evidence)}</pre></details>` : ""}
  </li>`;
}

const STATE_DOT = { fail: "fail", warn: "warn", off: "neutral", unchecked: "neutral", idle: "neutral", pass: "ok" };

/** `probed`: the network checks ran, so a check still undecided could not be checked, and says why. */
function healthSection(health, probed = false) {
  const checks = classified(health, probed);
  const unchecked = probed ? 0 : checks.filter((c) => c.state === "unchecked").length;
  const groups = probed
    ? GROUPS.map((g) => (g.state === "unchecked" ? { ...g, title: "Could not check", open: true } : g))
    : GROUPS;
  return html`<section id="health"><div class="trends-head"><h2>Health checks</h2>${unchecked ? html`<button type="button" class="btn-secondary" data-run-checks>Run all checks</button>` : ""}</div>
    ${unchecked ? html`<p class="muted small">${unchecked} ${unchecked === 1 ? "check contacts" : "checks contact"} the akm release source or your scheduler, so this page runs ${unchecked === 1 ? "it" : "them"} only when you ask.</p>` : ""}
    <div data-health-groups>${groups.map((g) => {
      const items = checks.filter((c) => c.state === g.state).map((c) => c.check);
      if (items.length === 0) return "";
      return html`<details class="group" ${g.open ? html`open` : ""}><summary><span class="dot dot-${STATE_DOT[g.state]}" aria-hidden="true"></span>${g.title} <span class="num muted">${items.length}</span></summary><ul class="checks">${items.map(checkItem)}</ul></details>`;
    })}</div>${checks.length === 0 ? emptyState("No health checks ran.") : ""}</section>`;
}

function statusStrip(health, probed = false) {
  const checks = classified(health, probed);
  const count = (state) => checks.filter((c) => c.state === state).length;
  const overall = health?.status ?? "unknown";
  const quiet = [
    count("off") ? `${count("off")} turned off` : "",
    count("unchecked") ? `${count("unchecked")} ${probed ? "could not check" : "not checked"}` : "",
    count("idle") ? `${count("idle")} no data yet` : "",
  ].filter(Boolean);
  return html`<div class="strip">
    <div class="strip-main"><span class="strip-label">Overall health</span>${badge(health ? overall : "unavailable", statusKind(overall))}<span class="muted small">last 24 hours</span></div>
    <div class="strip-item"><span class="num big ${count("fail") > 0 ? "text-fail" : ""}">${count("fail")}</span><span class="muted">failing</span></div>
    <div class="strip-item"><span class="num big ${count("warn") > 0 ? "text-warn" : ""}">${count("warn")}</span><span class="muted">warning</span></div>
    <div class="strip-item"><span class="num big">${count("pass")}</span><span class="muted">passing</span></div>
    <div class="strip-item strip-right">${quiet.length ? html`<a class="muted small" href="#/overview" data-anchor="health">${quiet.join(" · ")}</a>` : ""}</div>
  </div>`;
}

const ATTENTION_MAX = 5;

/** What needs the reader, most severe first. Each row is a sentence and a verb link. */
function attentionItems(data, pulse) {
  const items = [];
  const checks = allChecks(data.health);
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
      href: "#/overview",
      anchor: "automation",
    });
  if (warning.length)
    items.push({
      tone: "warn",
      text: plural(warning.length, "health warning"),
      verb: "View",
      href: "#/overview",
      anchor: "health",
    });
  const pending = pulse?.attention.pending;
  if (pending?.count)
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
      href: "#/improve",
      anchor: "harm",
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
  const line = pulse.improveLine;
  const improveLine = line.proposed
    ? html`<p class="improve-line">Last ${line.weeks} weeks: improve proposed ${fmtNum(line.proposed)}; ${fmtNum(line.accepted)} accepted${line.acceptedThenReverted ? ` (${line.acceptedThenReverted} since reverted)` : ""}, ${fmtNum(line.rejected)} rejected${line.rejected ? ` (${line.rejectedByYou} by you)` : ""}, ${fmtNum(line.waiting)} waiting · ${fmtNum(line.calls)} model calls <a href="#/improve">Improve impact →</a></p>`
    : html`<p class="improve-line muted">Improve has proposed nothing in the last ${line.weeks} weeks. <a href="#/improve">Improve impact →</a></p>`;
  return html`<section aria-labelledby="pulse-title"><h2 id="pulse-title">Last 7 days against your usual</h2>
    <div class="tiles pulse-tiles">
      ${pulseTile({
        title: "Found nothing",
        value: foundNothing.n ? fmtPct(foundNothing.rate) : "–",
        lines: [
          foundNothing.n
            ? `${fmtNum(foundNothing.x)} of ${fmtNum(foundNothing.n)} searches.`
            : "No searches recorded yet.",
          usualText(foundNothing.usual, fmtPct),
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
  const [data, pulse, trend] = await Promise.all([
    api("/api/overview", { metricsSince: window }),
    api("/api/overview/pulse").catch(() => null),
    api("/api/retrieval", { since: "84d" }).catch(() => null),
  ]);
  ctx.after.push((root) => {
    root.querySelector("[data-health]")?.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-run-checks]");
      if (!button) return;
      button.disabled = true;
      button.textContent = "Checking…";
      try {
        const health = await api("/api/health", { probe: "1" }, { signal: null });
        mount(root.querySelector("[data-health]"), healthSection(health, true));
        mount(root.querySelector("[data-strip]"), statusStrip(health, true));
        announce("Health checks finished.");
      } catch (error) {
        button.disabled = false;
        button.textContent = "Run all checks";
        announce(`Health checks failed: ${error.message}`);
      }
    });
  });
  return html`${pageHeader("Overview", "Your akm environment. Times are UTC.")}
    <div data-strip>${statusStrip(data.health)}</div>
    ${sectionErrors(data.errors)}
    ${attention(data, pulse)}
    ${pulseSection(pulse, trend)}
    <section aria-labelledby="trends-title"><div class="trends-head"><h2 id="trends-title">Trends</h2>${windowToggle({
      route: "overview",
      param: "window",
      label: "Trend window",
      current: window,
      choices: [
        ["30d", "30 days"],
        ["90d", "90 days"],
      ],
    })}</div>
    <p class="muted small">${data.metrics ? `${data.metrics.window.since.slice(0, 16).replace("T", " ")} to now, UTC. ` : ""}Today is partial. Health covers the last 24 hours.</p>
    <div class="chart-grid">${overviewCharts(ctx, data, trend)}</div></section>
    ${metricsCoverage(data.metrics)}
    <div data-health>${data.health ? healthSection(data.health) : ""}</div>`;
}
