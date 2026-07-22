// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm health --format html` — token builder for the full HTML health report
 * (#582). Ports the external akm-health-report skill's collect.py + render.py
 * to TypeScript so the report is generated in-process (no python, no
 * shell-out). The template (`src/assets/templates/html/health.html`) is a
 * strict superset of the skill's report.html; this module computes the 17
 * `%%TOKEN%%` replacements it consumes.
 *
 * Structure (chunk-9 WI-9.5a / H2, anchors C.6): `./report-view-model.ts`
 * holds the pure `AkmHealthResult`→`HealthReportViewModel` extractor — every
 * computed number/string/series the report shows, with NO HTML. This module
 * holds the thin VM→HTML fragment renderers (one per template section) plus
 * `buildHealthHtmlReplacements`, the extract-then-render glue that produces
 * the 17-token replacement map.
 *
 * Determinism: nothing here depends on Date.now()/Math.random(). Runs are
 * sorted by startedAt; `%%GENERATED_AT%%` derives from the latest run (or the
 * window anchor), so output is byte-identical for identical inputs.
 *
 * ECharts delivery (chunk-9 WI-9.4d, anchors C.1): CDN-only. The vendored
 * `~1MB` `echarts.min.js` self-contained/"inline" mode was removed along with
 * the asset itself — `buildEchartsTag` always emits a `<script src>` tag
 * pointed at the jsDelivr CDN, so viewing the report now requires network
 * access. BEHAVIOR CHANGE (plan-accepted, ledgered): previously
 * `AKM_ECHARTS=cdn` opted IN to the CDN with "inline" as the default; there is
 * no more env var or option to opt back into an offline report.
 */

import { escapeHtml } from "../../output/html-render";
import { pkgVersion } from "../../version";
import {
  buildHealthReportViewModel,
  compact,
  fmtMs,
  type HealthHtmlReportOptions,
  type HealthReportViewModel,
  humanize,
  num,
  type PendingProposalLike,
  type TrendDirection,
} from "./report-view-model";
import type { AkmHealthResult } from "./types";

export type { HealthHtmlReportOptions, PendingProposalLike };

const esc = escapeHtml;

/** Emit a <time> element that the browser's JS will reformat to the viewer's local timezone. */
function isoTimeTag(iso: string): string {
  const fallback = iso.slice(0, 16).replace("T", " ");
  return `<time data-iso="${esc(iso)}">${esc(fallback)}</time>`;
}

function trendClass(direction: TrendDirection): string {
  return direction === "up" ? "trend-up" : direction === "down" ? "trend-down" : "trend-flat";
}

function trendLabel(direction: TrendDirection): string {
  return direction === "up" ? "▲ up" : direction === "down" ? "▼ watch" : "— flat";
}

function deltaPill(deltas: HealthReportViewModel["deltas"], key: string, lowerIsBetter = false): string {
  const raw = deltas[key]?.pctChange;
  if (raw === undefined) return '<span class="trend-pill flat">— n/a</span>';
  if (typeof raw === "string") {
    const sign = raw.trim().startsWith("-") ? -1 : 1;
    const good = lowerIsBetter ? sign < 0 : sign > 0;
    return `<span class="trend-pill ${good ? "up" : "down"}">${sign > 0 ? "▲ new" : "▼ gone"}</span>`;
  }
  const good = lowerIsBetter ? raw < 0 : raw > 0;
  const cls = Math.abs(raw) < 1 ? "flat" : good ? "up" : "down";
  const arrow = raw > 0 ? "▲" : raw < 0 ? "▼" : "—";
  const signed = `${raw > 0 ? "+" : ""}${Math.round(raw)}%`;
  return `<span class="trend-pill ${cls}">${arrow} ${signed}</span>`;
}

// ── Action-item / advisory cards ─────────────────────────────────────────────

type Priority = "P1" | "P2" | "P3";

interface ActionItem {
  /** Stable de-dupe key — first item with a given key wins. */
  key: string;
  prio: Priority;
  cls: "warn" | "fail";
  title: string;
  /** Pre-escaped/safe HTML description. */
  descHtml: string;
  /** Optional remediation command (rendered in a <code> block). */
  remedy?: string;
}

const PRIO_RANK: Record<Priority, number> = { P1: 0, P2: 1, P3: 2 };

function actionItemCard(item: ActionItem): string {
  const icon = item.cls === "fail" ? "🔴" : item.prio === "P3" ? "🟡" : "⚠️";
  const remedy = item.remedy ? `<div class="remedy">Fix: <code>${esc(item.remedy)}</code></div>` : "";
  return (
    `<div class="advisory ${item.cls}"><div class="advisory-icon">${icon}</div>` +
    `<div class="advisory-body">` +
    `<div class="title"><span class="prio ${item.prio.toLowerCase()}">${item.prio}</span>${item.title}</div>` +
    `<div class="desc">${item.descHtml}</div>${remedy}</div></div>`
  );
}

function passCard(title: string, desc: string): string {
  return (
    '<div class="advisory" style="border-left:3px solid var(--green);">' +
    '<div class="advisory-icon">✅</div><div class="advisory-body">' +
    `<div class="title">${esc(title)}</div>` +
    `<div class="desc">${esc(desc)}</div></div></div>`
  );
}

// ── Status badges (presentation constants) ───────────────────────────────────

const badgeByStatus = {
  pass: { badge: "badge-pass", dot: "dot-pass", label: "PASS" },
  warn: { badge: "badge-warn", dot: "dot-warn", label: "WARN" },
  fail: { badge: "badge-fail", dot: "dot-fail", label: "FAIL" },
} as const;

// ── ECharts delivery ─────────────────────────────────────────────────────────

const ECHARTS_CDN = "https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js";

/** Always CDN — see the module docstring's chunk-9 WI-9.4d note. */
function buildEchartsTag(): string {
  return `<script src="${ECHARTS_CDN}"></script>`;
}

/**
 * Build the time-slice `<option>`s for the report's filter bar, DERIVED from
 * the actual report window (`vm.sliceCandidates`) so the choices always make
 * sense (the old hard-coded 1d–21d list was useless on a 24h or 7d report).
 * "All" is the default; the sub-window options carry their cutoff in
 * milliseconds (consumed by filteredRuns), largest first.
 */
function buildSliceOptions(vm: HealthReportViewModel): string {
  const opts = [`<option value="all" selected>All (${esc(vm.window)})</option>`];
  for (const [ms, label] of vm.sliceCandidates) opts.push(`<option value="${ms}">Last ${label}</option>`);
  return opts.join("\n      ");
}

// ── Fragment renderers (VM → HTML; one per template section) ────────────────

function renderSinceHuman(vm: HealthReportViewModel): string {
  return vm.sinceIso ? `${isoTimeTag(vm.sinceIso)} → now` : `last ${esc(vm.window)}`;
}

function renderStatusBadgeHtml(vm: HealthReportViewModel): string {
  const badge = badgeByStatus[vm.status];
  const statusBadge = `<span class="badge-pill ${badge.badge}"><span class="dot ${badge.dot}"></span>${badge.label}</span>`;
  const failBadge =
    `<span class="badge-pill ${vm.failOk ? "badge-pass" : "badge-warn"}">` +
    `<span class="dot ${vm.failOk ? "dot-pass" : "dot-warn"}"></span>${vm.taskFailRate} Fail Rate</span>`;
  return `${statusBadge}\n    ${failBadge}`;
}

/**
 * Executive-summary block: quick numbers, trend pills, period-over-period
 * deltas, the current-run snapshot, the window facts, the synthesized verdict
 * sentence, and the freshness line.
 */
function renderExecSummary(vm: HealthReportViewModel): string {
  const badge = badgeByStatus[vm.status];
  const li = (k: string, vHtml: string) => `<li><span class="k">${esc(k)}</span><span class="v">${vHtml}</span></li>`;
  const trendLi = (k: string, d: TrendDirection) =>
    li(k, `<span class="trend-pill ${d === "flat" ? "flat" : d}">${d}</span>`);

  const quickNumbers = [
    li("Task fail rate", vm.taskFailRate),
    li("Agent fail rate", vm.agentFailRate),
    li("Improve completion", `${num(vm.completed)} / ${num(vm.invoked)} (${vm.completionRate})`),
    li("MI yield rate", vm.miYieldRate),
    li("MI written", num(vm.miWritten)),
    li("Consolidation promoted", num(vm.consolidation.promoted)),
    li(
      "Consolidation judged: no action",
      `<abbr title="Candidates the consolidator reviewed but intentionally left unchanged (the 'judgedNoAction' field).">${num(vm.consolidation.judgedNoAction)}</abbr>`,
    ),
    li("Chunk failure", vm.chunkFail),
    li("Median wall time", fmtMs(vm.wallTime.medianMs)),
    li("P95 wall time", fmtMs(vm.wallTime.p95Ms)),
  ].join("");

  const trendRows = [
    trendLi("Decision quality", vm.trend.decisionQuality),
    trendLi("Output volume", vm.trend.outputVolume),
    trendLi("Failures", vm.trend.failures),
    trendLi("Latency", vm.trend.latency),
  ].join("");

  const deltaRows = [
    li("Promoted", deltaPill(vm.deltas, "improve.consolidation.promoted")),
    li("MI written", deltaPill(vm.deltas, "improve.memoryInference.written")),
    li("MI yield", deltaPill(vm.deltas, "improve.memoryInference.yieldRate")),
    li("Median wall", deltaPill(vm.deltas, "improve.wallTime.medianMs", true)),
    li("P95 wall", deltaPill(vm.deltas, "improve.wallTime.p95Ms", true)),
  ].join("");

  const snapRows = vm.latest
    ? [
        li("Run id", `<code>${esc(vm.latest.id.slice(0, 28))}</code>`),
        li("Completed", isoTimeTag(vm.latest.completedAt || vm.latest.startedAt)),
        li("Status", vm.latest.ok ? "✅ ok" : "❌ failed"),
        li("Wall time", fmtMs(vm.latest.wallTimeMs)),
        li("Reflect ok/fail", `${vm.latest.reflectOk} / ${vm.latest.reflectFailed}`),
        li("Promoted", String(vm.latest.promoted)),
        li(
          "Judged: no action",
          `<abbr title="Candidates reviewed but intentionally left unchanged on this run.">${vm.latest.judgedNoAction}</abbr>`,
        ),
        li("MI written", String(vm.latest.miWritten)),
        li("Graph entities/relations", `${vm.latest.geEntities} / ${vm.latest.geRelations}`),
      ].join("")
    : '<li><span class="k">No runs in window</span><span class="v">—</span></li>';

  const windowRows = [
    li("Report window", esc(vm.window)),
    li("Compare window", esc(vm.compare)),
    li("Runs", `${num(vm.totalRuns)} (${vm.failedRuns} failed)`),
    li("Included result rows", num(vm.includedResultRows)),
    li("Normalized result rows", num(vm.normalizedResultRows)),
    li("Invalid result rows skipped", num(vm.skippedInvalidResultRows)),
    li(
      "Stash derived",
      `<abbr title="Whole-stash recount of derived assets at report time — not a per-run sum.">${num(vm.memorySummary.derived)}</abbr>`,
    ),
    li(
      "Stash eligible",
      `<abbr title="Whole-stash recount of eligible assets at report time — not a per-run sum.">${num(vm.memorySummary.eligible)}</abbr>`,
    ),
    li("Pending proposals", String(vm.proposals.length)),
    li("Semantic search", vm.sem.blocked ? "BLOCKED" : "OK"),
  ].join("");

  const overallEmoji = vm.trend.overall === "improving" ? "📈" : vm.trend.overall === "degrading" ? "📉" : "↔️";

  const verdictSentence = `${vm.verdictWord} — ${esc(vm.verdictRest)}.`;
  const verdictHtml = `<div class="verdict ${vm.status}"><b>Verdict:</b> ${verdictSentence}</div>`;

  const latestRunHuman = vm.lastRun ? isoTimeTag(vm.lastRun.completedAt || vm.lastRun.startedAt) : "—";
  const freshnessHtml = `<div class="freshness${vm.isStale ? " stale" : ""}">${
    vm.isStale ? "⚠️ Stale: " : ""
  }Latest run ${latestRunHuman} &nbsp;·&nbsp; generated ${isoTimeTag(vm.generatedAt)}${
    vm.isStale ? " — no recent activity (newest run older than the 6h freshness threshold)." : "."
  }</div>`;

  return `
    <h2>${overallEmoji} Executive Summary
        <span class="badge-pill ${badge.badge}" style="font-size:11px;">
        <span class="dot ${badge.dot}"></span>${badge.label}</span></h2>
    ${verdictHtml}
    ${freshnessHtml}
    <div class="exec-grid">
      <div>
        <h4>Quick Numbers</h4>
        <ul>${quickNumbers}</ul>
      </div>
      <div>
        <h4>Trend vs prior ${esc(vm.compare)}</h4>
        <ul>${trendRows}</ul>
        <h4 style="margin-top:14px;">Period-over-period deltas</h4>
        <ul>${deltaRows}</ul>
      </div>
      <div>
        <h4>Current Run Snapshot</h4>
        <ul>${snapRows}</ul>
      </div>
      <div>
        <h4>Window</h4>
        <ul>${windowRows}</ul>
      </div>
    </div>
    <div class="overall">Overall trend: <b>${esc(vm.trend.overall)}</b> ${overallEmoji}
      &nbsp;·&nbsp; based on decision quality, output volume, failures, and latency vs the prior window.</div>`.trim();
}

/**
 * Color is a health SIGNAL, not decoration: green/yellow/red where a card has
 * a meaningful threshold; "neutral" for purely-informational counts. Cards
 * are ordered by operator priority (failures first, informational counts
 * last).
 */
function renderKpiCards(vm: HealthReportViewModel): string {
  const semValue = vm.sem.blocked ? "BLOCKED" : "OK";
  const semColor = vm.sem.blocked ? "red" : "green";
  const semStyle = vm.sem.blocked ? "font-size:18px;" : "";
  const completionColor = vm.completionPct >= 99 ? "green" : vm.completionPct >= 90 ? "yellow" : "red";
  const kpiCard = (color: string, label: string, value: string, sub: string, valueStyle = "") =>
    `<div class="kpi-card ${color}">
      <div class="label">${label}</div>
      <div class="value"${valueStyle ? ` style="${valueStyle}"` : ""}>${value}</div>
      <div class="sub">${sub}</div>
    </div>`;
  return [
    kpiCard(
      vm.failedRuns === 0 ? "green" : "red",
      "Failed Runs",
      String(vm.failedRuns),
      `of ${num(vm.totalRuns)} runs · ${vm.taskFailRate} task fail`,
    ),
    kpiCard(completionColor, "Completion Rate", vm.completionRate, `${num(vm.completed)} / ${num(vm.invoked)} invoked`),
    kpiCard("neutral", "Median Duration", `${vm.medianDurMin}m`, `p95 = ${vm.p95DurMin}m`),
    kpiCard("blue", "Total Promoted", num(vm.consolidation.promoted), `avg ${vm.avgPromoted} / run`),
    kpiCard("blue", "MI Written", num(vm.miWritten), `${vm.miYieldRate} yield rate`),
    kpiCard(
      "purple",
      "Graph Entities",
      num(vm.graphExtraction.entities),
      `+${num(vm.graphExtraction.relations)} relations`,
    ),
    kpiCard(
      "neutral",
      "Stash Derived",
      num(vm.memorySummary.derived),
      `of ${num(vm.memorySummary.eligible)} eligible (whole-stash)`,
    ),
    // #576: real LLM work — duration leads, tokens compact, not a GPU proxy.
    kpiCard(
      vm.llm.calls > 0 ? "purple" : "neutral",
      "🧠 LLM Work",
      `${vm.llmTokensCompact} tok`,
      `${fmtMs(vm.llm.totalDurationMs)} · ${num(vm.llm.calls)} calls · ${compact(vm.llm.reasoningTokens)} reasoning`,
    ),
    kpiCard(semColor, "Semantic Search", semValue, esc(vm.sem.detail), semStyle),
    kpiCard(
      vm.proposals.length > 0 ? "yellow" : "neutral",
      "Pending Proposals",
      String(vm.proposals.length),
      `from ${esc(vm.window)} batch`,
    ),
  ].join("\n");
}

function renderSummaryRowsHtml(vm: HealthReportViewModel): string {
  return vm.summaryRows
    .map(([label, value, t, tip]) => {
      const labelHtml = tip ? `<abbr title="${esc(tip)}">${esc(label)}</abbr>` : esc(label);
      return (
        `            <tr><td>${labelHtml}</td><td>${esc(value)}</td>` +
        `<td class="trend ${trendClass(t)}">${trendLabel(t)}</td></tr>`
      );
    })
    .join("\n");
}

/**
 * Merge + de-duplicate advisories and the old "what to watch" cards (built
 * from the same VM data — invalid rows, sem-blocked, proposals, tail-latency,
 * failed-runs, …) into ONE prioritized list (P1/P2/P3 + a remediation command
 * per item), keyed so each concern appears exactly once.
 */
function renderActionItems(vm: HealthReportViewModel): string {
  const items: ActionItem[] = [];
  const seen = new Set<string>();
  const pushItem = (item: ActionItem) => {
    if (seen.has(item.key)) return;
    seen.add(item.key);
    items.push(item);
  };

  if (vm.invalidRuns.length > 0) {
    pushItem({
      key: "invalid-improve-result-rows",
      prio: "P2",
      cls: "warn",
      title: `${vm.invalidRuns.length} invalid improve result row${vm.invalidRuns.length === 1 ? "" : "s"} skipped`,
      descHtml: `Excluded from result-derived metrics: ${vm.invalidRuns.map((run) => `<code>${esc(run.id)}</code>`).join(", ")}.`,
      remedy: `akm health --since=${vm.window} --group-by run`,
    });
  }

  // Hard advisories from the health check engine (own remediation in message).
  for (const a of vm.advisories) {
    if (a.status !== "warn" && a.status !== "fail") continue;
    pushItem({
      key: `advisory:${a.name}`,
      prio: a.status === "fail" ? "P1" : "P2",
      cls: a.status === "fail" ? "fail" : "warn",
      title: esc(humanize(a.name)),
      descHtml: esc(a.message),
    });
  }

  // Failed runs in window.
  if (vm.failedRuns > 0) {
    pushItem({
      key: "failed-runs",
      prio: "P1",
      cls: "fail",
      title: `${vm.failedRuns} failed run${vm.failedRuns === 1 ? "" : "s"} in window`,
      descHtml: `Task fail rate ${esc(vm.taskFailRate)}. Inspect failed runs (ok=false) for early-exit or harness errors.`,
      remedy: `akm health --since=${vm.window} --group-by run`,
    });
  }

  // Semantic search blocked.
  if (vm.sem.blocked) {
    pushItem({
      key: "semantic-search-blocked",
      prio: "P2",
      cls: "warn",
      title: "Semantic search blocked",
      descHtml: `Embedding provider unreachable. ${esc(vm.sem.detail)}. Curate falls back to keyword search — relevance scoring degraded.`,
      remedy: "akm config show",
    });
  }

  // Pending proposals to drain.
  if (vm.proposals.length > 0) {
    const srcSummary = vm.proposalsBySource.map(([source, count]) => `${count} via ${esc(source)}`).join(", ");
    pushItem({
      key: "drain-proposals",
      prio: "P2",
      cls: "warn",
      title: `Drain ${vm.proposals.length} pending proposal${vm.proposals.length === 1 ? "" : "s"}`,
      descHtml: `Proposals generated this batch (${srcSummary}). Review before the queue grows further.`,
      remedy: "akm proposal list",
    });
  }

  // High tail latency.
  if (vm.wallTime.p95Ms && vm.wallTime.medianMs && vm.wallTime.p95Ms / vm.wallTime.medianMs > 2.5) {
    pushItem({
      key: "tail-latency",
      prio: "P3",
      cls: "warn",
      title: `High tail latency: p95=${fmtMs(vm.wallTime.p95Ms)}, median=${fmtMs(vm.wallTime.medianMs)}`,
      descHtml:
        "P95 is well above median. Consolidation/LLM phase dominates wall time on slow runs. " +
        "Check for slow chunks or LLM rate limiting.",
    });
  }

  // Stale freshness.
  if (vm.isStale && vm.totalRuns > 0) {
    const latestRunHuman = vm.lastRun ? isoTimeTag(vm.lastRun.completedAt || vm.lastRun.startedAt) : "—";
    pushItem({
      key: "stale",
      prio: "P3",
      cls: "warn",
      title: "No recent improve runs",
      descHtml: `Newest run is ${esc(latestRunHuman)} — older than the 6h freshness threshold. Check the improve scheduler/cron.`,
    });
  }

  // WS-5: corpus entrenchment flag.
  if (vm.degradation?.entrenchmentFlagged) {
    pushItem({
      key: "corpus-entrenchment",
      prio: "P2",
      cls: "warn",
      title: "Corpus entrenchment risk: retrieval_salience Gini > 0.35",
      descHtml:
        "A small set of assets dominates retrieval — retrieval diversity is low. " +
        "Review top-ranked assets for stale or over-represented content. " +
        `Corpus diversity proxy: ${esc(String(vm.degradation.corpusCentroidDistance))}.`,
      remedy: "akm health --format json | jq '.improve.degradation'",
    });
  }

  // Low-tail companion: salience distribution collapsed toward uniform.
  if (vm.degradation?.salienceUniformityFlagged) {
    pushItem({
      key: "salience-uniformity-collapse",
      prio: "P2",
      cls: "warn",
      title: "Salience distribution collapsed: retrieval_salience Gini < 0.08",
      descHtml:
        "The top-100 salience scores are near-uniform (uniform baseline ≈ 0.1) — " +
        "ranking currently carries little to no discrimination between assets. " +
        `Corpus diversity proxy: ${esc(String(vm.degradation.corpusCentroidDistance))}.`,
      remedy: "akm health --format json | jq '.improve.degradation'",
    });
  }

  // WS-5: over-budget consolidation advisory.
  if (vm.perf.overBudgetRuns > 0) {
    pushItem({
      key: "over-budget-consolidation",
      prio: "P2",
      cls: "warn",
      title: `${vm.perf.overBudgetRuns} consolidation run${vm.perf.overBudgetRuns === 1 ? "" : "s"} exceeded budget`,
      descHtml:
        "Consolidation phase wall time exceeded the total run budget on these runs. " +
        "Consider increasing the timeout or reducing the consolidation pool via profile config.",
      remedy: "akm config show",
    });
  }

  // Session-log notes (informational, lowest priority).
  if (vm.sessionLogAdvisories.length > 0) {
    const patterns = vm.sessionLogAdvisories
      .slice(0, 6)
      .map((p) => `<li>${esc(p.topic)}</li>`)
      .join("");
    pushItem({
      key: "session-log-notes",
      prio: "P3",
      cls: "warn",
      title: `${vm.sessionLogAdvisories.length} session-log note(s) (informational)`,
      descHtml: `<ul style="margin:4px 0 0 16px;padding:0;">${patterns}</ul>`,
    });
  }

  items.sort((a, b) => PRIO_RANK[a.prio] - PRIO_RANK[b.prio]);
  return items.length > 0
    ? items.map(actionItemCard).join("\n")
    : passCard("No action items", "All checks passed and nothing needs attention for this window.");
}

function renderProposalRowsHtml(vm: HealthReportViewModel): string {
  return vm.proposals.length > 0
    ? vm.proposals
        .map((p, i) => {
          const tagCls = p.source === "extract" ? "tag-extract" : "tag-consolidate";
          return (
            `<tr><td>${i + 1}</td><td><code>${esc(p.ref)}</code></td>` +
            `<td><span class="tag ${tagCls}">${esc(p.source)}</span></td>` +
            `<td>${isoTimeTag(p.createdAt)}</td></tr>`
          );
        })
        .join("\n")
    : '<tr><td colspan="4" style="text-align:center;color:var(--muted);">No pending proposals</td></tr>';
}

// ── Main builder: extract-then-render glue ──────────────────────────────────

/**
 * Compute all 17 `%%TOKEN%%` replacements for the health HTML template.
 * There is deliberately NO standalone `%%OVERALL_STATUS%%` token — the
 * overall status is embedded in the pre-rendered badge / exec-summary
 * fragments, matching the skill template. Advisories and "what to watch" are
 * merged + de-duplicated into a single prioritized `%%ACTION_ITEMS_HTML%%`.
 */
export function buildHealthHtmlReplacements(
  result: AkmHealthResult,
  opts: HealthHtmlReportOptions,
): Record<string, string> {
  const vm = buildHealthReportViewModel(result, opts);
  return {
    "%%ECHARTS_TAG%%": buildEchartsTag(),
    "%%REPORT_TITLE%%": esc(vm.reportTitle),
    "%%WINDOW%%": esc(vm.window),
    "%%SINCE_HUMAN%%": renderSinceHuman(vm),
    "%%RUN_COUNT%%": num(vm.totalRuns),
    "%%STATUS_BADGE_HTML%%": renderStatusBadgeHtml(vm),
    "%%EXEC_SUMMARY_HTML%%": renderExecSummary(vm),
    "%%KPI_CARDS_HTML%%": renderKpiCards(vm),
    "%%RUNS_JS_CONST%%": `const RUNS = ${JSON.stringify(vm.runs)};`,
    "%%DISTILL_REASONS_JSON%%": JSON.stringify(vm.distillReasons),
    "%%SLICE_OPTIONS_HTML%%": buildSliceOptions(vm),
    "%%LLM_BY_STAGE_JSON%%": JSON.stringify(vm.llm.byStage ?? {}),
    "%%SUMMARY_ROWS_HTML%%": renderSummaryRowsHtml(vm),
    "%%ACTION_ITEMS_HTML%%": renderActionItems(vm),
    "%%PROPOSAL_ROWS_HTML%%": renderProposalRowsHtml(vm),
    "%%PROPOSAL_COUNT%%": String(vm.proposals.length),
    "%%GENERATED_AT%%": esc(vm.generatedAt),
    "%%AKM_VERSION%%": esc(pkgVersion),
  };
}
