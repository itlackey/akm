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
import type {
  AkmImproveResult,
  EligibilitySource,
  ImproveActionResult,
  ImproveEligibleRef,
  ImproveMemoryCleanupResult,
  ProceduralCompilationResult,
  RecombineResult,
} from "../../core/improve-types";
import { classifyImproveAction, foldDistillSkipped } from "../../core/improve-types";
import { getDbPath, getStateDbPathInDataDir } from "../../core/paths";
import { openStateDatabase } from "../../core/state-db";
import { info, warn } from "../../core/warn";
import { closeDatabase, getEntryCount, openExistingDatabase } from "../../indexer/db/db";
import { type EnsureIndexOptions, ensureIndex } from "../../indexer/ensure-index";
import type { GraphExtractionResult, runGraphExtractionPass } from "../../indexer/graph/graph-extraction";
import { akmIndex } from "../../indexer/indexer";
import type { MemoryInferenceResult, runMemoryInferencePass } from "../../indexer/passes/memory-inference";
import { resolveSourceEntries } from "../../indexer/search/search-source";
import { resolveTriageJudgmentRunner } from "../../integrations/agent/runner";
import type { SessionLogHarness } from "../../integrations/session-logs/types";
import { installLlmUsagePersistence } from "../../llm/usage-persist";
import { withLlmStage } from "../../llm/usage-telemetry";
import { isGitBackedStash, resolveWritableOverride, saveGitStash } from "../../sources/providers/git";
import { type DrainResult, drainProposals } from "../proposal/drain";
import { resolveDrainPolicy } from "../proposal/drain-policies";
import type { DeadUrl } from "../url-checker";
import type { AkmConsolidateOptions, ConsolidateResult } from "./consolidate";
import { type AkmDistillResult, akmDistill } from "./distill";
// Eligibility / candidate-selection predicates live in ./eligibility.
import {
  buildLatestProposalTsMap,
  collectEligibleRefs,
  memoryCleanupParentRef,
  resolveImproveScope,
  shouldAnalyzeMemoryCleanup,
} from "./eligibility";
import { countEvalCases } from "./eval-cases";
import type { AkmExtractResult, countNewExtractCandidates } from "./extract";
import { resolveProcessEnabled } from "./improve-profiles";
import { preflightImproveStrategyEngines, resolveImproveStrategy } from "./improve-strategies";
// #607 per-process lock primitives live in ./locks. Imported for internal use;
// resetHeldProcessLocks is re-exported (the test seam imports it from here).
import {
  PROCESS_LOCK_DEFS,
  processLockPath,
  releaseAllProcessLocks,
  releaseHeldLocksIfOwned,
  releaseProcessLock,
  tryAcquireProcessLock,
  withOptionalProcessLock,
} from "./locks";
// The cycle loop / post-loop / maintenance stages live in ./loop-stages.
import { runImproveLoopStage, runImprovePostLoopStage } from "./loop-stages";
import { detectAndWriteContradictions } from "./memory/memory-contradiction-detect";
import { analyzeMemoryCleanup, type applyMemoryCleanup, type MemoryCleanupPlan } from "./memory/memory-improve";
// The pre-loop preparation pipeline lives in ./preparation.
import { runImprovePreparationStage } from "./preparation";
import { DEFAULT_DUE_DAYS, filterProactiveDue } from "./proactive-maintenance";
import type { akmProcedural } from "./procedural";
import type { akmRecombine } from "./recombine";
import { type AkmReflectResult, akmReflect } from "./reflect";
import { errMessage } from "./shared";

export { resetHeldProcessLocks } from "./locks";
// Re-exported from ./loop-stages for test importers (improve-db-locking).
export { runImproveMaintenancePasses } from "./loop-stages";
// Re-exported from ./preparation so existing importers (tests, callers) resolve.
export { maybeAutoTuneThreshold } from "./preparation";

export interface AkmImproveOptions {
  scope?: string;
  task?: string;
  dryRun?: boolean;
  target?: string;
  /**
   * Confidence threshold (0-100). Undefined disables auto-accept for all
   * sub-processes (consolidation will prompt interactively on HTTP paths).
   * The CLI parser supplies 90 when --auto-accept is absent, so CLI callers
   * get auto-accept on by default. Programmatic callers must pass 90 explicitly
   * to match that behaviour.
   */
  autoAccept?: number;
  stashDir?: string;
  config?: AkmConfig;
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
   * When another improve run already holds a per-process lock, skip that
   * specific process gracefully instead of failing with a "already running"
   * config error (exit 78). Each process (consolidate, reflect+distill, triage)
   * has its own lock; a held lock skips only that process, not the entire run.
   * Intended for high-frequency scheduled runs (e.g. the every-30-min `quick`
   * pass) that would otherwise pile up exit-78 failures whenever a longer run
   * is in progress. Default: false (preserve hard error per lock).
   */
  skipIfLocked?: boolean;
  /** Named improve strategy from improve.strategies or built-in strategy names. */
  strategy?: string;
  /**
   * #616 — bounded multi-cycle phasing override (CLI/programmatic). Takes
   * precedence over `profile.maxCycles`. Number of prep->loop->post-loop cycles
   * per run; each cycle re-runs ensureIndex + collectEligibleRefs. DEFAULT 1 =>
   * byte-identical single-pass behavior. A cycle accepting ZERO new
   * gate-accepted proposals ends the loop (fixed-point); a cycle is not started
   * when remainingBudgetMs is exhausted.
   */
  maxCycles?: number;
  /** #616 test seam: override collectEligibleRefs (re-run each cycle). */
  collectEligibleRefsFn?: typeof collectEligibleRefs;
  /** #616 test seam: override runImprovePreparationStage (re-run each cycle). */
  runImprovePreparationStageFn?: typeof runImprovePreparationStage;
  /** #616 test seam: override runImproveLoopStage (re-run each cycle). */
  runImproveLoopStageFn?: typeof runImproveLoopStage;
  /** #616 test seam: override runImprovePostLoopStage (re-run each cycle). */
  runImprovePostLoopStageFn?: typeof runImprovePostLoopStage;
  consolidateOptions?: Omit<AkmConsolidateOptions, "config" | "stashDir">;
  /** Number of eligible memory assets above which consolidation is forced even if the memory_consolidation feature flag is not set. Defaults to 100. */
  memoryVolumeConsolidationThreshold?: number;
  reflectFn?: (options: NonNullable<Parameters<typeof akmReflect>[0]>) => Promise<AkmReflectResult>;
  distillFn?: (options: NonNullable<Parameters<typeof akmDistill>[0]>) => Promise<AkmDistillResult>;
  memoryInferenceFn?: typeof runMemoryInferencePass;
  /**
   * #609: injectable recombine / synthesize pass seam for tests. When omitted,
   * the real {@link akmRecombine} runs (gated on the opt-in `recombine` process
   * being enabled, `scope.mode !== "ref"`, and `!options.dryRun`).
   */
  recombineFn?: typeof akmRecombine;
  /**
   * #615: injectable procedural-compilation pass seam for tests. When omitted,
   * the real {@link akmProcedural} runs (gated on the opt-in `procedural` process
   * being enabled, `scope.mode !== "ref"`, and `!options.dryRun`).
   */
  proceduralFn?: typeof akmProcedural;
  graphExtractionFn?: typeof runGraphExtractionPass;
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
  reindexFn?: (options: { stashDir: string }) => Promise<unknown>;
  /** When true (default), attempt LLM-driven schema repair on validation failures before skipping. Requires llm config. */
  repairValidationFailures?: boolean;
  /**
   * When true, only assets with recent feedback signals are eligible.
   * Disables the high-retrieval fallback path for type/all scope runs.
   */
  requireFeedbackSignal?: boolean;
  /**
   * Minimum retrieval count required for the zero-feedback fallback path.
   * Defaults to 5.
   */
  minRetrievalCount?: number;
  /**
   * Named process key forwarded to `akmReflect` so the improve loop picks up
   * per-process agent config (e.g. `agent.processes["reflect"]`).
   * Defaults to `"reflect"`. Set to another process name to route improve's
   * reflect calls through a different profile.
   */
  agentProcess?: string;
  /**
   * Self-consistency multi-sample voting for high-utility refs (R-2 / #389).
   * When a ref's utility score is at or above this threshold, the improve loop
   * runs N reflect samples and picks the majority-vote winner by Jaccard token
   * overlap. Self-Consistency arXiv:2203.11171 — N=3 samples beat single-shot
   * quality on reasoning tasks.
   *
   * Default: 0.7. Set to 1.0 to disable (no refs qualify).
   */
  selfConsistencyThreshold?: number;
  /**
   * Number of reflect samples to generate for high-utility refs (R-2 / #389).
   * Must be >= 2 for voting to make sense. Default: 3. Capped at 5.
   */
  selfConsistencyN?: number;
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
   * promoted by PRIOR runs — files written by extract auto-accept in the
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
  /** #609: result of the opt-in recombine / synthesize pass, when it ran. */
  recombination?: RecombineResult;
  /** #615: result of the opt-in procedural-compilation pass, when it ran. */
  proceduralCompilation?: ProceduralCompilationResult;
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
  const scope: ImproveScope = resolveImproveScope(options.scope);
  const reflectFn = options.reflectFn ?? akmReflect;
  const distillFn = options.distillFn ?? akmDistill;
  const ensureIndexFn = options.ensureIndexFn ?? ensureIndex;
  const reindexFn = options.reindexFn ?? akmIndex;
  const drainProposalsFn = options.drainProposalsFn ?? drainProposals;
  // #616 multi-cycle test seams. Default to the real module-local fns.
  const collectEligibleRefsImpl = options.collectEligibleRefsFn ?? collectEligibleRefs;
  const runImprovePreparationStageImpl = options.runImprovePreparationStageFn ?? runImprovePreparationStage;
  const runImproveLoopStageImpl = options.runImproveLoopStageFn ?? runImproveLoopStage;
  const runImprovePostLoopStageImpl = options.runImprovePostLoopStageFn ?? runImprovePostLoopStage;
  // Resolve the improve profile for this run. Profile drives type filtering,
  // process gating, and default autoAccept/limit values.
  const _earlyConfig = options.config ?? loadConfig();
  const selectedStrategy = resolveImproveStrategy(options.strategy, _earlyConfig);
  preflightImproveStrategyEngines(selectedStrategy, _earlyConfig);
  const improveProfile = selectedStrategy.config;
  // Apply profile defaults — CLI flags take precedence over profile defaults.
  // Rebuild options with effective values so all downstream stage functions
  // automatically pick up the profile-driven defaults.
  options = {
    ...options,
    autoAccept: options.autoAccept ?? improveProfile.autoAccept,
    // Profile-level limit, then process-level reflect.limit as fallback.
    // CLI --limit takes precedence over both.
    limit: options.limit ?? improveProfile?.processes?.reflect?.limit ?? improveProfile.limit,
  };
  // #616 — bounded multi-cycle phasing. CLI/programmatic override wins over
  // profile.maxCycles; default 1 => single pass (byte-identical to pre-#616).
  const maxCycles = Math.max(1, Math.trunc(options.maxCycles ?? improveProfile.maxCycles ?? 1));
  let primaryStashDir: string | undefined;
  try {
    primaryStashDir = resolveSourceEntries(options.stashDir)[0]?.path;
  } catch {
    primaryStashDir = undefined;
  }

  // C2 (#553/#554/#499): resolve the state.db path ONCE, synchronously, at the
  // command boundary — before the first `await` below. Every state.db open in
  // this run (`openStateDatabase`, every default-path `appendEvent`) is pinned
  // to this snapshot via `eventsCtx.dbPath`, so a parallel test file mutating
  // `process.env.XDG_DATA_HOME` across an await boundary can never redirect this
  // run's DB opens to a wrong/just-deleted tmpdir mid-flight (the parallel-load
  // timeout root cause). Because beforeEach runs synchronously, env is still the
  // calling test's own at this point; we capture it before yielding the loop.
  const resolvedStateDbPath = getStateDbPathInDataDir();

  // #612 / WS-4 — bounded, OPT-IN per-phase auto-accept threshold auto-tune.
  // DEFAULT OFF: `autoTune: false` (or absent) is a complete no-op.
  //
  // WS-4 change: thresholds are now PER PHASE. The old single global mutation
  // of `options.autoAccept` is retired — it caused every phase to share one
  // calibration signal, so a reflect-dominated run could tighten the consolidate
  // gate (or vice-versa). Instead:
  //   - Each `makeGateConfig` call reads the phase's stored threshold from
  //     state.db (Migration 012) and uses it as `phaseThreshold`, overriding
  //     the `globalThreshold` (= options.autoAccept) for that phase.
  //   - Per-phase `maybeAutoTuneThreshold` calls fire AFTER each phase's gate
  //     has run and persist the new threshold to state.db for the NEXT run.
  //   - `options.autoAccept` stays unchanged (it is the operator-supplied
  //     baseline, not a mutable run-time state).
  //
  // The global tune call is intentionally removed here. See per-phase calls
  // below (near each makeGateConfig / runAutoAcceptGate block).

  // #607 Lock decomposition: three per-process locks replace the single
  // `improve.lock`. Each process acquires only the lock(s) it needs, so
  // quick-shredder consolidate can run alongside daily reflect+distill.
  //
  //   consolidate.lock     — protects consolidate + memoryInference + graphExtraction (index.db writers)
  //   reflect-distill.lock — protects reflect + distill (state.db proposal writers)
  //   triage.lock          — protects triage pre-pass (state.db proposal promotions)
  //
  // Lock base directory — same `.akm/` under the primary stash dir.
  const lockBaseDir = primaryStashDir ? path.join(primaryStashDir, ".akm") : path.join(options.stashDir ?? ".", ".akm");

  const preEnsureCleanupWarnings: string[] = [];
  // #616: assigned by runIndexAndCollect() (closure) so TS cannot prove definite
  // assignment — seed with empty values; the first runIndexAndCollect() call
  // (cycle 1, in the first try) always overwrites them before any read.
  let plannedRefs: Awaited<ReturnType<typeof collectEligibleRefs>>["plannedRefs"] = [];
  let memorySummary: Awaited<ReturnType<typeof collectEligibleRefs>>["memorySummary"] = { eligible: 0, derived: 0 };
  let profileFilteredRefs: Awaited<ReturnType<typeof collectEligibleRefs>>["profileFilteredRefs"] = [];
  let memoryCleanupPlan: ReturnType<typeof analyzeMemoryCleanup> | undefined;
  let guidance: string | undefined;
  let triageDrain: DrainResult | undefined;

  // #616 — ensureIndex + collectEligibleRefs + memory-cleanup recompute, lifted
  // into a helper so the SAME sequence runs once for cycle 1 (below, in the
  // first try) and is re-run at the top of each subsequent multi-cycle cycle.
  // Re-running ensureIndex between cycles makes cycle N's gate-promoted
  // proposals visible to cycle N+1's collectEligibleRefs. Mutates the
  // outer-scope plannedRefs/memorySummary/profileFilteredRefs/memoryCleanupPlan/
  // guidance so for maxCycles:1 the body is byte-identical to pre-#616.
  const runIndexAndCollect = async (): Promise<void> => {
    // #339 fix: ensureIndex MUST run BEFORE collectEligibleRefs. The eligible-ref
    // query reads the `entries` table; if a DB version upgrade just dropped that
    // table (or the index is otherwise empty), the prior run order silently
    // returned plannedRefs=[] and the improve loop no-op'd. Hoisting the call
    // here repopulates the index first so the subsequent query sees fresh data.
    if (primaryStashDir) {
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
        await ensureIndexFn(primaryStashDir, { mode: "blocking" });
      } catch (err) {
        preEnsureCleanupWarnings.push(`ensureIndex failed: ${errMessage(err)}`);
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

    ({ plannedRefs, memorySummary, profileFilteredRefs } = await collectEligibleRefsImpl(
      scope,
      options.stashDir,
      improveProfile,
    ));
    const cleanupParentRef = memoryCleanupParentRef(scope, options.stashDir);

    // M-1 (#367): Run contradiction-detection BEFORE analyzeMemoryCleanup so
    // the SCC resolver in resolveFamilyContradictions has edges to work on.
    // Best-effort: failures are warnings, never fatal.
    if (primaryStashDir && shouldAnalyzeMemoryCleanup(scope, memorySummary.eligible, primaryStashDir)) {
      try {
        // Reuse the config resolved at the top of the run instead of a second load.
        await withLlmStage("memory-contradiction", () =>
          detectAndWriteContradictions(primaryStashDir, _earlyConfig, undefined, improveProfile),
        );
      } catch (err) {
        // Non-fatal: contradiction detection is a best-effort pass.
        warn(`[improve] contradiction detection failed (non-fatal): ${errMessage(err)}`);
      }
    }

    memoryCleanupPlan = shouldAnalyzeMemoryCleanup(scope, memorySummary.eligible, primaryStashDir)
      ? analyzeMemoryCleanup(primaryStashDir as string, cleanupParentRef ? { parentRef: cleanupParentRef } : undefined)
      : undefined;
    guidance =
      memorySummary.eligible > 0
        ? "Improve folds memory cleanup into the same proposal queue: speculative promotions still go through reflect/distill proposals, while high-confidence redundant derived memories are moved into a recoverable cleanup archive instead of being left active in the stash."
        : undefined;
  };

  // Holds our own process.on("exit") backstop so the finally can remove EXACTLY
  // that handler (not every exit listener in the process). Declared in the scope
  // shared by the try and its finally; assigned when the backstop is registered.
  let exitBackstop: (() => void) | undefined;

  try {
    // #607: Per-process lock acquisition. Each process acquires only the lock(s)
    // it needs. The dry-run branch produces plannedRefs/memorySummary WITHOUT any
    // locks (decision: dry-run never mutates the queue).
    if (!options.dryRun) {
      // Backstop release on process.exit() (signal handler / budget watchdog),
      // which skips the finally below. Removed in that finally on the normal path.
      const releaseAllOnExit = (): void => releaseHeldLocksIfOwned(process.pid);
      exitBackstop = releaseAllOnExit;
      process.on("exit", releaseAllOnExit);

      // #607 triage pre-pass: acquire triage.lock, drain the standing pending
      // backlog BEFORE ensureIndex so improve generates fresh proposals against
      // a cleared queue (no `duplicate_pending` collisions) and ensureIndex
      // absorbs triage's promotions for free. Release immediately after —
      // triage.lock is not needed again until the next improve run.
      if (primaryStashDir && resolveProcessEnabled("triage", improveProfile)) {
        if (scope.mode === "ref") {
          warn("[improve] triage pre-pass skipped (single-ref scope never drains the whole queue)");
        } else {
          const triageLPath = processLockPath(lockBaseDir, "triage");
          const triageResult = tryAcquireProcessLock(
            triageLPath,
            PROCESS_LOCK_DEFS.triage.staleAfterMs,
            options.skipIfLocked,
            "triage",
          );
          if (triageResult === "skipped") {
            triageDrain = undefined;
          } else {
            try {
              const triageConfig = improveProfile.processes?.triage;
              const policy = resolveDrainPolicy(triageConfig?.policy);
              const applyMode: "queue" | "promote" = triageConfig?.applyMode ?? "queue";
              const maxAccepts = triageConfig?.maxAcceptsPerRun ?? 25;
              const judgment = triageConfig?.judgment
                ? resolveTriageJudgmentRunner(triageConfig.judgment, _earlyConfig)
                : null;
              triageDrain = await drainProposalsFn({
                stashDir: primaryStashDir,
                policy,
                applyMode,
                maxAccepts,
                dryRun: false,
                excludeIds: new Set<string>(),
                ...(triageConfig?.maxDiffLines !== undefined ? { maxDiffLines: triageConfig.maxDiffLines } : {}),
                judgment,
              });
            } catch (err) {
              warn(`[improve] triage pre-pass failed (non-fatal): ${errMessage(err)}`);
            } finally {
              releaseProcessLock(triageLPath);
            }
          }
        }
      }
    }

    // #339 fix: ensureIndex MUST run BEFORE collectEligibleRefs (now inside the
    // helper). Cycle 1 runs it here; subsequent multi-cycle cycles re-run it via
    // the same helper at the top of each cycle below.
    await runIndexAndCollect();

    if (options.dryRun) {
      const result: AkmImproveResult = {
        schemaVersion: 1,
        ok: true,
        strategy: selectedStrategy.name,
        scope,
        dryRun: true,
        ...(guidance ? { guidance } : {}),
        memorySummary,
        ...(memoryCleanupPlan ? { memoryCleanup: shapeMemoryCleanup(memoryCleanupPlan) } : {}),
        plannedRefs,
        ...(profileFilteredRefs.length > 0 ? { profileFilteredRefs } : {}),
      };
      return result;
    }
  } catch (err) {
    releaseAllProcessLocks();
    throw err;
  }

  // #607: per-process locks are acquired/released around each stage below.
  // The triage pre-pass already ran under triage.lock (released). The
  // preparation stage runs under consolidate.lock, the loop stage under
  // reflect-distill.lock, and the post-loop stage under consolidate.lock again.
  // Each stage acquires its lock just before starting and releases in finally.
  // best-effort `unlinkSync` is a no-op when no lock file exists.
  const startMs = Date.now();
  const budgetMs = options.timeoutMs ?? 2 * 60 * 60 * 1000; // default 2 hours
  // O-1 (#364): Create a shared AbortController derived from startMs + budgetMs.
  // Every async seam receives this signal so a hung sub-call cannot extend the
  // run past the declared budget.
  // References: Anthropic *Building Effective Agents* (2024); CoALA §5 (arXiv:2309.02427).
  const budgetAbortController = new AbortController();
  // Attach a live `remainingBudgetMs` getter to the signal so sub-callers
  // (e.g. consolidate.ts cold-start budget estimation) can read the remaining
  // wall-clock budget without needing an extra plumbing parameter. The property
  // is computed at access time via a getter so it always reflects the actual
  // elapsed time rather than a stale snapshot taken at arm time.
  Object.defineProperty(budgetAbortController.signal, "remainingBudgetMs", {
    get: () => Math.max(0, budgetMs - (Date.now() - startMs)),
    enumerable: false,
    configurable: true,
  });
  // Declared in the outer scope so the `finally` can clear the timer even if a
  // throw occurs before/after it is armed. Defaults to a no-op until armed.
  let clearBudgetTimer = (): void => {};
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

  // ── Crash-safe / incremental stash sync (#662) ──────────────────────────────
  // The primary stash writes as a filesystem source DURING the run
  // (write-source.ts case-3); those writes become a git commit only when this
  // closure runs. Historically the only call site was a single BATCH commit at
  // the very end of the happy path, so a run interrupted AFTER writing but
  // BEFORE finishing — a mid-cycle crash, a budget abort, or an external
  // SIGTERM/`process.exit` — left every write uncommitted until some LATER run
  // happened to finish cleanly and swept the whole backlog up. We now call this
  // from THREE places: between cycles (bank each completed cycle), at end-of-run
  // (the converged commit), and from the catch path (commit what was written
  // before the crash). That shrinks the worst-case loss from "the entire run" to
  // "the in-flight cycle".
  //
  // Declared in the OUTER scope (not inside the try) so the catch block can reach
  // it. Idempotent + NON-FATAL: `saveGitStash` short-circuits a clean working
  // tree ("nothing to commit") and a thrown sync error is swallowed here, so a
  // repeat call after a no-op cycle is cheap and a failed push never fails the
  // run. Gated identically to the original end-of-run block (git-backed primary
  // stash, sync not disabled). `eventsCtx` is captured by reference, so calls
  // after the db-backed context is installed inside the try use the live handle.
  const effectiveSync = { ...improveProfile.sync, ...options.sync };
  const commitStashBatch = (
    messageContext: Parameters<typeof renderSyncCommitMessage>[1],
  ): AkmImproveResult["sync"] | undefined => {
    if (!primaryStashDir || effectiveSync.enabled === false || !isGitBackedStash(primaryStashDir)) {
      return undefined;
    }
    const saveGitStashFn = options.saveGitStashFn ?? saveGitStash;
    const writableOverride = resolveWritableOverride(_earlyConfig);
    const push = effectiveSync.push !== false;
    const message = renderSyncCommitMessage(
      effectiveSync.message ?? "akm improve auto-sync",
      messageContext,
      Date.now(),
    );
    try {
      const syncResult = saveGitStashFn(undefined, message, writableOverride, { push, repoDir: primaryStashDir });
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

  try {
    // H7 (#566): arm the budget watchdog. `armBudgetWatchdog` captures both the
    // budget timer and the hard-kill timer it schedules on exhaustion, returning
    // a single dispose() that clears whichever are still pending. The `finally`
    // calls dispose() via `clearBudgetTimer` (RAII), so a clean cooperative
    // drain cancels the pending hard-kill before it can fire — the process then
    // exits naturally instead of being force-`exit(0)`-ed mid-flush, which could
    // truncate an in-flight log or `state.db` transaction.
    clearBudgetTimer = armBudgetWatchdog(budgetMs, budgetAbortController);

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

    // 2026-05-27: emit an `improve_skipped` audit event for refs the planner
    // pre-filtered (reflect AND distill both refuse them under the active
    // profile). Emitted as a single summary event (count only) rather than one
    // event per ref (#592) — the per-ref loop caused O(n) sequential state.db
    // writes that consumed ~500 s on a 9 000-ref stash. No downstream consumer
    // needs the per-ref audit trail: health's skip histogram reads the
    // `profile_filtered_all_passes` counters from `improve_completed` metadata.
    if (profileFilteredRefs.length > 0) {
      appendEvent(
        {
          eventType: "improve_skipped",
          ref: undefined,
          metadata: {
            reason: "profile_filtered_all_passes",
            count: profileFilteredRefs.length,
          },
        },
        eventsCtx,
      );
    }

    // #616 — bounded multi-cycle phasing. The prep->loop->post-loop sequence is
    // wrapped in an N-cycle loop. Each cycle re-runs ensureIndex +
    // collectEligibleRefs (via runIndexAndCollect) so gate-accepted output of
    // cycle N becomes selectable input to cycle N+1. The per-stage process locks
    // (consolidate / reflect-distill) are acquired+released INSIDE each cycle,
    // exactly as the single-pass path did. For maxCycles:1 the loop runs once and
    // every accumulator below collapses to the single-cycle value (sum-of-one,
    // concat-of-one, last==only) => BYTE-IDENTICAL to pre-#616.
    //
    // Accumulators (see CONSTRAINTS / aggregation plan in #616): SUM the count
    // fields and durations; CONCAT the array fields; LAST-WINS for point-in-time
    // objects (the final cycle's value reflects the converged state).
    let cyclesRun = 0;
    // Last-wins point-in-time values (assigned every cycle; the final cycle wins).
    let preparation!: ImprovePreparationResult;
    let memoryRefsForInference: Set<string> = new Set();
    let consolidation!: ConsolidateResult;
    let memoryInference: ImprovePostLoopResult["memoryInference"];
    let graphExtraction: ImprovePostLoopResult["graphExtraction"];
    let recombination: ImprovePostLoopResult["recombination"];
    let proceduralCompilation: ImprovePostLoopResult["proceduralCompilation"];
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

    for (let cycleIndex = 0; cycleIndex < maxCycles; cycleIndex++) {
      // #616 budget gate: never start a NEW cycle once the run's wall-clock
      // budget is exhausted (or the run was aborted). Cycle 0 ALWAYS runs so
      // maxCycles:1 is byte-identical regardless of budget.
      if (cycleIndex > 0) {
        const remaining = (budgetAbortController.signal as { remainingBudgetMs?: number }).remainingBudgetMs;
        if (budgetAbortController.signal.aborted || (remaining !== undefined && remaining <= 0)) {
          break;
        }
      }

      // #662 incremental sync: bank the PREVIOUS cycle's writes before starting a
      // new one, so a crash/abort/timeout mid-run loses at most the in-flight
      // cycle rather than the whole run. Guarded on `cycleIndex > 0`, so the
      // common maxCycles:1 path never calls this — its single end-of-run commit
      // below stays the only sync and the serialized envelope is byte-identical
      // to pre-#662. `saveGitStash` no-ops a clean tree, so a cycle that wrote
      // nothing costs only a `git status`.
      if (cycleIndex > 0) {
        commitStashBatch({ scope, plannedRefs, runId: options.runId });
      }

      // Re-run ensureIndex + collectEligibleRefs + memory-cleanup recompute for
      // cycles 2+ (cycle 1 already ran them in the first try above). This makes
      // cycle N's gate-promoted proposals visible to this cycle's ref selection.
      if (cycleIndex > 0) {
        await runIndexAndCollect();
        // Re-emit the profile-filtered audit summary for this cycle's selection.
        if (profileFilteredRefs.length > 0) {
          appendEvent(
            {
              eventType: "improve_skipped",
              ref: undefined,
              metadata: { reason: "profile_filtered_all_passes", count: profileFilteredRefs.length },
            },
            eventsCtx,
          );
        }
      }

      // #607: acquire consolidate.lock for the preparation stage (consolidate,
      // ensureIndex, extract all write index.db). Released immediately after.
      const consolidateLPath = processLockPath(lockBaseDir, "consolidate");
      preparation = await withOptionalProcessLock(
        {
          lockPath: consolidateLPath,
          staleAfterMs: PROCESS_LOCK_DEFS.consolidate.staleAfterMs,
          skipIfLocked: options.skipIfLocked,
          label: "consolidate",
        },
        () =>
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
            budgetSignal: budgetAbortController.signal,
          }),
      );
      prepGateCount += preparation.gateAutoAcceptedCount;
      prepGateFailedCount += preparation.gateAutoAcceptFailedCount;

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

      // #607: acquire reflect-distill.lock for the loop stage (reflect + distill
      // both write proposals to state.db). Released immediately after.
      const reflectDistillLPath = processLockPath(lockBaseDir, "reflectDistill");
      const loopResult = await withOptionalProcessLock(
        {
          lockPath: reflectDistillLPath,
          staleAfterMs: PROCESS_LOCK_DEFS.reflectDistill.staleAfterMs,
          skipIfLocked: options.skipIfLocked,
          label: "reflect-distill",
        },
        () => {
          // Post-lock cooldown re-filter for proactive refs (#SELECT-TIME-LEAK).
          // Planning built `lastReflectProposalTs` BEFORE acquiring this lock, so a
          // concurrent run's `reflect_invoked` writes are invisible to it. Now that
          // we hold the lock, re-read fresh timestamp maps for the proactive subset
          // and drop any ref whose cooldown has been consumed by the concurrent run.
          const proactiveLoopRefs = preparation.loopRefs.filter((r) => r.eligibilitySource === "proactive");
          let postLockLoopRefs = preparation.loopRefs;
          if (proactiveLoopRefs.length > 0) {
            const proactiveRefStrs = proactiveLoopRefs.map((r) => r.ref);
            const freshReflectTs = buildLatestProposalTsMap(proactiveRefStrs, "reflect");
            const freshDistillTs = buildLatestProposalTsMap(proactiveRefStrs, "distill");
            const pmDueDays = improveProfile.processes?.proactiveMaintenance?.dueDays ?? DEFAULT_DUE_DAYS;
            const stillDue = new Set(
              filterProactiveDue(proactiveLoopRefs, freshReflectTs, freshDistillTs, pmDueDays, Date.now()).map(
                (r) => r.ref,
              ),
            );
            const dropped = proactiveLoopRefs.filter((r) => !stillDue.has(r.ref));
            if (dropped.length > 0) {
              info(
                `[improve] post-lock cooldown re-filter: dropped ${dropped.length} proactive ref(s) claimed by concurrent run (${dropped.map((r) => r.ref).join(", ")})`,
              );
              postLockLoopRefs = preparation.loopRefs.filter(
                (r) => r.eligibilitySource !== "proactive" || stillDue.has(r.ref),
              );
            }
          }

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
            budgetSignal: budgetAbortController.signal,
          });
        },
      );
      const loopGateCountThisCycle = loopResult.gateAutoAcceptedCount;
      reflectsWithErrorContext += loopResult.reflectsWithErrorContext;
      loopGateCount += loopResult.gateAutoAcceptedCount;
      loopGateFailedCount += loopResult.gateAutoAcceptFailedCount;
      memoryRefsForInference = loopResult.memoryRefsForInference;

      // #551: consolidation now runs in the preparation stage (before extract);
      // its result and run-flag are read from `preparation`, not the post-loop.
      consolidation = preparation.consolidation;

      // #607: acquire consolidate.lock for the post-loop stage (memoryInference +
      // graphExtraction both write index.db). Released immediately after.
      const consolidatePostLPath = processLockPath(lockBaseDir, "consolidate");
      const postLoopResult = await withOptionalProcessLock(
        {
          lockPath: consolidatePostLPath,
          staleAfterMs: PROCESS_LOCK_DEFS.consolidate.staleAfterMs,
          skipIfLocked: options.skipIfLocked,
          label: "consolidate",
        },
        () =>
          runImprovePostLoopStageImpl({
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
            consolidationRan: preparation.consolidationRan,
            // R5: floor violations from this run's consolidate pass + the
            // auto-accepted volume so far (prep + loop gates) for churn detection.
            consolidationMergeFloorViolations: preparation.consolidation.mergeFloorViolations ?? 0,
            acceptedActions: preparation.gateAutoAcceptedCount + loopGateCountThisCycle,
          }),
      );
      const postLoopGateCountThisCycle = postLoopResult.gateAutoAcceptedCount;
      // Last-wins point-in-time objects.
      memoryInference = postLoopResult.memoryInference;
      graphExtraction = postLoopResult.graphExtraction;
      recombination = postLoopResult.recombination;
      proceduralCompilation = postLoopResult.proceduralCompilation;
      // Keep the last QUALIFYING cycle's snapshot — a later non-qualifying
      // cycle in a maxCycles>1 run must not clobber it with undefined.
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

      cyclesRun++;

      // #616 fixed-point stop: a cycle that produced ZERO gate-accepted proposals
      // (summed across prep + loop + post-loop) would feed cycle N+1 an identical
      // ref set, so end the loop here rather than spin a pointless next cycle.
      const gateAcceptedThisCycle =
        preparation.gateAutoAcceptedCount + loopGateCountThisCycle + postLoopGateCountThisCycle;
      if (gateAcceptedThisCycle === 0) break;
    }

    // C1 (13-bus-factor): fold the per-ref `distill-skipped` rows (~13k/run,
    // ~91% of result_json bytes) into a bounded aggregate BEFORE persistence.
    // The metric total + per-reason breakdown are preserved on `distillSkipped`;
    // the unbounded row list never reaches result_json. Reflect skip counters
    // below still read `finalActions` (reflect skips are not folded).
    const { actions: persistedActions, aggregate: distillSkippedAggregate } = foldDistillSkipped(finalActions);

    const result: AkmImproveResult = {
      schemaVersion: 1,
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
      ...(profileFilteredRefs.length > 0 ? { profileFilteredRefs } : {}),
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
      ...(recombination ? { recombination } : {}),
      ...(proceduralCompilation ? { proceduralCompilation } : {}),
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
      // #616 — report cycles run only when >1 so the default single-pass
      // serialized envelope stays byte-identical to pre-#616 (AC1).
      ...(cyclesRun > 1 ? { cyclesRun } : {}),
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
    // D3: emit improve_failed on unexpected crash so dashboards can detect failures.
    appendEvent(
      {
        eventType: "improve_failed",
        ref: scope.mode === "ref" ? scope.value : `improve:${scope.mode}:${scope.value ?? "all"}`,
        metadata: {
          error: errMessage(err),
          durationMs: Date.now() - startMs,
        },
      },
      eventsCtx,
    );
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
    // #607: release any per-process locks still held (backstop for error paths;
    // the normal path already released each lock after its stage completed).
    releaseAllProcessLocks();
    // Drop ONLY our own process.exit backstop so it does not fire later (or
    // accumulate across repeated in-process calls). Must NOT use
    // removeAllListeners("exit") here: in the in-process model (tests and
    // programmatic callers import cli.ts) that would silently destroy exit
    // handlers owned by the host or other commands.
    if (exitBackstop) {
      process.removeListener("exit", exitBackstop);
      exitBackstop = undefined;
    }
    // I1: close the long-lived state.db connection opened at the top of the run.
    try {
      eventsDb?.close();
    } catch {
      // ignore — DB may already be closed
    }
  }
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
 * existed at the start of the run — files written by extract auto-accept in
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
  improveProfile: import("./improve-profiles").ImproveProfileConfig;
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
