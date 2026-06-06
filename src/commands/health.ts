// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { loadConfig } from "../core/config";
import { ConfigError, UsageError } from "../core/errors";
import { appendEvent, readEvents } from "../core/events";
import { getStateDbPathInDataDir } from "../core/paths";
import { openStateDatabase, queryTaskHistory, type TaskHistoryRow } from "../core/state-db";
import { parseSinceToIso } from "../core/time";
import { readSemanticStatus } from "../indexer/semantic-status";
import type { AgentProfile } from "../integrations/agent";
import { detectAgentCliProfiles, requireAgentProfile } from "../integrations/agent";
import type { SessionLogEntry } from "../integrations/session-logs";
import { getExecutionLogCandidates } from "../integrations/session-logs";

export interface HealthCheckResult {
  name: string;
  kind: "deterministic" | "heuristic";
  status: "pass" | "warn" | "fail" | "unknown";
  message: string;
  confidence: "high" | "medium" | "low";
  evidence?: Record<string, unknown>;
}

export interface HealthMetrics {
  taskFailRate: number;
  agentFailureRate: number;
  stuckActiveRuns: number;
  logBackingRate: number;
  probeRoundTripMs: number | null;
}

export interface ImproveHealthMetrics {
  invoked: number;
  completed: number;
  skipped: number;
  skipReasons: Record<string, number>;
  plannedRefs: number;
  /**
   * Refs the planner dropped up-front because no enabled pass on the active
   * profile would accept them (e.g. `script:*` for reflect+distill). Sourced
   * from `improve_runs.result_json.profileFilteredRefs[]`. Wired 2026-05-27
   * after the planner pre-filter at improve.ts:collectEligibleRefs landed
   * in commit 0e9f283 but the metric reader was missed.
   */
  profileFilteredRefs: number;
  actions: {
    /**
     * Reflect action outcomes split by mode. Sourced from improve_runs.result_json
     * rather than the lossy events.metadata projection.
     */
    reflect: {
      ok: number;
      failed: number;
      cooldown: number;
      skipped: number;
      /**
       * Content-policy guard rejections (e.g. reflect size-rail hits:
       * `EXCESSIVE_SHRINKAGE` / `EXCESSIVE_EXPANSION`). These are NOT LLM
       * faults — the LLM produced a syntactically valid response and a
       * downstream deterministic guard blocked it. Split out of `failed`
       * so failure-rate dashboards do not conflate "model is broken" with
       * "model proposed an unsafe edit and we caught it". See
       * `/tmp/akm-health-investigations/metrics-taxonomy-review.md` §1a.
       */
      guardRejected: number;
      /**
       * Breakdown of `skipped` reflects by sub-reason. Sourced from
       * `actions[].result.reason` for `mode === "reflect-skipped"` entries.
       * Mirrors {@link distill.deferredByReason} (commit `d1273d0`). Values
       * observed today: `type-filter`, `raw-wiki`, `process-disabled`,
       * `unsupported_type`, `derived-memory-reflect-skipped`. Totals here
       * should match `skipped`. Pre-2026-05-26 this was discarded by the
       * rollup — the 18/18 reflect-skipped runs in `release/0.8.0` could not
       * be tuned because no operator could see WHY they were skipped. See
       * `/tmp/akm-health-investigations/tuning-reasons-investigation.md` §Q1.
       */
      skippedByReason: Record<string, number>;
    };
    /**
     * Distill outcomes split by `AkmDistillResult.outcome`. `skipped` here is
     * the distill-skipped action mode (cooldown), not the same as
     * `outcome: "skipped"` inside a successful distill envelope.
     */
    distill: {
      queued: number;
      llmFailed: number;
      /**
       * Sum of `judgeRejected + validatorRejected`. Retained for
       * backward-compatibility with pre-2026-05-26 consumers; new dashboards
       * should prefer the split fields below.
       */
      qualityRejected: number;
      /**
       * LLM-judge rejection (outcomes `quality_rejected` and `review_needed`).
       * Tuning lever: prompt/temperature/model — the judge said the output
       * was substantively low quality. Pre-2026-05-26 lumped with
       * deterministic lint failures under `qualityRejected`. See review §1b.
       */
      judgeRejected: number;
      /**
       * Deterministic lint/schema validator rejection (outcome
       * `validation_failed`). Tuning lever: validator config / prompt schema
       * — the LLM is fine, our post-LLM validators rejected the artifact.
       * In live 7d data, 29/29 of the legacy `qualityRejected` bucket were
       * actually this case.
       */
      validatorRejected: number;
      configDisabled: number;
      skipped: number;
      /**
       * Breakdown of `skipped` distill actions by sub-reason. Sourced from
       * `actions[].result.reason` for `mode === "distill-skipped"` entries.
       * Mirrors {@link reflect.skippedByReason} (commit `b3c2328`) so per-
       * reason tuning is possible. Reasons observed in production:
       * `no new signal since last proposal`, `distill signal-delta`,
       * `derived-memory-reflect-skipped`, `type-filter`, `raw-wiki`,
       * `process-disabled`, `pending proposal exists`,
       * `distill reject grace window`, `memory requires recent feedback signal`.
       * Totals here should match `skipped`. Pre-2026-05-27 these 7+ reasons
       * collapsed into a single counter; 62 539 events/7d on `release/0.8.0`
       * had no sub-reason visibility — see
       * `/tmp/akm-health-investigations/planner-profile-metrics-deep-analysis.md` §3.
       *
       * TODO(naming): `distill.skipped` is the SYNTHETIC pre-loop skip
       * counter; the REAL "LLM was called and returned skipped" counter is
       * `distill.deferred`. The names are swapped from intuition. The deep
       * analysis report (P2 follow-up) flagged the rename as a separate,
       * out-of-scope cleanup.
       */
      skippedByReason: Record<string, number>;
      /**
       * Distill actions where the planner produced a result with
       * `outcome: "skipped"` — i.e. the LLM was either bypassed by an
       * input-type guard (`recursive_lesson_input`), resolved a destination
       * conflict as NOOP, or its proposal was deduped at the persistence
       * layer (cooldown / content-hash match). These are successful no-ops,
       * not failures. Pre-2026-05-26 they were dropped on the floor by
       * health.ts (no `case "skipped"`). 465 events/7d were invisible in
       * the user's stack. See review §1d.
       */
      deferred: number;
      /** Breakdown of `deferred` by `skipReason` field on the result. */
      deferredByReason: Record<string, number>;
    };
    memoryPrune: number;
    memoryInference: number;
    graphExtraction: number;
    error: number;
  };
  autoAccept: {
    /** Total proposals promoted by the auto-accept gate across all phases. */
    promoted: number;
    /**
     * Total proposals that passed the confidence threshold but failed
     * validation during auto-accept (e.g. truncated description, invalid
     * frontmatter). These remain in the queue for manual review.
     */
    validationFailed: number;
  };
  reflectsWithErrorContext: number;
  coverageGapCount: number;
  evalCasesWritten: number;
  deadUrlCount: number;
  memorySummary: {
    eligible: number;
    derived: number;
  };
  memoryCleanup: {
    pruneCandidates: number;
    contradictionCandidates: number;
    beliefStateTransitions: number;
    consolidationCandidates: number;
    archived: number;
    warnings: number;
  };
  consolidation: {
    ran: boolean;
    processed: number;
    promoted: number;
    merged: number;
    deleted: number;
    contradicted: number;
    /**
     * Memories the LLM "saw" inside a chunk but proposed no op for. Computed
     * per chunk as `chunk.length − unique(ops.targetRefs)` and accumulated
     * across all chunks in a run. Pre-2026-05-26 this was completely
     * invisible: 78/119 (66%) of memories in the 23:07 UTC cron run had no
     * warning, event, or counter — they were a pure silent drop. Without
     * this metric no consolidate prompt tuning is empirically possible. See
     * `/tmp/akm-health-investigations/tuning-reasons-investigation.md` §Q2.
     */
    judgedNoAction: number;
    /**
     * Secondary memories absorbed into successful merge operations across the
     * window. 2026-05-26 accounting-leak fix: `merged` is op-level, but each
     * successful merge actions `1 + secondaries.length` memories — without
     * this counter the invariant
     * `processed == promoted + merged + mergedSecondaries + deleted + contradicted
     *           + judgedNoAction + Σ(skipReasons) + failedChunkMemories`
     * does not hold.
     */
    mergedSecondaries: number;
    /**
     * Memories in chunks whose LLM call failed (transport / invalid plan /
     * abort) before any per-chunk noAction calculation could run. 2026-05-26
     * accounting-leak fix: without this bucket, `failedChunks > 0` runs
     * silently dropped `Σ(failed_chunk.length)` memories from the envelope's
     * accounting.
     */
    failedChunkMemories: number;
    /**
     * Histogram of structured per-op skip reasons emitted by `consolidate.ts`
     * when a deterministic post-LLM guard rejects an operation the LLM
     * proposed. Codes observed in production: `dedup_pending_proposal`,
     * `captureMode_hot_refused`, `merge_missing_description`,
     * `merge_sanitization_failed`, `merge_invalid_frontmatter`,
     * `merge_truncated_description`, `merge_content_preservation_failed`,
     * `merge_participant_blocked`, `promote_source_too_small`,
     * `promote_dedup_window`, `promote_already_promoted_this_run`,
     * `promote_already_exists`, `promote_superseded`,
     * `promote_sanitization_failed`, `promote_invalid_frontmatter`,
     * `contradict_target_missing`. Each bucket is a separate tuning knob
     * (queue cleanup, memory recategorization, prompt fix, etc.). Pre-fix
     * these were buried in `warnings: string[]` as freeform English. See
     * review §1e and tuning investigation §Q2.
     */
    skipReasons: Record<string, number>;
    /**
     * Aggregated count of chunks that failed (HTTP error / empty response /
     * invalid plan) across runs in the window. Pre-2026-05-26 this was
     * invisible: a 100%-failure run still reported a healthy
     * `processed = memories.length` and `ok: true`. See
     * `/tmp/akm-health-investigations/consolidation-no-op.md`.
     */
    failedChunks: number;
    /** Aggregated total chunks attempted across runs in the window. */
    totalChunks: number;
    durationMs: number;
  };
  memoryInference: {
    ran: boolean;
    /** All pending parents inspected this run, including cache hits. */
    considered: number;
    /**
     * Parents whose body hash matched a prior LLM call's cached result.
     * Surfacing this separately keeps the operational yield rate
     * interpretable as the cache warms — without it, `written / considered`
     * collapses toward zero just because the cache absorbs most candidates.
     */
    cacheHits: number;
    /** `considered - cacheHits - skippedAborted` — the number of parents that actually hit the LLM. Budget-abort items return {aborted:true} with no LLM call; excluding them from the denominator prevents budget-exhaustion from appearing as a quality regression. */
    freshAttempts: number;
    splitParents: number;
    written: number;
    skippedNoFacts: number;
    /**
     * LLM produced a valid derived draft but `<parent>.derived.md` already
     * existed on disk (or the write threw). Without this counter the
     * attempt would silently inflate `freshAttempts` and tank the
     * health-reported yield rate. Plumbed straight through from the
     * `memoryInference` envelope.
     */
    skippedChildExists: number;
    /**
     * Records short-circuited by an abort signal before issuing a fresh
     * LLM call. Counted (rather than dropped) so `considered` decomposes
     * cleanly and aborts do not pollute yield.
     */
    skippedAborted: number;
    /**
     * Catch-all for per-record outcomes the pass could not categorise.
     * Should stay zero; a non-zero value means a code path is leaking
     * attempts past the counter taxonomy.
     */
    unaccounted: number;
    /**
     * Parents whose LLM call returned an HTML body (e.g. LM Studio serving its
     * web UI) instead of JSON. Surfaced distinctly from `skippedNoFacts` so a
     * provider-load failure is observable rather than masked as an empty-result
     * skip. Sourced from the `memoryInference` envelope's `htmlErrorCount`.
     */
    htmlErrorCount: number;
    /**
     * Count of envelopes that contributed to the yield denominator. A run
     * is yield-eligible iff its `memoryInference` envelope has a
     * `cacheHits` field (i.e. it post-dates the cache-hits metric). Older
     * envelopes are still counted in `considered`/`written` but excluded
     * from `freshAttempts` and `yieldRate` so legacy data does not drag
     * the rate down. See investigation 2026-05-26.
     */
    yieldEligibleRuns: number;
    /**
     * Sum of `considered` across yield-eligible runs only. This — not the
     * top-level `considered` — is what `freshAttempts` is derived from.
     */
    yieldEligibleConsidered: number;
    /**
     * Sum of `writtenFacts` across yield-eligible runs only. Numerator of
     * the gated `yieldRate`.
     */
    yieldEligibleWritten: number;
    /**
     * `written / freshAttempts`, 4dp; 0 when freshAttempts=0.
     *
     * Was previously `written / considered`. Changed 2026-05-25 because
     * the cache-hit denominator inflation made the metric drift toward
     * zero as the cache warmed even when actual extraction productivity
     * was steady. Use `freshAttempts` as the denominator so the rate
     * reflects "of the parents we actually re-inferred, how many produced
     * a fact?" — independent of cache state.
     */
    yieldRate: number;
    durationMs: number;
    /** @deprecated use `written` — kept as a soft-compat alias through 0.8.0. */
    writes: number;
  };
  graphExtraction: {
    ran: boolean;
    extractedFiles: number;
    entities: number;
    relations: number;
    cacheHits: number;
    cacheMisses: number;
    /** hits / (hits + misses), 4dp; 0 when both are 0. */
    cacheHitRate: number;
    truncations: number;
    failures: number;
    /**
     * Asset extractions where the provider returned an HTML body (e.g. LM
     * Studio serving its web UI) instead of JSON. Tracked distinctly from
     * `failures` so a provider-load failure is observable rather than folded
     * into the generic failure count. Sourced from the graph-extraction
     * telemetry's `htmlErrorCount`.
     */
    htmlErrors: number;
    durationMs: number;
  };
  /**
   * Session-extraction pass metrics (Phase 0.4 — `akmExtract`).
   * Aggregated across all harnesses and runs in the window.
   * `ran` is false when session_extraction is disabled or no harness
   * was available. `sessionsExtracted` counts sessions that produced
   * at least one proposal; `sessionsSkipped` counts already-seen
   * sessions deduped by state.db.
   */
  sessionExtraction: {
    ran: boolean;
    sessionsScanned: number;
    sessionsExtracted: number;
    sessionsSkipped: number;
    proposalsCreated: number;
    warnings: number;
    durationMs: number;
  };
  wallTime: {
    count: number;
    medianMs: number;
    p95Ms: number;
    minMs: number;
    maxMs: number;
    /**
     * Per-phase wall-time aggregates derived from per-envelope `durationMs`
     * fields that the passes already record. Answers "where did the 19-min
     * p95 go?" without raw envelope spelunking.
     *
     * Only phases that record their own durationMs surface here:
     *   - consolidation: from `consolidation.durationMs` on each envelope.
     *   - memoryInference: from top-level `memoryInferenceDurationMs`.
     *   - graphExtraction: from top-level `graphExtractionDurationMs`.
     *
     * `count` is the number of envelopes that contributed a duration (i.e.
     * the phase actually ran on that run). `totalMs` is the sum across the
     * window. Reflect and distill per-loop aggregates are deferred — only
     * per-action `durationMs` is recorded today; aggregating them is the
     * P1 follow-up (review §3 / P1 #8). See
     * `/tmp/akm-health-investigations/metrics-taxonomy-review.md` §1k.
     */
    byPhase: {
      consolidation: { count: number; totalMs: number; medianMs: number; p95Ms: number };
      memoryInference: { count: number; totalMs: number; medianMs: number; p95Ms: number };
      graphExtraction: { count: number; totalMs: number; medianMs: number; p95Ms: number };
    };
  };
}

export interface SessionLogAdvisory {
  topic: string;
  frequency: number;
  source: string;
  isFailurePattern: boolean;
}

export interface ImproveRunSummary {
  id: string;
  startedAt: string;
  completedAt: string;
  wallTimeMs: number;
  ok: boolean;
  scope: { mode: string; value?: string };
  actions: ImproveHealthMetrics["actions"];
  memorySummary: ImproveHealthMetrics["memorySummary"];
  memoryCleanup: ImproveHealthMetrics["memoryCleanup"];
  consolidation: ImproveHealthMetrics["consolidation"];
  memoryInference: ImproveHealthMetrics["memoryInference"];
  graphExtraction: ImproveHealthMetrics["graphExtraction"];
  reflectsWithErrorContext: number;
  evalCasesWritten: number;
  orphansPurged: number;
  lintFixed: number;
  lintFlagged: number;
}

export interface WindowSpec {
  name: string;
  since: string;
  until?: string;
}

export interface WindowResult {
  name: string;
  since: string;
  until: string;
  runs: number;
  improve: ImproveHealthMetrics;
  metrics: HealthMetrics;
}

export interface DeltaEntry {
  from: number;
  to: number;
  pctChange: number | string;
}

export interface AkmHealthResult {
  schemaVersion: 2;
  ok: boolean;
  status: "pass" | "warn" | "fail";
  since: string;
  hardChecks: HealthCheckResult[];
  advisories: HealthCheckResult[];
  metrics: HealthMetrics;
  improve: ImproveHealthMetrics;
  sessionLogAdvisories: SessionLogAdvisory[];
  runs?: ImproveRunSummary[];
  windows?: WindowResult[];
  deltas?: Record<string, DeltaEntry>;
}

export interface AkmHealthOptions {
  since?: string;
  /** Row grouping. `run` emits one row per improve_runs entry (was `--detail per-run`). */
  groupBy?: "run";
  windowCompare?: string;
  windows?: WindowSpec[];
  getExecutionLogCandidatesFn?: (sinceDays?: number) => SessionLogEntry[];
}

const DEFAULT_SINCE_MS = 24 * 60 * 60 * 1000;
const IMPROVE_COMPLETED_EVENT = "improve_completed";
const HEALTH_PROBE_EVENT = "health_probe";
const ACTIVE_RUN_WARN_MS = 15 * 60 * 1000;

export function parseHealthSince(since?: string): string {
  if (since === undefined || since.trim() === "") {
    return new Date(Date.now() - DEFAULT_SINCE_MS).toISOString();
  }
  const trimmed = since.trim();
  const durationMatch = trimmed.match(/^(\d+)([dhm])$/i);
  if (durationMatch) {
    const amount = Number.parseInt(durationMatch[1] ?? "0", 10);
    const unit = (durationMatch[2] ?? "d").toLowerCase();
    if (!Number.isFinite(amount) || amount < 0) {
      throw new UsageError("--since must be a non-negative duration or timestamp.", "INVALID_FLAG_VALUE");
    }
    const multiplier = unit === "h" ? 60 * 60 * 1000 : unit === "m" ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    return new Date(Date.now() - amount * multiplier).toISOString();
  }
  return parseSinceToIso(trimmed);
}

function roundRate(value: number): number {
  return Number(value.toFixed(4));
}

function parseTaskMetadata(row: TaskHistoryRow): {
  durationMs?: number;
  detail?: Record<string, unknown>;
  profile?: string;
} {
  try {
    return JSON.parse(row.metadata_json) as { durationMs?: number; detail?: Record<string, unknown>; profile?: string };
  } catch {
    return {};
  }
}

function createUnknownImproveMetrics(): ImproveHealthMetrics {
  return {
    invoked: 0,
    completed: 0,
    skipped: 0,
    skipReasons: {},
    plannedRefs: 0,
    profileFilteredRefs: 0,
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

/**
 * Event-derived metrics. Only `completed` and skipReasons/invoked are sourced
 * from events in v2 — the richer fields come from {@link summarizeImproveRuns}.
 * The function still receives `improve_completed` events so that the completed
 * count reflects the canonical event stream (it lines up 1:1 with improve_runs
 * rows in practice, but the events table remains the system-of-record for the
 * existence of a run).
 */
function summarizeImproveCompleted(events: ReturnType<typeof readEvents>["events"]): ImproveHealthMetrics {
  const metrics = createUnknownImproveMetrics();
  metrics.completed = events.length;
  return metrics;
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

  // profileFilteredRefs (array of {ref, reason}) — 2026-05-27: pre-filter
  // bucket from `collectEligibleRefs` so the metric reflects work the
  // planner dropped before signal-delta / per-pass dispatch.
  const profileFilteredRefs = result.profileFilteredRefs;
  if (Array.isArray(profileFilteredRefs)) metrics.profileFilteredRefs += profileFilteredRefs.length;

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
              const explicitReason = typeof r?.skipReason === "string" ? r.skipReason : undefined;
              const msg = typeof r?.message === "string" ? r.message : "";
              let reason = explicitReason ?? "unknown";
              if (!explicitReason) {
                if (/lesson inputs/i.test(msg)) reason = "recursive_lesson_input";
                else if (/NOOP/.test(msg)) reason = "conflict_noop";
                else if (/cooldown/i.test(msg)) reason = "proposal_cooldown";
                else if (/content[_ ]?hash/i.test(msg)) reason = "content_hash_match";
              }
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
  }

  const memoryInference = result.memoryInference as Record<string, unknown> | undefined;
  if (memoryInference) {
    const considered = toFiniteNumber(memoryInference.considered);
    const writtenFacts = toFiniteNumber(memoryInference.writtenFacts);
    metrics.memoryInference.considered += considered;
    metrics.memoryInference.cacheHits += toFiniteNumber(memoryInference.cacheHits);
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
  dst.profileFilteredRefs += src.profileFilteredRefs;
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
  dst.memorySummary.eligible += src.memorySummary.eligible;
  dst.memorySummary.derived += src.memorySummary.derived;
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
  dst.graphExtraction.durationMs += src.graphExtraction.durationMs;
  dst.sessionExtraction.sessionsScanned += src.sessionExtraction.sessionsScanned;
  dst.sessionExtraction.sessionsExtracted += src.sessionExtraction.sessionsExtracted;
  dst.sessionExtraction.sessionsSkipped += src.sessionExtraction.sessionsSkipped;
  dst.sessionExtraction.proposalsCreated += src.sessionExtraction.proposalsCreated;
  dst.sessionExtraction.warnings += src.sessionExtraction.warnings;
  dst.sessionExtraction.durationMs += src.sessionExtraction.durationMs;
}

interface ImproveRunRow {
  id: string;
  started_at: string;
  completed_at: string;
  ok: number;
  scope_mode: string;
  scope_value: string | null;
  result_json: string;
}

function loadImproveRunRows(db: Database, since: string, until?: string): ImproveRunRow[] {
  const sql = until
    ? "SELECT id, started_at, completed_at, ok, scope_mode, scope_value, result_json FROM improve_runs WHERE started_at >= ? AND started_at < ? AND dry_run = 0 ORDER BY started_at DESC"
    : "SELECT id, started_at, completed_at, ok, scope_mode, scope_value, result_json FROM improve_runs WHERE started_at >= ? AND dry_run = 0 ORDER BY started_at DESC";
  return (until ? db.prepare(sql).all(since, until) : db.prepare(sql).all(since)) as ImproveRunRow[];
}

function summarizeImproveRuns(
  db: Database,
  since: string,
  until?: string,
): { metrics: ImproveHealthMetrics; runCount: number } {
  const accum = createUnknownImproveMetrics();
  const rows = loadImproveRunRows(db, since, until);

  // Per-phase wall-time samples. Each entry is one envelope's durationMs for
  // that phase. Phases that did not run on a given envelope are simply
  // omitted (NOT counted as 0) so the median/p95 reflect actual phase work.
  const phaseDurations = {
    consolidation: [] as number[],
    memoryInference: [] as number[],
    graphExtraction: [] as number[],
  };

  for (const row of rows) {
    let result: Record<string, unknown>;
    try {
      result = JSON.parse(row.result_json) as Record<string, unknown>;
    } catch {
      continue;
    }
    const perRow = projectRunMetrics(result);
    mergeImproveMetrics(accum, perRow);

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
function summarizePhaseDurations(samples: number[]): {
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
function projectImproveRunSummary(row: ImproveRunRow, wallTimeMs: number): ImproveRunSummary {
  let result: Record<string, unknown> = {};
  try {
    result = JSON.parse(row.result_json) as Record<string, unknown>;
  } catch {
    // fall through with empty result so per-stage rollups are zeros
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
    scope: {
      mode: row.scope_mode,
      ...(row.scope_value ? { value: row.scope_value } : {}),
    },
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

interface TaskRunInterval {
  startMs: number;
  endMs: number;
  durationMs: number;
}

/**
 * Load task_history intervals for `task_id='akm-improve'` in the window.
 * Returned sorted by startMs ascending so containment lookups can use a
 * linear scan (typical N is ~24/day; not worth a tree).
 *
 * The window filter is widened by 5 minutes on each side because the cron
 * task wraps `akm improve` — the task `started_at` fires at e.g. :07:01
 * while `recordImproveRun` writes the matching `improve_runs.started_at`
 * later (after config load, planning, etc.), so the improve_runs row can
 * be inside the window even when its enclosing task_history row started
 * just before the window opened.
 */
function loadTaskIntervals(db: Database, since: string, until?: string): TaskRunInterval[] {
  const sinceMs = new Date(since).getTime();
  const untilMs = until ? new Date(until).getTime() : Number.POSITIVE_INFINITY;
  const widenedSince = new Date(sinceMs - 5 * 60 * 1000).toISOString();
  const widenedUntil = Number.isFinite(untilMs) ? new Date(untilMs + 5 * 60 * 1000).toISOString() : undefined;

  const sql = widenedUntil
    ? "SELECT started_at, completed_at FROM task_history WHERE task_id = 'akm-improve' AND started_at >= ? AND started_at < ? AND completed_at IS NOT NULL ORDER BY started_at"
    : "SELECT started_at, completed_at FROM task_history WHERE task_id = 'akm-improve' AND started_at >= ? AND completed_at IS NOT NULL ORDER BY started_at";
  const rows = (
    widenedUntil ? db.prepare(sql).all(widenedSince, widenedUntil) : db.prepare(sql).all(widenedSince)
  ) as Array<{
    started_at: string;
    completed_at: string;
  }>;

  const intervals: TaskRunInterval[] = [];
  for (const row of rows) {
    const startMs = new Date(row.started_at).getTime();
    const endMs = new Date(row.completed_at).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) continue;
    intervals.push({ startMs, endMs, durationMs: endMs - startMs });
  }
  return intervals;
}

/**
 * Find the task_history interval that contains the given timestamp. The
 * task wraps `akm improve`, so `improve_runs.started_at` (when
 * `recordImproveRun` writes) always falls inside the enclosing task's
 * [started_at, completed_at]. Returns undefined when no interval
 * contains the timestamp (which happens for manually-invoked improve
 * runs not driven by the `akm-improve` task).
 *
 * Linear scan because N is small. We tolerate a 1s slop on the upper
 * bound to handle clock skew between the wrapper's `completed_at` write
 * and recordImproveRun's `started_at` write.
 */
function findContainingTaskInterval(timestampMs: number, intervals: TaskRunInterval[]): TaskRunInterval | undefined {
  const SLOP_MS = 1000;
  for (const interval of intervals) {
    if (timestampMs >= interval.startMs && timestampMs <= interval.endMs + SLOP_MS) {
      return interval;
    }
  }
  return undefined;
}

function buildPerRunSummaries(db: Database, since: string, until?: string): ImproveRunSummary[] {
  const rows = loadImproveRunRows(db, since, until);
  const taskIntervals = loadTaskIntervals(db, since, until);
  const summaries: ImproveRunSummary[] = [];
  for (const row of rows) {
    const startMs = new Date(row.started_at).getTime();
    const endMs = new Date(row.completed_at).getTime();
    // Prefer the improve_runs row's own (completed_at - started_at) delta:
    // recordImproveRun now persists distinct start/end timestamps, so the
    // row's own delta is the authoritative per-run wall time even for
    // manually-invoked `akm improve` runs with no enclosing task_history.
    // Only fall back to the task_history containing-interval join for legacy/
    // backfill rows where started_at == completed_at (row delta is 0).
    const hasRowDelta = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs;
    let wallTimeMs: number;
    if (hasRowDelta) {
      wallTimeMs = endMs - startMs;
    } else {
      const interval = Number.isFinite(startMs) ? findContainingTaskInterval(startMs, taskIntervals) : undefined;
      wallTimeMs = interval?.durationMs ?? 0;
    }
    summaries.push(projectImproveRunSummary(row, wallTimeMs));
  }
  return summaries;
}

function emptyPhaseStats(): ImproveHealthMetrics["wallTime"]["byPhase"] {
  return {
    consolidation: { count: 0, totalMs: 0, medianMs: 0, p95Ms: 0 },
    memoryInference: { count: 0, totalMs: 0, medianMs: 0, p95Ms: 0 },
    graphExtraction: { count: 0, totalMs: 0, medianMs: 0, p95Ms: 0 },
  };
}

function computeWallTimeStats(
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

function buildImproveSkipSummary(events: ReturnType<typeof readEvents>["events"]): {
  skipped: number;
  skipReasons: Record<string, number>;
} {
  const skipReasons: Record<string, number> = {};
  for (const event of events) {
    const reason =
      typeof event.metadata?.reason === "string" && event.metadata.reason.trim() ? event.metadata.reason : "unknown";
    skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
  }
  return { skipped: events.length, skipReasons };
}

function probeStateDbRoundTrip(stateDbPath: string): { ok: boolean; durationMs: number | null; error?: string } {
  const before = readEvents({}, { dbPath: stateDbPath }).nextOffset;
  const started = Date.now();
  appendEvent(
    { eventType: HEALTH_PROBE_EVENT, ref: "health:probe", metadata: { source: "akm health" } },
    { dbPath: stateDbPath },
  );
  const after = readEvents(
    { sinceOffset: before, type: HEALTH_PROBE_EVENT, ref: "health:probe" },
    { dbPath: stateDbPath },
  );
  const durationMs = Date.now() - started;
  if (after.events.length === 0 || after.nextOffset <= before) {
    return { ok: false, durationMs, error: "probe event was not readable after append" };
  }
  return { ok: true, durationMs };
}

function runAgentProbe(): HealthCheckResult {
  const config = loadConfig();

  // v2: check profiles.agent first
  if (config.profiles?.agent) {
    const defaultName = config.defaults?.agent;
    const profileCount = Object.keys(config.profiles.agent).length;
    if (profileCount === 0) {
      return {
        name: "agent-profile",
        kind: "deterministic",
        status: "unknown",
        confidence: "high",
        message: "No agent profiles configured in profiles.agent.",
      };
    }
    const profileName = defaultName ?? Object.keys(config.profiles.agent)[0];
    const profile = config.profiles.agent[profileName];
    return {
      name: "agent-profile",
      kind: "deterministic",
      status: "pass",
      confidence: "high",
      message: `v2 agent profile "${profileName}" configured (platform: ${profile?.platform ?? "unknown"}).`,
      evidence: { profile: profileName, platform: profile?.platform, profileCount },
    };
  }

  if (!config.profiles?.agent && !config.defaults?.agent) {
    return {
      name: "agent-profile",
      kind: "deterministic",
      status: "unknown",
      confidence: "high",
      message: "No agent config present.",
    };
  }

  let profile: AgentProfile;
  try {
    profile = requireAgentProfile(config);
  } catch (error) {
    return {
      name: "agent-profile",
      kind: "deterministic",
      status: "warn",
      confidence: "high",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (profile.sdkMode === true) {
    return {
      name: "agent-profile",
      kind: "deterministic",
      status: profile.model ? "pass" : "warn",
      confidence: "high",
      message: profile.model
        ? `SDK mode profile "${profile.name}" is configured.`
        : `SDK mode profile "${profile.name}" has no explicit model.`,
      evidence: { profile: profile.name, sdkMode: true, model: profile.model ?? null },
    };
  }

  const detections = detectAgentCliProfiles(config);
  const detection = detections.find((entry) => entry.name === profile.name);
  if (!detection?.available) {
    return {
      name: "agent-profile",
      kind: "deterministic",
      status: "fail",
      confidence: "high",
      message: `Default agent profile "${profile.name}" is not available on PATH.`,
      evidence: { profile: profile.name, bin: profile.bin },
    };
  }

  const version = spawnSync(profile.bin, ["--version"], { encoding: "utf8", timeout: 5_000 });
  if ((version.status ?? 1) !== 0) {
    return {
      name: "agent-profile",
      kind: "deterministic",
      status: "warn",
      confidence: "medium",
      message: `Agent binary "${profile.bin}" was found but \`--version\` failed.`,
      evidence: {
        profile: profile.name,
        bin: profile.bin,
        exitCode: version.status ?? null,
        stderr: (version.stderr ?? "").trim(),
      },
    };
  }

  return {
    name: "agent-profile",
    kind: "deterministic",
    status: "pass",
    confidence: "high",
    message: `Agent profile "${profile.name}" is available.`,
    evidence: { profile: profile.name, bin: profile.bin, version: (version.stdout ?? "").trim() },
  };
}

/**
 * Parse a `--window-compare <duration>` shorthand into two adjacent windows
 * (current, prior). Duration syntax matches {@link parseHealthSince}.
 */
function resolveWindowCompare(duration: string): WindowSpec[] {
  const trimmed = duration.trim();
  const durationMatch = trimmed.match(/^(\d+)([dhm])$/i);
  if (!durationMatch) {
    throw new UsageError("--window-compare must be a duration like '24h', '7d', or '30m'.", "INVALID_FLAG_VALUE");
  }
  const amount = Number.parseInt(durationMatch[1] ?? "0", 10);
  const unit = (durationMatch[2] ?? "h").toLowerCase();
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new UsageError("--window-compare must be a positive duration.", "INVALID_FLAG_VALUE");
  }
  const multiplier = unit === "h" ? 60 * 60 * 1000 : unit === "m" ? 60 * 1000 : 24 * 60 * 60 * 1000;
  const ms = amount * multiplier;
  const now = Date.now();
  const currentSince = new Date(now - ms).toISOString();
  const currentUntil = new Date(now).toISOString();
  const priorSince = new Date(now - 2 * ms).toISOString();
  const priorUntil = currentSince;
  return [
    { name: "current", since: currentSince, until: currentUntil },
    { name: "prior", since: priorSince, until: priorUntil },
  ];
}

/**
 * Parse a single repeatable `--windows` value of the form
 * `name=...,since=...,until=...`. All keys are optional EXCEPT name and since.
 */
export function parseWindowSpec(raw: string): WindowSpec {
  const fields: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) {
      throw new UsageError(
        `--windows entry must be a comma-separated list of key=value pairs: ${raw}`,
        "INVALID_FLAG_VALUE",
      );
    }
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    fields[key] = value;
  }
  if (!fields.name) {
    throw new UsageError(`--windows entry is missing required 'name': ${raw}`, "INVALID_FLAG_VALUE");
  }
  if (!fields.since) {
    throw new UsageError(`--windows entry is missing required 'since': ${raw}`, "INVALID_FLAG_VALUE");
  }
  return {
    name: fields.name,
    since: fields.since,
    ...(fields.until ? { until: fields.until } : {}),
  };
}

/** Hard-coded list of "interesting" metric paths for window-compare deltas. */
const INTERESTING_DELTA_PATHS = [
  "improve.actions.reflect.failed",
  "improve.actions.reflect.guardRejected",
  "improve.actions.distill.llmFailed",
  "improve.actions.distill.queued",
  "improve.actions.distill.deferred",
  "improve.consolidation.promoted",
  "improve.memoryInference.written",
  "improve.memoryInference.yieldRate",
  "improve.memoryInference.skippedNoFacts",
  "improve.memoryInference.htmlErrorCount",
  "improve.graphExtraction.cacheHitRate",
  "improve.graphExtraction.failures",
  "improve.graphExtraction.htmlErrors",
  "improve.sessionExtraction.sessionsScanned",
  "improve.sessionExtraction.proposalsCreated",
  "improve.autoAccept.promoted",
  "improve.autoAccept.validationFailed",
  "improve.wallTime.medianMs",
  "improve.wallTime.p95Ms",
] as const;

function readNumericPath(obj: unknown, path: string): number {
  const parts = path.split(".");
  let cursor: unknown = obj;
  for (const part of parts) {
    if (typeof cursor !== "object" || cursor === null) return 0;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return typeof cursor === "number" && Number.isFinite(cursor) ? cursor : 0;
}

function computeDeltas(first: WindowResult, last: WindowResult): Record<string, DeltaEntry> {
  const out: Record<string, DeltaEntry> = {};
  for (const path of INTERESTING_DELTA_PATHS) {
    const from = readNumericPath(first, path);
    const to = readNumericPath(last, path);
    if (from === 0 && to === 0) continue;
    let pctChange: number | string;
    if (from === 0) {
      pctChange = to === 0 ? 0 : "+inf";
    } else {
      pctChange = Number((((to - from) / from) * 100).toFixed(2));
    }
    out[path] = { from, to, pctChange };
  }
  return out;
}

interface WindowMetricsBundle {
  improve: ImproveHealthMetrics;
  metrics: HealthMetrics;
  runs: number;
}

function buildWindowMetrics(db: Database, stateDbPath: string, since: string, until: string): WindowMetricsBundle {
  const taskRows = queryTaskHistory(db, { since }).filter((row) => {
    const startMs = new Date(row.started_at).getTime();
    const untilMs = new Date(until).getTime();
    return !Number.isFinite(untilMs) || startMs < untilMs;
  });
  const taskRowsWithLogs = taskRows.filter((row) => row.log_path !== null);
  const existingLogRows = taskRowsWithLogs.filter((row) => row.log_path && fs.existsSync(row.log_path));
  const failedTaskRows = taskRows.filter((row) => row.status === "failed");
  const activeRows = taskRows.filter((row) => row.status === "active");
  const stuckActiveRuns = activeRows.filter(
    (row) => Date.now() - new Date(row.started_at).getTime() > ACTIVE_RUN_WARN_MS,
  ).length;
  const promptRows = taskRows.filter((row) => row.target_kind === "prompt");
  const promptFailures = promptRows.filter((row) => {
    const detail = parseTaskMetadata(row).detail;
    return typeof detail?.reason === "string" && detail.reason.length > 0;
  });
  const logBackingRate = taskRowsWithLogs.length === 0 ? 1 : existingLogRows.length / taskRowsWithLogs.length;
  const taskFailRate = taskRows.length === 0 ? 0 : failedTaskRows.length / taskRows.length;
  const agentFailureRate = promptRows.length === 0 ? 0 : promptFailures.length / promptRows.length;

  const improveInvoked = readEvents({ since, type: "improve_invoked" }, { dbPath: stateDbPath }).events.filter(
    (event) => new Date(event.ts ?? since).getTime() < new Date(until).getTime(),
  ).length;
  const improveCompletedEvents = readEvents(
    { since, type: IMPROVE_COMPLETED_EVENT },
    { dbPath: stateDbPath },
  ).events.filter((event) => new Date(event.ts ?? since).getTime() < new Date(until).getTime());
  const improveSkippedEvents = readEvents({ since, type: "improve_skipped" }, { dbPath: stateDbPath }).events.filter(
    (event) => new Date(event.ts ?? since).getTime() < new Date(until).getTime(),
  );
  const eventsMetrics = summarizeImproveCompleted(improveCompletedEvents);
  const { metrics: improveSummary, runCount } = summarizeImproveRuns(db, since, until);
  improveSummary.invoked = improveInvoked;
  improveSummary.completed = eventsMetrics.completed;
  const skipSummary = buildImproveSkipSummary(improveSkippedEvents);
  improveSummary.skipped = skipSummary.skipped;
  improveSummary.skipReasons = skipSummary.skipReasons;
  // Preserve the per-phase aggregation computed by summarizeImproveRuns and
  // derive top-level wall times from the same improve-runs window so counts
  // and percentiles stay aligned with per-run reporting.
  const perRunSummaries = buildPerRunSummaries(db, since, until);
  const wallTimes = perRunSummaries.map((run) => run.wallTimeMs).filter((ms) => Number.isFinite(ms) && ms > 0);
  improveSummary.wallTime = computeWallTimeStats(wallTimes, improveSummary.wallTime.byPhase);

  const metrics: HealthMetrics = {
    taskFailRate: roundRate(taskFailRate),
    agentFailureRate: roundRate(agentFailureRate),
    stuckActiveRuns,
    logBackingRate: roundRate(logBackingRate),
    probeRoundTripMs: null,
  };

  return { improve: improveSummary, metrics, runs: runCount };
}

function validateAkmHealthOptions(options: AkmHealthOptions): void {
  if (options.groupBy !== undefined && options.groupBy !== "run") {
    throw new UsageError(`Invalid value for --group-by: ${options.groupBy}. Expected: run`, "INVALID_FLAG_VALUE");
  }
  if (options.windowCompare !== undefined && options.windows !== undefined && options.windows.length > 0) {
    throw new UsageError("--window-compare and --windows are mutually exclusive.", "INVALID_FLAG_VALUE");
  }
  if (options.windows) {
    if (options.windows.length > 4) {
      throw new UsageError("--windows accepts at most 4 entries.", "INVALID_FLAG_VALUE");
    }
    const seen = new Set<string>();
    for (const spec of options.windows) {
      if (seen.has(spec.name)) {
        throw new UsageError(`--windows has duplicate name: ${spec.name}`, "INVALID_FLAG_VALUE");
      }
      seen.add(spec.name);
    }
  }
}

export function akmHealth(options: AkmHealthOptions = {}): AkmHealthResult {
  validateAkmHealthOptions(options);
  const since = parseHealthSince(options.since);
  const stateDbPath = getStateDbPathInDataDir();
  const hardChecks: HealthCheckResult[] = [];
  const advisories: HealthCheckResult[] = [];
  const getExecutionLogCandidatesFn = options.getExecutionLogCandidatesFn ?? getExecutionLogCandidates;

  let db: ReturnType<typeof openStateDatabase> | undefined;
  try {
    db = openStateDatabase(stateDbPath);
  } catch (error) {
    throw new ConfigError(
      `Unable to open state.db: ${error instanceof Error ? error.message : String(error)}`,
      "INVALID_CONFIG_FILE",
    );
  }

  try {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('events', 'task_history', 'proposals', 'schema_migrations') ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((row) => row.name).sort();
    const requiredTables = ["events", "proposals", "schema_migrations", "task_history"];
    const missingTables = requiredTables.filter((name) => !tableNames.includes(name));
    hardChecks.push({
      name: "state-db-schema",
      kind: "deterministic",
      status: missingTables.length === 0 ? "pass" : "fail",
      confidence: "high",
      message:
        missingTables.length === 0
          ? "state.db opened and required tables are present."
          : `state.db is missing required tables: ${missingTables.join(", ")}`,
      evidence: { path: stateDbPath, tables: tableNames },
    });

    const probe = probeStateDbRoundTrip(stateDbPath);
    hardChecks.push({
      name: "state-db-round-trip",
      kind: "deterministic",
      status: probe.ok ? "pass" : "fail",
      confidence: "high",
      message: probe.ok ? "state.db append/read round-trip succeeded." : `state.db round-trip failed: ${probe.error}`,
      evidence: { path: stateDbPath, durationMs: probe.durationMs },
    });

    const taskRows = queryTaskHistory(db, { since });
    const taskRowsWithLogs = taskRows.filter((row) => row.log_path !== null);
    const existingLogRows = taskRowsWithLogs.filter((row) => row.log_path && fs.existsSync(row.log_path));
    const failedTaskRows = taskRows.filter((row) => row.status === "failed");
    const activeRows = taskRows.filter((row) => row.status === "active");
    const stuckActiveRuns = activeRows.filter(
      (row) => Date.now() - new Date(row.started_at).getTime() > ACTIVE_RUN_WARN_MS,
    ).length;
    const promptRows = taskRows.filter((row) => row.target_kind === "prompt");
    const promptFailures = promptRows.filter((row) => {
      const detail = parseTaskMetadata(row).detail;
      return typeof detail?.reason === "string" && detail.reason.length > 0;
    });
    const logBackingRate = taskRowsWithLogs.length === 0 ? 1 : existingLogRows.length / taskRowsWithLogs.length;
    const taskFailRate = taskRows.length === 0 ? 0 : failedTaskRows.length / taskRows.length;
    const agentFailureRate = promptRows.length === 0 ? 0 : promptFailures.length / promptRows.length;

    hardChecks.push({
      name: "task-history-read",
      kind: "deterministic",
      status: "pass",
      confidence: "high",
      message: `Read ${taskRows.length} task-history row(s) since ${since}.`,
      evidence: { rows: taskRows.length, since },
    });
    hardChecks.push({
      name: "task-log-backing",
      kind: "deterministic",
      status: logBackingRate === 1 ? "pass" : "fail",
      confidence: "high",
      message:
        logBackingRate === 1
          ? "Every task_history log_path resolved on disk."
          : `${taskRowsWithLogs.length - existingLogRows.length} task log(s) referenced in task_history are missing.`,
      evidence: { totalWithLogs: taskRowsWithLogs.length, existingLogs: existingLogRows.length },
    });
    hardChecks.push({
      name: "active-runs",
      kind: "deterministic",
      status: stuckActiveRuns === 0 ? "pass" : "warn",
      confidence: "high",
      message:
        stuckActiveRuns === 0
          ? "No active task runs exceeded the stale threshold."
          : `${stuckActiveRuns} active task run(s) are older than ${Math.round(ACTIVE_RUN_WARN_MS / 60000)} minutes.`,
      evidence: { stuckActiveRuns },
    });

    hardChecks.push(runAgentProbe());

    const semanticStatus = readSemanticStatus();
    advisories.push({
      name: "semantic-search-runtime",
      kind: "deterministic",
      status:
        !semanticStatus ||
        semanticStatus.status === "pending" ||
        semanticStatus.status === "ready-js" ||
        semanticStatus.status === "ready-vec"
          ? "pass"
          : "warn",
      confidence: "medium",
      message: semanticStatus
        ? `Semantic search status: ${semanticStatus.status}`
        : "No semantic-search runtime status recorded yet.",
      evidence: semanticStatus ? { ...semanticStatus } : undefined,
    });

    const improveInvoked = readEvents({ since, type: "improve_invoked" }, { dbPath: stateDbPath }).events.length;
    const improveCompletedEvents = readEvents({ since, type: IMPROVE_COMPLETED_EVENT }, { dbPath: stateDbPath }).events;
    const improveSkippedEvents = readEvents({ since, type: "improve_skipped" }, { dbPath: stateDbPath }).events;
    const eventsMetrics = summarizeImproveCompleted(improveCompletedEvents);
    const { metrics: improveSummary } = summarizeImproveRuns(db, since);
    improveSummary.invoked = improveInvoked;
    improveSummary.completed = eventsMetrics.completed;
    const skipSummary = buildImproveSkipSummary(improveSkippedEvents);
    improveSummary.skipped = skipSummary.skipped;
    improveSummary.skipReasons = skipSummary.skipReasons;
    const perRunSummaries = buildPerRunSummaries(db, since);
    const wallTimes = perRunSummaries.map((run) => run.wallTimeMs).filter((ms) => Number.isFinite(ms) && ms > 0);
    improveSummary.wallTime = computeWallTimeStats(wallTimes, improveSummary.wallTime.byPhase);

    let sessionLogEntries: SessionLogAdvisory[] = [];
    try {
      const sinceDays = Math.max(0, Math.ceil((Date.now() - new Date(since).getTime()) / (24 * 60 * 60 * 1000)));
      sessionLogEntries = getExecutionLogCandidatesFn(sinceDays).map((entry) => ({
        topic: entry.topic,
        frequency: entry.frequency,
        source: entry.source,
        isFailurePattern: entry.isFailurePattern,
      }));
    } catch {
      sessionLogEntries = [];
    }

    // session-log-failures: demoted to informational — the ERROR_PATTERNS regex
    // scans pre-LLM session text and produces false positives on diagnostic
    // conversation. It does not gate the real extraction pipeline (akmExtract).
    // Never triggers warn; kept for backward-compat visibility only.
    advisories.push({
      name: "session-log-failures",
      kind: "heuristic",
      status: "pass",
      confidence: "low",
      message:
        sessionLogEntries.length === 0
          ? "No repeated external session-log failure patterns were detected."
          : `${sessionLogEntries.length} raw session-log keyword match(es) detected (pre-LLM, informational only).`,
      evidence: { candidates: sessionLogEntries.slice(0, 5) },
    });

    const sx = improveSummary.sessionExtraction;
    const sxWarnReasons: string[] = [];
    if (sx.warnings > 0) sxWarnReasons.push(`${sx.warnings} harness error(s)`);
    if (sx.ran && sx.sessionsScanned >= 5 && sx.proposalsCreated === 0)
      sxWarnReasons.push("no proposals generated across scanned sessions");
    advisories.push({
      name: "session-extraction",
      kind: "heuristic",
      status: sxWarnReasons.length > 0 ? "warn" : "pass",
      confidence: sx.ran ? "medium" : "low",
      message: sx.ran
        ? sxWarnReasons.length > 0
          ? `Session extraction degraded: ${sxWarnReasons.join("; ")}.`
          : `Session extraction healthy: ${sx.sessionsScanned} scanned, ${sx.sessionsExtracted} extracted, ${sx.proposalsCreated} proposal(s) created.`
        : "Session extraction not active (feature disabled or no harness available).",
      evidence: {
        ran: sx.ran,
        sessionsScanned: sx.sessionsScanned,
        sessionsExtracted: sx.sessionsExtracted,
        sessionsSkipped: sx.sessionsSkipped,
        proposalsCreated: sx.proposalsCreated,
        warnings: sx.warnings,
        durationMs: sx.durationMs,
      },
    });

    const aa = improveSummary.autoAccept;
    advisories.push({
      name: "auto-accept-validation",
      kind: "heuristic",
      status: aa.validationFailed > 0 ? "warn" : "pass",
      confidence: aa.promoted + aa.validationFailed > 0 ? "high" : "low",
      message:
        aa.validationFailed > 0
          ? `${aa.validationFailed} proposal(s) passed confidence threshold but failed auto-accept validation (truncated description, invalid frontmatter, etc.) — they remain in the queue for manual review.`
          : aa.promoted > 0
            ? `Auto-accept healthy: ${aa.promoted} proposal(s) promoted, 0 validation failures.`
            : "Auto-accept gate did not run (disabled or no proposals above threshold).",
      evidence: { promoted: aa.promoted, validationFailed: aa.validationFailed },
    });

    const metrics: HealthMetrics = {
      taskFailRate: roundRate(taskFailRate),
      agentFailureRate: roundRate(agentFailureRate),
      stuckActiveRuns,
      logBackingRate: roundRate(logBackingRate),
      probeRoundTripMs: probe.durationMs,
    };

    const hardFailure = hardChecks.some((check) => check.status === "fail");
    const deterministicWarnings = [...hardChecks, ...advisories].some(
      (check) => check.status === "warn" && check.kind === "deterministic",
    );
    const status: AkmHealthResult["status"] = hardFailure ? "fail" : deterministicWarnings ? "warn" : "pass";

    // ── Window-compare mode (Phase 3) ─────────────────────────────────────
    let windowSpecs: WindowSpec[] | undefined;
    if (options.windowCompare) {
      windowSpecs = resolveWindowCompare(options.windowCompare);
    } else if (options.windows && options.windows.length > 0) {
      windowSpecs = options.windows;
    }

    let windowResults: WindowResult[] | undefined;
    let deltas: Record<string, DeltaEntry> | undefined;
    let topLevelImprove = improveSummary;
    let topLevelMetrics = metrics;
    let topLevelSince = since;

    if (windowSpecs && db) {
      windowResults = windowSpecs.map((spec) => {
        const winSince = parseHealthSince(spec.since);
        const winUntil = spec.until ? parseHealthSince(spec.until) : new Date().toISOString();
        const bundle = buildWindowMetrics(db as Database, stateDbPath, winSince, winUntil);
        return {
          name: spec.name,
          since: winSince,
          until: winUntil,
          runs: bundle.runs,
          improve: bundle.improve,
          metrics: bundle.metrics,
        };
      });
      // Preserve backward compat: top-level improve/metrics reflect window 0.
      if (windowResults.length > 0) {
        topLevelImprove = windowResults[0].improve;
        topLevelMetrics = { ...windowResults[0].metrics, probeRoundTripMs: probe.durationMs };
        topLevelSince = windowResults[0].since;
      }
      if (windowResults.length >= 2) {
        // Deltas always read chronologically: `from` = earliest window,
        // `to` = latest. Positive pctChange on a failure metric (e.g.
        // distill.llmFailed) means things got WORSE going forward in
        // time; negative means improvement. Window 0 in the output
        // array is whatever the user specified first (typically
        // `current` for --window-compare), but the delta direction is
        // independent of that array order.
        const sorted = [...windowResults].sort((a, b) => new Date(a.since).getTime() - new Date(b.since).getTime());
        deltas = computeDeltas(sorted[0], sorted[sorted.length - 1]);
      }
    }

    // ── Per-run mode (Phase 2) ────────────────────────────────────────────
    let runs: ImproveRunSummary[] | undefined;
    if (options.groupBy === "run") {
      runs = buildPerRunSummaries(db, since);
    }

    return {
      schemaVersion: 2,
      ok: !hardFailure,
      status,
      since: topLevelSince,
      hardChecks,
      advisories,
      metrics: topLevelMetrics,
      improve: topLevelImprove,
      sessionLogAdvisories: sessionLogEntries,
      ...(runs ? { runs } : {}),
      ...(windowResults ? { windows: windowResults } : {}),
      ...(deltas ? { deltas } : {}),
    };
  } finally {
    db.close();
  }
}

// ── Markdown renderers ───────────────────────────────────────────────────────

function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const lines: string[] = [];
  lines.push(headers.map((h, i) => padRight(h, widths[i] ?? 0)).join("  "));
  for (const row of rows) {
    lines.push(row.map((cell, i) => padRight(cell ?? "", widths[i] ?? 0)).join("  "));
  }
  return lines.join("\n");
}

/**
 * Render `--detail per-run` rows as a TSV-ish aligned table. The column
 * shape was originally inherited from the retired
 * `scripts/improve-stats/runs-detail` bash helper; keep the same shape
 * so operator muscle memory carries over.
 *
 * Columns: ts | ok | actions | refl_ok/fail/cd/skip |
 *   distill_q/llm-fail/qrej/cfg/skip | cons_proc/promo/merge/del |
 *   mem_cons/written/skip | graph_f/e/r | orphans | lint_f/fl
 */
export function renderRunsDetailMd(runs: ImproveRunSummary[]): string {
  const headers = [
    "ts",
    "ok",
    "actions",
    "refl_ok/fail/cd/skip",
    "distill_q/llm-fail/qrej/cfg/skip",
    "cons_proc/promo/merge/del",
    "mem_cons/written/skip",
    "graph_f/e/r",
    "orphans",
    "lint_f/fl",
  ];
  const rows = runs.map((r) => {
    const totalActions =
      r.actions.reflect.ok +
      r.actions.reflect.failed +
      r.actions.reflect.cooldown +
      r.actions.reflect.skipped +
      r.actions.distill.queued +
      r.actions.distill.llmFailed +
      r.actions.distill.qualityRejected +
      r.actions.distill.configDisabled +
      r.actions.distill.skipped +
      r.actions.memoryPrune +
      r.actions.memoryInference +
      r.actions.graphExtraction +
      r.actions.error;
    return [
      r.startedAt,
      String(r.ok),
      String(totalActions),
      `${r.actions.reflect.ok}/${r.actions.reflect.failed}/${r.actions.reflect.cooldown}/${r.actions.reflect.skipped}`,
      `${r.actions.distill.queued}/${r.actions.distill.llmFailed}/${r.actions.distill.qualityRejected}/${r.actions.distill.configDisabled}/${r.actions.distill.skipped}`,
      `${r.consolidation.processed}/${r.consolidation.promoted}/${r.consolidation.merged}/${r.consolidation.deleted}`,
      `${r.memoryInference.considered}/${r.memoryInference.written}/${r.memoryInference.skippedNoFacts}`,
      `${r.graphExtraction.extractedFiles}/${r.graphExtraction.entities}/${r.graphExtraction.relations}`,
      String(r.orphansPurged),
      `${r.lintFixed}/${r.lintFlagged}`,
    ];
  });
  return renderTable(headers, rows);
}

/**
 * Render a window-compare comparison as a side-by-side metric table with a
 * delta column. Bad-direction deltas (e.g. +pct on failed counts) get a `!`
 * marker prefix.
 */
export function renderWindowCompareMd(windows: WindowResult[], deltas: Record<string, DeltaEntry> | undefined): string {
  if (windows.length === 0) return "";
  const headers = ["metric", ...windows.map((w) => w.name), "delta"];
  const badIfPositive = new Set([
    "improve.actions.reflect.failed",
    "improve.actions.distill.llmFailed",
    "improve.graphExtraction.failures",
    "improve.wallTime.medianMs",
    "improve.wallTime.p95Ms",
    "improve.memoryInference.skippedNoFacts",
  ]);
  const rows: string[][] = [];
  for (const path of INTERESTING_DELTA_PATHS) {
    const values = windows.map((w) => String(readNumericPath(w, path)));
    const delta = deltas?.[path];
    let deltaStr = "—";
    if (delta) {
      const pct = delta.pctChange;
      const num = typeof pct === "number" ? pct : pct;
      const sign = typeof num === "number" && num > 0 ? "+" : "";
      const formatted = typeof num === "number" ? `${sign}${num}%` : String(num);
      const marker = badIfPositive.has(path) && typeof num === "number" && num > 0 ? "!" : "";
      deltaStr = marker + formatted;
    }
    rows.push([path, ...values, deltaStr]);
  }
  return renderTable(headers, rows);
}
