// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared improve run/option/result types — the dependency LEAF that severs the
 * improve ↔ loop-stages ↔ preparation import cycle (SCC #8; chunk-9
 * anchors.md D.3 / D.4.2, brief.md WI-9.10).
 *
 * `improve.ts` imports the stage functions (VALUES) from `./loop-stages` and
 * `./preparation`; those two files, in turn, used to import the shared
 * option/result types (`AkmImproveOptions`, `ImprovePreparationResult`,
 * `ImproveScope`, `ConsolidationPassResult`, `ImproveLoopResult`,
 * `ImproveMaintenanceResult`, `ImprovePostLoopResult`) back from `./improve`
 * — a type-only back-edge that the import-cycle ratchet counts the same as a
 * value edge (dependency direction is an architecture property). Moving the
 * definitions here — a module that imports from neither `./improve` nor
 * `./loop-stages` nor `./preparation` — breaks the cycle. `improve.ts`
 * re-exports every type below so its existing external importers (src +
 * tests) are unaffected.
 *
 * `ImproveLoopState` replaces the legacy dual-context interface this chunk
 * deleted (see anchors.md A.2): it wraps a {@link RunContext} (the minted,
 * run-scoped DI carrier from `./run-context`) plus the improve loop's own
 * immutable run snapshot fields and mutable per-run accumulators.
 * `eventsCtx`/`budgetSignal` — optional fields on the old interface — are
 * dropped in favor of the equivalent `ctx.eventsCtx` (required) /
 * `ctx.signal`; `primaryStashDir` stays an explicit optional field (see its
 * doc on {@link ImproveLoopState} — the rare unresolvable-primary path needs
 * an honest `undefined` that the required `ctx.stashDir` cannot encode).
 *
 * A few `AkmImproveOptions` test-seam fields (the `runImprove*StageFn`
 * overrides) reference functions defined in `./loop-stages` / `./preparation`
 * — the exact files this module must stay a leaf with respect to. Those three
 * fields use inline `typeof import("./loop-stages")...` / `typeof
 * import("./preparation")...` type queries instead of top-level `import type`
 * declarations: the cycle ratchet's static graph walks only top-level
 * `ImportDeclaration`/`ExportDeclaration` nodes (scripts/lint-import-cycles.ts
 * `buildImportGraph`), so an inline import-type query never becomes a graph
 * edge. This is the one place in this file that trick is needed; every other
 * field's type is sourced from files that do not import back from `./improve`
 * / `./loop-stages` / `./preparation`.
 */

import type { AkmConfig, ImproveProfileConfig } from "../../core/config/config";
import type { EventEnvelope } from "../../core/events";
import type { ImproveActionResult, ImproveEligibleRef } from "../../core/improve-types";
import type { ResolvedWriteTarget } from "../../core/write-source";
import type { EnsureIndexOptions } from "../../indexer/ensure-index";
import type { GraphExtractionResult, runGraphExtractionPass } from "../../indexer/graph/graph-extraction";
import type { MemoryInferenceResult, runMemoryInferencePass } from "../../indexer/passes/memory-inference";
import type { SessionLogHarness } from "../../integrations/session-logs/types";
import type { saveGitStash } from "../../sources/providers/git";
import type { drainProposals } from "../proposal/drain";
import type { DeadUrl } from "../url-checker";
import type { AkmConsolidateOptions, ConsolidateResult } from "./consolidate";
import type { AkmDistillResult, akmDistill } from "./distill";
import type { collectEligibleRefs, resolveImproveScope } from "./eligibility";
import type { AkmExtractResult, countNewExtractCandidates } from "./extract";
import type { ResolvedImprovePlan } from "./improve-strategies";
import type { detectAndWriteContradictions } from "./memory/memory-contradiction-detect";
import type { applyMemoryCleanup } from "./memory/memory-improve";
import type { AkmReflectResult, akmReflect } from "./reflect";
import type { RunContext } from "./run-context";

export type ImproveScope = ReturnType<typeof resolveImproveScope>;

export interface AkmImproveOptions {
  scope?: string;
  task?: string;
  dryRun?: boolean;
  target?: string;
  /** Write target resolved once at the improve invocation boundary. */
  writeTarget?: ResolvedWriteTarget;
  /** Stable source identity used for durable source-qualified improve state. */
  sourceName?: string;
  stashDir?: string;
  config?: AkmConfig;
  /** Internal cutover flag: permit bare durable-state reads for the historical local stash only. */
  legacyBareState?: boolean;
  /** Invocation plan preflighted by the public CLI before any side effects. */
  resolvedPlan?: ResolvedImprovePlan;
  /**
   * Run identifier minted by the CLI (`buildImproveRunId()`). Threaded onto the
   * result so health/run records and sync-commit templates (`{runId}`) can read
   * it. Undefined for programmatic callers that do not mint one.
   */
  runId?: string;
  /** Wall-clock budget for the entire improve run in milliseconds. Defaults to 2 hours. */
  timeoutMs?: number;
  limit?: number;
  /**
   * When another improve run already holds the lock, skip the whole run
   * gracefully instead of failing with an "already running" config error.
   * Intended for scheduled runs that should not overlap. Default: false.
   */
  skipIfLocked?: boolean;
  /** Named improve strategy from improve.strategies or built-in strategy names. */
  strategy?: string;
  /** Test seam: override collectEligibleRefs. */
  collectEligibleRefsFn?: typeof collectEligibleRefs;
  /** Test seam: override runImprovePreparationStage. */
  runImprovePreparationStageFn?: typeof import("./preparation").runImprovePreparationStage;
  /** Test seam: override runImproveLoopStage. */
  runImproveLoopStageFn?: typeof import("./loop-stages").runImproveLoopStage;
  /** Test seam: override runImprovePostLoopStage. */
  runImprovePostLoopStageFn?: typeof import("./loop-stages").runImprovePostLoopStage;
  consolidateOptions?: Omit<AkmConsolidateOptions, "config" | "stashDir">;
  /** Number of eligible memory assets above which consolidation is forced even if the memory_consolidation feature flag is not set. Defaults to 100. */
  memoryVolumeConsolidationThreshold?: number;
  reflectFn?: (options: NonNullable<Parameters<typeof akmReflect>[0]>) => Promise<AkmReflectResult>;
  distillFn?: (options: NonNullable<Parameters<typeof akmDistill>[0]>) => Promise<AkmDistillResult>;
  memoryInferenceFn?: typeof runMemoryInferencePass;
  graphExtractionFn?: typeof runGraphExtractionPass;
  /** Injectable contradiction-detection seam for invocation-plan boundary tests. */
  contradictionDetectionFn?: typeof detectAndWriteContradictions;
  /**
   * #554 minNewSessions gate: injectable counter for the number of NEW (unseen,
   * in-window) extract candidate sessions. Defaults to the real
   * {@link countNewExtractCandidates}. Tests inject a deterministic count to
   * exercise the below-threshold skip without touching real session logs.
   */
  extractCandidateCountFn?: typeof countNewExtractCandidates;
  /**
   * Override the session-log harness registry used by the extract phase (test
   * seam). When set, it is forwarded to both the #554 candidate counter and the
   * `akmExtract` calls so the same harness set drives the gate and the pass.
   */
  extractHarnesses?: SessionLogHarness[];
  ensureIndexFn?: (stashDir: string, options?: EnsureIndexOptions) => Promise<unknown>;
  reindexFn?: (options: { stashDir: string; signal?: AbortSignal }) => Promise<unknown>;
  /** Attempt LLM-driven repair after the unconditional structural validation sweep. Default true. */
  repairValidationFailures?: boolean;
  /**
   * When true, only assets with recent feedback signals are eligible.
   * Disables the proactive/high-salience fallback lanes for type/all scope runs.
   */
  requireFeedbackSignal?: boolean;
  /**
   * Named process key forwarded to `akmReflect` so the improve loop picks up
   * per-process agent config (e.g. `agent.processes["reflect"]`).
   * Defaults to `"reflect"`. Set to another process name to route improve's
   * reflect calls through a different profile.
   */
  agentProcess?: string;
  /**
   * Phase 4: injectable triage drain seam for tests. When omitted, the real
   * `drainProposals` runs as the improve pre-pass (gated on the `triage`
   * process being enabled, `scope.mode !== "ref"`, and `!options.dryRun`).
   */
  drainProposalsFn?: typeof drainProposals;
  /**
   * Injectable end-of-run stash-sync seam for tests. When omitted, the real
   * `saveGitStash` runs (gated on a git-backed primary stash + sync enabled).
   */
  saveGitStashFn?: typeof saveGitStash;
  /**
   * End-of-run auto-sync override (from CLI `--no-sync`/`--no-push`). Only the
   * keys the caller passed are set; CLI overrides the resolved profile `sync`
   * block, which in turn overrides the built-in default.
   */
  sync?: { enabled?: boolean; push?: boolean };
}

export interface ImprovePreparationResult {
  actions: ImproveActionResult[];
  cleanupWarnings: string[];
  appliedCleanup?: Awaited<ReturnType<typeof applyMemoryCleanup>>;
  memoryIndexHealth?: { lineCount: number; overBudget: boolean };
  /** Session-extract pass results (one per available harness), when enabled. */
  extract?: AkmExtractResult[];
  /**
   * Genuinely processable refs in priority order: post-validation, post-cooldown
   * (fully reflect+distill cooled refs are excluded and their synthetic skip
   * actions/events are emitted during preparation), post-signal-filter, and
   * sorted by combined utility + feedback-negativity score. distillOnly refs
   * participate in this set so --limit selects by score. Callers consuming
   * `plannedRefs` in the result envelope and post-loop maintenance use this
   * as the canonical "what got worked on this run" view.
   */
  actionableRefs: ImproveEligibleRef[];
  signalBearingSet: Set<string>;
  validationFailures: Array<{ ref: string; reason: string }>;
  schemaRepairs: Array<{
    ref: string;
    reason: string;
    outcome: "queued" | "written" | "skipped" | "error";
    proposalId?: string;
    error?: string;
  }>;
  lintSummary?: { fixed: number; flagged: number };
  loopRefs: ImproveEligibleRef[];
  distillCooledRefs: Set<string>;
  /** Refs on reflect cooldown but eligible for distill-only processing (Bug D2). */
  distillOnlyRefs: ImproveEligibleRef[];
  coverageGaps: string[];
  /** Per-ref utility scores (R-2 / #389): used for self-consistency threshold check. */
  utilityMap: Map<string, number>;
  /**
   * Per-originator rolling error windows (O-5 / #378).
   *
   * Errors from one sub-pass must NOT be injected into unrelated sub-passes as
   * avoidPatterns — that is the cross-task contamination failure mode Reflexion
   * (arXiv:2303.11366) warns against. Each originator key ("schema-repair",
   * "reflect", "distill") maps to its own rolling window of last-N errors.
   */
  recentErrors: Record<string, string[]>;
  gateAutoAcceptedCount: number;
  gateAutoAcceptFailedCount: number;
  /**
   * Consolidation result (#551). Consolidation now runs in the preparation
   * stage BEFORE the session-extract pass, so it only ever judges memories
   * promoted by PRIOR runs — files written by extract promotions in the
   * current run do not exist yet when the pool-delta gate is evaluated.
   */
  consolidation: ConsolidateResult;
  /** Whether the consolidation pass actually ran (vs profile-disabled / pool-delta skip). Drives graph-extraction reindex. */
  consolidationRan: boolean;
  /**
   * Layer 2 proactive-maintenance selector outcome, when the process ran.
   * Undefined when the process is disabled or the run is ref-scoped.
   */
  proactiveMaintenance?: { selected: number; dueTotal: number; neverReflected: number };
}

export interface ImproveLoopResult {
  reflectsWithErrorContext: number;
  memoryRefsForInference: Set<string>;
  gateAutoAcceptedCount: number;
  gateAutoAcceptFailedCount: number;
}

export interface ImprovePostLoopResult {
  allWarnings: string[];
  gateAutoAcceptedCount: number;
  gateAutoAcceptFailedCount: number;
  deadUrls?: DeadUrl[];
  memoryInference?: MemoryInferenceResult;
  graphExtraction?: GraphExtractionResult;
  maintenanceActions?: ImproveActionResult[];
  memoryInferenceDurationMs: number;
  graphExtractionDurationMs: number;
  orphansPurged?: number;
  /** Phase 6B (Advantage D6b): pending proposals archived as expired this run. */
  proposalsExpired?: number;
  /** R5: the collapse/churn detector's cycle snapshot, when this run qualified. */
  cycleMetrics?: import("../../storage/repositories/canaries-repository").CycleMetricsRow;
}

export interface ImproveMaintenanceResult {
  memoryInference?: MemoryInferenceResult;
  graphExtraction?: GraphExtractionResult;
  actions?: ImproveActionResult[];
  memoryInferenceDurationMs: number;
  graphExtractionDurationMs: number;
  orphansPurged?: number;
  /** Phase 6B (Advantage D6b): pending proposals archived as expired this run. */
  proposalsExpired?: number;
}

/**
 * Result of the consolidation pass (#551).
 *
 * Consolidation moved OUT of the post-loop stage and into the preparation
 * stage, where it runs BEFORE the session-extract pass. This guarantees the
 * pool-delta gate (and akmConsolidate itself) only ever observe memories that
 * existed at the start of the run — files written by extract promotions in the
 * CURRENT run are not on disk yet, so they cannot make the gate fire.
 */
export interface ConsolidationPassResult {
  consolidation: ConsolidateResult;
  /** True iff consolidation actually processed memories this run (drives graph reindex). */
  consolidationRan: boolean;
  gateAutoAcceptedCount: number;
  gateAutoAcceptFailedCount: number;
}

/**
 * Mutable improve-loop state: the (WI-9.10) unification of the deleted
 * legacy dual-context interface onto the minted {@link RunContext}. `ctx`
 * carries every run-scoped, immutable DI seam (stashDir, config, eventsCtx,
 * proposalsCtx, chat, getLlmConfig, sourceRun, dryRun, signal, now, asset IO
 * — see `./run-context`); the fields below are the improve-loop-specific
 * state that `RunContext` does not model — an immutable run snapshot plus
 * the mutable per-run accumulators the loop folds into as it walks
 * `loopRefs`.
 *
 * Field mapping from the deleted interface: `eventsCtx?` → `ctx.eventsCtx`
 * (now required — resolves the chunk-7 ledgered type blocker, anchors.md
 * A.2); `budgetSignal?` → `ctx.signal` (same `AbortSignal` instance the
 * run's budget watchdog stamped a `remainingBudgetMs` getter onto — identity
 * preserved end to end); `primaryStashDir?` stays an explicit optional field
 * here (see its doc below — the rare unresolvable-primary path must keep its
 * pre-unification skip behavior, which a required `ctx.stashDir` cannot
 * encode).
 */
export interface ImproveLoopState {
  /** The run-scoped, immutable DI carrier (see `./run-context`). */
  ctx: RunContext;
  // ── immutable run snapshot ────────────────────────────────────────────
  /**
   * The primary stash root — `undefined` when `akmImprove`'s
   * `resolveSourceEntries` lookup failed or returned no entries (rare). The
   * downstream loop-stage guards (`if (primaryStashDir)`) must keep SKIPPING
   * on that path exactly as they did pre-unification, so the honest optional
   * is threaded here; `ctx.stashDir` (required by the `RunContext` contract)
   * carries a best-effort fallback that no RunContext consumer reads on the
   * unresolvable path. Collapsing the two awaits a maintainer decision on
   * retiring the unresolvable-primary path itself.
   */
  primaryStashDir: string | undefined;
  scope: ImproveScope;
  options: AkmImproveOptions;
  reflectFn: (options: NonNullable<Parameters<typeof akmReflect>[0]>) => Promise<AkmReflectResult>;
  distillFn: (options: NonNullable<Parameters<typeof akmDistill>[0]>) => Promise<AkmDistillResult>;
  /** Active improve profile, resolved from profile name + config. */
  improveProfile: ImproveProfileConfig;
  /** Engine/materialized-connection snapshot shared by every process in this run. */
  resolvedPlan: ResolvedImprovePlan;
  startMs: number;
  budgetMs: number;
  // ── mutable per-run accumulators ──────────────────────────────────────
  loopRefs: ImproveEligibleRef[];
  actions: ImproveActionResult[];
  signalBearingSet: Set<string>;
  distillCooledRefs: Set<string>;
  /** Refs that should only run the distill path (reflect-cooled but distill expired, Bug D2). */
  distillOnlyRefs: ImproveEligibleRef[];
  /** Per-originator rolling error windows (O-5 / #378). */
  recentErrors: Record<string, string[]>;
  /** D6: pre-loaded map of most-recent proposal_rejected event per ref (last 30d). */
  rejectedProposalsByRef: Map<string, EventEnvelope>;
  /** R-2 / #389: per-ref utility scores for self-consistency threshold check. */
  utilityMap: Map<string, number>;
}
