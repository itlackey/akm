// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { LlmUsageCrossTabRow } from "../commands/health/types";
import type { EngineUnavailableProcess, ProcessRoutingRow } from "../commands/improve/improve-strategies";
import type { EligibilitySource, Proposal } from "../commands/proposal/proposal-types";
import type { LoweringNotice } from "../execution/resolved-request";
import type { GraphExtractionResult } from "../indexer/graph/graph-extraction";
import type { MemoryInferenceResult } from "../indexer/passes/memory-inference";
import type { RunnerSpec } from "../integrations/agent/runner";
import type { AgentFailureReason } from "../integrations/agent/spawn";
import { assertNever } from "./assert";

// ── Memory-cleanup domain types (moved DOWN from commands/improve/memory,
// same layering fix as the verb-result types below: this file's own
// ImproveMemoryCleanupResult needs these shapes, so they live here rather
// than being imported UP from the command module that consumes this file.
export type MemoryPruneReason = "duplicate-derived" | "superseded-derived" | "obsolete-derived";
export type MemoryBeliefState = "active" | "asserted" | "deprecated" | "superseded" | "contradicted" | "archived";

export interface MemoryPruneCandidate {
  ref: string;
  parentRef: string;
  reason: MemoryPruneReason;
  survivorRef?: string;
}

export interface MemoryConsolidationCandidate {
  parentRef: string;
  signal: string;
  refs: string[];
  suggestedSurvivorRef: string;
}

export interface MemoryContradictionCandidate {
  ref: string;
  parentRef: string;
  reason: "contradicted-derived";
  contradictedByRef: string;
  contradictedByRefs: string[];
  currentBeliefRefs: string[];
}

export interface MemoryBeliefStateTransition {
  ref: string;
  parentRef: string;
  fromState: Exclude<MemoryBeliefState, "archived">;
  toState: Exclude<MemoryBeliefState, "archived">;
  reason: "contradicted-derived" | "belief-refresh";
  relatedRef?: string;
  relatedRefs?: string[];
  currentBeliefRefs?: string[];
}

export interface RelativeDateCandidate {
  ref: string;
  filePath: string;
  matches: string[];
}

/**
 * A URL found dead by `checkDeadUrls` (commands/url-checker.ts). `"timeout"`
 * means the request exceeded `DEAD_URL_TIMEOUT_MS` without a response;
 * `"error"` covers any other thrown failure that isn't a recognized
 * DNS/connection-level error (those are counted in `DeadUrlCoverage.skipped`
 * instead — see that type). Plain data, no dependencies — owned here.
 */
export interface DeadUrl {
  ref: string;
  url: string;
  status: number | "error" | "timeout";
}

/**
 * Coverage of a `checkDeadUrls` run: how many of the URLs found across the
 * entries it was given got a definitive answer. `total` is every URL those
 * entries contain — `checkDeadUrls` itself applies no cap or slice, and its
 * one caller (`runImprovePostLoopStage`) hands it every actionable knowledge
 * ref, not a subset (#892). `checked` can still fall short of `total`: a URL
 * whose request fails with a DNS/connection-level error (host unreachable,
 * DNS lookup failed, and similar) is indeterminate — that failure says
 * something about reaching the host from here, not about whether the URL is
 * dead — so it is counted in `skipped` rather than reported as a `DeadUrl` or
 * silently treated as healthy. `checked + skipped === total` always.
 */
export interface DeadUrlCoverage {
  checked: number;
  total: number;
  skipped: number;
}

export interface ArchivedMemoryCleanupRecord {
  ref: string;
  parentRef: string;
  reason: MemoryPruneReason;
  beliefState: "archived";
  previousBeliefState: Exclude<MemoryBeliefState, "archived">;
  survivorRef?: string;
  originalPath: string;
  archivedPath: string;
  auditPath: string;
  archivedAt: string;
}

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
   * Durable fully-qualified `<bundle>//<concept-id>` spelling from
   * `entries.item_ref`, derived from the resolved index entry at planning time.
   * Unset when the planner could not resolve provenance for the ref (for example,
   * an unindexed scope-ref target), in which case the conceptId `ref` is used.
   */
  itemRef?: string;
  /**
   * The eligibility lane that selected this ref for the current run. Stamped at
   * partition time in `runImprovePreparationStage` and threaded through to the
   * reflect/distill event emit sites and proposal creation. See
   * {@link EligibilitySource} for the lane vocabulary and precedence rule.
   */
  eligibilitySource?: EligibilitySource;
}

/** Operator-facing lane reported by the improve execution planner. */
export type ImprovePlanLane = EligibilitySource | "distill-only";

export interface ImprovePlanGate {
  name: "profile" | "cleanup" | "validation" | "signal" | "disk" | "limit";
  removed: number;
  reason: string;
}

/** Read-side index boundary used to build an improve plan. */
export interface ImproveIndexSnapshot {
  status: "ready" | "missing" | "incompatible" | "unknown";
  reason: string;
}

export interface ImproveExecutionPlan {
  /** A plan is an estimate until the live loop dispatches it. */
  mode: "estimate" | "execution";
  /** Always false for dry-run; true only on a live result. */
  dispatch: boolean;
  /** Whether the existing index could be queried without creating or migrating it. */
  snapshot: ImproveIndexSnapshot;
  candidates: {
    /** Every in-scope ref before profile/process gates. */
    rawInScope: number;
    /** Refs surviving selectors and disk checks, before the global limit. */
    selected: number;
    /** Final ranked refs the improve loop is allowed to dispatch. */
    effective: number;
  };
  limits: {
    /** Authored values, kept separate so precedence is visible. */
    configured: { cli?: number; profile?: number; reflect?: number };
    /** Base cap for ordinary (non-replay) refs, resolved from CLI -> reflect process -> profile. */
    effective?: number;
    /** Separately configured replay refs that may be appended beyond the base cap. */
    additiveReplayAllowance: number;
    /** Finite maximum dispatch count when a base cap exists; base cap + replay allowance. */
    totalCeiling?: number;
  };
  gates: ImprovePlanGate[];
  effectiveRefs: Array<{ ref: string; lane: ImprovePlanLane; reason: ImproveEligibleRef["reason"] }>;
  /**
   * Resolved process -> engine -> model routing table (#947), one row per
   * `IMPROVE_PROCESS_ENGINE_CAPABILITIES` name plus a `"triage.judgment"` row
   * when configured. Present on dry AND live results — this is a preflight
   * projection, not a dispatch report; #944's post-run cost/routing report is
   * a separate, additional field. Sourced from `ResolvedImprovePlan`, which
   * is resolved before any side effect on every invocation (dry or live), so
   * `--dry-run`/`--plan` shows a `--strategy` override for free.
   */
  processes: ProcessRoutingRow[];
  proactive?: {
    configured: { dueDays?: number; maxPerRun?: number; limit?: number };
    effective: { dueDays: number; maxPerRun: number };
    candidatePool: number;
    dueTotal: number;
    neverReflected: number;
    selected: number;
    selectedRefs: string[];
  };
  consolidation: {
    configured: {
      enabled?: boolean;
      minPoolSize?: number;
      limit?: number;
      maxChunkSize?: number;
      incrementalSince?: string;
    };
    effective: { enabled: boolean; minPoolSize: number; limit?: number; chunkSize: number };
    poolSize: number;
    candidatePoolSize: number;
    gates: {
      profile: { passed: boolean; reason: string };
      minimumPool: { passed: boolean; reason: string };
      delta: { passed: boolean; reason: string };
    };
    wouldRun: boolean;
    reason: string;
    estimatedChunks: number;
  };
  stages: Array<{
    name: "consolidation" | "extract" | "graph-extraction" | "memory-inference";
    wouldRun: boolean;
    reason: string;
  }>;
  triage: {
    enabled: boolean;
    /** Authored mode before autonomy/config resolution. */
    configuredMode: "queue" | "promote";
    /** Effective mode the live pre-pass will execute. */
    mode: "queue" | "promote";
    maxAcceptsPerRun: number;
    maxDiffLines?: number;
  };
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

// ── Verb result types (moved DOWN from commands/improve/*, WI-9.8 KILL 2) ───
//
// ConsolidateResult / AkmDistillResult / AkmExtractResult / AkmReflectResult
// used to live in their respective verb modules (consolidate.ts / distill.ts
// / extract.ts / reflect.ts), which this file imported UP from — the §10.7
// layering inversion: core/ is supposed to sit BELOW commands/, but this file
// depended on the very command modules that depend on it, and each verb
// module's own (heavy) transitive imports could route back here, gluing the
// whole improve command family into one import-cycle SCC. Moving the result
// shapes down here fixes the dependency direction; verb modules import their
// result types directly from this leaf.

/** Op-kind discriminator used in {@link ConsolidateResult.skipReasons}. */
export type ConsolidateOpKind = "merge" | "delete" | "promote" | "contradict";

export interface ConsolidateResult {
  schemaVersion: 1;
  ok: boolean;
  shape: "consolidate-result";
  dryRun: boolean;
  previewOnly: boolean;
  target: string;
  processed: number;
  merged: number;
  deleted: number;
  promoted: string[];
  /** Promotion proposals that could not be emitted and must be retried. */
  failedPromotions?: number;
  /** Number of contradiction edges written (C-3 / #382). */
  contradicted: number;
  /**
   * R5 §4.2 — merges that failed the ADVISORY merge-information floor this run
   * (provenance shrank or specificity retention below the configured floor).
   * The merges still proceeded in v1; the count feeds the collapse detector's
   * cycle metrics and the health advisory.
   */
  mergeFloorViolations?: number;
  /**
   * Number of LLM chunks that failed (HTTP error, empty/invalid plan, etc.)
   * during this run. Counterpart to {@link processed}, which counts INPUT
   * memories — `failedChunks` is the visibility signal for silent LLM
   * failures so they surface in `akm health` instead of being absorbed into
   * a misleadingly healthy `processed` count.
   *
   * Backstory: 2026-05-26 incident — 21/21 runs reported `processed: 118` /
   * `merged: 0` / `deleted: 0` while every chunk was actually being rejected
   * with `n_keep > n_ctx`. The "OK + warnings" envelope hid the fact that
   * the pass was a no-op. See
   * `/tmp/akm-health-investigations/consolidation-no-op.md`.
   */
  failedChunks?: number;
  /** Total chunks attempted this run; lets callers compute a failure rate. */
  totalChunks?: number;
  /**
   * Memories the LLM saw inside a chunk but proposed no op for. Per chunk:
   * `chunk.length − unique(ops.targetRefs)`. Pre-2026-05-26 this was a pure
   * silent drop — 66% of consolidate memories had no warning, event, or
   * counter. Without it, no consolidate prompt tuning is possible.
   * See `/tmp/akm-health-investigations/tuning-reasons-investigation.md` §Q2.
   */
  judgedNoAction?: number;
  /**
   * Structured per-op skip reasons emitted at every deterministic post-LLM
   * rejection site. Replaces the regex-on-`warnings[]` smell with a typed
   * histogram input. Codes intentionally use snake_case; see
   * `ConsolidateSkipReason` in health.ts for the vocabulary.
   */
  skipReasons?: Array<{
    ref: string;
    skips: Array<{ op: ConsolidateOpKind | "unknown"; reason: string }>;
  }>;
  /**
   * Secondary memories absorbed into successful merge operations. 2026-05-26
   * accounting-leak fix: `merged` is an OP-LEVEL counter (1 per merge op), but
   * each successful merge actions `1 + secondaries.length` memories. Without
   * `mergedSecondaries`, those secondaries are excluded from `judgedNoAction`
   * (their refs land in the chunk's `targetRefs`) and never accounted for
   * elsewhere, producing the small "processed − actioned − noAction − skips
   * = N missing" gap observed in the 2026-05-27 02:07 run (11 unaccounted)
   * and prior runs. Required for the invariant
   * `processed == promoted + merged + mergedSecondaries + deleted + contradicted
   *           + judgedNoAction + Σ(skipReasons) + failedChunkMemories`.
   */
  mergedSecondaries?: number;
  /**
   * Memories belonging to chunks whose LLM call failed (HTTP error / empty
   * response / invalid plan / consolidation-aborted by failure-rate threshold).
   * 2026-05-26 accounting-leak fix: these memories never reach the per-chunk
   * `judgedNoAction` computation (it lives after the success-path continue
   * guards) and never enter `skipReasons` either, so they were a pure silent
   * drop on every `failedChunks > 0` run. Required for the accounting
   * invariant.
   */
  failedChunkMemories?: number;
  /** Memories deferred by the pre-embedding budget cap. Deferred runs do not advance the completion watermark. */
  deferredMemories?: number;
  /**
   * Planned consolidate ops. Only the op-kind discriminant is used by core
   * consumers (e.g. the `op !== "promote"` advisory-op check in
   * `preparation.ts`); the full `ConsolidateOperation` shape lives in
   * commands/improve/consolidate/types.ts, which core must not import.
   */
  planned?: { op: ConsolidateOpKind }[];
  warnings: string[];
  durationMs: number;
  /** Stable, secret-free execution-lowering diagnostics. */
  notices?: readonly Readonly<LoweringNotice>[];
  /**
   * WS-5 perf telemetry (Part V). Always emitted when consolidation runs —
   * these are health VIEWS of the pipeline, not truth sources. Omitted on the
   * early-exit paths (no memories, all judged-unchanged) to keep the envelope
   * tidy.
   */
  perfTelemetry?: ConsolidatePerfTelemetry;
}

/**
 * WS-5 per-run consolidation performance telemetry (Part V §5 of the plan).
 * All fields are optional so existing callers that spread ConsolidateResult
 * can adopt the shape incrementally.
 */
export interface ConsolidatePerfTelemetry {
  /**
   * Pool size BEFORE incremental/limit narrowing.
   * Measures the raw candidate set loaded from disk this run.
   */
  dedupPoolSize?: number;
  /**
   * Pool size AFTER incremental and limit filtering — the memories actually
   * sent to the LLM for a fresh judgment.
   */
  llmPoolSize?: number;
  /**
   * Wall-clock milliseconds spent in the embedding stage (cluster
   * reordering). Extracted from timing around embedBatch calls so the LLM
   * wall-clock accounts only for LLM calls.
   */
  embedMs?: number;
  /**
   * Number of body-embedding cache hits (content_hash found in body_embeddings).
   * Healthy incremental run: >95% hits once the cache is warm.
   */
  embedCacheHits?: number;
  /**
   * Number of body-embedding cache misses (content_hash not found; embedBatch
   * was called). High misses signal a cold cache or high corpus churn.
   */
  embedCacheMisses?: number;
  /**
   * Fraction of the run budget consumed by consolidation alone:
   * `consolidation.durationMs / budgetMs`. Values >1.0 mean this consolidation
   * pass alone exceeded the caller's declared budget — a SIGTERM risk signal.
   */
  estimatedBudgetFractionUsed?: number;
}

/**
 * Outcome reported on every `distill` invocation. Mirrors the metadata stored
 * on the corresponding `distill_invoked` event so observers can read either
 * the command result or the events stream and see the same picture.
 *
 *   - `queued`           — LLM returned valid lesson content; proposal created.
 *   - `skipped`          — Feature gate disabled OR LLM call failed/timed out.
 *                          No proposal. Exit 0.
 *   - `validation_failed`— LLM returned content but it failed lesson lint.
 *                          No proposal. Exit non-zero (UsageError).
 */
/**
 * D-5 / #388: "review_needed" outcome replaces the binary quality-gate cutoff
 * for the uncertainty band (score 2.5–3.5). MT-Bench arXiv:2306.05685 reports
 * ~±0.5 judge variance — 15-25% of borderline proposals flip between runs.
 * The review-needed band converts uncertain cases into explicit human review
 * requests rather than opaque auto-decisions.
 */
export type DistillOutcome =
  | "queued"
  | "skipped"
  | "config_disabled"
  | "llm_failed"
  | "validation_failed"
  | "quality_rejected"
  | "review_needed";

export interface AkmDistillResult {
  schemaVersion: 1;
  ok: boolean;
  outcome: DistillOutcome;
  /** Original input ref (verbatim). */
  inputRef: string;
  /** Target or queued proposal ref. */
  proposalRef: string;
  /** Type of proposal the invocation targeted or queued. */
  proposalKind?: "lesson" | "knowledge";
  /** Proposal id when `outcome === "queued"`. */
  proposalId?: string;
  /** Human-readable hint surfaced when the call was skipped. */
  message?: string;
  /** Machine-readable reason when `outcome === "skipped"`. */
  skipReason?: string;
  /** Validation findings when `outcome === "validation_failed"`. */
  findings?: { kind: string; field: string; message: string }[];
  /** The full proposal object when `outcome === "queued"`. */
  proposal?: Proposal;
  /**
   * Diagnostic — number of feedback events filtered out by
   * `excludeFeedbackFromRefs` (#267). Always present when the option was
   * supplied, even when the count is 0. Callers (e.g. `bench evolve`) use
   * this to surface filter-applied notes in their `warnings[]`.
   */
  filteredFeedbackCount?: number;
  /**
   * True when `excludeFeedbackFromRefs` reduced the feedback set to empty
   * AND there were originally events for the target ref. Lets callers
   * distinguish "no feedback was ever recorded" from "we suppressed all
   * recorded feedback" — the LLM-input contract is identical (no feedback
   * shown) but the operator-visible meaning differs.
   */
  feedbackFullyFiltered?: boolean;
  /**
   * Judge score (1–5 float) when `outcome === "quality_rejected"`.
   * Present as -1 when the judge could not run (no LLM / timeout / parse
   * failure) and the gate failed CLOSED (07 P0-2) — the proposal is rejected,
   * not minted.
   */
  score?: number;
  /**
   * One-sentence reason from the LLM judge when `outcome === "quality_rejected"`.
   */
  reason?: string;
  /**
   * Count of description ↔ when_to_use auto-swaps performed during this
   * distill run (0 or 1 today; reserved as a counter so callers and health
   * dashboards can track how often the swap-normalization guard triggers).
   * Only present when at least one swap was applied.
   */
  descriptionSwapped?: number;
  /** Stable, secret-free execution-lowering diagnostics. */
  notices?: readonly Readonly<LoweringNotice>[];
}

export interface ExtractedSessionResult {
  sessionId: string;
  harness: string;
  candidateCount: number;
  proposalIds: string[];
  /** When candidates was empty, the LLM's explanation. */
  rationaleIfEmpty?: string;
  /** Pre-filter stats for the session. */
  preFilter: { inputCount: number; outputCount: number; truncatedCount: number };
  warnings: string[];
  skipped?: boolean;
  skipReason?:
    | "read_failed"
    | "llm_unavailable"
    | "malformed_model_output"
    | "exception"
    | "already_extracted"
    | "too_short"
    | "triaged_out"
    | "locked_concurrent";
  /** #561 — canonical ref of the session asset written for this session, when indexing is enabled and a summary was produced. */
  sessionAssetRef?: string;
  /** #561 — log_path recorded in the session asset frontmatter (durable correlation key). */
  sessionLogPath?: string;
  /**
   * #602 — sha256 (hex) of the normalized session content computed at process
   * time. Undefined only when the session failed to read (read_failed) before a
   * hash could be computed; the caller persists `contentHash ?? null` so such
   * rows stay eligible for retry.
   */
  contentHash?: string;
  /** Stable, secret-free execution-lowering diagnostics for this session. */
  notices?: readonly Readonly<LoweringNotice>[];
  /**
   * #913 — resolved engine name for the run that produced this session
   * result, stamped from the run's `llmRunner` at the point each result is
   * accounted into the run (`accountExtractSessionResult`). Always present:
   * every session result — success or any skip reason — is produced inside a
   * run that has already resolved its engine (the one path with no resolved
   * engine, the feature-disabled early return, produces zero session
   * results). Today this is the same value for every session in a run; it
   * exists per-session because a future per-session engine override would
   * populate it, and because it keeps ledger metadata self-describing.
   */
  engine: string;
}

/**
 * #912 — skip reasons that mean infrastructure failed to run the extraction,
 * not that a session was legitimately uninteresting. `already_extracted`,
 * `too_short`, and `triaged_out` are the ledger and pre-filter doing their
 * job and are deliberately excluded; `malformed_model_output` already gets
 * its own per-session forwarding into the envelope's `warnings[]` and is
 * excluded here to avoid double-reporting the same failure two ways.
 *
 * Typed against `ExtractedSessionResult["skipReason"]` so a future reason
 * cannot be added to one union without a compiler error surfacing here.
 */
export const EXTRACT_INFRASTRUCTURE_SKIP_REASONS = [
  "llm_unavailable",
  "read_failed",
  "exception",
  "locked_concurrent",
] as const satisfies readonly NonNullable<ExtractedSessionResult["skipReason"]>[];

export interface AkmExtractResult {
  schemaVersion: 1;
  /**
   * #912 — `ok` means the command ran to completion; it does not mean the
   * run harvested anything. It is `true` even when every discovered session
   * was skipped (including for an infrastructure reason like
   * `llm_unavailable`), because the exit code follows `ok` and a
   * SessionEnd/SessionStart hook must not start exiting non-zero because a
   * LAN engine is temporarily down. Consumers that need "did this run
   * actually harvest" branch on `skipReasons`, `warnings`, or the
   * `sessionsProcessed`/`sessionsSkipped` counts instead.
   */
  ok: boolean;
  shape: "extract-result";
  dryRun: boolean;
  type: string;
  sessionsProcessed: number;
  sessionsSkipped: number;
  candidatesCreated: number;
  proposals: string[];
  sessions: ExtractedSessionResult[];
  warnings: string[];
  durationMs: number;
  /** Stable, secret-free execution-lowering diagnostics. */
  notices?: readonly Readonly<LoweringNotice>[];
  /**
   * #912 — per-reason count across every result in `sessions[]` (all skip
   * reasons, not only infrastructure ones — the aggregate warning line in
   * `warnings[]` is the infrastructure-only subset of this map). Present
   * whenever `sessionsSkipped > 0`; absent (not merely empty) on a run that
   * skipped nothing, so the envelope stays byte-identical to a run with no
   * skips to report.
   */
  skipReasons?: Partial<Record<NonNullable<ExtractedSessionResult["skipReason"]>, number>>;
  /**
   * #913 — resolved engine name / kind for this run, sourced from the same
   * `llmRunner` stamped onto each `sessions[].engine`. Optional because the
   * feature-disabled early return (`extract is disabled by the selected
   * improve strategy`) returns before any engine is resolved; every other
   * return path — including the harness-not-found/not-available and
   * session-not-found envelopes, which resolve the run's engine before
   * looking up the harness — has a real value here.
   */
  engine?: string;
  /** Kind of the runner `engine` resolved to; absent under the same condition as `engine`. */
  engineKind?: RunnerSpec["kind"];
}

export interface AkmReflectFailure {
  schemaVersion: 2;
  ok: false;
  reason: AgentFailureReason;
  error: string;
  ref?: string;
  engine?: string;
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  /** Stable, secret-free execution-lowering diagnostics. */
  notices?: readonly Readonly<LoweringNotice>[];
}

export interface AkmReflectSuccess {
  schemaVersion: 2;
  ok: true;
  proposal: Proposal;
  ref: string;
  engine: string;
  durationMs: number;
  /** Stable, secret-free execution-lowering diagnostics. */
  notices?: readonly Readonly<LoweringNotice>[];
}

export type AkmReflectResult = AkmReflectSuccess | AkmReflectFailure;

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
  /** Deduplicated, secret-free execution-lowering diagnostics from this run. */
  notices?: readonly Readonly<LoweringNotice>[];
  /**
   * Present when the run did no work because another improve held the whole-run
   * lock and `skipIfLocked` was set. The run exits 0; `reason` is `"lock-held"`.
   */
  skipped?: { reason: string };
  guidance?: string;
  memorySummary: {
    eligible: number;
    derived: number;
  };
  memoryCleanup?: ImproveMemoryCleanupResult;
  plannedRefs: ImproveEligibleRef[];
  /** Effective planner projection shared by dry-run preview and live execution. */
  plan?: ImproveExecutionPlan;
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
  /**
   * #957 — processes the active strategy enabled but whose engine could not
   * be resolved (no engine selected) or whose credential could not be
   * resolved in this process's own environment (the scheduler-vs-shell
   * mismatch #957 exists for). Sourced verbatim from
   * `ResolvedImprovePlan.engineUnavailable`; omitted entirely when nothing
   * was skipped this way.
   *
   * Like `AkmExtractResult.skipReasons` (#912, see that field's doc comment):
   * `ok` still means the run completed, not that it did work, and the exit
   * code follows `ok` — a scheduler must not start failing because one LLM
   * process's credential is temporarily missing while others still run.
   * Consumers that need to know branch on this field's presence/length
   * (or `akm improve --require-engines`, which aborts up front instead of
   * degrading). A credential-unavailable `reason` names the engine and WHICH
   * env var / apiKeyFile path / secret reference is missing — never its
   * value — so an operator whose own shell passes config validation can see
   * why the scheduler's stripped-down environment does not.
   */
  skippedProcesses?: readonly Readonly<EngineUnavailableProcess>[];
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
    outcome: "queued" | "skipped" | "error";
    proposalId?: string;
    error?: string;
  }>;
  consolidation?: ConsolidateResult;
  /**
   * Session-extract pass results (one entry per available harness). Present
   * when the selected strategy's `processes.extract.enabled` is explicitly true
   * and at least one harness reports `isAvailable() === true`.
   */
  extract?: AkmExtractResult[];
  lintSummary?: { fixed: number; flagged: number };
  memoryIndexHealth?: { lineCount: number; overBudget: boolean };
  coverageGaps?: string[];
  evalCasesWritten?: number;
  deadUrls?: DeadUrl[];
  /**
   * Coverage of the dead-link check (#892): present whenever `checkDeadUrls`
   * ran, independent of whether it found any dead URLs — so a clean run
   * still tells `akm health` how much of the bundle it actually covered.
   */
  deadUrlCoverage?: DeadUrlCoverage;
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
   * Total proposals auto-promoted by the (deleted, 0.9.0) improve confidence
   * gate across all phases. Always 0/omitted for new runs; kept on the
   * envelope allow-list because historical improve_runs rows carry counts.
   */
  gateAutoAcceptedCount?: number;
  /**
   * Total proposals that hit the (deleted, 0.9.0) confidence gate but failed
   * validation. Always 0/omitted for new runs; kept for historical rows.
   */
  gateAutoAcceptFailedCount?: number;
  /**
   * Triage pre-pass outcome (array lengths from the pre-pass `DrainResult`
   * mapped to counts). Present only when the triage pre-pass actually ran
   * (non-dry-run, triage process enabled, whole-stash / type-scoped run);
   * omitted entirely otherwise to keep the envelope tidy.
   */
  triage?: { promoted: number; rejected: number; deferred: number; failed: number; skippedByCap: number };
  /**
   * Layer 2 proactive-maintenance selector outcome. Present only when the
   * `proactiveMaintenance` process is enabled and the run was whole-stash / type
   * scope; omitted entirely otherwise. `selected` is the count of due assets
   * folded into the reflect/distill candidate set this run (bounded by
   * `maxPerRun`); `dueTotal` is the full due pool before the bound;
   * `neverReflected` is the subset of the due pool never previously reflected.
   */
  proactiveMaintenance?: { selected: number; dueTotal: number; neverReflected: number; selectedRefs: string[] };
  /**
   * R5 — the collapse/churn detector's cycle snapshot (mirrors one
   * improve_cycle_metrics row), present when this run qualified (consolidate
   * processed work) and the detector is enabled.
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
  /**
   * #652 — run-scoped write provenance: every path this run actually wrote,
   * created, or removed, as recorded by the write-provenance journal (NOT
   * inferred from a Git dirty-path diff). This is the exact set the end-of-run
   * auto-sync scopes its commit to, minus paths whose final bytes match HEAD.
   *
   * Deduped and sorted. Entries are POSIX paths relative to the run's primary
   * stash dir; a write that landed outside it (e.g. a `--target` bundle) is
   * reported as an absolute path. Omitted entirely when the run wrote nothing —
   * and always absent on a dry run, which writes nothing by construction.
   */
  writtenPaths?: string[];
  /** Present only when a started run was persisted after abnormal termination. */
  terminated?: { reason: string; at: string; errorMessage?: string };
  /**
   * #944 — this run's LLM call/token/failure accounting, split by process x
   * engine x model, plus which strategy-enabled processes made zero calls and
   * why. `byProcessEngineModel` is `summarizeLlmUsageCrossTab` over this run's
   * own `llm_usage` events (bounded to `[startedAt, completedAt)`, the same
   * per-run event-scoping technique `health/windows.ts` already uses for wall
   * time — events carry no `runId` column). `noCalls` covers every process the
   * active strategy enabled (including one disabled for `engineUnavailable`)
   * that ended the run with zero attributed calls; `reason` is drawn from the
   * existing `improve_skipped` reason vocabulary
   * (`"engine_unavailable"`/`"strategy_filtered_all_passes"`/`"autonomy_gated"`,
   * a reflect/distill `skippedByReason` dominant key, or `"no_signal"` as the
   * fallback) — never a fabricated category. Omitted entirely when both
   * arrays would be empty (e.g. a dry run, or a run that made no LLM calls
   * and enabled no LLM-backed process).
   */
  usageReport?: {
    byProcessEngineModel: readonly Readonly<LlmUsageCrossTabRow>[];
    noCalls: readonly Readonly<{ process: string; engine?: string; reason: string }>[];
  };
}
