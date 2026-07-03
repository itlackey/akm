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
 * Determinism: nothing here depends on Date.now()/Math.random(). Runs are
 * sorted by startedAt; `%%GENERATED_AT%%` derives from the latest run (or the
 * window anchor), so output is byte-identical for identical inputs.
 */

import fs from "node:fs";
import path from "node:path";
import { escapeHtml } from "../../output/html-render";
import { getDirname } from "../../runtime";
import { pkgVersion } from "../../version";
import type {
  AkmHealthResult,
  DeltaEntry,
  HealthCheckResult,
  ImproveDegradationMetrics,
  ImprovePerfTelemetry,
  ImproveRunSummary,
} from "../health";

/**
 * Distill skip-reasons hidden from the breakdown chart. `no new signal since
 * last proposal` is the steady-state "nothing changed, nothing to do" outcome —
 * it dominates the histogram and drowns out the actionable reasons, so it is
 * intentionally excluded from the chart (the count still lives in the data).
 */
const DISTILL_REASONS_HIDDEN = new Set(["no new signal since last proposal"]);

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

/** Emit a <time> element that the browser's JS will reformat to the viewer's local timezone. */
function isoTimeTag(iso: string): string {
  const fallback = iso.slice(0, 16).replace("T", " ");
  return `<time data-iso="${esc(iso)}">${esc(fallback)}</time>`;
}

function num(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/** Compact token/count formatter, e.g. 127345 → "127K", 1_500_000 → "1.5M". */
function compact(value: number): string {
  const v = Math.round(value);
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(v);
}

/** Humanize a camelCase / kebab / snake enum into reader-facing text. */
function humanize(raw: string): string {
  return raw
    .replace(/[-_]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
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
  taskId: string;
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
    taskId: r.taskId ?? "manual",
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

/** Parse an akm window string (`24h`, `7d`, `30m`, `2w`) to milliseconds; 0 if unparseable. */
function windowToMs(window: string): number {
  const m = /^(\d+)\s*([mhdw])$/i.exec(window.trim());
  if (!m) return 0;
  const n = Number(m[1]);
  const mult =
    { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2].toLowerCase() as "m" | "h" | "d" | "w"] ?? 0;
  return n * mult;
}

/**
 * Build the time-slice `<option>`s for the report's filter bar, DERIVED from the
 * actual report window so the choices always make sense (the old hard-coded
 * 1d–21d list was useless on a 24h or 7d report). "All" is the default; the
 * sub-window options carry their cutoff in milliseconds (consumed by
 * filteredRuns), largest first, only those strictly shorter than the window.
 */
function buildSliceOptions(window: string): string {
  const windowMs = windowToMs(window);
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  const candidates: Array<[number, string]> = [
    [6 * HOUR, "6h"],
    [12 * HOUR, "12h"],
    [DAY, "1d"],
    [3 * DAY, "3d"],
    [7 * DAY, "7d"],
    [14 * DAY, "14d"],
  ];
  const subs = candidates
    .filter(([ms]) => windowMs > 0 && ms < windowMs)
    .sort((a, b) => b[0] - a[0])
    .slice(0, 4);
  const opts = [`<option value="all" selected>All (${esc(window)})</option>`];
  for (const [ms, label] of subs) opts.push(`<option value="${ms}">Last ${label}</option>`);
  return opts.join("\n      ");
}

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
 * fragments, matching the skill template. Advisories and "what to watch" are
 * merged + de-duplicated into a single prioritized `%%ACTION_ITEMS_HTML%%`.
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
  // WS-5: perf telemetry, coverage, and degradation metrics.
  const perf: ImprovePerfTelemetry = improve.perfTelemetry ?? {
    dedupPoolSize: 0,
    llmPoolSize: 0,
    judgedCacheSkipped: 0,
    embedMs: 0,
    embedCacheHits: 0,
    embedCacheMisses: 0,
    overBudgetRuns: 0,
    runsWithTelemetry: 0,
  };
  const coverage = improve.coverage;
  const degradation: ImproveDegradationMetrics | undefined = improve.degradation;
  const minting = improve.enrichmentMinting;
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
  const sinceHuman = sinceIso ? `${isoTimeTag(sinceIso)} → now` : `last ${esc(opts.window)}`;
  const reportTitle = reportDate ? `AKM Health Report — ${reportDate}` : "AKM Health Report";
  const lastRun = runs[runs.length - 1];
  const generatedAt = lastRun ? lastRun.completedAt || lastRun.startedAt || sinceIso : sinceIso;
  const latest = [...runs].reverse().find((r) => r.ok) ?? lastRun;
  // Freshness: surface the newest run's timestamp + the generated-at anchor in
  // the exec card. Staleness is computed deterministically (no Date.now()) from
  // the gap between the window start (`since`) and the newest run we have: if no
  // run landed in the window, or the newest run sits in the first 25% of a
  // window wider than the 6h threshold (i.e. a long idle tail), we flag stale.
  const STALE_MS = 6 * 60 * 60 * 1000;
  const latestRunMs = lastRun ? Date.parse(lastRun.completedAt || lastRun.startedAt) : NaN;
  const sinceMs = Date.parse(sinceIso);
  const generatedMs = Date.parse(generatedAt);
  const idleTailMs =
    Number.isFinite(latestRunMs) && Number.isFinite(generatedMs) ? Math.max(0, generatedMs - latestRunMs) : 0;
  const isStale =
    totalRuns === 0 || (Number.isFinite(latestRunMs) && Number.isFinite(sinceMs) && idleTailMs > STALE_MS);
  const latestRunHuman = lastRun ? isoTimeTag(lastRun.completedAt || lastRun.startedAt) : "—";

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
    li(
      "Consolidation judged: no action",
      `<abbr title="Candidates the consolidator reviewed but intentionally left unchanged (the 'judgedNoAction' field).">${num(cons.judgedNoAction)}</abbr>`,
    ),
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
        li("Completed", isoTimeTag(latest.completedAt || latest.startedAt)),
        li("Status", latest.ok ? "✅ ok" : "❌ failed"),
        li("Wall time", fmtMs(latest.wallTimeMs)),
        li("Reflect ok/fail", `${latest.reflectOk} / ${latest.reflectFailed}`),
        li("Promoted", String(latest.promoted)),
        li(
          "Judged: no action",
          `<abbr title="Candidates reviewed but intentionally left unchanged on this run.">${latest.judgedNoAction}</abbr>`,
        ),
        li("MI written", String(latest.miWritten)),
        li("Graph entities/relations", `${latest.geEntities} / ${latest.geRelations}`),
      ].join("")
    : '<li><span class="k">No runs in window</span><span class="v">—</span></li>';

  const windowRows = [
    li("Report window", esc(opts.window)),
    li("Compare window", esc(opts.compare)),
    li("Runs", `${num(totalRuns)} (${failedRuns} failed)`),
    li(
      "Stash derived",
      `<abbr title="Whole-stash recount of derived assets at report time — not a per-run sum.">${num(improve.memorySummary.derived)}</abbr>`,
    ),
    li(
      "Stash eligible",
      `<abbr title="Whole-stash recount of eligible assets at report time — not a per-run sum.">${num(improve.memorySummary.eligible)}</abbr>`,
    ),
    li("Pending proposals", String(proposals.length)),
    li("Semantic search", sem.blocked ? "BLOCKED" : "OK"),
  ].join("");

  const overallEmoji = trend.overall === "improving" ? "📈" : trend.overall === "degrading" ? "📉" : "↔️";

  // ── Synthesized verdict (one sentence + 2-3 drivers) ───────────────────────
  // The verdict WORD is the authoritative health status (hard checks). Concerns
  // (failed improve runs, blocked search, pending proposals) are advisory and do
  // NOT gate that word, so we must not pair a green PASS with red "drivers" as
  // if they were failures. When the status is PASS we frame concerns as "watch:"
  // alongside the trend; only a degraded status (WARN/FAIL) leads with them.
  const concerns: string[] = [];
  if (failedRuns > 0) concerns.push(`${failedRuns} failed run${failedRuns === 1 ? "" : "s"}`);
  if (sem.blocked) concerns.push("semantic search blocked");
  if (proposals.length > 0) concerns.push(`${proposals.length} pending proposal${proposals.length === 1 ? "" : "s"}`);
  const trendClause =
    trend.overall === "improving"
      ? "throughput and latency improving"
      : trend.overall === "degrading"
        ? "throughput or latency degrading"
        : "throughput and latency steady";
  const verdictWord = badge.label;
  let verdictRest: string;
  if (result.status === "pass") {
    const watch = concerns.length > 0 ? `; watch: ${concerns.slice(0, 3).join(", ")}` : "";
    verdictRest = `healthy, ${trendClause}${watch}`;
  } else {
    const lead = concerns.length > 0 ? concerns.slice(0, 3).join("; ") : trendClause;
    verdictRest = trend.overall === "degrading" && concerns.length > 0 ? `${lead}; ${trendClause}` : lead;
  }
  const verdictSentence = `${verdictWord} — ${esc(verdictRest)}.`;
  const verdictHtml = `<div class="verdict ${result.status}"><b>Verdict:</b> ${verdictSentence}</div>`;

  // ── Freshness line ─────────────────────────────────────────────────────────
  const freshnessHtml = `<div class="freshness${isStale ? " stale" : ""}">${
    isStale ? "⚠️ Stale: " : ""
  }Latest run ${latestRunHuman} &nbsp;·&nbsp; generated ${isoTimeTag(generatedAt)}${
    isStale ? " — no recent activity (newest run older than the 6h freshness threshold)." : "."
  }</div>`;

  const execSummary = `
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
  // Color is a health SIGNAL, not decoration: green/yellow/red where a card has
  // a meaningful threshold; "neutral" for purely-informational counts. Cards are
  // ordered by operator priority (failures first, informational counts last).
  const semValue = sem.blocked ? "BLOCKED" : "OK";
  const semColor = sem.blocked ? "red" : "green";
  const semStyle = sem.blocked ? "font-size:18px;" : "";
  const completionPct = invoked ? (100 * completed) / invoked : 100;
  const completionColor = completionPct >= 99 ? "green" : completionPct >= 90 ? "yellow" : "red";
  const llmTokensCompact = compact(llm.totalTokens);
  const kpiCard = (color: string, label: string, value: string, sub: string, valueStyle = "") =>
    `<div class="kpi-card ${color}">
      <div class="label">${label}</div>
      <div class="value"${valueStyle ? ` style="${valueStyle}"` : ""}>${value}</div>
      <div class="sub">${sub}</div>
    </div>`;
  const kpiCards = [
    kpiCard(
      failedRuns === 0 ? "green" : "red",
      "Failed Runs",
      String(failedRuns),
      `of ${num(totalRuns)} runs · ${taskFailRate} task fail`,
    ),
    kpiCard(completionColor, "Completion Rate", completionRate, `${num(completed)} / ${num(invoked)} invoked`),
    kpiCard("neutral", "Median Duration", `${medianDurMin}m`, `p95 = ${p95DurMin}m`),
    kpiCard("blue", "Total Promoted", num(cons.promoted), `avg ${avgPromoted} / run`),
    kpiCard("blue", "MI Written", num(miWritten), `${miYieldRate} yield rate`),
    kpiCard("purple", "Graph Entities", num(ge.entities), `+${num(ge.relations)} relations`),
    kpiCard(
      "neutral",
      "Stash Derived",
      num(improve.memorySummary.derived),
      `of ${num(improve.memorySummary.eligible)} eligible (whole-stash)`,
    ),
    // #576: real LLM work — duration leads, tokens compact, not a GPU proxy.
    kpiCard(
      llm.calls > 0 ? "purple" : "neutral",
      "🧠 LLM Work",
      `${llmTokensCompact} tok`,
      `${fmtMs(llm.totalDurationMs)} · ${num(llm.calls)} calls · ${compact(llm.reasoningTokens)} reasoning`,
    ),
    kpiCard(semColor, "Semantic Search", semValue, esc(sem.detail), semStyle),
    kpiCard(
      proposals.length > 0 ? "yellow" : "neutral",
      "Pending Proposals",
      String(proposals.length),
      `from ${esc(opts.window)} batch`,
    ),
  ].join("\n");

  // ── Chart payload ──────────────────────────────────────────────────────────
  const distillReasons = [...new Set(runs.flatMap((r) => Object.keys(r.distillByReason)))]
    .filter((reason) => !DISTILL_REASONS_HIDDEN.has(reason))
    .sort();
  const runsJsConst = `const RUNS = ${JSON.stringify(runs)};`;

  // ── Summary table rows ─────────────────────────────────────────────────────
  // Optional 4th element = a glossary tooltip rendered as <abbr title>.
  const summaryRows: Array<[string, string, TrendDirection, string?]> = [
    ["Task fail rate", taskFailRate, "flat"],
    ["Agent fail rate", agentFailRate, "flat"],
    ["Improve completion", `${num(completed)} / ${num(invoked)}`, "flat"],
    [
      "MI yield rate",
      miYieldRate,
      trend.decisionQuality,
      "Memory-inference yield: share of considered candidates that produced a written fact.",
    ],
    ["MI written", num(miWritten), trend.outputVolume, "Memory-inference: facts written this window."],
    ["Consolidation promoted", num(cons.promoted), trend.outputVolume],
    ["Consolidation merged", num(cons.merged), "flat"],
    ["Consolidation deleted", num(cons.deleted), "flat"],
    ["Consolidation contradicted", num(cons.contradicted), "flat"],
    [
      "Consolidation judged: no action",
      num(cons.judgedNoAction),
      "flat",
      "Candidates reviewed but intentionally left unchanged (the 'judgedNoAction' field).",
    ],
    ["Chunk failure", chunkFail, "flat"],
    ["Graph entities", num(ge.entities), "up"],
    ["Graph relations", num(ge.relations), "up"],
    [
      "Stash derived",
      num(improve.memorySummary.derived),
      "up",
      "Whole-stash recount of derived assets at report time — not a per-run sum.",
    ],
    ["Median wall time", fmtMs(wallTime.medianMs), trend.latency],
    ["P95 wall time", fmtMs(wallTime.p95Ms), trend.latency],
    // #576: real LLM accounting (replaces the GPU-time proxy).
    ["LLM calls", num(llm.calls), "flat"],
    ["LLM total tokens", num(llm.totalTokens), "flat"],
    ["LLM prompt tokens", num(llm.promptTokens), "flat"],
    ["LLM completion tokens", num(llm.completionTokens), "flat"],
    [
      "LLM reasoning tokens",
      num(llm.reasoningTokens),
      "flat",
      "Tokens spent on model reasoning/thinking, billed separately from prompt and completion.",
    ],
    ["LLM wall time", fmtMs(llm.totalDurationMs), trend.latency],
  ];

  // #612 — auto-accept gate calibration. Only surface when the gate actually
  // acted on proposals in the window (samples > 0); a default ungated install
  // reports an empty summary and we omit the rows to keep the table parity-clean.
  const calibration = improve.calibration;
  if (calibration && calibration.samples > 0) {
    summaryRows.push(
      [
        "Calibration samples",
        num(calibration.samples),
        "flat",
        "Auto-accept gate decisions (auto-accepted + auto-rejected) the calibration join measured this window.",
      ],
      [
        "Calibration accept rate",
        String(calibration.overallAcceptRate),
        "flat",
        "Realized accept rate of acted-on gate decisions (auto-accepted / total acted-on).",
      ],
      [
        "Calibration gap",
        String(calibration.calibrationGap),
        "flat",
        "Mean predicted confidence minus realized accept rate. Positive = the gate is over-confident.",
      ],
    );
  }
  // WS-5: denominator-fixed coverage rows (only when we have real data).
  if (coverage && !Number.isNaN(coverage.rate)) {
    summaryRows.push(
      [
        "Coverage rate",
        pct(coverage.rate, 1),
        "flat",
        "Distinct accepted refs / total stash assets (denominator-fixed). Shows what fraction of the corpus has been touched.",
      ],
      [
        "Eligible fraction",
        pct(coverage.eligibleFraction, 1),
        "flat",
        "Eligible assets / total stash assets. Fraction the improve pipeline actively considers.",
      ],
      [
        "Coverage accepted",
        num(coverage.acceptedProposals),
        "flat",
        "Total accepted proposals in the window (raw volume — includes repeated rewrites of the same asset).",
      ],
      [
        "Churn ratio",
        Number.isFinite(coverage.churnRatio) ? num(coverage.churnRatio) : "—",
        Number.isFinite(coverage.churnRatio) && coverage.churnRatio > 1.5 ? "down" : "flat",
        "Accepted proposals / distinct refs touched. >1.5 = the loop is repeatedly rewriting the same assets (churn, not coverage).",
      ],
    );
  }

  // Enrichment-vs-minting policy rollup (reporting-only).
  if (minting && Number.isFinite(minting.share)) {
    summaryRows.push([
      "Enrichment-lane minted share",
      pct(minting.share, 1),
      minting.share > 0.05 ? "down" : "flat",
      `New assets minted by enrichment lanes / their accepted total (${minting.minted} minted vs ${minting.updated} updated). Enrichment lanes are ratified to edit existing assets only; WARN >5%, FAIL >15%.`,
    ]);
  }

  // WS-5: perf telemetry rows (only when at least one run reported telemetry).
  if (perf.runsWithTelemetry > 0) {
    const embedCacheTotal = perf.embedCacheHits + perf.embedCacheMisses;
    const embedCacheHitRate = embedCacheTotal > 0 ? pct(perf.embedCacheHits / embedCacheTotal, 1) : "—";
    summaryRows.push(
      [
        "Embed cache hit rate",
        embedCacheHitRate,
        "flat",
        "Fraction of embedding lookups served from cache (>95% is healthy). Aggregated across WS-5 runs.",
      ],
      [
        "Embed wall time",
        fmtMs(perf.embedMs),
        "flat",
        "Cumulative embedding wall-clock time across consolidation runs in the window.",
      ],
      [
        "Judged-cache skipped",
        num(perf.judgedCacheSkipped),
        "flat",
        "Candidates skipped by the judged-cache (not sent to LLM). Higher = more efficient reuse of prior judgments.",
      ],
      [
        "Dedup pool size",
        num(perf.dedupPoolSize),
        "flat",
        "Average memory pool size after deduplication (before judged-cache narrowing). WS-5 perf telemetry.",
      ],
      [
        "Over-budget consolidation runs",
        String(perf.overBudgetRuns),
        perf.overBudgetRuns > 0 ? "down" : "flat",
        "Runs where consolidation alone exceeded the total run budget (estimatedBudgetFractionUsed > 1.0).",
      ],
    );
  }

  // WS-5: degradation metrics rows.
  if (degradation) {
    summaryRows.push(
      [
        "Corpus diversity (Gini)",
        num(degradation.corpusCentroidDistance),
        degradation.entrenchmentFlagged || degradation.salienceUniformityFlagged ? "down" : "flat",
        "Gini coefficient of retrieval_salience for top-100 ranked assets. Two-tailed: >0.35 = entrenchment risk; <0.08 = collapsed toward uniform (ranking no longer discriminates).",
      ],
      [
        "Merge fidelity contradiction rate",
        pct(degradation.mergeFidelityContradictionRate, 1),
        "flat",
        "Fraction of consolidated proposals that involved a contradiction, from consolidation result envelopes.",
      ],
    );
  }

  const summaryRowsHtml = summaryRows
    .map(([label, value, t, tip]) => {
      const labelHtml = tip ? `<abbr title="${esc(tip)}">${esc(label)}</abbr>` : esc(label);
      return (
        `            <tr><td>${labelHtml}</td><td>${esc(value)}</td>` +
        `<td class="trend ${trendClass(t)}">${trendLabel(t)}</td></tr>`
      );
    })
    .join("\n");

  // ── Action Items (merged + de-duplicated advisories + what-to-watch) ────────
  // Advisories and the old "what to watch" cards were built from the same data
  // (result.advisories, sem-blocked, proposals, tail-latency, failed-runs). We
  // collapse them into ONE prioritized, de-duplicated list (P1/P2/P3 + a
  // remediation command per item), keyed so each concern appears exactly once.
  const items: ActionItem[] = [];
  const seen = new Set<string>();
  const pushItem = (item: ActionItem) => {
    if (seen.has(item.key)) return;
    seen.add(item.key);
    items.push(item);
  };

  // Hard advisories from the health check engine (own remediation in message).
  for (const a of result.advisories) {
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
  if (failedRuns > 0) {
    pushItem({
      key: "failed-runs",
      prio: "P1",
      cls: "fail",
      title: `${failedRuns} failed run${failedRuns === 1 ? "" : "s"} in window`,
      descHtml: `Task fail rate ${esc(taskFailRate)}. Inspect failed runs (ok=false) for early-exit or harness errors.`,
      remedy: `akm health --since=${opts.window} --group-by run`,
    });
  }

  // Semantic search blocked.
  if (sem.blocked) {
    pushItem({
      key: "semantic-search-blocked",
      prio: "P2",
      cls: "warn",
      title: "Semantic search blocked",
      descHtml: `Embedding provider unreachable. ${esc(sem.detail)}. Curate falls back to keyword search — relevance scoring degraded.`,
      remedy: "akm config show",
    });
  }

  // Pending proposals to drain.
  if (proposals.length > 0) {
    const bySource = new Map<string, number>();
    for (const p of proposals) bySource.set(p.source, (bySource.get(p.source) ?? 0) + 1);
    const srcSummary = [...bySource.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([source, count]) => `${count} via ${esc(source)}`)
      .join(", ");
    pushItem({
      key: "drain-proposals",
      prio: "P2",
      cls: "warn",
      title: `Drain ${proposals.length} pending proposal${proposals.length === 1 ? "" : "s"}`,
      descHtml: `Proposals generated this batch (${srcSummary}). Review before the queue grows further.`,
      remedy: "akm proposal list",
    });
  }

  // High tail latency.
  if (wallTime.p95Ms && wallTime.medianMs && wallTime.p95Ms / wallTime.medianMs > 2.5) {
    pushItem({
      key: "tail-latency",
      prio: "P3",
      cls: "warn",
      title: `High tail latency: p95=${fmtMs(wallTime.p95Ms)}, median=${fmtMs(wallTime.medianMs)}`,
      descHtml:
        "P95 is well above median. Consolidation/LLM phase dominates wall time on slow runs. " +
        "Check for slow chunks or LLM rate limiting.",
    });
  }

  // Stale freshness.
  if (isStale && totalRuns > 0) {
    pushItem({
      key: "stale",
      prio: "P3",
      cls: "warn",
      title: "No recent improve runs",
      descHtml: `Newest run is ${esc(latestRunHuman)} — older than the 6h freshness threshold. Check the improve scheduler/cron.`,
    });
  }

  // WS-5: corpus entrenchment flag.
  if (degradation?.entrenchmentFlagged) {
    pushItem({
      key: "corpus-entrenchment",
      prio: "P2",
      cls: "warn",
      title: "Corpus entrenchment risk: retrieval_salience Gini > 0.35",
      descHtml:
        "A small set of assets dominates retrieval — retrieval diversity is low. " +
        "Review top-ranked assets for stale or over-represented content. " +
        `Corpus diversity proxy: ${esc(String(degradation.corpusCentroidDistance))}.`,
      remedy: "akm health --format json | jq '.improve.degradation'",
    });
  }

  // Low-tail companion: salience distribution collapsed toward uniform.
  if (degradation?.salienceUniformityFlagged) {
    pushItem({
      key: "salience-uniformity-collapse",
      prio: "P2",
      cls: "warn",
      title: "Salience distribution collapsed: retrieval_salience Gini < 0.08",
      descHtml:
        "The top-100 salience scores are near-uniform (uniform baseline ≈ 0.1) — " +
        "ranking currently carries little to no discrimination between assets. " +
        `Corpus diversity proxy: ${esc(String(degradation.corpusCentroidDistance))}.`,
      remedy: "akm health --format json | jq '.improve.degradation'",
    });
  }

  // WS-5: over-budget consolidation advisory.
  if (perf.overBudgetRuns > 0) {
    pushItem({
      key: "over-budget-consolidation",
      prio: "P2",
      cls: "warn",
      title: `${perf.overBudgetRuns} consolidation run${perf.overBudgetRuns === 1 ? "" : "s"} exceeded budget`,
      descHtml:
        "Consolidation phase wall time exceeded the total run budget on these runs. " +
        "Consider increasing the timeout or reducing the consolidation pool via profile config.",
      remedy: "akm config show",
    });
  }

  // Session-log notes (informational, lowest priority).
  if (result.sessionLogAdvisories.length > 0) {
    const patterns = result.sessionLogAdvisories
      .slice(0, 6)
      .map((p) => `<li>${esc(p.topic)}</li>`)
      .join("");
    pushItem({
      key: "session-log-notes",
      prio: "P3",
      cls: "warn",
      title: `${result.sessionLogAdvisories.length} session-log note(s) (informational)`,
      descHtml: `<ul style="margin:4px 0 0 16px;padding:0;">${patterns}</ul>`,
    });
  }

  items.sort((a, b) => PRIO_RANK[a.prio] - PRIO_RANK[b.prio]);
  const actionItemsHtml =
    items.length > 0
      ? items.map(actionItemCard).join("\n")
      : passCard("No action items", "All checks passed and nothing needs attention for this window.");

  // ── Proposal rows ──────────────────────────────────────────────────────────
  const proposalRowsHtml =
    proposals.length > 0
      ? proposals
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

  return {
    "%%ECHARTS_TAG%%": buildEchartsTag(opts),
    "%%REPORT_TITLE%%": esc(reportTitle),
    "%%WINDOW%%": esc(opts.window),
    "%%SINCE_HUMAN%%": sinceHuman,
    "%%RUN_COUNT%%": num(totalRuns),
    "%%STATUS_BADGE_HTML%%": `${statusBadge}\n    ${failBadge}`,
    "%%EXEC_SUMMARY_HTML%%": execSummary,
    "%%KPI_CARDS_HTML%%": kpiCards,
    "%%RUNS_JS_CONST%%": runsJsConst,
    "%%DISTILL_REASONS_JSON%%": JSON.stringify(distillReasons),
    "%%SLICE_OPTIONS_HTML%%": buildSliceOptions(opts.window),
    "%%LLM_BY_STAGE_JSON%%": JSON.stringify(llm.byStage ?? {}),
    "%%SUMMARY_ROWS_HTML%%": summaryRowsHtml,
    "%%ACTION_ITEMS_HTML%%": actionItemsHtml,
    "%%PROPOSAL_ROWS_HTML%%": proposalRowsHtml,
    "%%PROPOSAL_COUNT%%": String(proposals.length),
    "%%GENERATED_AT%%": esc(generatedAt),
    "%%AKM_VERSION%%": esc(pkgVersion),
  };
}
