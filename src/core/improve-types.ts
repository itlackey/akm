// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { ConsolidateResult } from "../commands/improve/consolidate";
import type { AkmDistillResult } from "../commands/improve/distill";
import type { AkmExtractResult } from "../commands/improve/extract";
import type {
  ArchivedMemoryCleanupRecord,
  MemoryBeliefStateTransition,
  MemoryConsolidationCandidate,
  MemoryContradictionCandidate,
  MemoryPruneCandidate,
  RelativeDateCandidate,
} from "../commands/improve/memory/memory-improve";
import type { AkmReflectResult } from "../commands/improve/reflect";
import type { DeadUrl } from "../commands/url-checker";
import type { GraphExtractionResult } from "../indexer/graph/graph-extraction";
import type { MemoryInferenceResult } from "../indexer/passes/memory-inference";
import { assertNever } from "./assert";

/**
 * Which eligibility lane selected an asset for an improve run (attribution
 * tagging). Recorded on `reflect_invoked` / `distill_invoked` / `promoted`
 * state.db events and persisted on the proposal record so downstream
 * accept / reject / revert / retrieval outcomes can be sliced by lane — i.e.
 * "does the PROACTIVE lane produce value vs the reactive lanes?".
 *
 *   - `"signal-delta"`   — asset had fresh feedback since its last proposal
 *                          (the reactive feedback-signal lane).
 *   - `"high-retrieval"` — P0-A fallback: zero-feedback but frequently
 *                          retrieved (the reactive retrieval-spike lane).
 *   - `"proactive"`      — Layer-2 proactiveMaintenance scheduled selector.
 *   - `"scope"`              — explicit `--scope <ref>` bypass (user intent wins).
 *   - `"forgetting-safety"` — WS-1 protective consolidation: asset fell from
 *                             top-200 to below position 500 in the stash-wide
 *                             salience ranking (scenario B rank-change report).
 *                             Force-included for one consolidation pass regardless
 *                             of cooldown / signal-delta status so it is not
 *                             silently dropped from the candidate pool.
 *   - `"replay"`             — #610 bounded replay budget: a top-salience ref
 *                              revisited even with zero reactive signal and
 *                              regardless of cooldown. The WEAKEST lane — it never
 *                              relabels a ref another lane already chose, and its
 *                              selection is strictly ADDITIVE on top of `--limit`
 *                              (never steals fresh work). Converged refs
 *                              (consecutive_no_ops >= dampener threshold) are skipped.
 *   - `"unknown"`            — origin lane could not be determined. NOT a silent
 *                              alias for `signal-delta`; only used when the lane
 *                              genuinely cannot be attributed.
 *
 * Precedence when a ref qualifies via multiple lanes (prefer the most specific
 * reactive signal): `scope` > `signal-delta` > `high-retrieval` > `proactive` >
 * `high-salience` > `forgetting-safety` > `replay`. Replay is weakest so it never
 * relabels a ref another lane already chose.
 * A ref with real feedback is attributed to feedback even if it was also due
 * for proactive maintenance.
 */
export type EligibilitySource =
  | "signal-delta"
  | "high-retrieval"
  | "high-salience"
  | "proactive"
  | "scope"
  | "forgetting-safety"
  | "replay"
  | "exploration"
  | "recombine"
  | "procedural"
  | "unknown";

export interface ImproveEligibleRef {
  ref: string;
  reason: "scope-ref" | "scope-type" | "memory-cleanup" | "strategy_filtered_all_passes";
  /**
   * Absolute path on disk, pre-resolved from the index at planning time (#591).
   * Avoids repeated serial async DB lookups in the validation and disk-check
   * passes (~500 s on a 9 000-ref stash). Unset for scope-ref entries that
   * bypass `collectEligibleRefs`; consumers fall back to the async lookup.
   */
  filePath?: string;
  /**
   * The eligibility lane that selected this ref for the current run. Stamped at
   * partition time in `runImprovePreparationStage` and threaded through to the
   * reflect/distill event emit sites and proposal creation. See
   * {@link EligibilitySource} for the lane vocabulary and precedence rule.
   */
  eligibilitySource?: EligibilitySource;
}

/**
 * The mode discriminator on every {@link ImproveActionResult}. Named so the two
 * audit-counter switches (`computeImproveRunMetrics` in `state-db.ts` and
 * `emitImproveCompletedEvent` in `improve.ts`) and {@link classifyImproveAction}
 * all dispatch over the *same* canonical union — a new variant fails to compile
 * at every consumer rather than silently drifting out of one of them.
 */
export type ImproveActionMode =
  | "reflect"
  | "reflect-failed"
  | "reflect-cooldown"
  | "reflect-skipped"
  | "reflect-guard-rejected"
  | "distill"
  | "distill-skipped"
  | "memory-prune"
  | "memory-inference"
  | "graph-extraction"
  | "error";

/** Coarse audit bucket an {@link ImproveActionMode} contributes to. */
export type ImproveActionClass = "accepted" | "rejected" | "skipped" | "error" | "noop";

/**
 * Map an {@link ImproveActionMode} to its coarse audit bucket. Single source of
 * truth shared by `state-db.ts#computeImproveRunMetrics` and
 * `improve.ts#emitImproveCompletedEvent` so the aggregate accepted/rejected/
 * error counts can never disagree between the persisted `metrics_json` and the
 * emitted `improve_completed` event.
 *
 * Buckets:
 * - `accepted` — a write/content-authoring action succeeded.
 * - `skipped` — the ref was GATED OUT before any content was produced: a
 *   cooldown, a signal-delta/eligibility skip, or a distill pool-delta skip.
 *   These are NOT rejections of produced content — they are the run declining
 *   to act on a ref it had no new reason to touch, and they scale with the
 *   whole indexed-ref pool (~13k/run), so folding them into `rejected` made the
 *   "accept rate" meaningless (deep-tuning analysis 2026-06-29, finding #1).
 * - `rejected` — the run PRODUCED a change and a content-policy guard then
 *   rejected it (`reflect-guard-rejected`). This is the genuine value-rejection
 *   signal; it is small and meaningful, no longer drowned by gated skips.
 * - `error` — the action failed (LLM/runtime error).
 * - `noop` — bookkeeping that is neither a write nor a rejection (memory-prune);
 *   intentionally counted in none of the numeric buckets.
 *
 * The `default: assertNever(mode)` arm makes any future union variant a
 * compile-time error here, forcing an explicit bucket choice.
 */
export function classifyImproveAction(mode: ImproveActionMode): ImproveActionClass {
  switch (mode) {
    case "reflect":
    case "distill":
    case "memory-inference":
    case "graph-extraction":
      return "accepted";
    case "reflect-cooldown":
    case "reflect-skipped":
    case "distill-skipped":
      return "skipped";
    case "reflect-guard-rejected":
      return "rejected";
    case "reflect-failed":
    case "error":
      return "error";
    case "memory-prune":
      return "noop";
    default:
      return assertNever(mode);
  }
}

export interface ImproveActionResult {
  ref: string;
  mode: ImproveActionMode;
  result:
    | AkmReflectResult
    | AkmDistillResult
    | MemoryInferenceResult
    | GraphExtractionResult
    | { ok: true; pruned: boolean; reason: MemoryPruneCandidate["reason"] }
    | { ok: true; reason: string }
    | { ok: false; error: string };
}

/**
 * C1 (13-bus-factor) — bounded replacement for the per-ref `distill-skipped`
 * action rows that used to be persisted verbatim in
 * `improve_runs.result_json`. On a whole-stash run the loop emits one
 * `distill-skipped` action per gated ref (~13k rows/run, ~91% of result_json
 * bytes on the live stash — the 90-day TTL cannot bound this per-run growth),
 * yet the ONLY consumer of the detail (`health/improve-metrics.ts`) needs just
 * the total and the per-reason breakdown. So we fold the list into this
 * aggregate before persistence: the metric survives, the unbounded row list
 * does not.
 */
export interface DistillSkippedAggregate {
  /** Total number of distill-skipped actions this run (the metric total). */
  total: number;
  /** Per-reason histogram: reason string -> count. Sums to {@link total}. */
  byReason: Record<string, number>;
  /**
   * A small CAPPED sample of refs per reason (first
   * {@link DISTILL_SKIPPED_SAMPLE_CAP_PER_REASON} seen), retained only for
   * debugging. Bounded by construction so result_json can never grow with the
   * indexed-ref pool.
   */
  samples: Array<{ ref: string; reason: string }>;
}

/** Upper bound on retained sample refs PER reason in {@link DistillSkippedAggregate}. */
export const DISTILL_SKIPPED_SAMPLE_CAP_PER_REASON = 3;

/**
 * Partition an action list into the rows to persist and the `distill-skipped`
 * aggregate. Pure — no I/O. Called once at improve-result assembly time so the
 * serialized envelope never carries per-ref distill-skipped rows.
 *
 * Non-`distill-skipped` actions are returned verbatim and in order. When there
 * are zero distill-skipped actions the aggregate is omitted (the envelope stays
 * byte-identical to a run that skipped nothing).
 */
export function foldDistillSkipped(actions: ImproveActionResult[]): {
  actions: ImproveActionResult[];
  aggregate?: DistillSkippedAggregate;
} {
  const kept: ImproveActionResult[] = [];
  const byReason: Record<string, number> = {};
  const samples: Array<{ ref: string; reason: string }> = [];
  const sampleCountByReason: Record<string, number> = {};
  let total = 0;
  for (const action of actions) {
    if (action.mode !== "distill-skipped") {
      kept.push(action);
      continue;
    }
    total += 1;
    const r = action.result as { reason?: unknown } | undefined;
    const reason = typeof r?.reason === "string" && r.reason.trim() ? r.reason : "unknown";
    byReason[reason] = (byReason[reason] ?? 0) + 1;
    const seen = sampleCountByReason[reason] ?? 0;
    if (seen < DISTILL_SKIPPED_SAMPLE_CAP_PER_REASON) {
      sampleCountByReason[reason] = seen + 1;
      samples.push({ ref: action.ref, reason });
    }
  }
  if (total === 0) return { actions: kept };
  return { actions: kept, aggregate: { total, byReason, samples } };
}

export interface ImproveMemoryCleanupResult {
  analyzedDerived: number;
  pruneCandidates: MemoryPruneCandidate[];
  contradictionCandidates: MemoryContradictionCandidate[];
  beliefStateTransitions: MemoryBeliefStateTransition[];
  consolidationCandidates: MemoryConsolidationCandidate[];
  relativeDateCandidates?: RelativeDateCandidate[];
  archived?: ArchivedMemoryCleanupRecord[];
  transitionLogPath?: string;
  transitionLogEntries?: number;
  warnings?: string[];
}

/**
 * #609 — outcome of the recombine / synthesize pass. Emitted on
 * {@link AkmImproveResult.recombination} when the (opt-in) pass runs.
 */
export interface RecombineResult {
  schemaVersion: 1;
  /** False when the run aborted early (e.g. budget signal already fired). */
  ok: boolean;
  /** Number of relatedness clusters that reached the LLM induction step. */
  clustersFormed: number;
  /** Number of `type: hypothesis` proposals queued through the normal queue. */
  proposalsEmitted: number;
  /**
   * #625 — number of generalizations promoted to a `type: lesson` proposal this
   * run because their confirmation count reached `confirmThreshold`. Promotion
   * goes through the SAME proposal queue + quality gate (never a direct stash
   * write); a promoted run emits a lesson proposal INSTEAD of the hypothesis one.
   */
  lessonsPromoted: number;
  /** Number of clusters whose LLM returned a justified null (no proposal). */
  nullsReturned: number;
  /** Wall-clock duration of the pass in milliseconds. */
  durationMs: number;
  /** Non-fatal warnings accumulated during the pass. */
  warnings: string[];
}

/**
 * #615 — outcome of the procedural-compilation pass. Emitted on
 * {@link AkmImproveResult.proceduralCompilation} when the (opt-in) pass runs.
 */
export interface ProceduralCompilationResult {
  schemaVersion: 1;
  /** False when the run aborted early (e.g. budget signal already fired). */
  ok: boolean;
  /** Number of indexed entries scanned for an `orderedActions` sequence. */
  sequencesScanned: number;
  /** Number of recurring-sequence clusters that reached the LLM compilation step. */
  clustersFormed: number;
  /** Number of `type: workflow` proposals queued through the normal queue. */
  proposalsEmitted: number;
  /** Number of clusters whose LLM returned a justified null (no proposal). */
  nullsReturned: number;
  /** Wall-clock duration of the pass in milliseconds. */
  durationMs: number;
  /** Non-fatal warnings accumulated during the pass. */
  warnings: string[];
}

export interface AkmImproveResult {
  schemaVersion: 2;
  ok: boolean;
  /** Effective 0.9 improve strategy selected for this run. */
  strategy: string;
  scope: {
    mode: "all" | "type" | "ref";
    value?: string;
  };
  dryRun: boolean;
  /**
   * Present when the run did no work because another improve held the lock and
   * `skipIfLocked` was set. The run still exits 0 and records a (non-productive)
   * row so the skip is auditable; `reason` is `"lock-held"`.
   */
  skipped?: { reason: string };
  guidance?: string;
  memorySummary: {
    eligible: number;
    derived: number;
  };
  memoryCleanup?: ImproveMemoryCleanupResult;
  /**
   * #616 — number of prep->loop->post-loop cycles executed this run (>=1).
   * Omitted-or-1 for the default single-pass run; >1 when multi-cycle phasing
   * ran additional cycles. The loop stops at maxCycles OR at the first
   * fixed-point cycle (zero gate-accepted proposals) OR when remainingBudgetMs
   * is exhausted.
   */
  cyclesRun?: number;
  plannedRefs: ImproveEligibleRef[];
  /**
   * Refs the planner considered but excluded because every per-ref pass on
   * the active profile (reflect + distill) would refuse them. Additive
   * field — pre-2026-05-27 these refs went into `plannedRefs` and produced
   * 2× synthetic skip actions per run. See
   * `/tmp/akm-health-investigations/planner-profile-metrics-deep-analysis.md`.
   *
   * Each ref has its `reason` set to `"strategy_filtered_all_passes"`. The
   * audit trail is also emitted as a single summary `improve_skipped` event
   * with metadata `{reason, count}` (#592) — one event per ref caused O(n)
   * sequential state.db writes on large stashes.
   * Omitted entirely when no refs were filtered (keeps the envelope tidy
   * for stashes whose profile accepts every indexed type).
   */
  strategyFilteredRefs?: ImproveEligibleRef[];
  actions?: ImproveActionResult[];
  /**
   * C1 (13-bus-factor) — bounded aggregate of the per-ref `distill-skipped`
   * actions that used to bloat {@link actions} (and thus `result_json`). Built
   * by {@link foldDistillSkipped} at assembly time; the per-ref rows are NOT
   * persisted. Omitted when zero refs were distill-skipped. Consumers read
   * `distill.skipped` / `skippedByReason` from here (see
   * `health/improve-metrics.ts`) instead of scanning per-ref rows.
   */
  distillSkipped?: DistillSkippedAggregate;
  validationFailures?: Array<{ ref: string; reason: string }>;
  schemaRepairs?: Array<{
    ref: string;
    reason: string;
    outcome: "queued" | "written" | "skipped" | "error";
    proposalId?: string;
    error?: string;
  }>;
  consolidation?: ConsolidateResult;
  /**
   * Session-extract pass results (one entry per available harness). Present
   * when `profiles.improve.default.processes.extract.enabled` is true (default)
   * and at least one harness reports `isAvailable() === true`.
   */
  extract?: AkmExtractResult[];
  lintSummary?: { fixed: number; flagged: number };
  memoryIndexHealth?: { lineCount: number; overBudget: boolean };
  coverageGaps?: string[];
  evalCasesWritten?: number;
  deadUrls?: DeadUrl[];
  /** Number of reflect calls that had at least one error in the rolling window at call time. */
  reflectsWithErrorContext?: number;
  memoryInference?: MemoryInferenceResult;
  graphExtraction?: GraphExtractionResult;
  /**
   * Wall-clock duration of the memory-inference pass (ms). Surfaced at the
   * top level (not inside `memoryInference`) because both
   * `health.ts#summarizeImproveRuns` (wallTime.byPhase aggregator) and the
   * existing `metrics.memoryInference.durationMs` rollup read it from here.
   * Omitted entirely when the pass did not run.
   */
  memoryInferenceDurationMs?: number;
  /**
   * Wall-clock duration of the graph-extraction pass (ms). Same surfacing
   * convention as `memoryInferenceDurationMs` — top-level so the
   * `wallTime.byPhase.graphExtraction` aggregator in health.ts picks it up.
   * Omitted entirely when the pass did not run.
   */
  graphExtractionDurationMs?: number;
  /** Number of pending proposals purged because their target ref no longer exists on disk. */
  orphansPurged?: number;
  /**
   * Phase 6B (Advantage D6b): pending proposals archived as expired this run
   * because they aged past `config.archiveRetentionDays`.
   */
  proposalsExpired?: number;
  /** Number of reflect actions that were skipped due to cooldown/dedup signals. */
  reflectCooldownActions?: number;
  /** Number of reflect actions skipped because the asset type is not supported by reflect. */
  reflectSkippedActions?: number;
  /**
   * Number of reflect actions where a downstream content-policy guard
   * (e.g. EXCESSIVE_SHRINKAGE/EXCESSIVE_EXPANSION size rails) blocked an
   * otherwise valid LLM response. NOT counted as LLM failure. See
   * `/tmp/akm-health-investigations/metrics-taxonomy-review.md` §1a.
   */
  reflectGuardRejectedActions?: number;
  /**
   * Total proposals auto-promoted by the unified gate across all phases
   * (reflect, extract, distill, consolidate). Populated by summing the
   * `.promoted.length` from every `runAutoAcceptGate` call in the run.
   * Omitted when zero to keep the envelope tidy.
   */
  gateAutoAcceptedCount?: number;
  /**
   * Total proposals that hit the auto-accept gate but failed validation
   * (e.g. truncated description, invalid frontmatter). These are logged as
   * warnings and skipped — they remain in the proposal queue for manual review.
   * Omitted when zero.
   */
  gateAutoAcceptFailedCount?: number;
  /**
   * Triage pre-pass outcome (array lengths from the pre-pass `DrainResult`
   * mapped to counts). Present only when the triage pre-pass actually ran
   * (non-dry-run, triage process enabled, whole-stash / type-scoped run);
   * omitted entirely otherwise to keep the envelope tidy.
   */
  triage?: { promoted: number; rejected: number; deferred: number; skippedByCap: number };
  /**
   * Layer 2 proactive-maintenance selector outcome. Present only when the
   * `proactiveMaintenance` process is enabled and the run was whole-stash / type
   * scope; omitted entirely otherwise. `selected` is the count of due assets
   * folded into the reflect/distill candidate set this run (bounded by
   * `maxPerRun`); `dueTotal` is the full due pool before the bound;
   * `neverReflected` is the subset of the due pool never previously reflected.
   */
  proactiveMaintenance?: { selected: number; dueTotal: number; neverReflected: number };
  /**
   * #609 — recombine / synthesize pass outcome. Present only when the opt-in
   * `recombine` process is enabled and the run was whole-stash / type scope;
   * omitted entirely otherwise to keep the envelope tidy.
   */
  recombination?: RecombineResult;
  /**
   * #615 — procedural-compilation pass outcome. Present only when the opt-in
   * `procedural` process is enabled and the run was whole-stash / type scope;
   * omitted entirely otherwise to keep the envelope tidy.
   */
  proceduralCompilation?: ProceduralCompilationResult;
  /**
   * R5 — the collapse/churn detector's cycle snapshot (mirrors one
   * improve_cycle_metrics row), present when this run qualified (consolidate
   * processed work or recombine formed clusters) and the detector is enabled.
   */
  cycleMetrics?: import("../storage/repositories/canaries-repository").CycleMetricsRow;
  /**
   * Run identifier minted by the CLI (`buildImproveRunId()`) and threaded
   * through `options.runId`. Surfaced on the result so health/run records and
   * the `{runId}` sync-commit token can read it. Absent for programmatic
   * callers that did not mint one.
   */
  runId?: string;
  /**
   * End-of-run auto-sync outcome for a git-backed primary stash. Present only
   * when sync was attempted (non-dry-run, git-backed stash, sync not disabled).
   * `skipped: true` covers both a no-op `saveGitStash` and a caught failure
   * (a sync failure is non-fatal and never fails the run).
   */
  sync?: { committed: boolean; pushed: boolean; skipped: boolean; reason?: string };
  /** Present only when a started run was persisted after abnormal termination. */
  terminated?: { reason: string; at: string; errorMessage?: string };
}

/** Historical improve-result envelope written before the 0.9 strategy cutover. */
export type LegacyAkmImproveResult = Omit<AkmImproveResult, "schemaVersion" | "strategy" | "strategyFilteredRefs"> & {
  schemaVersion: 1;
  profile?: string;
  profileFilteredRefs?: ImproveEligibleRef[];
};
