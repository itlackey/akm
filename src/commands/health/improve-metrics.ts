// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Improve-pipeline metric projection for `akm health`: turning
 * `improve_runs.result_json` envelopes and `improve_*` events into the
 * aggregated {@link ImproveHealthMetrics} / {@link ImproveRunSummary} shapes.
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
  legacyProfile?: string;
} {
  const metadata = decodeTaskHistoryMetadata(row.metadata_json);
  return {
    ...(metadata.durationMs !== undefined ? { durationMs: metadata.durationMs } : {}),
    ...(metadata.detail ? { detail: metadata.detail } : {}),
    ...(metadata.metadataVersion === 2 && metadata.engine !== undefined ? { engine: metadata.engine } : {}),
    ...(metadata.metadataVersion === 1 && metadata.legacyProfile !== undefined
      ? { legacyProfile: metadata.legacyProfile }
      : {}),
  };
}

function createUnknownImproveMetrics(): ImproveHealthMetrics {
  return {
    invoked: 0,
    completed: 0,
    skipped: 0,
    skipReasons: {},
    resultRows: { total: 0, included: 0, normalized: 0, skipped: { invalid: 0 } },
    plannedRefs: 0,
    strategyFilteredRefs: 0,
    actions: {
      reflect: { ok: 0, failed: 0, cooldown: 0, skipped: 0, guardRejected: 0, skippedByReason: {} },
      distill: {
        queued: 0,
        llmFailed: 0,
        qualityRejected: 0,
        judgeRejected: 0,
        validatorRejected: 0,
        configDisabled: 0,
        skipped: 0,
        skippedByReason: {},
        deferred: 0,
        deferredByReason: {},
      },
      memoryPrune: 0,
      memoryInference: 0,
      graphExtraction: 0,
      error: 0,
    },
    autoAccept: { promoted: 0, validationFailed: 0 },
    reflectsWithErrorContext: 0,
    coverageGapCount: 0,
    evalCasesWritten: 0,
    deadUrlCount: 0,
    memorySummary: { eligible: 0, derived: 0 },
    memoryCleanup: {
      pruneCandidates: 0,
      contradictionCandidates: 0,
      beliefStateTransitions: 0,
      consolidationCandidates: 0,
      archived: 0,
      warnings: 0,
    },
    consolidation: {
      ran: false,
      processed: 0,
      promoted: 0,
      merged: 0,
      deleted: 0,
      contradicted: 0,
      judgedNoAction: 0,
      mergedSecondaries: 0,
      failedChunkMemories: 0,
      skipReasons: {},
      failedChunks: 0,
      totalChunks: 0,
      durationMs: 0,
    },
    memoryInference: {
      ran: false,
      considered: 0,
      cacheHits: 0,
      retryAttempts: 0,
      freshAttempts: 0,
      splitParents: 0,
      written: 0,
      skippedNoFacts: 0,
      skippedChildExists: 0,
      skippedAborted: 0,
      unaccounted: 0,
      htmlErrorCount: 0,
      yieldEligibleRuns: 0,
      yieldEligibleConsidered: 0,
      yieldEligibleWritten: 0,
      yieldRate: 0,
      durationMs: 0,
      writes: 0,
    },
    graphExtraction: {
      ran: false,
      extractedFiles: 0,
      entities: 0,
      relations: 0,
      cacheHits: 0,
      cacheMisses: 0,
      cacheHitRate: 0,
      truncations: 0,
      failures: 0,
      htmlErrors: 0,
      retryAttempts: 0,
      nonArrayBatchFailures: 0,
      durationMs: 0,
    },
    sessionExtraction: {
      ran: false,
      sessionsScanned: 0,
      sessionsExtracted: 0,
      sessionsSkipped: 0,
      proposalsCreated: 0,
      warnings: 0,
      durationMs: 0,
    },
    wallTime: {
      count: 0,
      medianMs: 0,
      p95Ms: 0,
      minMs: 0,
      maxMs: 0,
      byPhase: {
        consolidation: { count: 0, totalMs: 0, medianMs: 0, p95Ms: 0 },
        memoryInference: { count: 0, totalMs: 0, medianMs: 0, p95Ms: 0 },
        graphExtraction: { count: 0, totalMs: 0, medianMs: 0, p95Ms: 0 },
      },
    },
    perfTelemetry: {
      dedupPoolSize: 0,
      llmPoolSize: 0,
      embedMs: 0,
      embedCacheHits: 0,
      embedCacheMisses: 0,
      overBudgetRuns: 0,
      runsWithTelemetry: 0,
    },
    coverage: {
      rate: Number.NaN,
      eligibleFraction: Number.NaN,
      acceptedProposals: 0,
      distinctRefs: 0,
      churnRatio: Number.NaN,
      totalAssets: 0,
    },
  };
}

export function toFiniteNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/**
 * Event-derived metrics. Only `completed` and skipReasons/invoked are sourced
 * from events in v2 — the richer fields come from {@link summarizeImproveRuns}.
 * The function still receives `improve_completed` events so that the completed
 * count reflects the canonical event stream (it lines up 1:1 with improve_runs
 * rows in practice, but the events table remains the system-of-record for the
 * existence of a run).
 */
export function summarizeImproveCompleted(events: ReturnType<typeof readEvents>["events"]): ImproveHealthMetrics {
  const metrics = createUnknownImproveMetrics();
  metrics.completed = events.length;
  return metrics;
}

/**
 * Bucket a distill `outcome: "skipped"` result into a low-cardinality reason.
 * Prefers an explicit `skipReason`; otherwise sniffs the message. The WI-6.4
 * fingerprint/backoff vocabulary is checked before the legacy patterns, which
 * stay for historical improve_runs rows.
 */
function classifyDistillSkipReason(r: Record<string, unknown> | undefined): string {
  const explicitReason = typeof r?.skipReason === "string" ? r.skipReason : undefined;
  if (explicitReason) return explicitReason;
  const msg = typeof r?.message === "string" ? r.message : "";
  if (/lesson inputs/i.test(msg)) return "recursive_lesson_input";
  if (/NOOP/.test(msg)) return "conflict_noop";
  if (/fingerprint/i.test(msg)) return "fingerprint_match";
  if (/rejection backoff/i.test(msg)) return "rejection_backoff";
  if (/cooldown/i.test(msg)) return "proposal_cooldown";
  if (/content[_ ]?hash/i.test(msg)) return "content_hash_match";
  return "unknown";
}

/**
 * Project a single `improve_runs.result_json` envelope into an accumulator-shaped
 * ImproveHealthMetrics. The aggregator merges these per-row metrics into one
 * window-level metric.
 */
function projectRunMetrics(result: Record<string, unknown>): ImproveHealthMetrics {
  const metrics = createUnknownImproveMetrics();

  // plannedRefs (array of {ref, reason})
  const plannedRefs = result.plannedRefs;
  if (Array.isArray(plannedRefs)) metrics.plannedRefs += plannedRefs.length;

  // strategyFilteredRefs (array of {ref, reason}) — 2026-05-27: pre-filter
  // bucket from `collectEligibleRefs` so the metric reflects work the
  // planner dropped before signal-delta / per-pass dispatch.
  // Health v3 reports strategy metrics only. Historical v1 profile filtering
  // remains legacy data and must not be silently relabelled as a strategy metric.
  const strategyFilteredRefs = result.schemaVersion === 2 ? result.strategyFilteredRefs : undefined;
  if (Array.isArray(strategyFilteredRefs)) metrics.strategyFilteredRefs += strategyFilteredRefs.length;

  // actions: split reflect / distill by outcome, count others.
  const actions = result.actions;
  if (Array.isArray(actions)) {
    for (const action of actions as Array<Record<string, unknown>>) {
      const mode = typeof action.mode === "string" ? action.mode : "";
      switch (mode) {
        case "reflect":
          metrics.actions.reflect.ok += 1;
          break;
        case "reflect-failed":
          metrics.actions.reflect.failed += 1;
          break;
        case "reflect-cooldown":
          metrics.actions.reflect.cooldown += 1;
          break;
        case "reflect-skipped": {
          metrics.actions.reflect.skipped += 1;
          const r = action.result as Record<string, unknown> | undefined;
          const reason = typeof r?.reason === "string" && r.reason.trim() ? r.reason : "unknown";
          metrics.actions.reflect.skippedByReason[reason] = (metrics.actions.reflect.skippedByReason[reason] ?? 0) + 1;
          break;
        }
        case "reflect-guard-rejected":
          metrics.actions.reflect.guardRejected += 1;
          break;
        case "distill": {
          const r = action.result as Record<string, unknown> | undefined;
          const outcome = typeof r?.outcome === "string" ? r.outcome : "";
          switch (outcome) {
            case "queued":
              metrics.actions.distill.queued += 1;
              break;
            case "llm_failed":
              metrics.actions.distill.llmFailed += 1;
              break;
            case "quality_rejected":
            case "review_needed":
              metrics.actions.distill.qualityRejected += 1;
              metrics.actions.distill.judgeRejected += 1;
              break;
            case "validation_failed":
              metrics.actions.distill.qualityRejected += 1;
              metrics.actions.distill.validatorRejected += 1;
              break;
            case "config_disabled":
              metrics.actions.distill.configDisabled += 1;
              break;
            case "skipped": {
              // Previously dropped on the floor. The four sub-paths that emit
              // `outcome: "skipped"` (see distill.ts:893, 1024, 1120, 1576):
              //   - recursive_lesson_input (type guard refused a lesson input)
              //   - conflict_noop (LLM resolved destination conflict as NOOP)
              //   - proposal-skipped cooldown / dedup at persistence
              // 465 events/7d in the user's live stack. The result message
              // typically encodes the reason; we also accept an explicit
              // `skipReason` field when downstream code sets it.
              metrics.actions.distill.deferred += 1;
              const reason = classifyDistillSkipReason(r);
              metrics.actions.distill.deferredByReason[reason] =
                (metrics.actions.distill.deferredByReason[reason] ?? 0) + 1;
              break;
            }
            default:
              break;
          }
          break;
        }
        case "distill-skipped": {
          metrics.actions.distill.skipped += 1;
          const r = action.result as Record<string, unknown> | undefined;
          const reason = typeof r?.reason === "string" && r.reason.trim() ? r.reason : "unknown";
          metrics.actions.distill.skippedByReason[reason] = (metrics.actions.distill.skippedByReason[reason] ?? 0) + 1;
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
      }
    }
  }

  // C1 (13-bus-factor): new runs persist the bounded `distillSkipped` aggregate
  // instead of per-ref `distill-skipped` rows. Read the total + per-reason
  // histogram from it into the SAME `distill.skipped` / `skippedByReason`
  // metric the per-ref loop above populated. Legacy rows carry the per-ref rows
  // and NO aggregate (counted above); new rows carry the aggregate and NO
  // per-ref rows (counted here) — so a run is never double-counted.
  const distillSkipped = result.distillSkipped as { total?: unknown; byReason?: Record<string, unknown> } | undefined;
  if (distillSkipped && typeof distillSkipped === "object") {
    metrics.actions.distill.skipped += toFiniteNumber(distillSkipped.total);
    const byReason = distillSkipped.byReason;
    if (byReason && typeof byReason === "object") {
      for (const [reason, count] of Object.entries(byReason)) {
        metrics.actions.distill.skippedByReason[reason] =
          (metrics.actions.distill.skippedByReason[reason] ?? 0) + toFiniteNumber(count);
      }
    }
  }

  metrics.autoAccept.promoted += toFiniteNumber(result.gateAutoAcceptedCount);
  metrics.autoAccept.validationFailed += toFiniteNumber(result.gateAutoAcceptFailedCount);
  metrics.reflectsWithErrorContext += toFiniteNumber(result.reflectsWithErrorContext);
  if (Array.isArray(result.coverageGaps)) metrics.coverageGapCount += result.coverageGaps.length;
  metrics.evalCasesWritten += toFiniteNumber(result.evalCasesWritten);
  if (Array.isArray(result.deadUrls)) metrics.deadUrlCount += result.deadUrls.length;

  const memorySummary = result.memorySummary as Record<string, unknown> | undefined;
  if (memorySummary) {
    metrics.memorySummary.eligible += toFiniteNumber(memorySummary.eligible);
    metrics.memorySummary.derived += toFiniteNumber(memorySummary.derived);
  }

  const memoryCleanup = result.memoryCleanup as Record<string, unknown> | undefined;
  if (memoryCleanup) {
    if (Array.isArray(memoryCleanup.pruneCandidates))
      metrics.memoryCleanup.pruneCandidates += memoryCleanup.pruneCandidates.length;
    if (Array.isArray(memoryCleanup.contradictionCandidates))
      metrics.memoryCleanup.contradictionCandidates += memoryCleanup.contradictionCandidates.length;
    if (Array.isArray(memoryCleanup.beliefStateTransitions))
      metrics.memoryCleanup.beliefStateTransitions += memoryCleanup.beliefStateTransitions.length;
    if (Array.isArray(memoryCleanup.consolidationCandidates))
      metrics.memoryCleanup.consolidationCandidates += memoryCleanup.consolidationCandidates.length;
    if (Array.isArray(memoryCleanup.archived)) metrics.memoryCleanup.archived += memoryCleanup.archived.length;
    if (Array.isArray(memoryCleanup.warnings)) metrics.memoryCleanup.warnings += memoryCleanup.warnings.length;
  }

  const consolidation = result.consolidation as Record<string, unknown> | undefined;
  if (consolidation) {
    metrics.consolidation.processed += toFiniteNumber(consolidation.processed);
    metrics.consolidation.merged += toFiniteNumber(consolidation.merged);
    metrics.consolidation.deleted += toFiniteNumber(consolidation.deleted);
    metrics.consolidation.contradicted += toFiniteNumber(consolidation.contradicted);
    if (Array.isArray(consolidation.promoted)) metrics.consolidation.promoted += consolidation.promoted.length;
    metrics.consolidation.failedChunks += toFiniteNumber(consolidation.failedChunks);
    metrics.consolidation.totalChunks += toFiniteNumber(consolidation.totalChunks);
    metrics.consolidation.durationMs += toFiniteNumber(consolidation.durationMs);
    metrics.consolidation.judgedNoAction += toFiniteNumber(consolidation.judgedNoAction);
    metrics.consolidation.mergedSecondaries += toFiniteNumber(consolidation.mergedSecondaries);
    metrics.consolidation.failedChunkMemories += toFiniteNumber(consolidation.failedChunkMemories);
    // Structured emitter (new on this branch): consolidate.ts now pushes
    // per-ref grouped `{ref, skips: [{op, reason}]}` entries to `skipReasons`
    // for every deterministic post-LLM rejection. Each ref appears once but
    // may carry multiple skips; aggregate every reason. Pre-fix envelopes have
    // neither field, so be defensive.
    const skipReasons = consolidation.skipReasons;
    if (Array.isArray(skipReasons)) {
      for (const entry of skipReasons) {
        if (!entry || typeof entry !== "object") continue;
        const skips = (entry as Record<string, unknown>).skips;
        if (!Array.isArray(skips)) continue;
        for (const skip of skips) {
          if (!skip || typeof skip !== "object") continue;
          const reason = (skip as Record<string, unknown>).reason;
          if (typeof reason !== "string" || !reason.trim()) continue;
          metrics.consolidation.skipReasons[reason] = (metrics.consolidation.skipReasons[reason] ?? 0) + 1;
        }
      }
    }
    // WS-5: extract perf telemetry from the consolidation envelope.
    // Pre-WS-5 envelopes lack `perfTelemetry`; be defensive.
    const perf = consolidation.perfTelemetry as Record<string, unknown> | undefined;
    if (perf) {
      metrics.perfTelemetry.runsWithTelemetry += 1;
      metrics.perfTelemetry.dedupPoolSize += toFiniteNumber(perf.dedupPoolSize);
      metrics.perfTelemetry.llmPoolSize += toFiniteNumber(perf.llmPoolSize);
      metrics.perfTelemetry.embedMs += toFiniteNumber(perf.embedMs);
      metrics.perfTelemetry.embedCacheHits += toFiniteNumber(perf.embedCacheHits);
      metrics.perfTelemetry.embedCacheMisses += toFiniteNumber(perf.embedCacheMisses);
      const budgetFrac = toFiniteNumber(perf.estimatedBudgetFractionUsed);
      if (budgetFrac > 1.0) metrics.perfTelemetry.overBudgetRuns += 1;
    }
  }

  const memoryInference = result.memoryInference as Record<string, unknown> | undefined;
  if (memoryInference) {
    const considered = toFiniteNumber(memoryInference.considered);
    const writtenFacts = toFiniteNumber(memoryInference.writtenFacts);
    metrics.memoryInference.considered += considered;
    metrics.memoryInference.cacheHits += toFiniteNumber(memoryInference.cacheHits);
    metrics.memoryInference.retryAttempts += toFiniteNumber(memoryInference.retryAttempts);
    metrics.memoryInference.splitParents += toFiniteNumber(memoryInference.splitParents);
    metrics.memoryInference.written += writtenFacts;
    metrics.memoryInference.skippedNoFacts += toFiniteNumber(memoryInference.skippedNoFacts);
    metrics.memoryInference.skippedChildExists += toFiniteNumber(memoryInference.skippedChildExists);
    metrics.memoryInference.skippedAborted += toFiniteNumber(memoryInference.skippedAborted);
    metrics.memoryInference.unaccounted += toFiniteNumber(memoryInference.unaccounted);
    metrics.memoryInference.htmlErrorCount += toFiniteNumber(memoryInference.htmlErrorCount);
    // Yield-rate gating: pre-cache-feature envelopes lack the `cacheHits`
    // field entirely. Treating their `considered` as freshAttempts (since
    // cacheHits=0) is mathematically tempting but operationally wrong —
    // historical runs with the legacy schema have no cache instrumentation
    // and the SUM dragged the reported rate to ~14% in local data. Only
    // contribute to the yield aggregate when the envelope actually carries
    // the field. See investigation 2026-05-26.
    if (Object.hasOwn(memoryInference, "cacheHits")) {
      metrics.memoryInference.yieldEligibleRuns += 1;
      metrics.memoryInference.yieldEligibleConsidered += considered;
      metrics.memoryInference.yieldEligibleWritten += writtenFacts;
    }
  }
  metrics.memoryInference.durationMs += toFiniteNumber(result.memoryInferenceDurationMs);

  const graphExtraction = result.graphExtraction as Record<string, unknown> | undefined;
  if (graphExtraction) {
    const quality = graphExtraction.quality as Record<string, unknown> | undefined;
    if (quality) metrics.graphExtraction.extractedFiles += toFiniteNumber(quality.extractedFiles);
    metrics.graphExtraction.entities += toFiniteNumber(graphExtraction.totalEntities);
    metrics.graphExtraction.relations += toFiniteNumber(graphExtraction.totalRelations);
    const telemetry = graphExtraction.telemetry as Record<string, unknown> | undefined;
    if (telemetry) {
      metrics.graphExtraction.cacheHits += toFiniteNumber(telemetry.cacheHits);
      metrics.graphExtraction.cacheMisses += toFiniteNumber(telemetry.cacheMisses);
      metrics.graphExtraction.truncations += toFiniteNumber(telemetry.truncationCount);
      metrics.graphExtraction.failures += toFiniteNumber(telemetry.failureCount);
      metrics.graphExtraction.htmlErrors += toFiniteNumber(telemetry.htmlErrorCount);
      metrics.graphExtraction.retryAttempts += toFiniteNumber(telemetry.retryAttempts);
      metrics.graphExtraction.nonArrayBatchFailures += toFiniteNumber(telemetry.nonArrayBatchFailures);
    }
  }
  metrics.graphExtraction.durationMs += toFiniteNumber(result.graphExtractionDurationMs);

  if (Array.isArray(result.extract)) {
    for (const e of result.extract as Record<string, unknown>[]) {
      metrics.sessionExtraction.sessionsScanned += toFiniteNumber(e.sessionsProcessed);
      metrics.sessionExtraction.sessionsSkipped += toFiniteNumber(e.sessionsSkipped);
      if (Array.isArray(e.sessions)) {
        metrics.sessionExtraction.sessionsExtracted += (e.sessions as Record<string, unknown>[]).filter(
          (s) => Array.isArray(s.proposalIds) && (s.proposalIds as unknown[]).length > 0,
        ).length;
      }
      metrics.sessionExtraction.proposalsCreated += Array.isArray(e.proposals) ? (e.proposals as unknown[]).length : 0;
      metrics.sessionExtraction.warnings += Array.isArray(e.warnings) ? (e.warnings as unknown[]).length : 0;
      metrics.sessionExtraction.durationMs += toFiniteNumber(e.durationMs);
    }
  }

  return metrics;
}

/**
 * Finalize derived flags and rates on an accumulator. Used both for the
 * window-level aggregate and for each per-run row in --detail per-run mode
 * so the single-row metrics still expose `ran` / `yieldRate` / `cacheHitRate`.
 */
function finalizeImproveMetrics(metrics: ImproveHealthMetrics): void {
  metrics.consolidation.ran =
    metrics.consolidation.processed > 0 ||
    metrics.consolidation.durationMs > 0 ||
    metrics.consolidation.promoted > 0 ||
    metrics.consolidation.merged > 0 ||
    metrics.consolidation.deleted > 0 ||
    metrics.consolidation.contradicted > 0 ||
    metrics.consolidation.totalChunks > 0;
  metrics.memoryInference.ran =
    metrics.memoryInference.considered > 0 ||
    metrics.memoryInference.written > 0 ||
    metrics.memoryInference.durationMs > 0;
  metrics.memoryInference.writes = metrics.memoryInference.written;
  // Yield denominator excludes cache hits AND legacy (pre-cacheHits-field)
  // envelopes. Only runs whose envelope carries a `cacheHits` field
  // contribute to freshAttempts/yieldRate; legacy rows remain in
  // `considered`/`written` for totals but are excluded from the rate so
  // they cannot drag it down. See ImproveHealthMetrics.memoryInference
  // jsdoc for the rationale.
  metrics.memoryInference.freshAttempts = Math.max(
    0,
    metrics.memoryInference.yieldEligibleConsidered -
      metrics.memoryInference.cacheHits -
      metrics.memoryInference.skippedAborted,
  );
  metrics.memoryInference.yieldRate =
    metrics.memoryInference.freshAttempts > 0
      ? roundRate(metrics.memoryInference.yieldEligibleWritten / metrics.memoryInference.freshAttempts)
      : 0;
  metrics.graphExtraction.ran =
    metrics.graphExtraction.extractedFiles > 0 ||
    metrics.graphExtraction.entities > 0 ||
    metrics.graphExtraction.durationMs > 0;
  const cacheTotal = metrics.graphExtraction.cacheHits + metrics.graphExtraction.cacheMisses;
  metrics.graphExtraction.cacheHitRate = cacheTotal > 0 ? roundRate(metrics.graphExtraction.cacheHits / cacheTotal) : 0;
  metrics.sessionExtraction.ran =
    metrics.sessionExtraction.sessionsScanned > 0 ||
    metrics.sessionExtraction.proposalsCreated > 0 ||
    metrics.sessionExtraction.durationMs > 0;
}

/**
 * Merge per-row metrics from `src` into accumulator `dst`. All numeric fields
 * are additive; cumulative rates are recomputed by finalizeImproveMetrics.
 */
function mergeImproveMetrics(dst: ImproveHealthMetrics, src: ImproveHealthMetrics): void {
  dst.plannedRefs += src.plannedRefs;
  // strategyFilteredRefs is the count of refs the planner drops up-front for the
  // active strategy — recomputed against the (stable) stash every run, so it is a
  // snapshot, NOT a per-run increment. Summing it re-counts the same refs each
  // run (the ~2.4M bug). Set from the most recent run in summarizeImproveRuns.
  dst.actions.reflect.ok += src.actions.reflect.ok;
  dst.actions.reflect.failed += src.actions.reflect.failed;
  dst.actions.reflect.cooldown += src.actions.reflect.cooldown;
  dst.actions.reflect.skipped += src.actions.reflect.skipped;
  dst.actions.reflect.guardRejected += src.actions.reflect.guardRejected;
  for (const [reason, count] of Object.entries(src.actions.reflect.skippedByReason)) {
    dst.actions.reflect.skippedByReason[reason] = (dst.actions.reflect.skippedByReason[reason] ?? 0) + count;
  }
  dst.actions.distill.queued += src.actions.distill.queued;
  dst.actions.distill.llmFailed += src.actions.distill.llmFailed;
  dst.actions.distill.qualityRejected += src.actions.distill.qualityRejected;
  dst.actions.distill.judgeRejected += src.actions.distill.judgeRejected;
  dst.actions.distill.validatorRejected += src.actions.distill.validatorRejected;
  dst.actions.distill.configDisabled += src.actions.distill.configDisabled;
  dst.actions.distill.skipped += src.actions.distill.skipped;
  for (const [reason, count] of Object.entries(src.actions.distill.skippedByReason)) {
    dst.actions.distill.skippedByReason[reason] = (dst.actions.distill.skippedByReason[reason] ?? 0) + count;
  }
  dst.actions.distill.deferred += src.actions.distill.deferred;
  for (const [reason, count] of Object.entries(src.actions.distill.deferredByReason)) {
    dst.actions.distill.deferredByReason[reason] = (dst.actions.distill.deferredByReason[reason] ?? 0) + count;
  }
  dst.actions.memoryPrune += src.actions.memoryPrune;
  dst.actions.memoryInference += src.actions.memoryInference;
  dst.actions.graphExtraction += src.actions.graphExtraction;
  dst.actions.error += src.actions.error;
  dst.autoAccept.promoted += src.autoAccept.promoted;
  dst.autoAccept.validationFailed += src.autoAccept.validationFailed;
  dst.reflectsWithErrorContext += src.reflectsWithErrorContext;
  dst.coverageGapCount += src.coverageGapCount;
  dst.evalCasesWritten += src.evalCasesWritten;
  dst.deadUrlCount += src.deadUrlCount;
  // NOTE: memorySummary (derived/eligible) is a WHOLE-STASH snapshot recorded on
  // every run, NOT a per-run increment — summing it across the window inflates
  // it ~N× (the 1.2M-eligible bug). It is set from the most recent run in
  // summarizeImproveRuns instead, so it is intentionally not merged here.
  dst.memoryCleanup.pruneCandidates += src.memoryCleanup.pruneCandidates;
  dst.memoryCleanup.contradictionCandidates += src.memoryCleanup.contradictionCandidates;
  dst.memoryCleanup.beliefStateTransitions += src.memoryCleanup.beliefStateTransitions;
  dst.memoryCleanup.consolidationCandidates += src.memoryCleanup.consolidationCandidates;
  dst.memoryCleanup.archived += src.memoryCleanup.archived;
  dst.memoryCleanup.warnings += src.memoryCleanup.warnings;
  dst.consolidation.processed += src.consolidation.processed;
  dst.consolidation.promoted += src.consolidation.promoted;
  dst.consolidation.merged += src.consolidation.merged;
  dst.consolidation.deleted += src.consolidation.deleted;
  dst.consolidation.contradicted += src.consolidation.contradicted;
  dst.consolidation.failedChunks += src.consolidation.failedChunks;
  dst.consolidation.totalChunks += src.consolidation.totalChunks;
  dst.consolidation.durationMs += src.consolidation.durationMs;
  dst.consolidation.judgedNoAction += src.consolidation.judgedNoAction;
  dst.consolidation.mergedSecondaries += src.consolidation.mergedSecondaries;
  dst.consolidation.failedChunkMemories += src.consolidation.failedChunkMemories;
  for (const [reason, count] of Object.entries(src.consolidation.skipReasons)) {
    dst.consolidation.skipReasons[reason] = (dst.consolidation.skipReasons[reason] ?? 0) + count;
  }
  dst.memoryInference.considered += src.memoryInference.considered;
  dst.memoryInference.cacheHits += src.memoryInference.cacheHits;
  dst.memoryInference.splitParents += src.memoryInference.splitParents;
  dst.memoryInference.written += src.memoryInference.written;
  dst.memoryInference.skippedNoFacts += src.memoryInference.skippedNoFacts;
  dst.memoryInference.skippedChildExists += src.memoryInference.skippedChildExists;
  dst.memoryInference.skippedAborted += src.memoryInference.skippedAborted;
  dst.memoryInference.unaccounted += src.memoryInference.unaccounted;
  dst.memoryInference.htmlErrorCount += src.memoryInference.htmlErrorCount;
  dst.memoryInference.yieldEligibleRuns += src.memoryInference.yieldEligibleRuns;
  dst.memoryInference.yieldEligibleConsidered += src.memoryInference.yieldEligibleConsidered;
  dst.memoryInference.yieldEligibleWritten += src.memoryInference.yieldEligibleWritten;
  dst.memoryInference.durationMs += src.memoryInference.durationMs;
  dst.graphExtraction.extractedFiles += src.graphExtraction.extractedFiles;
  dst.graphExtraction.entities += src.graphExtraction.entities;
  dst.graphExtraction.relations += src.graphExtraction.relations;
  dst.graphExtraction.cacheHits += src.graphExtraction.cacheHits;
  dst.graphExtraction.cacheMisses += src.graphExtraction.cacheMisses;
  dst.graphExtraction.truncations += src.graphExtraction.truncations;
  dst.graphExtraction.failures += src.graphExtraction.failures;
  dst.graphExtraction.htmlErrors += src.graphExtraction.htmlErrors;
  dst.graphExtraction.nonArrayBatchFailures += src.graphExtraction.nonArrayBatchFailures;
  dst.graphExtraction.durationMs += src.graphExtraction.durationMs;
  dst.sessionExtraction.sessionsScanned += src.sessionExtraction.sessionsScanned;
  dst.sessionExtraction.sessionsExtracted += src.sessionExtraction.sessionsExtracted;
  dst.sessionExtraction.sessionsSkipped += src.sessionExtraction.sessionsSkipped;
  dst.sessionExtraction.proposalsCreated += src.sessionExtraction.proposalsCreated;
  dst.sessionExtraction.warnings += src.sessionExtraction.warnings;
  dst.sessionExtraction.durationMs += src.sessionExtraction.durationMs;
  // WS-5: merge perf telemetry (additive sums).
  dst.perfTelemetry.dedupPoolSize += src.perfTelemetry.dedupPoolSize;
  dst.perfTelemetry.llmPoolSize += src.perfTelemetry.llmPoolSize;
  dst.perfTelemetry.embedMs += src.perfTelemetry.embedMs;
  dst.perfTelemetry.embedCacheHits += src.perfTelemetry.embedCacheHits;
  dst.perfTelemetry.embedCacheMisses += src.perfTelemetry.embedCacheMisses;
  dst.perfTelemetry.overBudgetRuns += src.perfTelemetry.overBudgetRuns;
  dst.perfTelemetry.runsWithTelemetry += src.perfTelemetry.runsWithTelemetry;
  // coverage: acceptedProposals is additive; totalAssets is a snapshot (like memorySummary).
  // totalAssets is intentionally NOT merged here — set from the most recent run in summarizeImproveRuns.
  dst.coverage.acceptedProposals += src.coverage.acceptedProposals;
}

// The improve_runs read lives in the owner module (core/state-db.ts) so this
// command file holds no raw SQL. `ImproveRunRow` aliases the owner's row shape.
type ImproveRunRow = ImproveRunSummaryRow;

function compareImproveRunRecency(a: ImproveRunRow, b: ImproveRunRow): number {
  const started = a.started_at.localeCompare(b.started_at);
  if (started !== 0) return started;
  const completed = (a.completed_at ?? "").localeCompare(b.completed_at ?? "");
  if (completed !== 0) return completed;
  return a.id.localeCompare(b.id);
}

export function summarizeImproveRuns(
  db: Database,
  since: string,
  until?: string,
): { metrics: ImproveHealthMetrics; runCount: number } {
  const accum = createUnknownImproveMetrics();
  const rows = queryImproveRuns(db, since, until);

  // Per-phase wall-time samples. Each entry is one envelope's durationMs for
  // that phase. Phases that did not run on a given envelope are simply
  // omitted (NOT counted as 0) so the median/p95 reflect actual phase work.
  const phaseDurations = {
    consolidation: [] as number[],
    memoryInference: [] as number[],
    graphExtraction: [] as number[],
  };

  // memorySummary is a whole-stash snapshot per run, so the window value is the
  // MOST RECENT run's snapshot (current state) — not a sum across runs.
  let latestCompleteRow: ImproveRunRow | undefined;
  let latestMemorySummary: ImproveHealthMetrics["memorySummary"] | undefined;
  let latestStrategyFilteredRefs = 0;

  if (!accum.resultRows) throw new Error("invariant: improve result-row accounting was not initialized");
  accum.resultRows.total = rows.length;

  for (const row of rows) {
    let decoded: ReturnType<typeof decodeImproveResult>;
    try {
      decoded = decodeImproveResult(row.result_json);
    } catch {
      accum.resultRows.skipped.invalid += 1;
      continue;
    }
    accum.resultRows.included += 1;
    if (decoded.normalizedLegacyPartial) accum.resultRows.normalized += 1;
    const result = decoded.envelope as unknown as Record<string, unknown>;
    const perRow = projectRunMetrics(result);
    mergeImproveMetrics(accum, perRow);

    const startMs = new Date(row.started_at).getTime();
    if (
      !decoded.normalizedLegacyPartial &&
      result.terminated === undefined &&
      Number.isFinite(startMs) &&
      (latestCompleteRow === undefined || compareImproveRunRecency(row, latestCompleteRow) > 0)
    ) {
      latestCompleteRow = row;
      latestMemorySummary = perRow.memorySummary;
      latestStrategyFilteredRefs = perRow.strategyFilteredRefs;
    }

    // Collect per-phase durations directly off the envelope. consolidation's
    // duration lives inside the sub-object; memoryInference and graphExtraction
    // expose top-level *DurationMs keys (`memoryInferenceDurationMs`,
    // `graphExtractionDurationMs`) when they actually ran on that envelope.
    const consol = result.consolidation as { durationMs?: unknown } | undefined;
    const consolMs = toFiniteNumber(consol?.durationMs);
    if (consolMs > 0) phaseDurations.consolidation.push(consolMs);
    const memMs = toFiniteNumber(result.memoryInferenceDurationMs);
    if (memMs > 0) phaseDurations.memoryInference.push(memMs);
    const graphMs = toFiniteNumber(result.graphExtractionDurationMs);
    if (graphMs > 0) phaseDurations.graphExtraction.push(graphMs);
  }

  finalizeImproveMetrics(accum);
  if (latestMemorySummary) accum.memorySummary = latestMemorySummary;
  accum.strategyFilteredRefs = latestStrategyFilteredRefs;
  accum.wallTime.byPhase = {
    consolidation: summarizePhaseDurations(phaseDurations.consolidation),
    memoryInference: summarizePhaseDurations(phaseDurations.memoryInference),
    graphExtraction: summarizePhaseDurations(phaseDurations.graphExtraction),
  };
  return { metrics: accum, runCount: rows.length };
}

/**
 * Aggregate a list of per-envelope phase durations into the
 * `wallTime.byPhase.*` shape: count, total, median, p95. Median/p95 use the
 * same nearest-rank picker as the top-level wallTime stats so the two are
 * comparable.
 */
export function summarizePhaseDurations(samples: number[]): {
  count: number;
  totalMs: number;
  medianMs: number;
  p95Ms: number;
} {
  if (samples.length === 0) return { count: 0, totalMs: 0, medianMs: 0, p95Ms: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const totalMs = sorted.reduce((acc, n) => acc + n, 0);
  return {
    count: sorted.length,
    totalMs,
    medianMs: pick(0.5),
    p95Ms: pick(0.95),
  };
}

/**
 * Project an improve_runs row + wall-time lookup into a single ImproveRunSummary.
 * Used by `akm health --detail per-run`.
 */
export function projectImproveRunSummary(row: ImproveRunRow, wallTimeMs: number, taskId: string): ImproveRunSummary {
  let result: Record<string, unknown> = {};
  let resultStatus: NonNullable<ImproveRunSummary["resultStatus"]> = "invalid";
  try {
    const decoded = decodeImproveResult(row.result_json);
    result = decoded.envelope as unknown as Record<string, unknown>;
    resultStatus = decoded.normalizedLegacyPartial ? "normalized" : "valid";
  } catch {
    // Keep the persisted row visible in per-run output, but do not project its
    // unknown payload or admit its duration to result-derived denominators.
    wallTimeMs = 0;
  }
  const perRow = projectRunMetrics(result);
  finalizeImproveMetrics(perRow);

  const orphansPurged = toFiniteNumber(result.orphansPurged);
  const lintSummary = result.lintSummary as Record<string, unknown> | undefined;
  const lintFixed = lintSummary ? toFiniteNumber(lintSummary.fixed) : 0;
  const lintFlagged = lintSummary ? toFiniteNumber(lintSummary.flagged) : 0;

  return {
    id: row.id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    wallTimeMs,
    ok: row.ok === 1,
    resultStatus,
    resultComplete: resultStatus === "valid" && result.terminated === undefined,
    strategy: row.strategy,
    legacyProfile: row.legacyProfile,
    scope: {
      mode: row.scope_mode,
      ...(row.scope_value ? { value: row.scope_value } : {}),
    },
    taskId,
    actions: perRow.actions,
    memorySummary: perRow.memorySummary,
    memoryCleanup: perRow.memoryCleanup,
    consolidation: perRow.consolidation,
    memoryInference: perRow.memoryInference,
    graphExtraction: perRow.graphExtraction,
    reflectsWithErrorContext: perRow.reflectsWithErrorContext,
    evalCasesWritten: perRow.evalCasesWritten,
    orphansPurged,
    lintFixed,
    lintFlagged,
  };
}

function emptyPhaseStats(): ImproveHealthMetrics["wallTime"]["byPhase"] {
  return {
    consolidation: { count: 0, totalMs: 0, medianMs: 0, p95Ms: 0 },
    memoryInference: { count: 0, totalMs: 0, medianMs: 0, p95Ms: 0 },
    graphExtraction: { count: 0, totalMs: 0, medianMs: 0, p95Ms: 0 },
  };
}

export function computeWallTimeStats(
  durationsMs: number[],
  byPhase?: ImproveHealthMetrics["wallTime"]["byPhase"],
): ImproveHealthMetrics["wallTime"] {
  const phase = byPhase ?? emptyPhaseStats();
  if (durationsMs.length === 0) return { count: 0, medianMs: 0, p95Ms: 0, minMs: 0, maxMs: 0, byPhase: phase };
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return {
    count: sorted.length,
    medianMs: pick(0.5),
    p95Ms: pick(0.95),
    minMs: sorted[0] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
    byPhase: phase,
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
  //    current snapshot — matching how memorySummary/strategyFilteredRefs are
  //    handled. Events arrive in chronological (offset) order, so the last
  //    count-bearing event per reason is the latest run's value.
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
