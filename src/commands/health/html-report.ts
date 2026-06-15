// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm health --format html` — token builder for the full HTML health report
 * (#582). Ports the external akm-health-report skill's collect.py + render.py
 * to TypeScript so the report is generated in-process (no python, no
 * shell-out). The template (`src/assets/templates/html/health.html`) is a
 * verbatim copy of the skill's report.html; this module computes the 17
 * `%%TOKEN%%` replacements it consumes.
 *
 * Determinism: nothing here depends on Date.now()/Math.random(). Runs are
 * sorted by startedAt; `%%GENERATED_AT%%` derives from the latest run (or the
 * window anchor), so output is byte-identical for identical inputs.
 */

import fs from "node:fs";
import path from "node:path";
import { escapeHtml } from "../../output/html-render";
import { getDirname } from "../../runtime";
import type { AkmHealthResult, DeltaEntry, HealthCheckResult, ImproveRunSummary } from "../health";

const ECHARTS_CDN = "https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js";
const ECHARTS_VENDOR_PATH = path.join(getDirname(import.meta.url), "../../assets/templates/html/vendor/echarts.min.js");

/** Pending-proposal fields the report consumes (`listPendingProposals` rows satisfy this). */
export interface PendingProposalLike {
  ref: string;
  source: string;
  createdAt: string;
}

export interface HealthHtmlReportOptions {
  /** Window label as the user typed it (`--since`), e.g. "24h". */
  window: string;
  /** Comparison-window label (`--compare`), e.g. "24h". */
  compare: string;
  /** Pending proposal queue (from `listPendingProposals`). */
  proposals: PendingProposalLike[];
  /**
   * Period-over-period deltas from the window-compare health call. The
   * intercept runs `akmHealth` twice (canonical `--since` window + compare
   * windows) exactly like the skill's collect.py, so the aggregate metrics
   * are not distorted when `--since` and `--compare` differ.
   */
  deltas?: Record<string, DeltaEntry>;
  /** ECharts delivery. Defaults to `AKM_ECHARTS` ("cdn" opts in; anything else inlines). */
  echarts?: "inline" | "cdn";
  /** Override for the vendored echarts.min.js path (tests). */
  echartsLibPath?: string;
}

// ── Small formatters (ports of render.py helpers) ───────────────────────────

const esc = escapeHtml;

function num(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function fmtMs(ms: number): string {
  return ms ? `${(ms / 60000).toFixed(1)}m` : "—";
}

function pct(rate: number, digits: number): string {
  return `${(rate * 100).toFixed(digits)}%`;
}

type TrendDirection = "up" | "down" | "flat";

function trendClass(direction: TrendDirection): string {
  return direction === "up" ? "trend-up" : direction === "down" ? "trend-down" : "trend-flat";
}

function trendLabel(direction: TrendDirection): string {
  return direction === "up" ? "▲ up" : direction === "down" ? "▼ watch" : "— flat";
}

/** pctChange may be a number or an "+inf"/"-inf" sentinel (prior window was 0). */
function coercePct(raw: number | string | undefined): number | undefined {
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return undefined;
  const s = raw.trim().toLowerCase();
  if (s === "+inf" || s === "inf" || s === "infinity" || s === "+infinity") return 1e9;
  if (s === "-inf" || s === "-infinity") return -1e9;
  const parsed = Number.parseFloat(s.replace(/%$/, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

// ── Per-run reshape (port of collect.py reshape_run) ─────────────────────────

interface ReportRun {
  id: string;
  startedAt: string;
  completedAt: string;
  wallTimeMs: number;
  ok: boolean;
  mode: string;
  consDurationMs: number;
  miDurationMs: number;
  geDurationMs: number;
  otherMs: number;
  consRan: boolean;
  promoted: number;
  merged: number;
  deleted: number;
  contradicted: number;
  judgedNoAction: number;
  processed: number;
  failedChunks: number;
  totalChunks: number;
  miWritten: number;
  miConsidered: number;
  miYieldRate: number;
  miCacheHits: number;
  geEntities: number;
  geRelations: number;
  geCacheHitRate: number;
  geFailures: number;
  distillSkipped: number;
  distillQueued: number;
  distillLlmFailed: number;
  distillByReason: Record<string, number>;
  reflectOk: number;
  reflectFailed: number;
  derived: number;
  eligible: number;
  lintFlagged: number;
  lintFixed: number;
  reflectsWithErrorContext: number;
  orphansPurged: number;
  evalCasesWritten: number;
}

function reshapeRun(r: ImproveRunSummary): ReportRun {
  const cons = r.consolidation;
  const mi = r.memoryInference;
  const ge = r.graphExtraction;
  const wall = r.wallTimeMs || 0;
  const consMs = cons.durationMs || 0;
  const miMs = mi.durationMs || 0;
  const geMs = ge.durationMs || 0;
  return {
    id: r.id,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    wallTimeMs: wall,
    ok: r.ok,
    mode: r.scope.mode,
    consDurationMs: consMs,
    miDurationMs: miMs,
    geDurationMs: geMs,
    otherMs: Math.max(0, wall - consMs - miMs - geMs),
    consRan: cons.ran,
    promoted: cons.promoted,
    merged: cons.merged,
    deleted: cons.deleted,
    contradicted: cons.contradicted,
    judgedNoAction: cons.judgedNoAction,
    processed: cons.processed,
    failedChunks: cons.failedChunks,
    totalChunks: cons.totalChunks,
    miWritten: mi.written || mi.writes || 0,
    miConsidered: mi.considered,
    miYieldRate: mi.yieldRate,
    miCacheHits: mi.cacheHits,
    geEntities: ge.entities,
    geRelations: ge.relations,
    geCacheHitRate: ge.cacheHitRate,
    geFailures: ge.failures,
    distillSkipped: r.actions.distill.skipped,
    distillQueued: r.actions.distill.queued,
    distillLlmFailed: r.actions.distill.llmFailed,
    distillByReason: r.actions.distill.skippedByReason,
    reflectOk: r.actions.reflect.ok,
    reflectFailed: r.actions.reflect.failed,
    derived: r.memorySummary.derived,
    eligible: r.memorySummary.eligible,
    lintFlagged: r.lintFlagged,
    lintFixed: r.lintFixed,
    reflectsWithErrorContext: r.reflectsWithErrorContext,
    orphansPurged: r.orphansPurged,
    evalCasesWritten: r.evalCasesWritten,
  };
}

// ── Trend classification (port of collect.py classify) ──────────────────────

function classify(deltas: Record<string, DeltaEntry>, metricKeys: string[], lowerIsBetter = false): TrendDirection {
  const changes = metricKeys
    .map((key) => coercePct(deltas[key]?.pctChange))
    .filter((c): c is number => c !== undefined);
  if (changes.length === 0) return "flat";
  const avg = changes.reduce((acc, c) => acc + c, 0) / changes.length;
  if (Math.abs(avg) < 5) return "flat";
  const direction: TrendDirection = avg > 0 ? "up" : "down";
  if (lowerIsBetter) return avg > 0 ? "down" : "up";
  return direction;
}

interface TrendBlock {
  decisionQuality: TrendDirection;
  outputVolume: TrendDirection;
  failures: TrendDirection;
  latency: TrendDirection;
  overall: "improving" | "degrading" | "mixed";
}

function buildTrend(deltas: Record<string, DeltaEntry>): TrendBlock {
  const decisionQuality = classify(deltas, ["improve.memoryInference.yieldRate", "improve.consolidation.promoted"]);
  const outputVolume = classify(deltas, [
    "improve.consolidation.promoted",
    "improve.memoryInference.written",
    "improve.sessionExtraction.proposalsCreated",
  ]);
  const failures = classify(deltas, ["improve.graphExtraction.failures"], true);
  const latency = classify(deltas, ["improve.wallTime.medianMs", "improve.wallTime.p95Ms"], true);
  const score = [decisionQuality, outputVolume, failures, latency].reduce(
    (acc, d) => acc + (d === "up" ? 1 : d === "down" ? -1 : 0),
    0,
  );
  const overall = score >= 1 ? "improving" : score <= -1 ? "degrading" : "mixed";
  return { decisionQuality, outputVolume, failures, latency, overall };
}

function deltaPill(deltas: Record<string, DeltaEntry>, key: string, lowerIsBetter = false): string {
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

// ── Advisory / watch-item cards ──────────────────────────────────────────────

function advisoryCard(cls: "warn" | "fail", icon: string, title: string, descHtml: string): string {
  return (
    `<div class="advisory ${cls}"><div class="advisory-icon">${icon}</div>` +
    `<div class="advisory-body"><div class="title">${title}</div>` +
    `<div class="desc">${descHtml}</div></div></div>`
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

interface SemSearchStatus {
  blocked: boolean;
  detail: string;
}

function readSemSearch(advisories: HealthCheckResult[]): SemSearchStatus {
  const check = advisories.find((a) => a.name === "semantic-search-runtime");
  if (!check) return { blocked: false, detail: "" };
  const evidence = check.evidence ?? {};
  const status = String(evidence.status ?? "unknown");
  const blocked = check.status !== "pass" || status.toLowerCase().includes("block");
  const entries = typeof evidence.entryCount === "number" ? evidence.entryCount : 0;
  const embeddings = typeof evidence.embeddingCount === "number" ? evidence.embeddingCount : 0;
  return { blocked, detail: `${num(entries)} entries, ${num(embeddings)} embeddings` };
}

// ── ECharts delivery ─────────────────────────────────────────────────────────

function buildEchartsTag(opts: HealthHtmlReportOptions): string {
  const mode = opts.echarts ?? (process.env.AKM_ECHARTS === "cdn" ? "cdn" : "inline");
  if (mode === "cdn") return `<script src="${ECHARTS_CDN}"></script>`;
  const libPath = opts.echartsLibPath ?? ECHARTS_VENDOR_PATH;
  // Guard against an accidental </script> in the minified payload.
  const lib = fs.readFileSync(libPath, "utf8").replaceAll("</script>", "<\\/script>");
  return `<script>\n${lib}\n</script>`;
}

// ── Main builder ─────────────────────────────────────────────────────────────

/**
 * Compute all 17 `%%TOKEN%%` replacements for the health HTML template.
 * There is deliberately NO standalone `%%OVERALL_STATUS%%` token — the
 * overall status is embedded in the pre-rendered badge / exec-summary
 * fragments, matching the skill template.
 */
export function buildHealthHtmlReplacements(
  result: AkmHealthResult,
  opts: HealthHtmlReportOptions,
): Record<string, string> {
  const deltas = opts.deltas ?? {};
  const runs = (result.runs ?? []).map(reshapeRun).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const improve = result.improve;
  const proposals = opts.proposals;
  const sem = readSemSearch(result.advisories);
  const trend = buildTrend(deltas);

  // ── Aggregates (collect.py step 6) ─────────────────────────────────────────
  const cons = improve.consolidation;
  const mi = improve.memoryInference;
  const ge = improve.graphExtraction;
  const wallTime = improve.wallTime;
  // #576: real per-stage LLM token/time accounting (replaces the GPU-time
  // proxy). Optional-guarded so reports built from older health JSON without
  // the aggregate still render.
  const llm = result.metrics.llmUsage ?? {
    calls: 0,
    totalDurationMs: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
    byStage: {},
  };
  const totalRuns = runs.length;
  const failedRuns = runs.filter((r) => !r.ok).length;
  const invoked = improve.invoked || totalRuns;
  const completed = improve.completed || totalRuns - failedRuns;
  const miWritten = mi.written || mi.writes || 0;

  const completionRate = invoked ? `${Math.round((100 * completed) / invoked)}%` : "0%";
  const taskFailRate = pct(result.metrics.taskFailRate, 1);
  const agentFailRate = pct(result.metrics.agentFailureRate, 2);
  const miYieldRate = pct(mi.yieldRate, 1);
  const medianDurMin = (wallTime.medianMs / 60000).toFixed(1);
  const p95DurMin = (wallTime.p95Ms / 60000).toFixed(1);
  const avgPromoted = totalRuns ? String(Math.round(cons.promoted / totalRuns)) : "0";
  const chunkFail = `${num(cons.failedChunks)} / ${num(cons.totalChunks)}`;

  // ── Meta (collect.py steps 10-11) ──────────────────────────────────────────
  const sinceIso = result.since;
  const reportDate = sinceIso.slice(0, 10);
  const sinceHuman = sinceIso ? `${sinceIso.slice(0, 16).replace("T", " ")} UTC → now` : `last ${opts.window}`;
  const reportTitle = reportDate ? `AKM Health Report — ${reportDate}` : "AKM Health Report";
  const lastRun = runs[runs.length - 1];
  const generatedAt = lastRun ? lastRun.completedAt || lastRun.startedAt || sinceIso : sinceIso;
  const latest = [...runs].reverse().find((r) => r.ok) ?? lastRun;

  // ── Status badges ──────────────────────────────────────────────────────────
  const badgeByStatus = {
    pass: { badge: "badge-pass", dot: "dot-pass", label: "PASS" },
    warn: { badge: "badge-warn", dot: "dot-warn", label: "WARN" },
    fail: { badge: "badge-fail", dot: "dot-fail", label: "FAIL" },
  } as const;
  const badge = badgeByStatus[result.status];
  const statusBadge = `<span class="badge-pill ${badge.badge}"><span class="dot ${badge.dot}"></span>${badge.label}</span>`;
  const failOk = result.metrics.taskFailRate < 0.05;
  const failBadge =
    `<span class="badge-pill ${failOk ? "badge-pass" : "badge-warn"}">` +
    `<span class="dot ${failOk ? "dot-pass" : "dot-warn"}"></span>${taskFailRate} Fail Rate</span>`;

  // ── Executive summary ──────────────────────────────────────────────────────
  const li = (k: string, vHtml: string) => `<li><span class="k">${esc(k)}</span><span class="v">${vHtml}</span></li>`;
  const trendLi = (k: string, d: TrendDirection) =>
    li(k, `<span class="trend-pill ${d === "flat" ? "flat" : d}">${d}</span>`);

  const quickNumbers = [
    li("Task fail rate", taskFailRate),
    li("Agent fail rate", agentFailRate),
    li("Improve completion", `${num(completed)} / ${num(invoked)} (${completionRate})`),
    li("MI yield rate", miYieldRate),
    li("MI written", num(miWritten)),
    li("Consolidation promoted", num(cons.promoted)),
    li("Consolidation judgedNoAction", num(cons.judgedNoAction)),
    li("Chunk failure", chunkFail),
    li("Median wall time", fmtMs(wallTime.medianMs)),
    li("P95 wall time", fmtMs(wallTime.p95Ms)),
  ].join("");

  const trendRows = [
    trendLi("Decision quality", trend.decisionQuality),
    trendLi("Output volume", trend.outputVolume),
    trendLi("Failures", trend.failures),
    trendLi("Latency", trend.latency),
  ].join("");

  const deltaRows = [
    li("Promoted", deltaPill(deltas, "improve.consolidation.promoted")),
    li("MI written", deltaPill(deltas, "improve.memoryInference.written")),
    li("MI yield", deltaPill(deltas, "improve.memoryInference.yieldRate")),
    li("Median wall", deltaPill(deltas, "improve.wallTime.medianMs", true)),
    li("P95 wall", deltaPill(deltas, "improve.wallTime.p95Ms", true)),
  ].join("");

  const snapRows = latest
    ? [
        li("Run id", `<code>${esc(latest.id.slice(0, 28))}</code>`),
        li("Completed", `${esc((latest.completedAt || latest.startedAt).slice(0, 16).replace("T", " "))} UTC`),
        li("Status", latest.ok ? "✅ ok" : "❌ failed"),
        li("Wall time", fmtMs(latest.wallTimeMs)),
        li("Reflect ok/fail", `${latest.reflectOk} / ${latest.reflectFailed}`),
        li("Promoted", String(latest.promoted)),
        li("judgedNoAction", String(latest.judgedNoAction)),
        li("MI written", String(latest.miWritten)),
        li("Graph entities/relations", `${latest.geEntities} / ${latest.geRelations}`),
      ].join("")
    : '<li><span class="k">No runs in window</span><span class="v">—</span></li>';

  const windowRows = [
    li("Report window", esc(opts.window)),
    li("Compare window", esc(opts.compare)),
    li("Runs", `${num(totalRuns)} (${failedRuns} failed)`),
    li("Stash derived", num(improve.memorySummary.derived)),
    li("Stash eligible", num(improve.memorySummary.eligible)),
    li("Pending proposals", String(proposals.length)),
    li("Semantic search", sem.blocked ? "BLOCKED" : "OK"),
  ].join("");

  const overallEmoji = trend.overall === "improving" ? "📈" : trend.overall === "degrading" ? "📉" : "↔️";
  const execSummary = `
    <h2>${overallEmoji} Executive Summary
        <span class="badge-pill ${badge.badge}" style="font-size:11px;">
        <span class="dot ${badge.dot}"></span>${badge.label}</span></h2>
    <div class="exec-grid">
      <div>
        <h4>Quick Numbers</h4>
        <ul>${quickNumbers}</ul>
      </div>
      <div>
        <h4>Trend vs prior ${esc(opts.compare)}</h4>
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
    <div class="overall">Overall trend: <b>${esc(trend.overall)}</b> ${overallEmoji}
      &nbsp;·&nbsp; based on decision quality, output volume, failures, and latency vs the prior window.</div>`.trim();

  // ── KPI cards ──────────────────────────────────────────────────────────────
  const semValue = sem.blocked ? "BLOCKED" : "OK";
  const semColor = sem.blocked ? "yellow" : "green";
  const semStyle = sem.blocked ? "font-size:18px;" : "";
  const kpiCard = (color: string, label: string, value: string, sub: string, valueStyle = "") =>
    `<div class="kpi-card ${color}">
      <div class="label">${label}</div>
      <div class="value"${valueStyle ? ` style="${valueStyle}"` : ""}>${value}</div>
      <div class="sub">${sub}</div>
    </div>`;
  const kpiCards = [
    kpiCard(
      failedRuns === 0 ? "green" : "yellow",
      "Completion Rate",
      completionRate,
      `${num(completed)} / ${num(invoked)} invoked`,
    ),
    kpiCard(
      failedRuns === 0 ? "green" : "red",
      "Failed Runs",
      String(failedRuns),
      `of ${num(totalRuns)} runs · ${taskFailRate} task fail`,
    ),
    kpiCard("blue", "Total Promoted", num(cons.promoted), `avg ${avgPromoted} / run`),
    kpiCard("blue", "MI Written", num(miWritten), `${miYieldRate} yield rate`),
    kpiCard("purple", "Graph Entities", num(ge.entities), `+${num(ge.relations)} relations`),
    kpiCard(
      "green",
      "Stash Derived",
      num(improve.memorySummary.derived),
      `of ${num(improve.memorySummary.eligible)} eligible`,
    ),
    kpiCard("yellow", "Median Duration", `${medianDurMin}m`, `p95 = ${p95DurMin}m`),
    // #576: real LLM work — total tokens + call count + wall-time, not a GPU proxy.
    kpiCard(
      "purple",
      "🧠 LLM Work",
      num(llm.totalTokens),
      `${num(llm.calls)} calls · ${fmtMs(llm.totalDurationMs)} · ${num(llm.reasoningTokens)} reasoning`,
    ),
    kpiCard(semColor, "Semantic Search", semValue, esc(sem.detail), semStyle),
    kpiCard("yellow", "Pending Proposals", String(proposals.length), `from ${esc(opts.window)} batch`),
  ].join("\n");

  // ── Chart payload ──────────────────────────────────────────────────────────
  const distillReasons = [...new Set(runs.flatMap((r) => Object.keys(r.distillByReason)))].sort();
  const runsJsConst = `const RUNS = ${JSON.stringify(runs)};`;

  // ── Summary table rows ─────────────────────────────────────────────────────
  const summaryRows: Array<[string, string, TrendDirection]> = [
    ["Task fail rate", taskFailRate, "flat"],
    ["Agent fail rate", agentFailRate, "flat"],
    ["Improve completion", `${num(completed)} / ${num(invoked)}`, "flat"],
    ["MI yield rate", miYieldRate, trend.decisionQuality],
    ["MI written", num(miWritten), trend.outputVolume],
    ["Consolidation promoted", num(cons.promoted), trend.outputVolume],
    ["Consolidation merged", num(cons.merged), "flat"],
    ["Consolidation deleted", num(cons.deleted), "flat"],
    ["Consolidation contradicted", num(cons.contradicted), "flat"],
    ["Consolidation judgedNoAction", num(cons.judgedNoAction), "flat"],
    ["Chunk failure", chunkFail, "flat"],
    ["Graph entities", num(ge.entities), "up"],
    ["Graph relations", num(ge.relations), "up"],
    ["Stash derived", num(improve.memorySummary.derived), "up"],
    ["Median wall time", fmtMs(wallTime.medianMs), trend.latency],
    ["P95 wall time", fmtMs(wallTime.p95Ms), trend.latency],
    // #576: real LLM accounting (replaces the GPU-time proxy).
    ["LLM calls", num(llm.calls), "flat"],
    ["LLM total tokens", num(llm.totalTokens), "flat"],
    ["LLM prompt tokens", num(llm.promptTokens), "flat"],
    ["LLM completion tokens", num(llm.completionTokens), "flat"],
    ["LLM reasoning tokens", num(llm.reasoningTokens), "flat"],
    ["LLM wall time", fmtMs(llm.totalDurationMs), trend.latency],
  ];
  const summaryRowsHtml = summaryRows
    .map(
      ([label, value, t]) =>
        `            <tr><td>${esc(label)}</td><td>${esc(value)}</td>` +
        `<td class="trend ${trendClass(t)}">${trendLabel(t)}</td></tr>`,
    )
    .join("\n");

  // ── Advisory cards ─────────────────────────────────────────────────────────
  const advisoryParts: string[] = [];
  for (const a of result.advisories) {
    if (a.status !== "warn" && a.status !== "fail") continue;
    advisoryParts.push(
      advisoryCard(
        a.status === "fail" ? "fail" : "warn",
        a.status === "fail" ? "🔴" : "⚠️",
        esc(a.name),
        esc(a.message),
      ),
    );
  }
  if (sem.blocked) {
    advisoryParts.push(
      advisoryCard(
        "warn",
        "⚠️",
        "Semantic search blocked",
        `Embedding provider unreachable. ${esc(sem.detail)}. Curate falls back to keyword search — relevance scoring degraded.`,
      ),
    );
  }
  if (proposals.length > 0) {
    advisoryParts.push(
      advisoryCard(
        "warn",
        "⚠️",
        `${proposals.length} proposals pending (drain needed)`,
        "Run <code>akm proposal list</code> to review and drain.",
      ),
    );
  }
  if (result.sessionLogAdvisories.length > 0) {
    const patterns = result.sessionLogAdvisories
      .slice(0, 6)
      .map((p) => `<li>${esc(p.topic)}</li>`)
      .join("");
    advisoryParts.push(
      '<div class="advisory" style="border-left:3px solid var(--accent);">' +
        '<div class="advisory-icon">ℹ️</div><div class="advisory-body">' +
        `<div class="title">${result.sessionLogAdvisories.length} session-log note(s) (informational)</div>` +
        `<div class="desc"><ul style="margin:4px 0 0 16px;padding:0;">${patterns}</ul></div></div></div>`,
    );
  }
  const advisoryCardsHtml =
    advisoryParts.length > 0
      ? advisoryParts.join("\n")
      : passCard("No active advisories", "All checks passed for this window.");

  // ── Proposal rows ──────────────────────────────────────────────────────────
  const proposalRowsHtml =
    proposals.length > 0
      ? proposals
          .map((p, i) => {
            const tagCls = p.source === "extract" ? "tag-extract" : "tag-consolidate";
            const ts = p.createdAt.slice(0, 16).replace("T", " ");
            return (
              `<tr><td>${i + 1}</td><td><code>${esc(p.ref)}</code></td>` +
              `<td><span class="tag ${tagCls}">${esc(p.source)}</span></td>` +
              `<td>${esc(ts)}</td></tr>`
            );
          })
          .join("\n")
      : '<tr><td colspan="4" style="text-align:center;color:var(--muted);">No pending proposals</td></tr>';

  // ── What to watch ──────────────────────────────────────────────────────────
  const watchParts: string[] = [];
  for (const a of result.advisories) {
    if (a.status !== "warn" && a.status !== "fail") continue;
    const prio = a.status === "fail" ? "P1" : "P2";
    watchParts.push(
      advisoryCard(
        a.status === "fail" ? "fail" : "warn",
        a.status === "fail" ? "🔴" : "🟡",
        `${esc(a.name)} (${prio})`,
        esc(a.message),
      ),
    );
  }
  if (sem.blocked) {
    watchParts.push(
      advisoryCard(
        "warn",
        "🟡",
        "Embedding server unreachable (P2)",
        "Curate quality and semantic ranking are degraded. Check the embedding endpoint configured in config.json.",
      ),
    );
  }
  if (proposals.length > 0) {
    const bySource = new Map<string, number>();
    for (const p of proposals) bySource.set(p.source, (bySource.get(p.source) ?? 0) + 1);
    const srcSummary = [...bySource.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([source, count]) => `${count} via ${esc(source)}`)
      .join(", ");
    watchParts.push(
      advisoryCard(
        "warn",
        "🟡",
        `Drain ${proposals.length} pending proposals (P2)`,
        `Proposals generated this batch (${srcSummary}). Run <code>akm proposal list</code> before the queue grows further.`,
      ),
    );
  }
  if (wallTime.p95Ms && wallTime.medianMs && wallTime.p95Ms / wallTime.medianMs > 2.5) {
    watchParts.push(
      advisoryCard(
        "warn",
        "🟡",
        `High tail latency (P3): p95=${fmtMs(wallTime.p95Ms)}, median=${fmtMs(wallTime.medianMs)}`,
        "P95 is well above median. Consolidation/LLM phase dominates wall time on slow runs. " +
          "Check for slow chunks or LLM rate limiting.",
      ),
    );
  }
  if (failedRuns > 0) {
    watchParts.push(
      advisoryCard(
        "warn",
        "🟡",
        `${failedRuns} failed run(s) in window (P2)`,
        `Task fail rate ${taskFailRate}. Inspect failed runs (ok=false) for early-exit or harness errors.`,
      ),
    );
  }
  const watchItemsHtml =
    watchParts.length > 0
      ? watchParts.join("\n")
      : passCard("Nothing critical to watch", "All indicators are within normal range.");

  // ── Commands used ──────────────────────────────────────────────────────────
  const commandsHtml = [
    `      <div><span>akm health --since=${esc(opts.window)} --group-by run --format json</span></div>`,
    `      <div><span>akm health --since=${esc(opts.window)} --window-compare=${esc(opts.compare)} --format json</span></div>`,
    "      <div><span>akm proposal list</span></div>",
  ].join("\n");

  return {
    "%%ECHARTS_TAG%%": buildEchartsTag(opts),
    "%%REPORT_TITLE%%": esc(reportTitle),
    "%%WINDOW%%": esc(opts.window),
    "%%SINCE_HUMAN%%": esc(sinceHuman),
    "%%RUN_COUNT%%": num(totalRuns),
    "%%STATUS_BADGE_HTML%%": `${statusBadge}\n    ${failBadge}`,
    "%%EXEC_SUMMARY_HTML%%": execSummary,
    "%%KPI_CARDS_HTML%%": kpiCards,
    "%%RUNS_JS_CONST%%": runsJsConst,
    "%%DISTILL_REASONS_JSON%%": JSON.stringify(distillReasons),
    "%%SUMMARY_ROWS_HTML%%": summaryRowsHtml,
    "%%ADVISORY_CARDS_HTML%%": advisoryCardsHtml,
    "%%PROPOSAL_ROWS_HTML%%": proposalRowsHtml,
    "%%PROPOSAL_COUNT%%": String(proposals.length),
    "%%WATCH_ITEMS_HTML%%": watchItemsHtml,
    "%%COMMANDS_HTML%%": commandsHtml,
    "%%GENERATED_AT%%": esc(generatedAt),
  };
}
