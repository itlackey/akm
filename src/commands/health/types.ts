// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared type surface + constants for the `akm health` command modules. These
 * interfaces are consumed across health/{improve-metrics,task-runs,windows,
 * llm-usage,metrics,advisories}.ts, the report renderers, and the check
 * registry, so they live here rather than in any single concern module.
 */

import type { CalibrationSummary } from "../improve/calibration";

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
  /**
   * Per-stage LLM usage aggregates (#576), derived from `llm_usage` events in
   * the window. Replaces the prior GPU-time proxy: real token + wall-time
   * accounting attributed to the pipeline stage that made each call. `stages`
   * is keyed by stage name (`"reflect"`, `"memory-inference"`, …); calls made
   * outside any stage scope land under the `unattributed` key.
   */
  llmUsage: LlmUsageAggregate;
}

/** Aggregated LLM usage over a window: a total plus a per-stage breakdown. */
export interface LlmUsageAggregate {
  /** Number of `llm_usage` events (== number of LLM calls) in the window. */
  calls: number;
  totalDurationMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  /** Per-stage breakdown, keyed by stage name (unscoped calls → `unattributed`). */
  byStage: Record<string, LlmUsageStageAggregate>;
}

/** LLM usage totals for one pipeline stage. */
export interface LlmUsageStageAggregate {
  calls: number;
  totalDurationMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens: number;
}

export interface ImproveHealthMetrics {
  invoked: number;
  completed: number;
  skipped: number;
  skipReasons: Record<string, number>;
  plannedRefs: number;
  /**
   * Refs the planner dropped up-front because no enabled pass on the active
   * strategy would accept them (e.g. `script:*` for reflect+distill). Sourced
   * from `improve_runs.result_json.strategyFilteredRefs[]` for v2 rows.
   * after the planner pre-filter at improve.ts:collectEligibleRefs landed
   * in commit 0e9f283 but the metric reader was missed.
   */
  strategyFilteredRefs: number;
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
       * `unsupported_type`, `no_change` (#580 noise gate),
       * `derived-memory-reflect-skipped`. Totals here
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
  /**
   * Auto-accept gate calibration (#612). Joins predicted confidence (from the
   * gate's per-proposal `gateDecision` records) to the realized accept/reject
   * outcome over the window, producing a reliability table + an aggregate
   * calibration gap (predicted vs realized acceptance). Empty (zeros) when no
   * acted-on gate decisions fall in the window — so the default, ungated
   * install reports a parity-preserving empty summary.
   */
  calibration: CalibrationSummary;
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
    /** Single bounded retries triggered for transient LLM failures during inference. */
    retryAttempts: number;
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
    /** Single bounded retries triggered for transient LLM failures during extraction. */
    retryAttempts: number;
    /**
     * Batch extraction calls that stayed non-array even after the stricter
     * retry, each forcing a per-asset fallback. A rising count signals the
     * batch→per-asset cost cliff (#635). Sourced from the graph-extraction
     * telemetry's `nonArrayBatchFailures`.
     */
    nonArrayBatchFailures: number;
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
  /**
   * WS-5 perf telemetry (Part V §5). Aggregated across runs in the window.
   * Emitted regardless of gate so operators can baseline before enabling
   * behavior-changing work-streams. All fields are zero when consolidation
   * did not run or pre-WS-5 envelopes are in the window.
   */
  perfTelemetry: ImprovePerfTelemetry;
  /**
   * WS-5 per-run degradation metrics (Part V §4). Sourced from the stash on
   * the read path (health-command read), not from run envelopes, so they
   * reflect the CURRENT corpus state rather than historical per-run snapshots.
   * Absent when not enough data is available (e.g. empty stash).
   */
  degradation?: ImproveDegradationMetrics;
  /**
   * WS-5 denominator-fixed coverage (Part V §3).
   * `coverage = distinct_accepted_refs / total_assets` (denominator is fixed
   * at total stash size, not the moving eligible set). The numerator counts
   * DISTINCT refs, not proposals — repeated accepted rewrites of one asset
   * are churn, not coverage, and previously inflated this rate.
   * `eligibleFraction` is reported separately so narrowing eligibility doesn't
   * spuriously inflate coverage. Rates are NaN when total_assets=0 (empty stash).
   */
  coverage: {
    /** distinct_accepted_refs / total_assets (fixed denominator). NaN when total=0. */
    rate: number;
    /** eligible_assets / total_assets. NaN when total=0. */
    eligibleFraction: number;
    /** Total proposals accepted (window-scoped, from state.db). Raw volume — includes churn. */
    acceptedProposals: number;
    /** Distinct asset refs among the window's accepted proposals. */
    distinctRefs: number;
    /**
     * acceptedProposals / distinctRefs. 1.0 = every accepted proposal touched
     * a different asset; values above ~1.5 mean the loop is repeatedly
     * rewriting the same assets (churn). NaN when distinctRefs=0.
     */
    churnRatio: number;
    /** Total stash assets at the time of the most recent run (whole-stash snapshot). */
    totalAssets: number;
  };
  /**
   * Enrichment-vs-minting policy rollup (reporting-only). Enrichment-classed
   * lanes are ratified to EDIT existing assets, not mint new ones; this
   * surfaces the split so drift is visible without a manual DB query.
   * Absent when no lane-attributed accepted proposals exist in the window.
   */
  enrichmentMinting?: EnrichmentMintingRollup;
}

/**
 * Lanes ratified as ENRICHMENT-ONLY: they may propose edits to existing
 * assets (metadata, relations, content refresh) but must not mint new ones.
 * New-asset generation belongs to the signal-gated minting lanes
 * (extract/distill/memory-inference/recombine).
 */
export const ENRICHMENT_LANES: readonly string[] = ["proactive", "high-salience", "high-retrieval", "signal-delta"];

/** Minted share of enrichment-lane accepts that triggers a WARN advisory. */
export const ENRICHMENT_MINTED_WARN_SHARE = 0.05;

/** Minted share of enrichment-lane accepts that triggers a FAIL advisory. */
export const ENRICHMENT_MINTED_FAIL_SHARE = 0.15;

/**
 * Cron task failure rate at or above which the `task-fail-rate` health advisory
 * warns. 0.05 (5%) is the SAME threshold the HTML report already applies as its
 * fail-rate pass/warn cutoff (`failOk = taskFailRate < 0.05` in
 * src/commands/health/html-report.ts) — this constant makes it the single
 * source so the advisory and the rendered badge cannot drift.
 */
export const TASK_FAIL_RATE_WARN = 0.05;

/**
 * The enrichment-vs-minting split over the health window's accepted,
 * lane-attributed proposals. Create-vs-update is discriminated by
 * `metadata_json.backupContent`: apply captures the prior content for
 * updates, so its absence means a genuinely new asset was minted.
 */
export interface EnrichmentMintingRollup {
  /** Accepted enrichment-lane proposals that MINTED a new asset (no backupContent). */
  minted: number;
  /** Accepted enrichment-lane proposals that UPDATED an existing asset. */
  updated: number;
  /** minted / (minted + updated) across enrichment lanes. NaN when they decided nothing. */
  share: number;
  /** Per-lane minted/updated split for every lane-attributed accepted proposal. */
  byLane: Record<string, { minted: number; updated: number }>;
}

/**
 * WS-5 perf telemetry for the consolidation pipeline. All fields are additive
 * sums across runs in the health window. Per-run rates (e.g. cache hit rate)
 * are computed by health callers from the raw counters.
 */
export interface ImprovePerfTelemetry {
  /** Sum of dedupPoolSize across consolidation runs in the window. */
  dedupPoolSize: number;
  /** Sum of llmPoolSize across consolidation runs in the window. */
  llmPoolSize: number;
  /** Sum of judgedCacheSkipped across consolidation runs. */
  judgedCacheSkipped: number;
  /** Total embedding wall-clock time across consolidation runs (ms). */
  embedMs: number;
  /** Total body-embedding cache hits across consolidation runs. */
  embedCacheHits: number;
  /** Total body-embedding cache misses across consolidation runs. */
  embedCacheMisses: number;
  /**
   * Number of consolidation runs that reported estimatedBudgetFractionUsed > 1.0
   * (consolidation alone exceeded the caller's declared budget — SIGTERM risk).
   */
  overBudgetRuns: number;
  /** Number of consolidation runs that reported any perfTelemetry (denominator for rates). */
  runsWithTelemetry: number;
}

/**
 * WS-5 per-run degradation metrics (Part V §4). Computed on the health read
 * path from the current corpus state. These catch slow rot that a throughput
 * gate misses.
 */
export interface ImproveDegradationMetrics {
  /**
   * Inter-run corpus diversity: cosine centroid distance of the top-N retrieved
   * assets between the most recent two runs. A >10% drop flags entrenchment.
   * NaN when fewer than 2 runs or no retrieved-asset data.
   */
  corpusCentroidDistance: number;
  /**
   * Whether corpusCentroidDistance represents a >10% drop vs the prior run.
   * `undefined` when the metric is NaN.
   */
  entrenchmentFlagged?: boolean;
  /**
   * Low-tail Gini flag: `true` when the top-100 retrieval_salience Gini is
   * below 0.08 — the salience distribution has collapsed toward uniform and
   * no longer discriminates between assets (ranking carries no signal).
   * The uniform baseline for this formula is ~0.1, so a healthy distribution
   * sits above it; the old one-tailed check (>0.35 entrenchment only)
   * rendered a fully collapsed distribution as healthy.
   * `undefined` when the metric is NaN.
   */
  salienceUniformityFlagged?: boolean;
  /**
   * Merge fidelity: fraction of accepted merge proposals in the window whose
   * result was later contradicted (a proxy for "the merge degraded content").
   * 0 = no contradictions detected; higher = potential fidelity loss.
   */
  mergeFidelityContradictionRate: number;
  /**
   * Oracle spot-check: up to 5 recently accepted proposals sampled from the
   * window, surfaced for human eyeballing in the health report.
   */
  oracleSpotCheck: OracleSpotCheckEntry[];
}

/** One sample in the oracle spot-check. */
export interface OracleSpotCheckEntry {
  /** Proposal id. */
  proposalId: string;
  /** Asset ref the proposal targets. */
  ref: string;
  /** Source phase that produced the proposal (reflect, distill, consolidate, …). */
  source: string;
  /** ISO-8601 timestamp when the proposal was accepted. */
  acceptedAt: string;
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
  strategy: string | null;
  legacyProfile: string | null;
  scope: { mode: string; value?: string };
  /**
   * The scheduled task that launched this improve run (e.g.
   * `akm-improve-frequent`), resolved by matching the run's start time to a
   * `task_history` row with a `task_id` beginning `akm-improve` (±5 min).
   * `"manual"` when no scheduled task matches (a hand-run `akm improve`).
   * Drives the health report's Task column + task filter.
   */
  taskId: string;
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
  schemaVersion: 3;
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

/** Event type recorded on each completed improve run. */
export const IMPROVE_COMPLETED_EVENT = "improve_completed";

/** An active task older than this (ms) is treated as stuck. */
export const ACTIVE_RUN_WARN_MS = 15 * 60 * 1000;
