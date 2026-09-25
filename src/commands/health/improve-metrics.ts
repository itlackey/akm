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

export function roundRate(value: number): number {
  return Number(value.toFixed(4));
}

export function parseTaskMetadata(row: TaskHistoryRow): {
  durationMs?: number;
  detail?: Record<string, unknown>;
  engine?: string | null;
} {
  const metadata = decodeTaskHistoryMetadata(row.metadata_json);
  return {
    ...(metadata.durationMs !== undefined ? { durationMs: metadata.durationMs } : {}),
    ...(metadata.detail ? { detail: metadata.detail } : {}),
    ...(metadata.engine !== undefined ? { engine: metadata.engine } : {}),
  };
}

/**
 * `parseTaskMetadata`, but per-row skip-and-warn instead of throwing (mirrors
 * `listStateProposals`). `decodeTaskHistoryMetadata` already tolerates
 * legacy/additive shapes; only genuine corruption reaches this catch, and a
 * corrupt row must degrade the metric (excluded, not fatal) rather than abort
 * the whole `akm health` computation.
 */
export function taskFailureDetail(row: TaskHistoryRow): Record<string, unknown> | undefined {
  try {
    return parseTaskMetadata(row).detail;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[akm] Skipping unparseable task_history row in agent-failure-rate (task_id=${row.task_id}, started_at=${row.started_at}): ${message}`,
    );
    return undefined;
  }
}

/**
 * `akm health`'s `agentFailureRate` predicate: true for a `task_history` row
 * that represents a prepared command (agent/LLM) result. `target_kind` is
 * read in the current (post-D8) vocabulary — the
 * `025-task-history-vocabulary-backfill` state migration rewrites every
 * legacy-vocabulary row before this ever runs against it, so a `"command"`
 * row here is unambiguously the agent/LLM arm.
 */
export function isAgentTaskHistoryRow(row: TaskHistoryRow): boolean {
  return row.target_kind === "command";
}

/**
 * #943: reason-value breakdown for a set of agent (command-kind) task
 * failure rows — how much of the observed failures are `timeout` vs
 * `non_zero_exit` vs `spawn_failed` etc., so `akm health`'s `task-fail-rate`
 * advisory can say "timeout-dominant" from data rather than log grep. A
 * reason-per-row read failure (already warned by {@link taskFailureDetail})
 * still counts under `"unknown"` rather than being dropped, so the total
 * always equals `agentFailures.length`.
 */
export function countAgentFailureReasons(agentFailures: readonly TaskHistoryRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of agentFailures) {
    const reason = String(taskFailureDetail(row)?.reason ?? "unknown");
    counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return counts;
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
      reflect: { ok: 0, failed: 0, cooldown: 0, skipped: 0 },
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
      graphExtraction: 0,
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
      durationMs: 0,
    },
    memoryInference: { considered: 0, freshAttempts: 0, written: 0, skippedNoFacts: 0, yieldRate: 0, durationMs: 0 },
    graphExtraction: { extractedFiles: 0, entities: 0, relations: 0, failures: 0, durationMs: 0 },
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
    case "reflect-failed":
      metrics.actions.reflect.failed += 1;
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
    case "graph-extraction":
      metrics.actions.graphExtraction += 1;
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

  metrics.autoAccept.promoted += toFiniteNumber(result.gateAutoAcceptedCount);
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
    mi.skippedNoFacts += toFiniteNumber(memoryInference.skippedNoFacts);
  }
  metrics.memoryInference.durationMs += toFiniteNumber(result.memoryInferenceDurationMs);

  const graphExtraction = result.graphExtraction as Record<string, unknown> | undefined;
  if (graphExtraction) {
    const ge = metrics.graphExtraction;
    const quality = graphExtraction.quality as Record<string, unknown> | undefined;
    ge.extractedFiles += toFiniteNumber(quality?.extractedFiles);
    ge.entities += toFiniteNumber(graphExtraction.totalEntities);
    ge.relations += toFiniteNumber(graphExtraction.totalRelations);
    const telemetry = graphExtraction.telemetry as Record<string, unknown> | undefined;
    ge.failures += toFiniteNumber(telemetry?.failureCount);
  }
  metrics.graphExtraction.durationMs += toFiniteNumber(result.graphExtractionDurationMs);

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
  dst.actions.graphExtraction += src.actions.graphExtraction;
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
  dst.consolidation.durationMs += src.consolidation.durationMs;
  dst.memoryInference.considered += src.memoryInference.considered;
  dst.memoryInference.freshAttempts += src.memoryInference.freshAttempts;
  dst.memoryInference.written += src.memoryInference.written;
  dst.memoryInference.skippedNoFacts += src.memoryInference.skippedNoFacts;
  dst.memoryInference.durationMs += src.memoryInference.durationMs;
  dst.graphExtraction.extractedFiles += src.graphExtraction.extractedFiles;
  dst.graphExtraction.entities += src.graphExtraction.entities;
  dst.graphExtraction.relations += src.graphExtraction.relations;
  dst.graphExtraction.failures += src.graphExtraction.failures;
  dst.graphExtraction.durationMs += src.graphExtraction.durationMs;
}

function compareImproveRunRecency(a: ImproveRunSummaryRow, b: ImproveRunSummaryRow): number {
  const started = a.started_at.localeCompare(b.started_at);
  if (started !== 0) return started;
  const completed = a.completed_at.localeCompare(b.completed_at);
  if (completed !== 0) return completed;
  return a.id.localeCompare(b.id);
}

/**
 * Aggregate the window's `improve_runs` rows. `runCount` is every non-dry-run
 * row in the window; rows whose envelope does not decode are counted under
 * `resultRows.skipped.invalid` and excluded from the result-derived metrics.
 */
export function summarizeImproveRuns(
  db: Database,
  since: string,
  until?: string,
): { metrics: ImproveHealthMetrics; runCount: number } {
  const accum = emptyImproveMetrics();
  const rows = queryImproveRuns(db, since, until);
  const resultRows = { total: rows.length, included: 0, skipped: { invalid: 0 } };

  // memorySummary is a whole-stash snapshot per run, so the window value is the
  // newest complete run's snapshot (current state) — not a sum across runs.
  let latest: { row: ImproveRunSummaryRow; memorySummary: ImproveHealthMetrics["memorySummary"] } | undefined;

  for (const row of rows) {
    let result: Record<string, unknown>;
    try {
      result = decodeImproveResult(row.result_json).envelope as unknown as Record<string, unknown>;
    } catch {
      resultRows.skipped.invalid += 1;
      continue;
    }
    resultRows.included += 1;
    const perRow = projectRunMetrics(result);
    mergeImproveMetrics(accum, perRow);
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
  return { metrics: accum, runCount: rows.length };
}

/** Project an improve_runs row + wall time + task attribution into one {@link ImproveRunSummary}. */
export function projectImproveRunSummary(
  row: ImproveRunSummaryRow,
  wallTimeMs: number,
  taskId: string,
): ImproveRunSummary {
  let result: Record<string, unknown> = {};
  let resultStatus: NonNullable<ImproveRunSummary["resultStatus"]> = "invalid";
  try {
    result = decodeImproveResult(row.result_json).envelope as unknown as Record<string, unknown>;
    resultStatus = "valid";
  } catch {
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
    graphExtraction: perRow.graphExtraction,
    orphansPurged: toFiniteNumber(result.orphansPurged),
    lintFixed: lintSummary ? toFiniteNumber(lintSummary.fixed) : 0,
    lintFlagged: lintSummary ? toFiniteNumber(lintSummary.flagged) : 0,
  };
}

/** Nearest-rank median and p95 of the window's run wall times. */
export function computeWallTimeStats(durationsMs: number[]): ImproveHealthMetrics["wallTime"] {
  if (durationsMs.length === 0) return { medianMs: 0, p95Ms: 0 };
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { medianMs: pick(0.5), p95Ms: pick(0.95) };
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
