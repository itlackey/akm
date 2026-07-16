// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure `AkmHealthResult` (+ report options) → `HealthReportViewModel`
 * extractor for the health HTML report (chunk-9 WI-9.5a / H2, anchors C.6).
 *
 * Every computed number, string, boolean, and series the report shows is
 * derived here — deltas, trends, staleness, rate/duration formatting, the
 * synthesized verdict components, the summary-table rows, the action-item
 * inputs. NOTHING in this module emits HTML: `html-report.ts` holds the thin
 * VM→HTML fragment renderers that consume this shape (`buildEchartsTag`,
 * `isoTimeTag`, the `<li>`/card builders, …).
 *
 * Determinism: nothing here depends on Date.now()/Math.random(). Runs are
 * sorted by startedAt so the view model — and therefore the rendered report —
 * is byte-identical for identical inputs.
 */

import {
  type AkmHealthResult,
  type DeltaEntry,
  type HealthCheckResult,
  type ImproveDegradationMetrics,
  type ImprovePerfTelemetry,
  type ImproveRunSummary,
  TASK_FAIL_RATE_WARN,
} from "./types";

/** Distill skip-reasons hidden from the breakdown chart (steady-state noise). */
const DISTILL_REASONS_HIDDEN = new Set(["no new signal since last proposal"]);

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
}

// ── Small pure formatters (ports of render.py helpers; no HTML) ─────────────

export function num(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/** Compact token/count formatter, e.g. 127345 → "127K", 1_500_000 → "1.5M". */
export function compact(value: number): string {
  const v = Math.round(value);
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(v);
}

/** Humanize a camelCase / kebab / snake enum into reader-facing text. */
export function humanize(raw: string): string {
  return raw
    .replace(/[-_]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

export function fmtMs(ms: number): string {
  return ms ? `${(ms / 60000).toFixed(1)}m` : "—";
}

export function pct(rate: number, digits: number): string {
  return `${(rate * 100).toFixed(digits)}%`;
}

export type TrendDirection = "up" | "down" | "flat";

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

export interface ReportRun {
  id: string;
  resultStatus: "valid" | "normalized" | "invalid";
  resultComplete: boolean;
  taskId: string;
  strategy: string | null;
  legacyProfile: string | null;
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
    resultStatus: r.resultStatus ?? "valid",
    resultComplete: r.resultComplete ?? (r.resultStatus === undefined || r.resultStatus === "valid"),
    taskId: r.taskId ?? "manual",
    strategy: r.strategy,
    legacyProfile: r.legacyProfile,
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

function compareRuns(a: ReportRun, b: ReportRun): number {
  return (
    a.startedAt.localeCompare(b.startedAt) || a.completedAt.localeCompare(b.completedAt) || a.id.localeCompare(b.id)
  );
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

export interface TrendBlock {
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

// ── Semantic-search status ───────────────────────────────────────────────────

export interface SemSearchStatus {
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

// ── Report-window → time-slice candidates (data only; HTML wrapping is the
//    renderer's job) ─────────────────────────────────────────────────────────

/** Parse an akm window string (`24h`, `7d`, `30m`, `2w`) to milliseconds; 0 if unparseable. */
export function windowToMs(window: string): number {
  const m = /^(\d+)\s*([mhdw])$/i.exec(window.trim());
  if (!m) return 0;
  const n = Number(m[1]);
  const mult =
    { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2].toLowerCase() as "m" | "h" | "d" | "w"] ?? 0;
  return n * mult;
}

/**
 * Candidate sub-window slices strictly shorter than the report window,
 * largest-first, capped at 4 — the data half of the filter bar's `<option>`s
 * (the "All" option and the `<option>` tags themselves are the renderer's job).
 */
function computeSliceCandidates(window: string): Array<[number, string]> {
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
  return candidates
    .filter(([ms]) => windowMs > 0 && ms < windowMs)
    .sort((a, b) => b[0] - a[0])
    .slice(0, 4);
}

// ── Summary-table rows (plain data tuples; HTML escaping happens at render) ──

/** Optional 4th element = a glossary tooltip rendered as `<abbr title>` by the renderer. */
export type SummaryRow = [label: string, value: string, trend: TrendDirection, tooltip?: string];

// ── The view model ───────────────────────────────────────────────────────────

/**
 * Every computed number/string/boolean/series the health HTML report shows,
 * with zero HTML. See `html-report.ts` for the renderers that turn this into
 * markup, and `buildHealthHtmlReplacements` for the extract-then-render glue.
 */
export interface HealthReportViewModel {
  // Window / meta
  window: string;
  compare: string;
  sinceIso: string;
  reportDate: string;
  reportTitle: string;
  generatedAt: string;
  isStale: boolean;

  // Runs
  runs: ReportRun[];
  invalidRuns: ReportRun[];
  lastRun: ReportRun | undefined;
  /** Most recent run with a complete result envelope. */
  latest: ReportRun | undefined;
  totalRuns: number;
  failedRuns: number;

  // Status
  status: AkmHealthResult["status"];
  failOk: boolean;
  /** PASS/WARN/FAIL — the authoritative status word (hard checks). */
  statusLabel: string;

  // Improve aggregates (defaults already applied, matching the pre-split code)
  consolidation: AkmHealthResult["improve"]["consolidation"];
  memoryInference: AkmHealthResult["improve"]["memoryInference"];
  graphExtraction: AkmHealthResult["improve"]["graphExtraction"];
  wallTime: AkmHealthResult["improve"]["wallTime"];
  perf: ImprovePerfTelemetry;
  coverage: AkmHealthResult["improve"]["coverage"];
  degradation: ImproveDegradationMetrics | undefined;
  minting: AkmHealthResult["improve"]["enrichmentMinting"];
  llm: AkmHealthResult["metrics"]["llmUsage"];
  memorySummary: AkmHealthResult["improve"]["memorySummary"];
  includedResultRows: number;
  normalizedResultRows: number;
  skippedInvalidResultRows: number;
  invoked: number;
  completed: number;
  miWritten: number;

  // Formatted rate/duration strings (plain text, no markup)
  completionRate: string;
  completionPct: number;
  taskFailRate: string;
  agentFailRate: string;
  miYieldRate: string;
  medianDurMin: string;
  p95DurMin: string;
  avgPromoted: string;
  chunkFail: string;
  llmTokensCompact: string;

  // Trend / deltas
  trend: TrendBlock;
  deltas: Record<string, DeltaEntry>;

  // Semantic search
  sem: SemSearchStatus;

  // Proposals
  proposals: PendingProposalLike[];
  /** proposals grouped by `source`, sorted alphabetically. */
  proposalsBySource: Array<[string, number]>;

  // Synthesized-verdict components (plain text; the renderer wraps them in HTML)
  concerns: string[];
  trendClause: string;
  verdictWord: string;
  verdictRest: string;

  // Summary table
  summaryRows: SummaryRow[];

  // Time-slice filter-bar candidates
  sliceCandidates: Array<[number, string]>;

  // Distill skip-reason chart categories
  distillReasons: string[];

  // Action-item inputs (pass-through; already plain data on AkmHealthResult)
  advisories: HealthCheckResult[];
  sessionLogAdvisories: AkmHealthResult["sessionLogAdvisories"];
}

// ── buildHealthReportViewModel phase helpers (each is a cohesive slice of the
// extractor; the glue function at the bottom composes them in the same order
// the pre-split code computed them) ──────────────────────────────────────────

interface RunsPhase {
  runs: ReportRun[];
  invalidRuns: ReportRun[];
}

function partitionRuns(result: AkmHealthResult): RunsPhase {
  const allRuns = (result.runs ?? []).map(reshapeRun).sort(compareRuns);
  return {
    invalidRuns: allRuns.filter((run) => run.resultStatus === "invalid"),
    runs: allRuns.filter((run) => run.resultStatus !== "invalid"),
  };
}

type AggregatesPhase = Pick<
  HealthReportViewModel,
  | "consolidation"
  | "memoryInference"
  | "graphExtraction"
  | "wallTime"
  | "perf"
  | "coverage"
  | "degradation"
  | "minting"
  | "llm"
  | "memorySummary"
  | "includedResultRows"
  | "normalizedResultRows"
  | "skippedInvalidResultRows"
  | "invoked"
  | "completed"
  | "miWritten"
  | "completionRate"
  | "completionPct"
  | "taskFailRate"
  | "agentFailRate"
  | "miYieldRate"
  | "medianDurMin"
  | "p95DurMin"
  | "avgPromoted"
  | "chunkFail"
  | "llmTokensCompact"
  | "totalRuns"
  | "failedRuns"
>;

/** Aggregates (collect.py step 6) + the WS-5 sub-rollups + their formatted-rate strings. */
function buildAggregatesPhase(result: AkmHealthResult, runsPhase: RunsPhase): AggregatesPhase {
  const { runs, invalidRuns } = runsPhase;
  const improve = result.improve;
  const cons = improve.consolidation;
  const mi = improve.memoryInference;
  const ge = improve.graphExtraction;
  const wallTime = improve.wallTime;
  // WS-5: perf telemetry, coverage, and degradation metrics.
  const perf: ImprovePerfTelemetry = improve.perfTelemetry ?? {
    dedupPoolSize: 0,
    llmPoolSize: 0,
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
    byProcess: {},
    byEngine: {},
  };
  const totalRuns = runs.length;
  const failedRuns = runs.filter((r) => !r.ok).length;
  const invoked = improve.invoked || totalRuns;
  const completed = improve.completed || totalRuns - failedRuns;
  const miWritten = mi.written || mi.writes || 0;

  return {
    consolidation: cons,
    memoryInference: mi,
    graphExtraction: ge,
    wallTime,
    perf,
    coverage,
    degradation,
    minting,
    llm,
    memorySummary: improve.memorySummary,
    includedResultRows: improve.resultRows?.included ?? totalRuns,
    normalizedResultRows: improve.resultRows?.normalized ?? 0,
    skippedInvalidResultRows: improve.resultRows?.skipped.invalid ?? invalidRuns.length,
    invoked,
    completed,
    miWritten,
    completionRate: invoked ? `${Math.round((100 * completed) / invoked)}%` : "0%",
    completionPct: invoked ? (100 * completed) / invoked : 100,
    taskFailRate: pct(result.metrics.taskFailRate, 1),
    agentFailRate: pct(result.metrics.agentFailureRate, 2),
    miYieldRate: pct(mi.yieldRate, 1),
    medianDurMin: (wallTime.medianMs / 60000).toFixed(1),
    p95DurMin: (wallTime.p95Ms / 60000).toFixed(1),
    avgPromoted: totalRuns ? String(Math.round(cons.promoted / totalRuns)) : "0",
    chunkFail: `${num(cons.failedChunks)} / ${num(cons.totalChunks)}`,
    llmTokensCompact: compact(llm.totalTokens),
    totalRuns,
    failedRuns,
  };
}

type MetaPhase = Pick<
  HealthReportViewModel,
  "sinceIso" | "reportDate" | "reportTitle" | "generatedAt" | "isStale" | "lastRun" | "latest"
>;

/**
 * Meta (collect.py steps 10-11) + freshness. Staleness is computed
 * deterministically (no Date.now()) from the gap between the window start
 * (`since`) and the newest run we have: if no run landed in the window, or
 * the newest run sits in the first 25% of a window wider than the 6h
 * threshold (i.e. a long idle tail), we flag stale.
 */
function buildMetaPhase(result: AkmHealthResult, runs: ReportRun[]): MetaPhase {
  const sinceIso = result.since;
  const reportDate = sinceIso.slice(0, 10);
  const reportTitle = reportDate ? `AKM Health Report — ${reportDate}` : "AKM Health Report";
  const lastRun = runs[runs.length - 1];
  const generatedAt = lastRun ? lastRun.completedAt || lastRun.startedAt || sinceIso : sinceIso;
  const latest = [...runs]
    .filter((run) => run.resultComplete)
    .sort(compareRuns)
    .at(-1);
  const STALE_MS = 6 * 60 * 60 * 1000;
  const latestRunMs = lastRun ? Date.parse(lastRun.completedAt || lastRun.startedAt) : NaN;
  const sinceMs = Date.parse(sinceIso);
  const generatedMs = Date.parse(generatedAt);
  const idleTailMs =
    Number.isFinite(latestRunMs) && Number.isFinite(generatedMs) ? Math.max(0, generatedMs - latestRunMs) : 0;
  const isStale =
    runs.length === 0 || (Number.isFinite(latestRunMs) && Number.isFinite(sinceMs) && idleTailMs > STALE_MS);
  return { sinceIso, reportDate, reportTitle, generatedAt, isStale, lastRun, latest };
}

type VerdictPhase = Pick<
  HealthReportViewModel,
  "status" | "failOk" | "statusLabel" | "concerns" | "trendClause" | "verdictWord" | "verdictRest"
>;

const STATUS_LABEL: Record<AkmHealthResult["status"], string> = { pass: "PASS", warn: "WARN", fail: "FAIL" };

/**
 * Synthesized verdict (one sentence + 2-3 drivers). The verdict WORD is the
 * authoritative health status (hard checks). Concerns (failed improve runs,
 * blocked search, pending proposals) are advisory and do NOT gate that word,
 * so a green PASS is never paired with red "drivers" as if they were
 * failures. When the status is PASS we frame concerns as "watch:" alongside
 * the trend; only a degraded status (WARN/FAIL) leads with them.
 */
function buildVerdictPhase(
  result: AkmHealthResult,
  trend: TrendBlock,
  sem: SemSearchStatus,
  proposals: PendingProposalLike[],
  failedRuns: number,
): VerdictPhase {
  const statusLabel = STATUS_LABEL[result.status];
  const failOk = result.metrics.taskFailRate < TASK_FAIL_RATE_WARN;

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
  const verdictWord = statusLabel;
  let verdictRest: string;
  if (result.status === "pass") {
    const watch = concerns.length > 0 ? `; watch: ${concerns.slice(0, 3).join(", ")}` : "";
    verdictRest = `healthy, ${trendClause}${watch}`;
  } else {
    const lead = concerns.length > 0 ? concerns.slice(0, 3).join("; ") : trendClause;
    verdictRest = trend.overall === "degrading" && concerns.length > 0 ? `${lead}; ${trendClause}` : lead;
  }
  return { status: result.status, failOk, statusLabel, concerns, trendClause, verdictWord, verdictRest };
}

/** Distill skip-reason chart categories (collect.py chart payload step). */
function computeDistillReasons(runs: ReportRun[]): string[] {
  return [...new Set(runs.flatMap((r) => Object.keys(r.distillByReason)))]
    .filter((reason) => !DISTILL_REASONS_HIDDEN.has(reason))
    .sort();
}

/** Proposals grouped by `source`, sorted alphabetically (drain-proposals action item). */
function groupProposalsBySource(proposals: PendingProposalLike[]): Array<[string, number]> {
  const bySource = new Map<string, number>();
  for (const p of proposals) bySource.set(p.source, (bySource.get(p.source) ?? 0) + 1);
  return [...bySource.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** Summary table rows: the base metric set + the WS-5 coverage/minting/perf/degradation extensions, when present. */
function buildSummaryRows(aggregates: AggregatesPhase, trend: TrendBlock): SummaryRow[] {
  const { consolidation: cons, graphExtraction: ge, wallTime, llm, coverage, minting, perf, degradation } = aggregates;

  const summaryRows: SummaryRow[] = [
    ["Task fail rate", aggregates.taskFailRate, "flat"],
    ["Agent fail rate", aggregates.agentFailRate, "flat"],
    ["Improve completion", `${num(aggregates.completed)} / ${num(aggregates.invoked)}`, "flat"],
    [
      "MI yield rate",
      aggregates.miYieldRate,
      trend.decisionQuality,
      "Memory-inference yield: share of considered candidates that produced a written fact.",
    ],
    ["MI written", num(aggregates.miWritten), trend.outputVolume, "Memory-inference: facts written this window."],
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
    ["Chunk failure", aggregates.chunkFail, "flat"],
    ["Graph entities", num(ge.entities), "up"],
    ["Graph relations", num(ge.relations), "up"],
    [
      "Stash derived",
      num(aggregates.memorySummary.derived),
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
        "Dedup pool size",
        num(perf.dedupPoolSize),
        "flat",
        "Memory pool size after incremental narrowing, before the limit cap. WS-5 perf telemetry.",
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

  return summaryRows;
}

/**
 * Extract the health HTML report's view model from an `AkmHealthResult` +
 * report options. Pure — no HTML, no I/O, no clock/RNG reads. Byte-identical
 * output for identical inputs, mirroring the pre-split
 * `buildHealthHtmlReplacements` arithmetic exactly. File-level decomposed
 * (chunk-9 WI-9.5a) into one phase helper per section above; this function is
 * the extract-then-compose glue.
 */
export function buildHealthReportViewModel(
  result: AkmHealthResult,
  opts: HealthHtmlReportOptions,
): HealthReportViewModel {
  const deltas = opts.deltas ?? {};
  const proposals = opts.proposals;
  const runsPhase = partitionRuns(result);
  const sem = readSemSearch(result.advisories);
  const trend = buildTrend(deltas);

  const aggregates = buildAggregatesPhase(result, runsPhase);
  const meta = buildMetaPhase(result, runsPhase.runs);
  const verdict = buildVerdictPhase(result, trend, sem, proposals, aggregates.failedRuns);
  const distillReasons = computeDistillReasons(runsPhase.runs);
  const proposalsBySource = groupProposalsBySource(proposals);
  const summaryRows = buildSummaryRows(aggregates, trend);

  return {
    window: opts.window,
    compare: opts.compare,
    ...meta,

    runs: runsPhase.runs,
    invalidRuns: runsPhase.invalidRuns,

    ...verdict,
    ...aggregates,

    trend,
    deltas,

    sem,

    proposals,
    proposalsBySource,

    summaryRows,

    sliceCandidates: computeSliceCandidates(opts.window),

    distillReasons,

    advisories: result.advisories,
    sessionLogAdvisories: result.sessionLogAdvisories,
  };
}
