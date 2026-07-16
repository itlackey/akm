// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { assertNever } from "../../core/assert";
import { daysToMs } from "../../core/common";
import type { AkmConfig } from "../../core/config/config";
import { loadConfig } from "../../core/config/config";
import { rethrowIfTestIsolationError } from "../../core/errors";
import { appendEvent, type EventEnvelope, type EventsContext, readEvents } from "../../core/events";
import type { LockOwnership } from "../../core/file-lock";
import type {
  AkmImproveResult,
  EligibilitySource,
  ImproveActionResult,
  ImproveEligibleRef,
  ImproveMemoryCleanupResult,
} from "../../core/improve-types";
import { classifyImproveAction, foldDistillSkipped } from "../../core/improve-types";
import { getDbPath, getStateDbPathInDataDir } from "../../core/paths";
import { redactSensitiveText } from "../../core/redaction";
import { openStateDatabase } from "../../core/state-db";
import { info, warn } from "../../core/warn";
import { type ResolvedWriteTarget, resolveWritable, resolveWriteTarget } from "../../core/write-source";
import { closeDatabase, getEntryCount, openExistingDatabase } from "../../indexer/db/db";
import { type EnsureIndexOptions, ensureIndex } from "../../indexer/ensure-index";
import type { GraphExtractionResult, runGraphExtractionPass } from "../../indexer/graph/graph-extraction";
import { akmIndex } from "../../indexer/indexer";
import type { MemoryInferenceResult, runMemoryInferencePass } from "../../indexer/passes/memory-inference";
import { resolveSourceEntries } from "../../indexer/search/search-source";
import { collectEngineCredentialValues } from "../../integrations/agent/engine-resolution";
import { materializeLlmRunnerConnection } from "../../integrations/agent/runner";
import type { SessionLogHarness } from "../../integrations/session-logs/types";
import { installLlmUsagePersistence } from "../../llm/usage-persist";
import { withLlmStage } from "../../llm/usage-telemetry";
import {
  isGitBackedStash,
  listGitChangedPaths,
  resolveWritableOverride,
  saveGitStash,
} from "../../sources/providers/git";
import { type DrainResult, drainProposals } from "../proposal/drain";
import { resolveDrainPolicy } from "../proposal/drain-policies";
import type { DeadUrl } from "../url-checker";
import type { AkmConsolidateOptions, ConsolidateResult } from "./consolidate";
import { type AkmDistillResult, akmDistill } from "./distill";
// Eligibility / candidate-selection predicates live in ./eligibility.
import {
  buildLatestProposalTsMap,
  collectEligibleRefs,
  collectEligibleRefsReadOnly,
  memoryCleanupParentRef,
  resolveImproveScope,
  shouldAnalyzeMemoryCleanup,
} from "./eligibility";
import { countEvalCases } from "./eval-cases";
import type { AkmExtractResult, countNewExtractCandidates } from "./extract";
import { type ResolvedImprovePlan, resolveImprovePlan } from "./improve-strategies";
import { improveLockPath, MIN_IMPROVE_LOCK_STALE_MS, releaseImproveLock, tryAcquireImproveLock } from "./locks";
// The cycle loop / post-loop / maintenance stages live in ./loop-stages.
import { runImproveLoopStage, runImprovePostLoopStage } from "./loop-stages";
import { detectAndWriteContradictions } from "./memory/memory-contradiction-detect";
import { analyzeMemoryCleanup, type applyMemoryCleanup, type MemoryCleanupPlan } from "./memory/memory-improve";
// The pre-loop preparation pipeline lives in ./preparation.
import { runImprovePreparationStage } from "./preparation";
import { DEFAULT_DUE_DAYS, filterProactiveDue } from "./proactive-maintenance";
import { type AkmReflectResult, akmReflect } from "./reflect";
import { errMessage } from "./shared";
import { shouldReadLegacyBareImproveState } from "./source-identity";

// Re-exported from ./loop-stages for test importers (improve-db-locking).
export { runImproveMaintenancePasses } from "./loop-stages";

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
  runImprovePreparationStageFn?: typeof runImprovePreparationStage;
  /** Test seam: override runImproveLoopStage. */
  runImproveLoopStageFn?: typeof runImproveLoopStage;
  /** Test seam: override runImprovePostLoopStage. */
  runImprovePostLoopStageFn?: typeof runImprovePostLoopStage;
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

export type {
  AkmImproveResult,
  EligibilitySource,
  ImproveActionResult,
  ImproveEligibleRef,
  ImproveMemoryCleanupResult,
};

export type ImproveScope = ReturnType<typeof resolveImproveScope>;

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

export function renderSyncCommitMessage(
  template: string,
  result: {
    scope: { mode: string; value?: string };
    plannedRefs: unknown[];
    gateAutoAcceptedCount?: number;
    triage?: { promoted: number; rejected: number; deferred: number; skippedByCap: number };
    runId?: string;
  },
  nowMs: number,
): string {
  const iso = new Date(nowMs).toISOString();
  const tokens: Record<string, string> = {
    timestamp: `${iso.slice(0, 10)} ${iso.slice(11, 19)}`,
    date: iso.slice(0, 10),
    time: iso.slice(11, 19),
    scope: result.scope.value ?? result.scope.mode,
    refs: String(result.plannedRefs.length),
    accepted: String(result.gateAutoAcceptedCount ?? 0),
    triage_promoted: String(result.triage?.promoted ?? 0),
    triage_rejected: String(result.triage?.rejected ?? 0),
    runId: result.runId ?? "",
  };
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (Object.hasOwn(tokens, key) ? tokens[key] : match));
}

export function armBudgetWatchdog(
  budgetMs: number,
  controller: AbortController,
  deps?: {
    setTimeoutFn?: typeof setTimeout;
    clearTimeoutFn?: typeof clearTimeout;
    exitFn?: (code: number) => void;
    hardKillGraceMs?: number;
  },
): () => void {
  const setTimeoutFn = deps?.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps?.clearTimeoutFn ?? clearTimeout;
  const exitFn = deps?.exitFn ?? ((code: number) => process.exit(code));
  const hardKillGraceMs = deps?.hardKillGraceMs ?? 5_000;

  let hardKillTimer: ReturnType<typeof setTimeout> | undefined;

  const budgetTimer = setTimeoutFn(() => {
    // Cooperative cancellation first: let the run drain.
    controller.abort("improve budget exhausted");
    // Watchdog: only force-exit if the drain itself overruns the grace period.
    // Exit 0: budget exhaustion is a normal scheduled-task condition, not an error.
    hardKillTimer = setTimeoutFn(() => exitFn(0), hardKillGraceMs);
    // Never keep the event loop alive solely for the watchdog.
    hardKillTimer.unref?.();
  }, budgetMs);

  // RAII dispose: clears whichever timer is still pending. Idempotent.
  return () => {
    clearTimeoutFn(budgetTimer);
    if (hardKillTimer !== undefined) {
      clearTimeoutFn(hardKillTimer);
      hardKillTimer = undefined;
    }
  };
}

export async function akmImprove(options: AkmImproveOptions = {}): Promise<AkmImproveResult> {
  const setup = resolveImproveRunSetup(options);
  options = setup.options;
  const {
    budgetMs,
    budgetAbortController,
    scope,
    selectedStrategy,
    syncRepoDir,
    resolvedStateDbPath,
    resolvedLockPath,
    lockStaleAfterMs,
  } = setup;
  let clearBudgetTimer = (): void => {};
  let initialGitPaths = new Set<string>();

  const preEnsureCleanupWarnings: string[] = [];
  // Assigned by runIndexAndCollect() (closure) so TS cannot prove definite
  // assignment — seed with empty values; the runIndexAndCollect() call below
  // always overwrites them before any read.
  let plannedRefs: Awaited<ReturnType<typeof collectEligibleRefs>>["plannedRefs"] = [];
  let memorySummary: Awaited<ReturnType<typeof collectEligibleRefs>>["memorySummary"] = { eligible: 0, derived: 0 };
  let strategyFilteredRefs: Awaited<ReturnType<typeof collectEligibleRefs>>["strategyFilteredRefs"] = [];
  let memoryCleanupPlan: ReturnType<typeof analyzeMemoryCleanup> | undefined;
  let guidance: string | undefined;
  let triageDrain: DrainResult | undefined;

  let improveLockOwnership: LockOwnership | undefined;
  let exitBackstop: (() => void) | undefined;
  const releaseRunLock = (): void => {
    const ownership = improveLockOwnership;
    if (!ownership) return;
    improveLockOwnership = undefined;
    try {
      releaseImproveLock(ownership);
    } catch {
      // Best-effort cleanup. Exact ownership prevents deleting a successor.
    }
  };

  if (!options.dryRun) {
    const remainingBudget = (budgetAbortController.signal as { remainingBudgetMs?: number }).remainingBudgetMs;
    clearBudgetTimer = armBudgetWatchdog(Math.max(1, remainingBudget ?? budgetMs), budgetAbortController);
  }

  try {
    if (!options.dryRun) {
      const acquisition = tryAcquireImproveLock(resolvedLockPath, lockStaleAfterMs, options.skipIfLocked, {
        // R25: C2 boundary-pinned path — the long-lived handle doesn't exist yet.
        dbPath: resolvedStateDbPath,
      });
      if (acquisition.state === "skipped") {
        clearBudgetTimer();
        return buildLockSkippedResult(selectedStrategy.name, scope, options.runId);
      }
      improveLockOwnership = acquisition.ownership;
      exitBackstop = releaseRunLock;
      process.on("exit", exitBackstop);
      initialGitPaths =
        syncRepoDir && isGitBackedStash(syncRepoDir) ? new Set(listGitChangedPaths(syncRepoDir)) : new Set<string>();

      // Drain the standing proposal backlog before indexing so fresh proposal
      // generation sees promotions from this same serialized run.
      triageDrain = await runTriagePrePass(setup);
    }

    // #339 fix: ensureIndex MUST run BEFORE collectEligibleRefs (inside the
    // indexAndCollect helper).
    const collected = await indexAndCollect({ run: setup, signal: budgetAbortController.signal });
    plannedRefs = collected.plannedRefs;
    memorySummary = collected.memorySummary;
    strategyFilteredRefs = collected.strategyFilteredRefs;
    memoryCleanupPlan = collected.memoryCleanupPlan;
    guidance = collected.guidance;
    preEnsureCleanupWarnings.push(...collected.warnings);

    if (options.dryRun) {
      const result = buildDryRunResult(setup, collected);
      clearBudgetTimer();
      return result;
    }
  } catch (err) {
    clearBudgetTimer();
    if (exitBackstop) {
      process.removeListener("exit", exitBackstop);
      exitBackstop = undefined;
    }
    releaseRunLock();
    throw err;
  }

  // I1: open a single state.db connection for the entire improve run so all
  // appendEvent calls reuse one handle instead of open/migrate/close per call.
  let eventsDb: import("../../storage/database").Database | undefined;
  // `eventsCtx` is read by the main catch (improve_failed) and finally, so it
  // lives in the outer scope. It is always assigned at the top of the try.
  // Pinned to the boundary snapshot so the fallback per-call `appendEvent`
  // opens (when the long-lived handle below fails to open) never re-read env.
  let eventsCtx: EventsContext = { dbPath: resolvedStateDbPath };
  // #576: clears the per-run LLM usage sink. Defaults to a no-op until the sink
  // is installed inside the try; the `finally` always calls it.
  let disposeLlmUsageSink = (): void => {};

  const commitStashBatch = makeCommitStashBatch({
    run: setup,
    getInitialGitPaths: () => initialGitPaths,
    // Captured via getter: the live `eventsCtx` binding is reassigned inside
    // the try below, and the catch-path sync must write through whichever
    // context is current (#662 / P6/P7 in the chunk-7 ledger).
    getEventsCtx: () => eventsCtx,
  });

  try {
    try {
      eventsDb = openStateDatabase(resolvedStateDbPath);
      eventsCtx = { db: eventsDb };
    } catch (err) {
      rethrowIfTestIsolationError(err);
      // If we cannot open state.db up-front, fall back to per-call opens — but
      // still pinned to the boundary-resolved path, never a live env re-read.
      eventsCtx = { dbPath: resolvedStateDbPath };
    }

    // #576: persist per-call LLM usage telemetry for this run as `llm_usage`
    // events, reusing the same boundary-pinned events context (and long-lived
    // handle when available). Disposed in `finally` so the sink never leaks
    // across runs. Wrapping is best-effort end to end — see usage-telemetry.ts.
    disposeLlmUsageSink = installLlmUsagePersistence(eventsCtx);

    const seq = await runImproveStageSequence({
      run: setup,
      strategyFilteredRefs,
      plannedRefs,
      memoryCleanupPlan,
      memorySummary,
      preEnsureCleanupWarnings,
      eventsCtx,
    });

    const result = finalizeImproveResult({
      run: setup,
      seq,
      guidance,
      memorySummary,
      memoryCleanupPlan,
      strategyFilteredRefs,
      triageDrain,
      eventsCtx,
    });

    // End-of-run BATCH auto-sync — the converged commit. Recognition is
    // decoupled from the per-write path (see write-source.ts case-3): the primary
    // stash writes as a filesystem source during the run, then is committed via
    // the same `saveGitStash` that `akm sync` calls. The gating (git-backed
    // primary stash, sync not disabled) and the NON-FATAL guarantee now live in
    // `commitStashBatch` (#662); the inter-cycle and catch-path calls reuse it.
    // dry-run already returned above, so this always runs on a completed live
    // run. `result.sync` reflects this final commit (for a one-cycle run it is
    // the only commit; for a multi-cycle run the earlier cycles were banked by
    // the inter-cycle calls and this records the last batch). `result` carries
    // the full `{accepted}`/`{refs}`/`{triage_*}` token data for the message.
    result.sync = commitStashBatch(result);

    return result;
  } catch (err) {
    recordImproveFailure(err, setup, eventsCtx);
    // #662 crash/abort safety net: commit whatever this run already wrote to the
    // primary stash BEFORE rethrowing, so an interrupted run (mid-cycle crash or
    // a cooperative budget abort that surfaces as a throw) does not leave its
    // writes uncommitted until a later clean run sweeps them up. Best-effort —
    // `commitStashBatch` swallows its own errors and no-ops a clean tree, so this
    // never masks or supersedes the original failure being rethrown below.
    commitStashBatch({ scope, plannedRefs, runId: options.runId });
    throw err;
  } finally {
    // #576: clear the per-run LLM usage sink BEFORE closing `eventsDb` below, so
    // no late sink invocation can write through a closed handle.
    disposeLlmUsageSink();
    // O-1 (#364): Clear the budget abort timer so it does not keep the event
    // loop alive after the run completes.
    clearBudgetTimer();
    // Drop ONLY our own process.exit backstop so it does not fire later (or
    // accumulate across repeated in-process calls). Must NOT use
    // removeAllListeners("exit") here: in the in-process model (tests and
    // programmatic callers import cli.ts) that would silently destroy exit
    // handlers owned by the host or other commands.
    if (exitBackstop) {
      process.removeListener("exit", exitBackstop);
      exitBackstop = undefined;
    }
    releaseRunLock();
    // I1: close the long-lived state.db connection opened at the top of the run.
    try {
      eventsDb?.close();
    } catch {
      // ignore — DB may already be closed
    }
  }
}

// ── akmImprove run-setup / stage-sequencing / run-teardown units ────────────
// WI-7.7 step 1 (R31): the 810-line orchestrator body is decomposed into the
// named units below. The two-try topology, all four early-exit paths, and the
// exit-path cleanup ordering stay in akmImprove itself (they are the teardown
// contract — see P1–P8 in the chunk-7 ledger); the units hold the straight-line
// mass. Args objects carry the run-scoped values; return values replace the
// old closure-mutated outer `let`s.

/**
 * Run-setup: budget/watchdog plumbing, scope + seam resolution, the invocation
 * plan, write-target resolution, the profile-defaulted options rebuild, and
 * the boundary-pinned state.db/lock paths. Fully SYNCHRONOUS — the C2 boundary
 * snapshot (resolvedStateDbPath) must be taken before the first await of the
 * run.
 */
function resolveImproveRunSetup(options: AkmImproveOptions) {
  const startMs = Date.now();
  const budgetMs = options.timeoutMs ?? 2 * 60 * 60 * 1000;
  const budgetAbortController = new AbortController();
  Object.defineProperty(budgetAbortController.signal, "remainingBudgetMs", {
    get: () => Math.max(0, budgetMs - (Date.now() - startMs)),
    enumerable: false,
    configurable: true,
  });
  const scope: ImproveScope = resolveImproveScope(options.scope);
  const reflectFn = options.reflectFn ?? akmReflect;
  const distillFn = options.distillFn ?? akmDistill;
  const ensureIndexFn = options.ensureIndexFn ?? ensureIndex;
  const reindexFn = options.reindexFn ?? akmIndex;
  const drainProposalsFn = options.drainProposalsFn ?? drainProposals;
  // #616 multi-cycle test seams. Default to the real module-local fns.
  const collectEligibleRefsImpl =
    options.collectEligibleRefsFn ?? (options.dryRun ? collectEligibleRefsReadOnly : collectEligibleRefs);
  const runImprovePreparationStageImpl = options.runImprovePreparationStageFn ?? runImprovePreparationStage;
  const runImproveLoopStageImpl = options.runImproveLoopStageFn ?? runImproveLoopStage;
  const runImprovePostLoopStageImpl = options.runImprovePostLoopStageFn ?? runImprovePostLoopStage;
  // Resolve the improve profile for this run. Profile drives type filtering,
  // process gating, and the default limit value.
  const _earlyConfig = options.config ?? loadConfig();
  const resolvedPlan =
    options.resolvedPlan ??
    resolveImprovePlan(options.strategy, _earlyConfig, {
      repairValidationFailures: options.repairValidationFailures,
    });
  const selectedStrategy = resolvedPlan.strategy;
  const improveSensitiveValues = collectEngineCredentialValues(_earlyConfig);
  const improveProfile = selectedStrategy.config;
  const writeTarget =
    options.writeTarget ??
    (options.target || _earlyConfig.defaultWriteTarget || !options.stashDir
      ? resolveWriteTarget(_earlyConfig, options.target, { requireWritable: !options.dryRun })
      : {
          source: { kind: "filesystem" as const, name: "stash", path: options.stashDir },
          config: {
            type: "filesystem" as const,
            name: "stash",
            path: options.stashDir,
            writable: true,
          },
        });
  // Apply profile defaults — CLI flags take precedence over profile defaults.
  // Rebuild options with effective values so all downstream stage functions
  // automatically pick up the profile-driven defaults.
  options = {
    ...options,
    // Pin nested calls and quality gates to the same config snapshot as the
    // invocation plan. They must never reload a changed config mid-run.
    config: _earlyConfig,
    target: writeTarget.selector,
    sourceName: writeTarget.source.name,
    writeTarget,
    stashDir: writeTarget.source.path,
    consolidateOptions: {
      ...options.consolidateOptions,
      target: writeTarget.selector,
      writeTarget,
    },
    legacyBareState:
      options.legacyBareState ??
      shouldReadLegacyBareImproveState(writeTarget.source.name, writeTarget.source.path, _earlyConfig),
    // Profile-level limit, then process-level reflect.limit as fallback.
    // CLI --limit takes precedence over both.
    limit: options.limit ?? improveProfile?.processes?.reflect?.limit ?? improveProfile.limit,
  };
  let primaryStashDir: string | undefined;
  try {
    primaryStashDir = resolveSourceEntries(options.stashDir)[0]?.path;
  } catch {
    primaryStashDir = undefined;
  }
  const syncRepoDir = writeTarget?.source.repoPath ?? primaryStashDir;
  // C2 (#553/#554/#499): resolve the state.db path ONCE, synchronously, at the
  // command boundary — before the first `await` below. Every state.db open in
  // this run (`openStateDatabase`, every default-path `appendEvent`) is pinned
  // to this snapshot via `eventsCtx.dbPath`, so a parallel test file mutating
  // `process.env.XDG_DATA_HOME` across an await boundary can never redirect this
  // run's DB opens to a wrong/just-deleted tmpdir mid-flight (the parallel-load
  // timeout root cause). Because beforeEach runs synchronously, env is still the
  // calling test's own at this point; we capture it before yielding the loop.
  const resolvedStateDbPath = getStateDbPathInDataDir();

  // One conservative run lock protects the complete mutation window, including
  // triage, indexing, proposal work, maintenance, and final stash sync.
  const lockBaseDir = primaryStashDir ? path.join(primaryStashDir, ".akm") : path.join(options.stashDir ?? ".", ".akm");
  const resolvedLockPath = improveLockPath(lockBaseDir);
  const lockStaleAfterMs = Math.max(MIN_IMPROVE_LOCK_STALE_MS, budgetMs + 10 * 60 * 1000);
  const effectiveSync = { ...improveProfile.sync, ...options.sync };

  return {
    startMs,
    budgetMs,
    budgetAbortController,
    scope,
    reflectFn,
    distillFn,
    ensureIndexFn,
    reindexFn,
    drainProposalsFn,
    collectEligibleRefsImpl,
    runImprovePreparationStageImpl,
    runImproveLoopStageImpl,
    runImprovePostLoopStageImpl,
    _earlyConfig,
    resolvedPlan,
    selectedStrategy,
    improveSensitiveValues,
    improveProfile,
    writeTarget,
    options,
    primaryStashDir,
    syncRepoDir,
    resolvedStateDbPath,
    resolvedLockPath,
    lockStaleAfterMs,
    effectiveSync,
  };
}

/** The run-setup record every downstream unit receives (inferred shape). */
type ImproveRunSetup = ReturnType<typeof resolveImproveRunSetup>;

/** The catch-path improve_failed audit event (D3), redacted. */
function recordImproveFailure(err: unknown, run: ImproveRunSetup, eventsCtx: EventsContext): void {
  const { scope, selectedStrategy, improveSensitiveValues, startMs } = run;
  // D3: emit improve_failed on unexpected crash so dashboards can detect failures.
  appendEvent(
    {
      eventType: "improve_failed",
      ref: scope.mode === "ref" ? scope.value : `improve:${scope.mode}:${scope.value ?? "all"}`,
      metadata: {
        strategy: selectedStrategy.name,
        error: redactSensitiveText(errMessage(err), improveSensitiveValues),
        durationMs: Date.now() - startMs,
      },
    },
    eventsCtx,
  );
}

/**
 * ensureIndex + collectEligibleRefs + the contradiction pre-pass + the
 * memory-cleanup recompute (#339 ordering). Formerly the runIndexAndCollect
 * closure mutating outer `let`s; now a pure pass returning its results.
 */
async function indexAndCollect(args: { run: ImproveRunSetup; signal: AbortSignal }): Promise<{
  plannedRefs: Awaited<ReturnType<typeof collectEligibleRefs>>["plannedRefs"];
  memorySummary: Awaited<ReturnType<typeof collectEligibleRefs>>["memorySummary"];
  strategyFilteredRefs: NonNullable<Awaited<ReturnType<typeof collectEligibleRefs>>["strategyFilteredRefs"]>;
  memoryCleanupPlan?: ReturnType<typeof analyzeMemoryCleanup>;
  guidance?: string;
  warnings: string[];
}> {
  const { signal } = args;
  const {
    scope,
    options,
    primaryStashDir,
    improveProfile,
    resolvedPlan,
    _earlyConfig,
    ensureIndexFn,
    collectEligibleRefsImpl,
  } = args.run;
  const warnings: string[] = [];
  let plannedRefs: Awaited<ReturnType<typeof collectEligibleRefs>>["plannedRefs"] = [];
  let memorySummary: Awaited<ReturnType<typeof collectEligibleRefs>>["memorySummary"] = { eligible: 0, derived: 0 };
  let strategyFilteredRefs: Awaited<ReturnType<typeof collectEligibleRefs>>["strategyFilteredRefs"] = [];
  // #339 fix: ensureIndex MUST run BEFORE collectEligibleRefs. The eligible-ref
  // query reads the `entries` table; if a DB version upgrade just dropped that
  // table (or the index is otherwise empty), the prior run order silently
  // returned plannedRefs=[] and the improve loop no-op'd. Hoisting the call
  // here repopulates the index first so the subsequent query sees fresh data.
  if (primaryStashDir && !options.dryRun) {
    // Probe pre-ensureIndex entry count to drive the loud-fail warning below.
    // Best-effort: a missing DB / unreadable schema is the fresh-install case
    // and not a bug — we silently skip the probe.
    let preEnsureEntryCount: number | undefined;
    try {
      const dbPath = getDbPath();
      if (fs.existsSync(dbPath)) {
        const probeDb = openExistingDatabase();
        try {
          preEnsureEntryCount = getEntryCount(probeDb);
        } finally {
          closeDatabase(probeDb);
        }
      }
    } catch (err) {
      rethrowIfTestIsolationError(err);
      // best-effort; leave preEnsureEntryCount undefined
    }

    try {
      await ensureIndexFn(primaryStashDir, { mode: "blocking", signal: signal });
    } catch (err) {
      if (signal.aborted) throw err;
      warnings.push(`ensureIndex failed: ${errMessage(err)}`);
    }

    // #339 loud-fail: if the index was empty pre-ensureIndex but is now
    // populated, a version-upgrade-triggered rebuild just happened. Surface
    // that on stderr so the improve run is not silently masked by stale
    // index state. Zero-before AND zero-after is the empty-stash case and
    // is intentionally not warned (not a bug).
    if (preEnsureEntryCount === 0) {
      try {
        const probeDb = openExistingDatabase();
        let postCount = 0;
        try {
          postCount = getEntryCount(probeDb);
        } finally {
          closeDatabase(probeDb);
        }
        if (postCount > 0) {
          warn("[improve] index was empty after DB version upgrade — repopulating before continuing");
        }
      } catch (err) {
        rethrowIfTestIsolationError(err);
        // best-effort
      }
    }
  }

  ({
    plannedRefs,
    memorySummary,
    strategyFilteredRefs = [],
  } = await collectEligibleRefsImpl(scope, options.stashDir, improveProfile));
  const cleanupParentRef = memoryCleanupParentRef(scope, options.stashDir);

  // M-1 (#367): Run contradiction-detection BEFORE analyzeMemoryCleanup so
  // the SCC resolver in resolveFamilyContradictions has edges to work on.
  // Best-effort: failures are warnings, never fatal.
  if (
    !options.dryRun &&
    primaryStashDir &&
    shouldAnalyzeMemoryCleanup(scope, memorySummary.eligible, primaryStashDir)
  ) {
    try {
      // Reuse the config resolved at the top of the run instead of a second load.
      const contradictionDetectionFn = options.contradictionDetectionFn ?? detectAndWriteContradictions;
      await withLlmStage(
        "memory-contradiction",
        () =>
          contradictionDetectionFn(
            primaryStashDir,
            _earlyConfig,
            undefined,
            improveProfile,
            resolvedPlan.processes.consolidate.runner
              ? materializeLlmRunnerConnection(resolvedPlan.processes.consolidate.runner)
              : null,
          ),
        { engine: resolvedPlan.processes.consolidate.runner?.engine, process: "consolidate" },
      );
    } catch (err) {
      if (signal.aborted) throw err;
      // Non-fatal: contradiction detection is a best-effort pass.
      warn(`[improve] contradiction detection failed (non-fatal): ${errMessage(err)}`);
    }
  }

  const memoryCleanupPlan = shouldAnalyzeMemoryCleanup(scope, memorySummary.eligible, primaryStashDir)
    ? analyzeMemoryCleanup(primaryStashDir as string, cleanupParentRef ? { parentRef: cleanupParentRef } : undefined)
    : undefined;
  const guidance =
    memorySummary.eligible > 0
      ? "Improve folds memory cleanup into the same proposal queue: speculative promotions still go through reflect/distill proposals, while high-confidence redundant derived memories are moved into a recoverable cleanup archive instead of being left active in the stash."
      : undefined;
  return {
    plannedRefs,
    memorySummary,
    strategyFilteredRefs: strategyFilteredRefs ?? [],
    memoryCleanupPlan,
    guidance,
    warnings,
  };
}

/** The P2 lock-skipped envelope (graceful `skipIfLocked` early return). Exported for unit tests. */
export function buildLockSkippedResult(
  strategyName: string,
  scope: ImproveScope,
  runId: string | undefined,
): AkmImproveResult {
  return {
    schemaVersion: 2,
    ok: true,
    strategy: strategyName,
    scope,
    dryRun: false,
    skipped: { reason: "lock-held" },
    memorySummary: { eligible: 0, derived: 0 },
    plannedRefs: [],
    actions: [],
    ...(runId !== undefined ? { runId } : {}),
  };
}

/** The P3 dry-run envelope (plan-only early return). Exported for unit tests. */
export function buildDryRunResult(
  run: ImproveRunSetup,
  collected: Awaited<ReturnType<typeof indexAndCollect>>,
): AkmImproveResult {
  const { selectedStrategy, scope } = run;
  const { guidance, memorySummary, memoryCleanupPlan, plannedRefs, strategyFilteredRefs } = collected;
  return {
    schemaVersion: 2,
    ok: true,
    strategy: selectedStrategy.name,
    scope,
    dryRun: true,
    ...(guidance ? { guidance } : {}),
    memorySummary,
    ...(memoryCleanupPlan ? { memoryCleanup: shapeMemoryCleanup(memoryCleanupPlan) } : {}),
    plannedRefs,
    ...(strategyFilteredRefs.length > 0 ? { strategyFilteredRefs } : {}),
  };
}

/** The triage drain pre-pass (non-fatal; single-ref scope never drains). */
async function runTriagePrePass(run: ImproveRunSetup): Promise<DrainResult | undefined> {
  const { primaryStashDir, resolvedPlan, scope, options, improveProfile, drainProposalsFn } = run;
  let triageDrain: DrainResult | undefined;
  if (primaryStashDir && resolvedPlan.processes.triage.enabled) {
    if (scope.mode === "ref") {
      warn("[improve] triage pre-pass skipped (single-ref scope never drains the whole queue)");
    } else {
      try {
        const triageConfig = improveProfile.processes?.triage;
        const policy = resolveDrainPolicy(triageConfig?.policy);
        const applyMode: "queue" | "promote" = triageConfig?.applyMode ?? "queue";
        const maxAccepts = triageConfig?.maxAcceptsPerRun ?? 25;
        triageDrain = await drainProposalsFn({
          stashDir: primaryStashDir,
          ...(options.target ? { target: options.target } : {}),
          config: options.config,
          policy,
          applyMode,
          maxAccepts,
          dryRun: false,
          excludeIds: new Set<string>(),
          ...(triageConfig?.maxDiffLines !== undefined ? { maxDiffLines: triageConfig.maxDiffLines } : {}),
          judgment: resolvedPlan.triageJudgment,
        });
      } catch (err) {
        warn(`[improve] triage pre-pass failed (non-fatal): ${errMessage(err)}`);
      }
    }
  }
  return triageDrain;
}

/**
 * Crash-safe / incremental stash sync (#662) — see the factory-returned
 * closure's original doc block: the primary stash writes as a filesystem
 * source DURING the run; this commits them at end-of-run AND from the catch
 * path. Idempotent + NON-FATAL. `getEventsCtx`/`getInitialGitPaths` are
 * getters because both outer bindings are (re)assigned after this factory
 * runs — the returned closure must observe the live values.
 */
function makeCommitStashBatch(deps: {
  run: ImproveRunSetup;
  getInitialGitPaths: () => Set<string>;
  getEventsCtx: () => EventsContext;
}): (messageContext: Parameters<typeof renderSyncCommitMessage>[1]) => AkmImproveResult["sync"] | undefined {
  const { writeTarget, primaryStashDir, effectiveSync, options, _earlyConfig, improveProfile } = deps.run;
  return (messageContext) => {
    const eventsCtx = deps.getEventsCtx();
    const initialGitPaths = deps.getInitialGitPaths();
    const repoDir = writeTarget?.source.repoPath ?? primaryStashDir;
    if (!primaryStashDir || !repoDir || effectiveSync.enabled === false || !isGitBackedStash(repoDir)) {
      return undefined;
    }
    const saveGitStashFn = options.saveGitStashFn ?? saveGitStash;
    const writableOverride = writeTarget ? resolveWritable(writeTarget.config) : resolveWritableOverride(_earlyConfig);
    const push = options.sync?.push ?? writeTarget?.config.options?.pushOnCommit ?? improveProfile.sync?.push ?? true;
    const message = renderSyncCommitMessage(
      effectiveSync.message ?? "akm improve auto-sync",
      messageContext,
      Date.now(),
    );
    try {
      const assetRoot = writeTarget?.source.path ?? primaryStashDir;
      const assetPrefix = assetRoot ? path.relative(repoDir, assetRoot).replaceAll(path.sep, "/") : "";
      const paths = listGitChangedPaths(repoDir).filter((changedPath) => {
        if (initialGitPaths.has(changedPath)) return false;
        if (path.basename(changedPath).includes(".lock")) return false;
        return !assetPrefix || changedPath === assetPrefix || changedPath.startsWith(`${assetPrefix}/`);
      });
      const syncResult = saveGitStashFn(undefined, message, writableOverride, {
        push,
        repoDir,
        paths,
      });
      appendEvent(
        {
          eventType: "stash_synced",
          metadata: {
            committed: syncResult.committed,
            pushed: syncResult.pushed,
            skipped: syncResult.skipped,
            reason: syncResult.reason ?? null,
          },
        },
        eventsCtx,
      );
      return {
        committed: syncResult.committed,
        pushed: syncResult.pushed,
        skipped: syncResult.skipped,
        ...(syncResult.reason !== undefined ? { reason: syncResult.reason } : {}),
      };
    } catch (syncErr) {
      const reason = errMessage(syncErr);
      warn(`improve: stash sync failed (non-fatal): ${reason}`);
      appendEvent(
        {
          eventType: "stash_synced",
          metadata: { committed: false, pushed: false, skipped: true, reason },
        },
        eventsCtx,
      );
      return { committed: false, pushed: false, skipped: true, reason };
    }
  };
}

/** D6: pre-load the last 30 days of proposal_rejected events once per run. */
function preloadRejectedProposals(): Map<string, EventEnvelope> {
  // D6: pre-load all proposal_rejected events from the last 30 days once,
  // so the per-asset loop can use a Map lookup instead of N DB round trips.
  const REJECTED_PROPOSAL_WINDOW_MS = daysToMs(30);
  const rejectedProposalSince = new Date(Date.now() - REJECTED_PROPOSAL_WINDOW_MS).toISOString();
  const allRejectedProposalEvents = readEvents({ type: "proposal_rejected", since: rejectedProposalSince }).events;
  const rejectedProposalsByRef = new Map<string, EventEnvelope>();
  for (const e of allRejectedProposalEvents) {
    if (e.ref && (!rejectedProposalsByRef.has(e.ref) || e.ts > (rejectedProposalsByRef.get(e.ref)?.ts ?? ""))) {
      rejectedProposalsByRef.set(e.ref, e);
    }
  }
  return rejectedProposalsByRef;
}

/**
 * Post-lock proactive cooldown re-filter: re-read cooldown timestamps
 * immediately before the loop so external proposal writes that occurred
 * before this run acquired its lock are visible.
 */
export function refilterProactiveLoopRefs(
  loopRefs: ImprovePreparationResult["loopRefs"],
  options: AkmImproveOptions,
  improveProfile: import("../../core/config/config").ImproveProfileConfig,
): ImprovePreparationResult["loopRefs"] {
  // Re-read cooldown timestamps immediately before execution so external
  // proposal writes that occurred before this run acquired its lock are visible.
  const proactiveLoopRefs = loopRefs.filter((r) => r.eligibilitySource === "proactive");
  let postLockLoopRefs = loopRefs;
  if (proactiveLoopRefs.length > 0) {
    const proactiveRefStrs = proactiveLoopRefs.map((r) => r.ref);
    const freshReflectTs = buildLatestProposalTsMap(
      proactiveRefStrs,
      "reflect",
      options.sourceName,
      options.legacyBareState,
    );
    const freshDistillTs = buildLatestProposalTsMap(
      proactiveRefStrs,
      "distill",
      options.sourceName,
      options.legacyBareState,
    );
    const pmDueDays = improveProfile.processes?.proactiveMaintenance?.dueDays ?? DEFAULT_DUE_DAYS;
    const stillDue = new Set(
      filterProactiveDue(proactiveLoopRefs, freshReflectTs, freshDistillTs, pmDueDays, Date.now()).map((r) => r.ref),
    );
    const dropped = proactiveLoopRefs.filter((r) => !stillDue.has(r.ref));
    if (dropped.length > 0) {
      info(
        `[improve] post-lock cooldown re-filter: dropped ${dropped.length} proactive ref(s) claimed by concurrent run (${dropped.map((r) => r.ref).join(", ")})`,
      );
      postLockLoopRefs = loopRefs.filter((r) => r.eligibilitySource !== "proactive" || stillDue.has(r.ref));
    }
  }
  return postLockLoopRefs;
}

/**
 * Stage-sequencing: the strategy-filtered audit event, then the single
 * prep → loop → post-loop pass via the #616 seams (D12). Returns every
 * accumulator the result assembly reads — the old closure-scoped `let`s.
 */
async function runImproveStageSequence(args: {
  run: ImproveRunSetup;
  strategyFilteredRefs: NonNullable<Awaited<ReturnType<typeof collectEligibleRefs>>["strategyFilteredRefs"]>;
  plannedRefs: Awaited<ReturnType<typeof collectEligibleRefs>>["plannedRefs"];
  memoryCleanupPlan?: ReturnType<typeof analyzeMemoryCleanup>;
  memorySummary: { eligible: number; derived: number };
  preEnsureCleanupWarnings: string[];
  eventsCtx: EventsContext;
}) {
  const { strategyFilteredRefs, plannedRefs, memoryCleanupPlan, memorySummary, preEnsureCleanupWarnings, eventsCtx } =
    args;
  const {
    scope,
    options,
    primaryStashDir,
    startMs,
    budgetMs,
    improveProfile,
    resolvedPlan,
    budgetAbortController,
    selectedStrategy,
    reflectFn,
    distillFn,
    reindexFn,
    runImprovePreparationStageImpl,
    runImproveLoopStageImpl,
    runImprovePostLoopStageImpl,
  } = args.run;
  // 2026-05-27: one summary `improve_skipped` audit event (count only) for
  // planner-pre-filtered refs — never per-ref (#592: O(n) sequential state.db
  // writes cost ~500 s on a 9 000-ref stash; health reads the counters).
  if (strategyFilteredRefs.length > 0) {
    appendEvent(
      {
        eventType: "improve_skipped",
        ref: undefined,
        metadata: {
          strategy: selectedStrategy.name,
          reason: "strategy_filtered_all_passes",
          count: strategyFilteredRefs.length,
        },
      },
      eventsCtx,
    );
  }

  // Single prep->loop->post-loop pass, run under the invocation's lock.
  // Accumulators are direct assignments from the single pass's results.
  let preparation!: ImprovePreparationResult;
  let memoryRefsForInference: Set<string> = new Set();
  let consolidation!: ConsolidateResult;
  let memoryInference: ImprovePostLoopResult["memoryInference"];
  let graphExtraction: ImprovePostLoopResult["graphExtraction"];
  let cycleMetrics: ImprovePostLoopResult["cycleMetrics"];
  // Summed counters/durations.
  let prepGateCount = 0;
  let prepGateFailedCount = 0;
  let reflectsWithErrorContext = 0;
  let loopGateCount = 0;
  let loopGateFailedCount = 0;
  let postLoopGateCount = 0;
  let postLoopGateFailedCount = 0;
  let memoryInferenceDurationMs = 0;
  let graphExtractionDurationMs = 0;
  let orphansPurged: number | undefined;
  let proposalsExpired: number | undefined;
  // Concatenated arrays.
  const allWarnings: string[] = [];
  let deadUrls: ImprovePostLoopResult["deadUrls"];
  const finalActions: ImproveActionResult[] = [];

  {
    const runPreparation = () =>
      runImprovePreparationStageImpl({
        scope,
        options,
        plannedRefs,
        memoryCleanupPlan,
        primaryStashDir,
        memorySummary,
        reindexFn,
        startMs,
        budgetMs,
        eventsCtx,
        initialCleanupWarnings: preEnsureCleanupWarnings,
        improveProfile,
        resolvedPlan,
        strategyName: selectedStrategy.name,
        budgetSignal: budgetAbortController.signal,
      });
    preparation = await runPreparation();
    prepGateCount += preparation.gateAutoAcceptedCount;
    prepGateFailedCount += preparation.gateAutoAcceptFailedCount;

    const rejectedProposalsByRef = preloadRejectedProposals();

    const runLoop = () => {
      const postLockLoopRefs = refilterProactiveLoopRefs(preparation.loopRefs, options, improveProfile);

      return runImproveLoopStageImpl({
        scope,
        options,
        primaryStashDir,
        reflectFn,
        distillFn,
        loopRefs: postLockLoopRefs,
        actions: preparation.actions,
        signalBearingSet: preparation.signalBearingSet,
        distillCooledRefs: preparation.distillCooledRefs,
        distillOnlyRefs: preparation.distillOnlyRefs,
        recentErrors: preparation.recentErrors,
        rejectedProposalsByRef,
        utilityMap: preparation.utilityMap,
        startMs,
        budgetMs,
        eventsCtx,
        improveProfile,
        resolvedPlan,
        budgetSignal: budgetAbortController.signal,
      });
    };
    const loopResult = await runLoop();
    const loopGateCountThisCycle = loopResult.gateAutoAcceptedCount;
    reflectsWithErrorContext += loopResult.reflectsWithErrorContext;
    loopGateCount += loopResult.gateAutoAcceptedCount;
    loopGateFailedCount += loopResult.gateAutoAcceptFailedCount;
    memoryRefsForInference = loopResult.memoryRefsForInference;

    // #551: consolidation now runs in the preparation stage (before extract);
    // its result and run-flag are read from `preparation`, not the post-loop.
    consolidation = preparation.consolidation;

    // Do not start new post-loop work after the shared wall-clock budget. The
    // result still finalizes normally, so scheduled budget exhaustion exits 0.
    const emptyPostLoopResult: ImprovePostLoopResult = {
      allWarnings: [],
      gateAutoAcceptedCount: 0,
      gateAutoAcceptFailedCount: 0,
      memoryInferenceDurationMs: 0,
      graphExtractionDurationMs: 0,
    };
    const remainingBudget = (budgetAbortController.signal as { remainingBudgetMs?: number }).remainingBudgetMs;
    let postLoopResult: ImprovePostLoopResult;
    if (budgetAbortController.signal.aborted || (remainingBudget !== undefined && remainingBudget <= 0)) {
      info("[improve] post-loop maintenance skipped (wall-clock budget exhausted)");
      postLoopResult = emptyPostLoopResult;
    } else {
      postLoopResult = await runImprovePostLoopStageImpl({
        scope,
        options,
        primaryStashDir,
        actionableRefs: preparation.actionableRefs,
        appliedCleanup: preparation.appliedCleanup,
        cleanupWarnings: preparation.cleanupWarnings,
        memoryRefsForInference,
        reindexFn,
        eventsCtx,
        budgetSignal: budgetAbortController.signal,
        improveProfile,
        resolvedPlan,
        consolidationRan: preparation.consolidationRan,
        // R5: floor violations from this run's consolidate pass + the
        // accepted volume so far (always 0 since the 0.9.0 confidence-gate
        // deletion) for churn detection.
        consolidationMergeFloorViolations: preparation.consolidation.mergeFloorViolations ?? 0,
        acceptedActions: preparation.gateAutoAcceptedCount + loopGateCountThisCycle,
      });
    }
    // Result objects (single pass — no cycle accumulation).
    memoryInference = postLoopResult.memoryInference;
    graphExtraction = postLoopResult.graphExtraction;
    if (postLoopResult.cycleMetrics) cycleMetrics = postLoopResult.cycleMetrics;
    // Summed counters/durations.
    postLoopGateCount += postLoopResult.gateAutoAcceptedCount;
    postLoopGateFailedCount += postLoopResult.gateAutoAcceptFailedCount;
    memoryInferenceDurationMs += postLoopResult.memoryInferenceDurationMs;
    graphExtractionDurationMs += postLoopResult.graphExtractionDurationMs;
    if (postLoopResult.orphansPurged !== undefined) {
      orphansPurged = (orphansPurged ?? 0) + postLoopResult.orphansPurged;
    }
    if (postLoopResult.proposalsExpired !== undefined) {
      proposalsExpired = (proposalsExpired ?? 0) + postLoopResult.proposalsExpired;
    }
    // Concatenated arrays.
    allWarnings.push(...postLoopResult.allWarnings);
    if (postLoopResult.deadUrls !== undefined) {
      deadUrls = [...(deadUrls ?? []), ...postLoopResult.deadUrls];
    }
    const maintenanceActions = postLoopResult.maintenanceActions;
    if (maintenanceActions && maintenanceActions.length > 0) {
      finalActions.push(...preparation.actions, ...maintenanceActions);
    } else {
      finalActions.push(...preparation.actions);
    }
  }

  return {
    preparation,
    memoryRefsForInference,
    consolidation,
    memoryInference,
    graphExtraction,
    cycleMetrics,
    prepGateCount,
    prepGateFailedCount,
    reflectsWithErrorContext,
    loopGateCount,
    loopGateFailedCount,
    postLoopGateCount,
    postLoopGateFailedCount,
    memoryInferenceDurationMs,
    graphExtractionDurationMs,
    orphansPurged,
    proposalsExpired,
    allWarnings,
    deadUrls,
    finalActions,
  };
}

/**
 * Run-teardown, result half: assemble the AkmImproveResult envelope and emit
 * the improve_completed event (same adjacency as the old inline code — no
 * side effects run between assembly and emit).
 */
function finalizeImproveResult(args: {
  run: ImproveRunSetup;
  seq: Awaited<ReturnType<typeof runImproveStageSequence>>;
  guidance?: string;
  memorySummary: { eligible: number; derived: number };
  memoryCleanupPlan?: ReturnType<typeof analyzeMemoryCleanup>;
  strategyFilteredRefs: NonNullable<Awaited<ReturnType<typeof collectEligibleRefs>>["strategyFilteredRefs"]>;
  triageDrain?: DrainResult;
  eventsCtx: EventsContext;
}): AkmImproveResult {
  const { guidance, memorySummary, memoryCleanupPlan, strategyFilteredRefs, triageDrain, eventsCtx } = args;
  const { selectedStrategy, scope, options, primaryStashDir, startMs } = args.run;
  const {
    preparation,
    consolidation,
    memoryInference,
    graphExtraction,
    cycleMetrics,
    prepGateCount,
    prepGateFailedCount,
    reflectsWithErrorContext,
    loopGateCount,
    loopGateFailedCount,
    postLoopGateCount,
    postLoopGateFailedCount,
    memoryInferenceDurationMs,
    graphExtractionDurationMs,
    orphansPurged,
    proposalsExpired,
    allWarnings,
    deadUrls,
    finalActions,
  } = args.seq;
  // C1 (13-bus-factor): fold the per-ref `distill-skipped` rows (~13k/run,
  // ~91% of result_json bytes) into a bounded aggregate BEFORE persistence.
  // The metric total + per-reason breakdown are preserved on `distillSkipped`;
  // the unbounded row list never reaches result_json. Reflect skip counters
  // below still read `finalActions` (reflect skips are not folded).
  const { actions: persistedActions, aggregate: distillSkippedAggregate } = foldDistillSkipped(finalActions);

  const result: AkmImproveResult = {
    schemaVersion: 2,
    ok: true,
    strategy: selectedStrategy.name,
    scope,
    dryRun: false,
    ...(guidance ? { guidance } : {}),
    memorySummary,
    ...(memoryCleanupPlan
      ? {
          memoryCleanup: {
            ...shapeMemoryCleanup(memoryCleanupPlan),
            ...(preparation.appliedCleanup
              ? {
                  archived: preparation.appliedCleanup.archived,
                  ...(preparation.appliedCleanup.transitionLogPath
                    ? { transitionLogPath: preparation.appliedCleanup.transitionLogPath }
                    : {}),
                  ...(preparation.appliedCleanup.transitionLogEntries !== undefined
                    ? { transitionLogEntries: preparation.appliedCleanup.transitionLogEntries }
                    : {}),
                  ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
                }
              : preparation.cleanupWarnings.length > 0
                ? { warnings: preparation.cleanupWarnings }
                : {}),
          },
        }
      : {}),
    plannedRefs: preparation.actionableRefs,
    ...(strategyFilteredRefs.length > 0 ? { strategyFilteredRefs } : {}),
    actions: persistedActions,
    ...(distillSkippedAggregate ? { distillSkipped: distillSkippedAggregate } : {}),
    ...(preparation.validationFailures.length > 0 ? { validationFailures: preparation.validationFailures } : {}),
    ...(preparation.schemaRepairs.length > 0 ? { schemaRepairs: preparation.schemaRepairs } : {}),
    ...(consolidation.processed > 0 || consolidation.warnings.length > 0 ? { consolidation } : {}),
    ...(preparation.lintSummary !== undefined ? { lintSummary: preparation.lintSummary } : {}),
    ...(preparation.memoryIndexHealth !== undefined ? { memoryIndexHealth: preparation.memoryIndexHealth } : {}),
    ...(preparation.coverageGaps.length > 0 ? { coverageGaps: preparation.coverageGaps } : {}),
    ...(preparation.extract && preparation.extract.length > 0 ? { extract: preparation.extract } : {}),
    ...(primaryStashDir !== undefined ? { evalCasesWritten: countEvalCases(primaryStashDir) } : {}),
    ...(deadUrls !== undefined && deadUrls.length > 0 ? { deadUrls } : {}),
    ...(reflectsWithErrorContext > 0 ? { reflectsWithErrorContext } : {}),
    ...(memoryInference ? { memoryInference } : {}),
    ...(graphExtraction ? { graphExtraction } : {}),
    // Per-phase wall-clock durations. Surfaced at the top level of the
    // envelope (not nested) because `health.ts`'s `wallTime.byPhase`
    // aggregator and the existing `memoryInference.durationMs` /
    // `graphExtraction.durationMs` health buckets all read
    // `result.{memoryInferenceDurationMs,graphExtractionDurationMs}`
    // directly. Mirrors how `consolidation.durationMs` is surfaced inside
    // the consolidation sub-object (different convention because the
    // consolidation result type already owns that field). Phases that did
    // not run (zero duration) are omitted so the aggregator's
    // "phase actually ran" filter (`> 0`) excludes them from the median/p95
    // sample. Plumbed in d1273d0's follow-up — see
    // `/tmp/akm-health-investigations/metrics-taxonomy-review.md` §1k / §3.
    ...(memoryInferenceDurationMs > 0 ? { memoryInferenceDurationMs } : {}),
    ...(graphExtractionDurationMs > 0 ? { graphExtractionDurationMs } : {}),
    ...(cycleMetrics ? { cycleMetrics } : {}),
    ...(orphansPurged !== undefined ? { orphansPurged } : {}),
    ...(proposalsExpired !== undefined && proposalsExpired > 0 ? { proposalsExpired } : {}),
    reflectCooldownActions: finalActions.filter((a) => a.mode === "reflect-cooldown").length,
    reflectSkippedActions: finalActions.filter((a) => a.mode === "reflect-skipped").length,
    reflectGuardRejectedActions: finalActions.filter((a) => a.mode === "reflect-guard-rejected").length,
    ...(() => {
      const t = prepGateCount + loopGateCount + postLoopGateCount;
      return t > 0 ? { gateAutoAcceptedCount: t } : {};
    })(),
    ...(() => {
      const f = prepGateFailedCount + loopGateFailedCount + postLoopGateFailedCount;
      return f > 0 ? { gateAutoAcceptFailedCount: f } : {};
    })(),
    ...(triageDrain
      ? {
          triage: {
            promoted: triageDrain.promoted.length,
            rejected: triageDrain.rejected.length,
            deferred: triageDrain.deferred.length,
            skippedByCap: triageDrain.skippedByCap.length,
          },
        }
      : {}),
    ...(preparation.proactiveMaintenance ? { proactiveMaintenance: preparation.proactiveMaintenance } : {}),
    ...(options.runId !== undefined ? { runId: options.runId } : {}),
  };
  if (!result.dryRun)
    emitImproveCompletedEvent(
      result,
      {
        memoryInferenceDurationMs,
        graphExtractionDurationMs,
        totalDurationMs: Date.now() - startMs,
        warningCount: allWarnings.length,
        orphansPurged: orphansPurged ?? 0,
      },
      eventsCtx,
    );
  return result;
}

function emitImproveCompletedEvent(
  result: AkmImproveResult,
  durations: {
    memoryInferenceDurationMs: number;
    graphExtractionDurationMs: number;
    totalDurationMs?: number;
    warningCount?: number;
    orphansPurged?: number;
  },
  eventsCtx?: EventsContext,
): void {
  const actionCounts = {
    reflect: 0,
    reflectFailed: 0,
    reflectCooldown: 0,
    reflectSkipped: 0,
    reflectGuardRejected: 0,
    distill: 0,
    distillSkipped: 0,
    memoryPrune: 0,
    memoryInference: 0,
    graphExtraction: 0,
    error: 0,
  };
  // Coarse audit buckets, derived from the SAME classifyImproveAction the
  // persisted metrics_json uses (state-db.ts#computeImproveRunMetrics) so the
  // emitted event and the stored row can never disagree.
  const classCounts = { accepted: 0, rejected: 0, skipped: 0, error: 0, noop: 0 };
  for (const action of result.actions ?? []) {
    classCounts[classifyImproveAction(action.mode)] += 1;
    // Per-variant counters for the event metadata. The default arm makes any
    // new ImproveActionMode variant a compile error so a future variant cannot
    // be silently dropped from the improve_completed event (the `reflect-guard-
    // rejected` case below was previously missing here entirely).
    switch (action.mode) {
      case "reflect":
        actionCounts.reflect += 1;
        break;
      case "reflect-failed":
        actionCounts.reflectFailed += 1;
        break;
      case "reflect-cooldown":
        actionCounts.reflectCooldown += 1;
        break;
      case "reflect-skipped":
        actionCounts.reflectSkipped += 1;
        break;
      case "reflect-guard-rejected":
        actionCounts.reflectGuardRejected += 1;
        break;
      case "distill":
        actionCounts.distill += 1;
        break;
      case "distill-skipped":
        actionCounts.distillSkipped += 1;
        break;
      case "memory-prune":
        actionCounts.memoryPrune += 1;
        break;
      case "memory-inference":
        actionCounts.memoryInference += 1;
        break;
      case "graph-extraction":
        actionCounts.graphExtraction += 1;
        break;
      case "error":
        actionCounts.error += 1;
        break;
      default:
        assertNever(action.mode);
    }
  }

  // C1: distill-skipped rows are no longer in `result.actions` (folded into the
  // bounded `distillSkipped` aggregate at assembly). Add the aggregate total to
  // the per-variant counter AND the coarse `skipped` bucket so the emitted event
  // still reports the true skipped volume.
  const distillSkippedTotal = result.distillSkipped?.total ?? 0;
  actionCounts.distillSkipped += distillSkippedTotal;
  classCounts.skipped += distillSkippedTotal;

  appendEvent(
    {
      eventType: "improve_completed",
      ref:
        result.scope.mode === "ref"
          ? result.scope.value
          : `improve:${result.scope.mode}:${result.scope.value ?? "all"}`,
      metadata: {
        strategy: result.strategy,
        plannedRefs: result.plannedRefs.length,
        reflectActions: actionCounts.reflect,
        distillActions: actionCounts.distill,
        distillSkippedActions: actionCounts.distillSkipped,
        memoryPruneActions: actionCounts.memoryPrune,
        memoryInferenceActions: actionCounts.memoryInference,
        graphExtractionActions: actionCounts.graphExtraction,
        errorActions: actionCounts.error,
        reflectFailedActions: actionCounts.reflectFailed,
        reflectCooldownActions: actionCounts.reflectCooldown,
        reflectSkippedActions: actionCounts.reflectSkipped,
        // Previously dropped from the event entirely; now emitted so the guard
        // rejections are visible in improve_completed telemetry.
        reflectGuardRejectedActions: actionCounts.reflectGuardRejected,
        acceptedActions: classCounts.accepted,
        rejectedActions: classCounts.rejected,
        skippedActions: classCounts.skipped,
        noopActions: classCounts.noop,
        reflectsWithErrorContext: result.reflectsWithErrorContext ?? 0,
        coverageGapCount: result.coverageGaps?.length ?? 0,
        evalCasesWritten: result.evalCasesWritten ?? 0,
        deadUrlCount: result.deadUrls?.length ?? 0,
        memoryEligible: result.memorySummary.eligible,
        memoryDerived: result.memorySummary.derived,
        memoryCleanupPruneCandidates: result.memoryCleanup?.pruneCandidates.length ?? 0,
        memoryCleanupContradictionCandidates: result.memoryCleanup?.contradictionCandidates.length ?? 0,
        memoryCleanupBeliefStateTransitions: result.memoryCleanup?.beliefStateTransitions.length ?? 0,
        memoryCleanupConsolidationCandidates: result.memoryCleanup?.consolidationCandidates.length ?? 0,
        memoryCleanupArchived: result.memoryCleanup?.archived?.length ?? 0,
        memoryCleanupWarnings: result.memoryCleanup?.warnings?.length ?? 0,
        consolidationProcessed: result.consolidation?.processed ?? 0,
        consolidationDurationMs: result.consolidation?.durationMs ?? 0,
        memoryInferenceWrites: result.memoryInference?.writtenFacts ?? 0,
        memoryInferenceDurationMs: durations.memoryInferenceDurationMs,
        graphExtractionExtractedFiles: result.graphExtraction?.quality.extractedFiles ?? 0,
        graphExtractionDurationMs: durations.graphExtractionDurationMs,
        // Layer-2 proactive-maintenance coverage (0 when the process is disabled
        // or the run was ref-scoped) so a scheduled sweep's reach is trackable.
        proactiveSelected: result.proactiveMaintenance?.selected ?? 0,
        proactiveDueTotal: result.proactiveMaintenance?.dueTotal ?? 0,
        proactiveNeverReflected: result.proactiveMaintenance?.neverReflected ?? 0,
        // New metrics for tuning the improve loop.
        ...(durations.totalDurationMs !== undefined ? { durationMs: durations.totalDurationMs } : {}),
        ...(durations.warningCount !== undefined ? { warningCount: durations.warningCount } : {}),
        ...(durations.orphansPurged !== undefined ? { orphansPurged: durations.orphansPurged } : {}),
        ...(result.graphExtraction?.quality
          ? {
              graphCoverage: result.graphExtraction.quality.extractionCoverage,
              graphDensity: result.graphExtraction.quality.density,
              graphEntities: result.graphExtraction.quality.entityCount,
            }
          : {}),
      },
    },
    eventsCtx,
  );
}

/**
 * Result of the consolidation pass (#551).
 *
 * Consolidation moved OUT of the post-loop stage and into the preparation
 * stage, where it runs BEFORE the session-extract pass. This guarantees the
 * pool-delta gate (and akmConsolidate itself) only ever observe memories that
 * existed at the start of the run — files written by extract promotions in
 * the CURRENT run are not on disk yet, so they cannot make the gate fire.
 */
export interface ConsolidationPassResult {
  consolidation: ConsolidateResult;
  /** True iff consolidation actually processed memories this run (drives graph reindex). */
  consolidationRan: boolean;
  gateAutoAcceptedCount: number;
  gateAutoAcceptFailedCount: number;
}

export interface ImproveRunContext {
  scope: ImproveScope;
  options: AkmImproveOptions;
  primaryStashDir?: string;
  reflectFn: (options: NonNullable<Parameters<typeof akmReflect>[0]>) => Promise<AkmReflectResult>;
  distillFn: (options: NonNullable<Parameters<typeof akmDistill>[0]>) => Promise<AkmDistillResult>;
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
  startMs: number;
  budgetMs: number;
  eventsCtx?: EventsContext;
  /** Active improve profile, resolved from profile name + config. */
  improveProfile: import("../../core/config/config").ImproveProfileConfig;
  /** Engine/materialized-connection snapshot shared by every process in this run. */
  resolvedPlan: ResolvedImprovePlan;
  /**
   * #616 — run-budget abort signal (also carries a live `remainingBudgetMs`
   * getter). Threaded in so the loop stage participates in the same cooperative
   * budget drain as the prep/post-loop stages and so multi-cycle callers can
   * observe abort propagation.
   */
  budgetSignal?: AbortSignal;
}

function shapeMemoryCleanup(plan: MemoryCleanupPlan): ImproveMemoryCleanupResult {
  return {
    analyzedDerived: plan.analyzedDerived,
    pruneCandidates: plan.pruneCandidates,
    contradictionCandidates: plan.contradictionCandidates,
    beliefStateTransitions: plan.beliefStateTransitions,
    consolidationCandidates: plan.consolidationCandidates,
    ...(plan.relativeDateCandidates.length > 0 ? { relativeDateCandidates: plan.relativeDateCandidates } : {}),
  };
}
