// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Improve-pipeline metric projection for `akm health`: `improve_runs.result_json`
 * envelopes and `improve_*` events → the aggregated {@link ImproveHealthMetrics}
 * / {@link ImproveRunSummary} shapes, plus the window's accepted-proposal
 * coverage read from the proposals table.
 */

import type { readEvents } from "../../core/events";
import { decodeImproveResult } from "../../core/improve-result";
import type { Database } from "../../storage/database";
import { type ImproveRunSummaryRow, queryImproveRuns } from "../../storage/repositories/improve-runs-repository";
import { decodeTaskHistoryMetadata, type TaskHistoryRow } from "../../storage/repositories/task-history-repository";
import type { ImproveHealthMetrics, ImproveRunSummary } from "./types";

function roundRate(value: number): number {
  return Number(value.toFixed(4));
}

/** {@link roundRate}, keeping an unknown (null) rate unknown. */
export function roundOrNull(value: number | null): number | null {
  return value === null ? null : roundRate(value);
}

/** A history row with its metadata decoded; `metadata` is undefined when the row's `metadata_json` is corrupt. */
interface DecodedTaskRow {
  row: TaskHistoryRow;
  metadata: ReturnType<typeof decodeTaskHistoryMetadata> | undefined;
}

/**
 * Decode each row's `metadata_json` once, warning once per corrupt row (it degrades the metrics, never aborts
 * `akm health`, mirrors `listStateProposals`). `decodeTaskHistoryMetadata` already tolerates legacy/additive shapes;
 * only genuine corruption reaches the catch.
 */
export function decodeTaskRows(rows: readonly TaskHistoryRow[]): DecodedTaskRow[] {
  return rows.map((row) => {
    try {
      return { row, metadata: decodeTaskHistoryMetadata(row.metadata_json) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[akm] Skipping unparseable task_history row in health metrics (task_id=${row.task_id}, started_at=${row.started_at}): ${message}`,
      );
      return { row, metadata: undefined };
    }
  });
}

/** The runs of `task-fail-rate`'s window, by what started them (`trigger` in the row's metadata). */
export interface TaskRunCounts {
  runs: number;
  tasks: number;
  scheduled: number;
  manual: number;
  /** Rows written before the trigger was recorded. */
  unrecorded: number;
  /** Rows whose metadata could not be read. */
  unreadable: number;
}

/** The runs of `rows` by what started them, and how many distinct tasks they belong to. */
export function countTaskRuns(rows: readonly DecodedTaskRow[]): TaskRunCounts {
  const counts: TaskRunCounts = {
    runs: rows.length,
    tasks: new Set(rows.map(({ row }) => row.task_id)).size,
    scheduled: 0,
    manual: 0,
    unrecorded: 0,
    unreadable: 0,
  };
  for (const { metadata } of rows) {
    if (!metadata) counts.unreadable += 1;
    else if (metadata.trigger === "schedule") counts.scheduled += 1;
    else if (metadata.trigger === "manual") counts.manual += 1;
    else counts.unrecorded += 1;
  }
  return counts;
}

/** One agent dispatch recorded in task history; `reason` is set when it failed. */
export interface AgentDispatch {
  reason?: string;
}

/**
 * The agent dispatches `akm health` counts for `agentFailureRate`: every version 4 `command` row (the dispatch is the
 * row; it failed when `detail.reason` is set) and every version 5 step that recorded an `agent` fact (it failed when
 * `agent.reason` is set). A row written before the fact was recorded holds no dispatch: it is unknown, not a success.
 */
export function agentDispatches(rows: readonly DecodedTaskRow[]): AgentDispatch[] {
  const dispatches: AgentDispatch[] = [];
  for (const { row, metadata } of rows) {
    if (!metadata) continue;
    if (row.target_kind === "command") {
      const reason = metadata.detail?.reason;
      dispatches.push(typeof reason === "string" && reason.length > 0 ? { reason } : {});
    }
    for (const step of metadata.steps ?? []) {
      if (step.agent) dispatches.push(step.agent.reason ? { reason: step.agent.reason } : {});
    }
  }
  return dispatches;
}

/**
 * #943: reason-value breakdown for the failed agent dispatches — how many are `timeout` vs `non_zero_exit` vs
 * `parse_error` etc., so `akm health`'s `task-fail-rate` advisory can say "timeout-dominant" from data rather than log
 * grep. The total equals the number of failed dispatches the rate counts.
 */
export function countAgentFailureReasons(dispatches: readonly AgentDispatch[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { reason } of dispatches) {
    if (reason === undefined) continue;
    counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return counts;
}

/**
 * Decode one `improve_runs.result_json` envelope, warning once per row on
 * failure (mirrors {@link taskFailureDetail}'s handling of the analogous
 * `task_history` case) and returning `undefined` instead of throwing.
 * Callers count the `undefined` case themselves (`resultRows.skipped.invalid`
 * / `resultStatus: "invalid"`) so a decode failure is never silent — the
 * warning names *why* (corrupt data, or a decoder too strict for a shape an
 * older release legitimately wrote), the counters say *how many*.
 */
function decodeImproveResultRow(
  row: Pick<ImproveRunSummaryRow, "id" | "started_at" | "result_json">,
): Record<string, unknown> | undefined {
  try {
    return decodeImproveResult(row.result_json).envelope as unknown as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[akm] Skipping unparseable improve_runs row in health metrics (id=${row.id}, started_at=${row.started_at}): ${message}`,
    );
    return undefined;
  }
}

/** An `improve_runs` row with its envelope decoded; `result` is undefined when the envelope does not decode. */
export interface DecodedImproveRow {
  row: ImproveRunSummaryRow;
  result: Record<string, unknown> | undefined;
}

/** The window's `improve_runs` rows, each decoded once (one warning per bad row) for every reader of the window. */
export function readImproveRows(db: Database, since: string, until?: string): DecodedImproveRow[] {
  return queryImproveRuns(db, since, until).map((row) => ({ row, result: decodeImproveResultRow(row) }));
}

/** A zeroed accumulator — also what health reports when it could not read state.db at all (#791). */
export function emptyImproveMetrics(): ImproveHealthMetrics {
  return {
    invoked: 0,
    completed: 0,
    skipped: 0,
    skipReasons: {},
    resultRows: { total: 0, included: 0, skipped: { invalid: 0 } },
    actions: {
      reflect: { ok: 0, failed: 0, cooldown: 0, skipped: 0, rejected: 0 },
      distill: {
        queued: 0,
        llmFailed: 0,
        judgeRejected: 0,
        validatorRejected: 0,
        configDisabled: 0,
        skipped: 0,
        skippedByReason: {},
      },
      memoryPrune: 0,
      memoryInference: 0,
      error: 0,
    },
    autoAccept: { promoted: 0, validationFailed: 0 },
    memorySummary: { eligible: 0, derived: 0 },
    consolidation: {
      processed: 0,
      promoted: 0,
      merged: 0,
      deleted: 0,
      contradicted: 0,
      judgedNoAction: 0,
      failedChunks: 0,
      totalChunks: 0,
      pairsJudged: 0,
      failedPairs: 0,
      deferredPairs: 0,
      durationMs: 0,
    },
    memoryInference: {
      considered: 0,
      freshAttempts: 0,
      written: 0,
      noChange: 0,
      skippedNoFacts: 0,
      yieldRate: 0,
      durationMs: 0,
    },
    wallTime: { medianMs: 0, p95Ms: 0 },
    coverage: { acceptedProposals: 0, distinctRefs: 0 },
  };
}

function toFiniteNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/** One `actions[]` entry → its counter bucket; unknown modes/outcomes are not counted. */
function applyAction(metrics: ImproveHealthMetrics, action: Record<string, unknown>): void {
  switch (typeof action.mode === "string" ? action.mode : "") {
    case "reflect":
      metrics.actions.reflect.ok += 1;
      break;
    case "reflect-failed": {
      // Runs recorded before a quality rejection had its own mode carry it as `reflect-failed`.
      const result = action.result as Record<string, unknown> | undefined;
      if (result?.reason === "quality_rejected") metrics.actions.reflect.rejected += 1;
      else metrics.actions.reflect.failed += 1;
      break;
    }
    case "reflect-guard-rejected":
      metrics.actions.reflect.rejected += 1;
      break;
    case "reflect-cooldown":
      metrics.actions.reflect.cooldown += 1;
      break;
    case "reflect-skipped":
      metrics.actions.reflect.skipped += 1;
      break;
    case "distill": {
      const result = action.result as Record<string, unknown> | undefined;
      switch (typeof result?.outcome === "string" ? result.outcome : "") {
        case "queued":
          metrics.actions.distill.queued += 1;
          break;
        case "llm_failed":
          metrics.actions.distill.llmFailed += 1;
          break;
        case "quality_rejected":
        case "review_needed":
          metrics.actions.distill.judgeRejected += 1;
          break;
        case "validation_failed":
          metrics.actions.distill.validatorRejected += 1;
          break;
        case "config_disabled":
          metrics.actions.distill.configDisabled += 1;
          break;
        default:
          break;
      }
      break;
    }
    case "memory-prune":
      metrics.actions.memoryPrune += 1;
      break;
    case "memory-inference":
      metrics.actions.memoryInference += 1;
      break;
    case "error":
      metrics.actions.error += 1;
      break;
    default:
      break;
  }
}

/** Project one `improve_runs.result_json` envelope into a single-run accumulator. */
function projectRunMetrics(result: Record<string, unknown>): ImproveHealthMetrics {
  const metrics = emptyImproveMetrics();

  if (Array.isArray(result.actions)) {
    for (const action of result.actions as Array<Record<string, unknown>>) applyAction(metrics, action);
  }

  const distillSkipped = result.distillSkipped as { total?: unknown; byReason?: Record<string, unknown> } | undefined;
  if (distillSkipped && typeof distillSkipped === "object") {
    metrics.actions.distill.skipped += toFiniteNumber(distillSkipped.total);
    for (const [reason, count] of Object.entries(distillSkipped.byReason ?? {})) {
      metrics.actions.distill.skippedByReason[reason] =
        (metrics.actions.distill.skippedByReason[reason] ?? 0) + toFiniteNumber(count);
    }
  }

  metrics.autoAccept.promoted += toFiniteNumber((result.triage as { promoted?: unknown } | undefined)?.promoted);
  metrics.autoAccept.validationFailed += toFiniteNumber(result.gateAutoAcceptFailedCount);

  const memorySummary = result.memorySummary as Record<string, unknown> | undefined;
  if (memorySummary) {
    metrics.memorySummary.eligible += toFiniteNumber(memorySummary.eligible);
    metrics.memorySummary.derived += toFiniteNumber(memorySummary.derived);
  }

  const consolidation = result.consolidation as Record<string, unknown> | undefined;
  if (consolidation) {
    const cons = metrics.consolidation;
    cons.processed += toFiniteNumber(consolidation.processed);
    if (Array.isArray(consolidation.promoted)) cons.promoted += consolidation.promoted.length;
    cons.merged += toFiniteNumber(consolidation.merged);
    cons.deleted += toFiniteNumber(consolidation.deleted);
    cons.contradicted += toFiniteNumber(consolidation.contradicted);
    cons.judgedNoAction += toFiniteNumber(consolidation.judgedNoAction);
    cons.failedChunks += toFiniteNumber(consolidation.failedChunks);
    cons.totalChunks += toFiniteNumber(consolidation.totalChunks);
    cons.durationMs += toFiniteNumber(consolidation.durationMs);
    const pairPass = consolidation.pairPass as Record<string, unknown> | undefined;
    if (pairPass) {
      cons.pairsJudged += toFiniteNumber(pairPass.pairsJudged);
      cons.failedPairs += toFiniteNumber(pairPass.failedJudgments);
      const deferred = pairPass.deferredJudgments;
      cons.deferredPairs =
        typeof deferred === "number" && Number.isSafeInteger(deferred) && deferred >= 0 ? deferred : null;
    }
  }

  const memoryInference = result.memoryInference as Record<string, unknown> | undefined;
  if (memoryInference) {
    const considered = toFiniteNumber(memoryInference.considered);
    const mi = metrics.memoryInference;
    mi.considered += considered;
    // Cache hits and budget-aborted records never reached the LLM; excluding
    // them keeps the yield rate a statement about real inference attempts.
    mi.freshAttempts += Math.max(
      0,
      considered - toFiniteNumber(memoryInference.cacheHits) - toFiniteNumber(memoryInference.skippedAborted),
    );
    mi.written += toFiniteNumber(memoryInference.writtenFacts);
    mi.noChange += toFiniteNumber(memoryInference.noChange);
    mi.skippedNoFacts += toFiniteNumber(memoryInference.skippedNoFacts);
  }
  metrics.memoryInference.durationMs += toFiniteNumber(result.memoryInferenceDurationMs);

  return metrics;
}

/** Derived rates on an accumulator (window aggregate or single run). */
function finalizeImproveMetrics(metrics: ImproveHealthMetrics): void {
  const mi = metrics.memoryInference;
  mi.yieldRate = mi.freshAttempts > 0 ? roundRate(mi.written / mi.freshAttempts) : 0;
}

/**
 * Merge per-run metrics from `src` into accumulator `dst`. Every counter is
 * additive; `memorySummary` is a whole-stash snapshot and is deliberately NOT
 * merged (summing it across runs inflated it ~N× — the 1.2M-eligible bug), and
 * the derived rate is recomputed by {@link finalizeImproveMetrics}.
 */
function mergeImproveMetrics(dst: ImproveHealthMetrics, src: ImproveHealthMetrics): void {
  dst.actions.reflect.ok += src.actions.reflect.ok;
  dst.actions.reflect.failed += src.actions.reflect.failed;
  dst.actions.reflect.cooldown += src.actions.reflect.cooldown;
  dst.actions.reflect.skipped += src.actions.reflect.skipped;
  dst.actions.reflect.rejected += src.actions.reflect.rejected;
  dst.actions.distill.queued += src.actions.distill.queued;
  dst.actions.distill.llmFailed += src.actions.distill.llmFailed;
  dst.actions.distill.judgeRejected += src.actions.distill.judgeRejected;
  dst.actions.distill.validatorRejected += src.actions.distill.validatorRejected;
  dst.actions.distill.configDisabled += src.actions.distill.configDisabled;
  dst.actions.distill.skipped += src.actions.distill.skipped;
  for (const [reason, count] of Object.entries(src.actions.distill.skippedByReason)) {
    dst.actions.distill.skippedByReason[reason] = (dst.actions.distill.skippedByReason[reason] ?? 0) + count;
  }
  dst.actions.memoryPrune += src.actions.memoryPrune;
  dst.actions.memoryInference += src.actions.memoryInference;
  dst.actions.error += src.actions.error;
  dst.autoAccept.promoted += src.autoAccept.promoted;
  dst.autoAccept.validationFailed += src.autoAccept.validationFailed;
  dst.consolidation.processed += src.consolidation.processed;
  dst.consolidation.promoted += src.consolidation.promoted;
  dst.consolidation.merged += src.consolidation.merged;
  dst.consolidation.deleted += src.consolidation.deleted;
  dst.consolidation.contradicted += src.consolidation.contradicted;
  dst.consolidation.judgedNoAction += src.consolidation.judgedNoAction;
  dst.consolidation.failedChunks += src.consolidation.failedChunks;
  dst.consolidation.totalChunks += src.consolidation.totalChunks;
  dst.consolidation.pairsJudged += src.consolidation.pairsJudged;
  dst.consolidation.failedPairs += src.consolidation.failedPairs;
  dst.consolidation.deferredPairs =
    dst.consolidation.deferredPairs === null || src.consolidation.deferredPairs === null
      ? null
      : dst.consolidation.deferredPairs + src.consolidation.deferredPairs;
  dst.consolidation.durationMs += src.consolidation.durationMs;
  dst.memoryInference.considered += src.memoryInference.considered;
  dst.memoryInference.freshAttempts += src.memoryInference.freshAttempts;
  dst.memoryInference.written += src.memoryInference.written;
  dst.memoryInference.noChange += src.memoryInference.noChange;
  dst.memoryInference.skippedNoFacts += src.memoryInference.skippedNoFacts;
  dst.memoryInference.durationMs += src.memoryInference.durationMs;
}

function compareImproveRunRecency(a: ImproveRunSummaryRow, b: ImproveRunSummaryRow): number {
  const started = a.started_at.localeCompare(b.started_at);
  if (started !== 0) return started;
  const completed = a.completed_at.localeCompare(b.completed_at);
  if (completed !== 0) return completed;
  return a.id.localeCompare(b.id);
}

/** Internal advisory inputs; public per-run summaries retain the recorded envelope's status. */
export interface ImproveRunOutcomes {
  failedRunIds: string[];
  interruptedRunIds: string[];
}

/**
 * Aggregate the window's `improve_runs` rows. `runCount` is every non-dry-run
 * row in the window; rows whose envelope does not decode are counted under
 * `resultRows.skipped.invalid` and excluded from the result-derived metrics.
 */
export function summarizeImproveRuns(rows: readonly DecodedImproveRow[]): {
  metrics: ImproveHealthMetrics;
  runCount: number;
  outcomes: ImproveRunOutcomes;
} {
  const accum = emptyImproveMetrics();
  const resultRows = { total: rows.length, included: 0, skipped: { invalid: 0 } };
  const outcomes: ImproveRunOutcomes = { failedRunIds: [], interruptedRunIds: [] };

  // memorySummary is a whole-stash snapshot per run, so the window value is the
  // newest complete run's snapshot (current state) — not a sum across runs.
  let latest: { row: ImproveRunSummaryRow; memorySummary: ImproveHealthMetrics["memorySummary"] } | undefined;

  for (const { row, result } of rows) {
    if (!result) {
      resultRows.skipped.invalid += 1;
      if (!row.ok) outcomes.failedRunIds.push(row.id);
      continue;
    }
    resultRows.included += 1;
    const perRow = projectRunMetrics(result);
    mergeImproveMetrics(accum, perRow);
    const terminationReason = (result.terminated as { reason: string } | undefined)?.reason;
    const interrupted = ["SIGINT", "SIGTERM", "SIGHUP"].includes(terminationReason ?? "");
    // Completed envelopes can be ok:true despite failed processing. Signals alone
    // do not distinguish deliberate cancellation from a timeout or service stop.
    if (
      perRow.actions.reflect.failed > 0 ||
      perRow.actions.distill.llmFailed > 0 ||
      perRow.actions.error > 0 ||
      perRow.consolidation.failedChunks > 0 ||
      perRow.consolidation.failedPairs > 0 ||
      perRow.memoryInference.skippedNoFacts > 0 ||
      (!interrupted && (!row.ok || terminationReason !== undefined))
    ) {
      outcomes.failedRunIds.push(row.id);
    } else if (interrupted) {
      outcomes.interruptedRunIds.push(row.id);
    }
    if (
      result.terminated === undefined &&
      Number.isFinite(new Date(row.started_at).getTime()) &&
      (latest === undefined || compareImproveRunRecency(row, latest.row) > 0)
    ) {
      latest = { row, memorySummary: perRow.memorySummary };
    }
  }

  finalizeImproveMetrics(accum);
  accum.resultRows = resultRows;
  if (latest) accum.memorySummary = latest.memorySummary;
  return { metrics: accum, runCount: rows.length, outcomes };
}

/** Project an improve_runs row + wall time + task attribution into one {@link ImproveRunSummary}. */
export function projectImproveRunSummary(
  { row, result: decoded }: DecodedImproveRow,
  wallTimeMs: number,
  taskId: string,
): ImproveRunSummary {
  const result: Record<string, unknown> = decoded ?? {};
  const resultStatus: NonNullable<ImproveRunSummary["resultStatus"]> = decoded ? "valid" : "invalid";
  if (!decoded) {
    // Keep the persisted row visible in per-run output, but do not project its
    // unknown payload or admit its duration to result-derived denominators.
    wallTimeMs = 0;
  }
  const perRow = projectRunMetrics(result);
  finalizeImproveMetrics(perRow);
  const lintSummary = result.lintSummary as Record<string, unknown> | undefined;

  return {
    id: row.id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    wallTimeMs,
    ok: row.ok === 1,
    resultStatus,
    resultComplete: resultStatus === "valid" && result.terminated === undefined,
    strategy: row.strategy,
    scope: {
      mode: row.scope_mode,
      ...(row.scope_value ? { value: row.scope_value } : {}),
    },
    taskId,
    actions: perRow.actions,
    memorySummary: perRow.memorySummary,
    consolidation: perRow.consolidation,
    memoryInference: perRow.memoryInference,
    orphansPurged: toFiniteNumber(result.orphansPurged),
    lintFixed: lintSummary ? toFiniteNumber(lintSummary.fixed) : 0,
    lintFlagged: lintSummary ? toFiniteNumber(lintSummary.flagged) : 0,
  };
}

/** Upper median and nearest-rank p95 of the window's run wall times. */
export function computeWallTimeStats(durationsMs: number[]): ImproveHealthMetrics["wallTime"] {
  if (durationsMs.length === 0) return { medianMs: 0, p95Ms: 0 };
  const sorted = [...durationsMs].sort((a, b) => a - b);
  return {
    medianMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
    p95Ms: sorted[Math.ceil(0.95 * sorted.length) - 1] ?? 0,
  };
}

export function buildImproveSkipSummary(events: ReturnType<typeof readEvents>["events"]): {
  skipped: number;
  skipReasons: Record<string, number>;
} {
  // Two kinds of skip events:
  //  - Per-occurrence (no `count`): one event per skipped ref → SUM is correct.
  //  - Aggregated snapshot (carries `count`): a single per-run event whose count
  //    is the number of refs that hit a STABLE, whole-stash condition that run
  //    (`no_new_signal`, `strategy_filtered_all_passes`). Each run re-counts the
  //    same stable set, so summing across the window re-counts it N times (the
  //    2.7M / 3M inflation). For these we keep the MOST RECENT run's count — the
  //    current snapshot — matching how memorySummary is handled. Events arrive
  //    in chronological (offset) order, so the last count-bearing event per
  //    reason is the latest run's value.
  const summed: Record<string, number> = {};
  const latestSnapshot: Record<string, number> = {};
  for (const event of events) {
    const reason =
      typeof event.metadata?.reason === "string" && event.metadata.reason.trim() ? event.metadata.reason : "unknown";
    const rawCount = event.metadata?.count;
    if (typeof rawCount === "number" && Number.isFinite(rawCount) && rawCount > 0) {
      latestSnapshot[reason] = rawCount; // overwrite → keeps the latest run's snapshot
    } else {
      summed[reason] = (summed[reason] ?? 0) + 1;
    }
  }
  const skipReasons: Record<string, number> = { ...summed };
  for (const [reason, count] of Object.entries(latestSnapshot)) {
    skipReasons[reason] = (skipReasons[reason] ?? 0) + count;
  }
  const skipped = Object.values(skipReasons).reduce((a, b) => a + b, 0);
  return { skipped, skipReasons };
}

/**
 * Proposals accepted in `[since, until)` (by `updated_at`) and the distinct
 * refs among them — N accepted rewrites of one asset touch one ref. A single
 * SQL aggregate; proposal bodies are never loaded. Fails open to zeros when
 * the table is absent.
 */
export function computeWindowProposalCoverage(
  db: Database,
  since: string,
  until?: string,
): ImproveHealthMetrics["coverage"] {
  try {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS accepted, COUNT(DISTINCT ref) AS refs FROM proposals " +
          "WHERE status = 'accepted' AND updated_at >= ? AND (? IS NULL OR updated_at < ?)",
      )
      .get(since, until ?? null, until ?? null) as { accepted: number; refs: number } | undefined;
    return { acceptedProposals: row?.accepted ?? 0, distinctRefs: row?.refs ?? 0 };
  } catch {
    return { acceptedProposals: 0, distinctRefs: 0 };
  }
}
