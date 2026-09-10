// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { assertNever } from "../../core/assert";
import { type AssetRef, parseRefInput } from "../../core/asset/resolve-ref";
import { daysToMs } from "../../core/common";
import { type AkmConfig, bundlesToSourceEntries, loadConfig } from "../../core/config/config";
import { ConfigError, rethrowIfTestIsolationError, UsageError } from "../../core/errors";
import { appendEvent, type EventsContext, readEvents } from "../../core/events";
import type { EventEnvelope } from "../../core/events-types";
import type { LockOwnership } from "../../core/file-lock";
import type {
  AkmImproveResult,
  ConsolidateResult,
  ImproveActionResult,
  ImproveEligibleRef,
  ImproveIndexSnapshot,
  ImproveMemoryCleanupResult,
} from "../../core/improve-types";
import { classifyImproveAction, foldDistillSkipped } from "../../core/improve-types";
import { resolveMutationTarget } from "../../core/mutation-target";
import { getDbPath, getStashLocksDir, getStateDbPathInDataDir } from "../../core/paths";
import { redactSensitiveText } from "../../core/redaction";
import { openStateDatabase } from "../../core/state-db";
import { info, warn, warnVerbose } from "../../core/warn";
import { beginWriteProvenance, relativeWrittenPath, type WriteProvenanceJournal } from "../../core/write-provenance";
import { resolveWritable, resolveWriteTarget } from "../../core/write-source";
import type { LoweringNotice } from "../../execution/resolved-request";
import { ensureIndex } from "../../indexer/ensure-index";
import { akmIndex } from "../../indexer/indexer";
import { collectPendingMemories } from "../../indexer/passes/memory-inference";
import { resolveEntryContentDir, resolveSourceEntries } from "../../indexer/search/search-source";
import { collectEngineCredentialValues } from "../../integrations/agent/engine-resolution";
import { installLlmUsagePersistence, LLM_USAGE_EVENT } from "../../llm/usage-persist";
import {
  isGitBackedStash,
  listGitChangedPaths,
  resolveWritableOverride,
  saveGitStash,
} from "../../sources/providers/git";
import { closeDatabase, openExistingDatabase } from "../../storage/repositories/index-connection";
import { getEntryCount } from "../../storage/repositories/index-entries-repository";
import { openSqliteReadSnapshot, SqliteReadSnapshotUnavailableError } from "../../storage/sqlite-read-snapshot";
import { summarizeLlmUsageCrossTab } from "../health/llm-usage";
import { type DrainResult, drainProposals } from "../proposal/drain";
import { resolveDrainPolicy } from "../proposal/drain-policies";
import type { EligibilitySource } from "../proposal/proposal-types";
import { type AutonomyLane, describeGatedLanes, isAutonomyLaneAllowed } from "./autonomy-gate";
import { akmDistill } from "./distill";
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
// Shared improve option/result types live in the dependency-leaf
// ./improve-run-types (severs the improve ↔ loop-stages ↔ preparation import
// cycle, SCC #8 — anchors.md D.3). Re-exported below for external importers.
import type {
  AkmImproveOptions,
  ImprovePostLoopResult,
  ImprovePreparationResult,
  ImproveScope,
} from "./improve-run-types";
import {
  projectResolvedProcessRouting,
  type ResolvedImprovePlan,
  resolveImprovePlan,
  resolveImproveStrategy,
  shouldSkipRef,
} from "./improve-strategies";
import { buildImproveUsageReport } from "./improve-usage-report";
import { improveLockPath, releaseImproveLock, tryAcquireImproveLock } from "./locks";
// The cycle loop / post-loop / maintenance stages live in ./loop-stages.
import { runImproveLoopStage, runImprovePostLoopStage } from "./loop-stages";
import { analyzeMemoryCleanup, type MemoryCleanupPlan } from "./memory/memory-improve";
import { buildImproveExecutionPlan } from "./planner";
// The pre-loop preparation pipeline lives in ./preparation.
import { runImprovePreparationStage } from "./preparation";
import { DEFAULT_DUE_DAYS, filterProactiveDue } from "./proactive-maintenance";
import { akmReflect } from "./reflect";
import { createRunContext, type RunContext } from "./run-context";
import { errMessage } from "./shared";

export type {
  AkmImproveOptions,
  ConsolidationPassResult,
  ImproveLoopResult,
  ImproveLoopState,
  ImproveMaintenanceResult,
  ImprovePostLoopResult,
  ImprovePreparationResult,
  ImproveScope,
} from "./improve-run-types";
// Re-exported from ./loop-stages for test importers (improve-db-locking).
export { runImproveMaintenancePasses } from "./loop-stages";

export type {
  AkmImproveResult,
  EligibilitySource,
  ImproveActionResult,
  ImproveEligibleRef,
  ImproveMemoryCleanupResult,
};

export function renderSyncCommitMessage(
  template: string,
  result: {
    scope: { mode: string; value?: string };
    plannedRefs: unknown[];
    gateAutoAcceptedCount?: number;
    triage?: { promoted: number; rejected: number; deferred: number; failed: number; skippedByCap: number };
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
  return template.replace(/\{(\w+)\}/g, (match, key: string) => tokens[key] ?? match);
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

/**
 * The run's write-provenance journal lifecycle as one named unit (#652).
 *
 * The journal is opened once the run owns its lock — so it spans exactly the
 * window in which this run, and only this run, is allowed to write — and closed
 * on every exit path including the crash-safety commit. Keeping the mutable
 * handle behind this factory rather than as a bare `let` in {@link akmImprove}
 * is also what keeps that function under the R31 size gate
 * (`tests/architecture/improve-fn-size-ratchet.test.ts`, absolute 220-line bar
 * with an empty baseline): lifecycle state belongs in a named unit, not in the
 * orchestrator's preamble.
 */
function createRunWriteJournal(): {
  open(): void;
  close(): void;
  current(): WriteProvenanceJournal | undefined;
} {
  let journal: WriteProvenanceJournal | undefined;
  return {
    open: () => {
      journal = beginWriteProvenance();
    },
    close: () => {
      journal?.end();
      journal = undefined;
    },
    current: () => journal,
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
  } = setup;
  let clearBudgetTimer = (): void => {};
  let initialGitPaths = new Set<string>();
  const runJournal = createRunWriteJournal();

  const preEnsureCleanupWarnings: string[] = [];
  let plannedRefs: Awaited<ReturnType<typeof collectEligibleRefs>>["plannedRefs"] = [];
  let memorySummary: Awaited<ReturnType<typeof collectEligibleRefs>>["memorySummary"] = { eligible: 0, derived: 0 };
  let strategyFilteredRefs: Awaited<ReturnType<typeof collectEligibleRefs>>["strategyFilteredRefs"] = [];
  let indexSnapshot: ImproveIndexSnapshot | undefined;
  let memoryCleanupPlan: ReturnType<typeof analyzeMemoryCleanup> | undefined;
  let autonomyGatedDirectLanes: AutonomyLane[] = [];
  let guidance: string | undefined;
  let triageDrain: DrainResult | undefined;

  let improveLockOwnership: LockOwnership | undefined;
  let exitBackstop: (() => void) | undefined;
  // I1: open a single state.db connection for the main improve run so all
  // appendEvent calls reuse one handle instead of open/migrate/close per call.
  let eventsDb: import("../../storage/database").Database | undefined;
  // Start boundary-pinned for prepass telemetry, then replace this binding with
  // the long-lived handle after the prepass. The usage sink resolves it per
  // append, so one owner and counter span both lifecycle phases.
  let eventsCtx: EventsContext = { dbPath: resolvedStateDbPath };
  let disposeLlmUsageSink = (): void => {};
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
  const commitStashBatch = makeCommitStashBatch({
    run: setup,
    getInitialGitPaths: () => initialGitPaths,
    getWriteJournal: () => runJournal.current(),
    // Captured via getter: the live `eventsCtx` binding is reassigned after the
    // prepass, and the catch-path sync must write through the current context.
    getEventsCtx: () => eventsCtx,
  });

  if (!options.dryRun) {
    const remainingBudget = (budgetAbortController.signal as { remainingBudgetMs?: number }).remainingBudgetMs;
    clearBudgetTimer = armBudgetWatchdog(Math.max(1, remainingBudget ?? budgetMs), budgetAbortController);
  }

  try {
    if (!options.dryRun) {
      const acquisition = tryAcquireImproveLock(resolvedLockPath, options.skipIfLocked, {
        // R25: C2 boundary-pinned path — the long-lived handle doesn't exist yet.
        dbPath: resolvedStateDbPath,
      });
      if (acquisition.state === "skipped") {
        clearBudgetTimer();
        return buildLockSkippedResult(selectedStrategy.name, scope, options.runId);
      }
      improveLockOwnership = acquisition.ownership;
      disposeLlmUsageSink = installLlmUsagePersistence(() => eventsCtx);
      exitBackstop = releaseRunLock;
      process.on("exit", exitBackstop);
      initialGitPaths =
        syncRepoDir && isGitBackedStash(syncRepoDir) ? new Set(listGitChangedPaths(syncRepoDir)) : new Set<string>();
      // #652: open AFTER the lock, so the journal covers exactly the window in
      // which this run — and only this run — is allowed to write.
      runJournal.open();

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
    indexSnapshot = collected.indexSnapshot;
    memoryCleanupPlan = collected.memoryCleanupPlan;
    autonomyGatedDirectLanes = collected.autonomyGatedDirectLanes;
    guidance = collected.guidance;
    preEnsureCleanupWarnings.push(...collected.warnings);

    if (options.dryRun) {
      const result = await runDryPlanningStage({
        run: setup,
        collected,
        resolvedStateDbPath,
        budgetMs,
        initialCleanupWarnings: preEnsureCleanupWarnings,
        signal: budgetAbortController.signal,
      });
      clearBudgetTimer();
      return result;
    }
  } catch (err) {
    // If the live prepass fails, emit its summary and clear the owning sink
    // before any run teardown. The disposer is idempotent with the main finalizer.
    disposeLlmUsageSink();
    clearBudgetTimer();
    if (exitBackstop) {
      process.removeListener("exit", exitBackstop);
      exitBackstop = undefined;
    }
    releaseRunLock();
    runJournal.close();
    throw err;
  }

  try {
    const openedEvents = openImproveEventsContext(resolvedStateDbPath);
    eventsDb = openedEvents.db;
    eventsCtx = openedEvents.ctx;

    // WI-9.10: construct the run's RunContext here — the first point after
    // run-setup where config/stashDir/eventsCtx/proposalsCtx/sourceRun/dryRun
    // are all in hand. See buildImproveRunContext for exactly which
    // already-resolved values back each field.
    const ctx = buildImproveRunContext(setup, eventsCtx);

    const seq = await runImproveStageSequence({
      run: setup,
      strategyFilteredRefs,
      plannedRefs,
      memoryCleanupPlan,
      autonomyGatedDirectLanes,
      memorySummary,
      preEnsureCleanupWarnings,
      eventsCtx,
      ctx,
    });

    const result = finalizeImproveResult({
      run: setup,
      seq,
      guidance,
      memorySummary,
      memoryCleanupPlan,
      strategyFilteredRefs,
      rawPlannedRefs: plannedRefs,
      indexSnapshot,
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
    //
    // #652: surface the run's write provenance on the envelope BEFORE the sync
    // (the sync itself writes no assets), so `result.writtenPaths` describes
    // exactly the set the commit below was scoped to.
    const writtenPaths = describeRunWrittenPaths(setup, runJournal.current()?.writtenPaths() ?? []);
    if (writtenPaths.length > 0) result.writtenPaths = writtenPaths;
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
    // #652: close the write-provenance journal LAST among the write-facing
    // teardown steps — the catch path's crash-safety commit above still needs
    // it open to know what this run wrote.
    runJournal.close();
    // I1: close the long-lived state.db connection opened at the top of the run.
    try {
      eventsDb?.close();
    } catch {
      // ignore — DB may already be closed
    }
  }
}

/** Open the run-owned state handle while preserving the boundary-pinned fallback. */
function openImproveEventsContext(dbPath: string): {
  db?: import("../../storage/database").Database;
  ctx: EventsContext;
} {
  try {
    const db = openStateDatabase(dbPath);
    return { db, ctx: { db } };
  } catch (err) {
    rethrowIfTestIsolationError(err);
    return { ctx: { dbPath } };
  }
}

/**
 * Shape the run's journaled absolute paths for `result.writtenPaths` (#652):
 * POSIX-relative to the run's primary stash dir (the repo root for a git-backed
 * stash) when the write landed inside it, absolute otherwise — a run writing to
 * a `--target` bundle outside the stash still reports what it wrote. Deduped and
 * sorted so the field is stable across runs.
 */
function describeRunWrittenPaths(setup: ImproveRunSetup, writtenPaths: readonly string[]): string[] {
  const root = setup.primaryStashDir ?? setup.syncRepoDir;
  const described = new Set<string>();
  for (const absolutePath of writtenPaths) {
    const relative = root ? relativeWrittenPath(root, absolutePath) : undefined;
    described.add(relative ?? absolutePath.replaceAll(path.sep, "/"));
  }
  return [...described].sort();
}

// ── akmImprove run-setup / stage-sequencing / run-teardown units ────────────
// WI-7.7 step 1 (R31): the 810-line orchestrator body is decomposed into the
// named units below. The two-try topology, all four early-exit paths, and the
// exit-path cleanup ordering stay in akmImprove itself (they are the teardown
// contract — see P1–P8 in the chunk-7 ledger); the units hold the straight-line
// mass. Args objects carry the run-scoped values; return values replace the
// old closure-mutated outer `let`s.

interface ImproveReadSource {
  selector?: string;
  source: { name: string; path: string };
}

/**
 * Resolve a dry-run inspection source without adapting it into a write target.
 * Exported so `improve-cli.ts`'s `--show-prompt` (#952) can resolve the same
 * read-only bundle a plain `--dry-run` would, without duplicating this
 * selector/target/fallback precedence.
 */
export function resolveImproveReadSource(
  config: AkmConfig,
  scopedRef: AssetRef | undefined,
  explicitTarget: string | undefined,
  fallbackStashDir?: string,
): ImproveReadSource {
  if (scopedRef?.origin && explicitTarget && scopedRef.origin !== explicitTarget) {
    throw new UsageError(
      `Qualified ref bundle "${scopedRef.origin}" conflicts with --target "${explicitTarget}".`,
      "INVALID_FLAG_VALUE",
      `Drop --target or use --target ${scopedRef.origin}.`,
    );
  }

  const selector = scopedRef?.origin ?? explicitTarget ?? config.defaultWriteTarget;
  if (!selector && fallbackStashDir) {
    return { source: { name: "stash", path: fallbackStashDir } };
  }
  const configuredSelector = selector ?? config.defaultBundle;
  if (configuredSelector) {
    const entry = bundlesToSourceEntries(config)?.find((source) => source.name === configuredSelector);
    if (!entry) {
      throw new UsageError(
        `No source named "${configuredSelector}" is configured. Run \`akm bundle list\` to see available sources.`,
        "INVALID_FLAG_VALUE",
      );
    }
    const sourcePath = resolveEntryContentDir(entry);
    if (!sourcePath) {
      throw new ConfigError(
        `Source "${configuredSelector}" has no resolvable on-disk path; improve cannot inspect this entry.`,
        "INVALID_CONFIG_FILE",
      );
    }
    return { selector: configuredSelector, source: { name: configuredSelector, path: sourcePath } };
  }

  const implicit = resolveSourceEntries(undefined, config)[0];
  if (!implicit) {
    throw new ConfigError("no source configured; run `akm bundle create`", "STASH_DIR_NOT_FOUND");
  }
  return { source: { name: implicit.registryId ?? "stash", path: implicit.path } };
}

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
  const configuredImproveProfile = resolveImproveStrategy(options.strategy, _earlyConfig).config;
  const resolvedPlan =
    options.resolvedPlan ??
    // #800/#957 round 3 — same dry-run exemption as improve-cli.ts's own
    // resolveImprovePlan call: a dry run never dispatches, so a strategy left
    // fully disabled by an unreachable credential must not abort here either.
    resolveImprovePlan(options.strategy, _earlyConfig, {
      repairValidationFailures: options.repairValidationFailures,
      allowAllDisabled: options.dryRun,
    });
  const selectedStrategy = resolvedPlan.strategy;
  const improveSensitiveValues = collectEngineCredentialValues(_earlyConfig);
  const improveProfile = selectedStrategy.config;
  const configuredLimits = {
    ...(options.limit !== undefined ? { cli: options.limit } : {}),
    ...(configuredImproveProfile.limit !== undefined ? { profile: configuredImproveProfile.limit } : {}),
    ...(configuredImproveProfile.processes?.reflect?.limit !== undefined
      ? { reflect: configuredImproveProfile.processes.reflect.limit }
      : {}),
  };
  const effectiveLimit = options.limit ?? improveProfile?.processes?.reflect?.limit ?? improveProfile.limit;
  const scopedRef = scope.mode === "ref" && scope.value ? parseRefInput(scope.value) : undefined;
  const readSource = options.dryRun
    ? options.writeTarget
      ? { selector: options.writeTarget.selector, source: options.writeTarget.source }
      : resolveImproveReadSource(_earlyConfig, scopedRef, options.target, options.stashDir)
    : undefined;
  const writeTarget = options.dryRun
    ? undefined
    : scopedRef?.origin
      ? resolveMutationTarget(_earlyConfig, scopedRef, options.writeTarget?.source.name ?? options.target).target
      : (options.writeTarget ??
        (options.target || _earlyConfig.defaultWriteTarget || !options.stashDir
          ? resolveWriteTarget(_earlyConfig, options.target)
          : {
              source: { kind: "filesystem" as const, name: "stash", path: options.stashDir },
              config: {
                type: "filesystem" as const,
                name: "stash",
                path: options.stashDir,
                writable: true,
              },
            }));
  const selectedSource = writeTarget?.source ?? readSource?.source;
  if (!selectedSource) throw new ConfigError("improve could not resolve a source", "STASH_DIR_NOT_FOUND");
  const selectedSelector = writeTarget?.selector ?? readSource?.selector;
  // Apply profile defaults — CLI flags take precedence over profile defaults.
  // Rebuild options with effective values so all downstream stage functions
  // automatically pick up the profile-driven defaults.
  options = {
    ...options,
    // Pin nested calls and quality gates to the same config snapshot as the
    // invocation plan. They must never reload a changed config mid-run.
    config: _earlyConfig,
    target: selectedSelector,
    sourceName: selectedSource.name,
    ...(writeTarget ? { writeTarget } : {}),
    stashDir: selectedSource.path,
    consolidateOptions: {
      ...options.consolidateOptions,
      target: selectedSelector,
      ...(writeTarget ? { writeTarget } : {}),
    },
    // Profile-level limit, then process-level reflect.limit as fallback.
    // CLI --limit takes precedence over both.
    limit: effectiveLimit,
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
  // triage, indexing, proposal work, maintenance, and final stash sync. Moved
  // out of `$STASH/.akm` to `$STATE/locks/<stash>/` (itlackey/akm#890): a lock
  // file is machine-local coordination state, not content that must travel
  // with the bundle.
  const lockBaseDir = getStashLocksDir(primaryStashDir ?? options.stashDir ?? ".");
  const resolvedLockPath = improveLockPath(lockBaseDir);
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
    configuredImproveProfile,
    configuredLimits,
    effectiveLimit,
    writeTarget,
    options,
    primaryStashDir,
    syncRepoDir,
    resolvedStateDbPath,
    resolvedLockPath,
    effectiveSync,
  };
}

/** The run-setup record every downstream unit receives (inferred shape). */
type ImproveRunSetup = ReturnType<typeof resolveImproveRunSetup>;

/**
 * WI-9.10: build the run's {@link RunContext} purely from values
 * `resolveImproveRunSetup` and the long-lived state.db open already
 * resolved — no second config load, no new db handle. Called once, right
 * after `eventsCtx` is resolved (the last of {config, stashDir, eventsCtx,
 * proposalsCtx, sourceRun, dryRun} to become available in `akmImprove`).
 */
function buildImproveRunContext(run: ImproveRunSetup, eventsCtx: EventsContext): RunContext {
  return createRunContext({
    config: run._earlyConfig,
    // primaryStashDir can fail to resolve (rare); "." mirrors the existing
    // lockBaseDir fallback in resolveImproveRunSetup for the same case. This
    // is a BEST-EFFORT value for the required RunContext field only — the
    // loop stage reads `ImproveLoopState.primaryStashDir` (the honest
    // optional), so its `if (primaryStashDir)` guards still skip on the
    // unresolvable path; no RunContext consumer reads `ctx.stashDir` there.
    stashDir: run.primaryStashDir ?? run.options.stashDir ?? ".",
    eventsCtx,
    // ProposalsContext threads only a dbPath seam (D14: no db handle is
    // threaded in), mirroring eventsCtx's own dbPath-only fallback shape.
    // Not yet wired into any proposal call site this stage — verb-level
    // RunContext adoption (reflect/distill/extract/consolidate) is later.
    proposalsCtx: { dbPath: run.resolvedStateDbPath },
    // Representative symbolic runner for this run: reflect is the loop's
    // primary model-driving process. Credentials remain unresolved here.
    getLlmRunner: () => run.resolvedPlan.processes.reflect.runner,
    sourceRun: run.options.runId ?? `improve-${run.startMs}`,
    // Always false here: callers only reach this point past the dry-run
    // early return in akmImprove.
    dryRun: run.options.dryRun ?? false,
    // Same AbortSignal instance armBudgetWatchdog stamped a live
    // `remainingBudgetMs` getter onto (#616) — identity preserved so
    // `ctx.signal.remainingBudgetMs` resolves correctly for every consumer.
    signal: run.budgetAbortController.signal,
  });
}

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
  indexSnapshot?: ImproveIndexSnapshot;
  memoryCleanupPlan?: ReturnType<typeof analyzeMemoryCleanup>;
  /**
   * Direct lanes that were eligible to run but denied by the autonomy gate.
   * Empty when autonomy is on OR when the lanes were not eligible anyway — the
   * caller turns these into the operator warning and `improve_skipped` event.
   */
  autonomyGatedDirectLanes: AutonomyLane[];
  guidance?: string;
  warnings: string[];
}> {
  const { signal } = args;
  const { scope, options, primaryStashDir, improveProfile, _earlyConfig, ensureIndexFn, collectEligibleRefsImpl } =
    args.run;
  const warnings: string[] = [];
  let plannedRefs: Awaited<ReturnType<typeof collectEligibleRefs>>["plannedRefs"] = [];
  let memorySummary: Awaited<ReturnType<typeof collectEligibleRefs>>["memorySummary"] = { eligible: 0, derived: 0 };
  let strategyFilteredRefs: Awaited<ReturnType<typeof collectEligibleRefs>>["strategyFilteredRefs"] = [];
  let indexSnapshot: ImproveIndexSnapshot | undefined;
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
    indexSnapshot,
  } = await collectEligibleRefsImpl(scope, options.stashDir, improveProfile, _earlyConfig));
  const cleanupParentRef = memoryCleanupParentRef(scope, options.stashDir);

  // D8 — the two direct lanes share one eligibility predicate, which reads scope
  // and eligible-memory count and no strategy flag at all. Compute it once: it
  // decides whether each lane would have run, which is also what decides whether
  // a gated lane is worth REPORTING. A lane that was never eligible was not
  // suppressed by the gate, so claiming it was would be noise.
  const cleanupEligible = shouldAnalyzeMemoryCleanup(scope, memorySummary.eligible, primaryStashDir);
  // Cleanup remains independent of the disabled contradiction writer.
  const memoryCleanupPlan = cleanupEligible
    ? analyzeMemoryCleanup(primaryStashDir as string, cleanupParentRef ? { parentRef: cleanupParentRef } : undefined)
    : undefined;
  const cleanupWouldMutate = Boolean(
    memoryCleanupPlan &&
      (memoryCleanupPlan.pruneCandidates.length > 0 ||
        memoryCleanupPlan.beliefStateTransitions.length > 0 ||
        memoryCleanupPlan.relativeDateCandidates.length > 0),
  );
  const autonomyGatedDirectLanes: AutonomyLane[] =
    cleanupWouldMutate && !isAutonomyLaneAllowed("memoryCleanup", _earlyConfig) ? ["memoryCleanup"] : [];
  const guidance =
    memorySummary.eligible > 0
      ? "Improve folds memory cleanup into the same proposal queue: speculative promotions still go through reflect/distill proposals, while high-confidence redundant derived memories are moved into a recoverable cleanup archive instead of being left active in the stash."
      : undefined;
  return {
    plannedRefs,
    memorySummary,
    strategyFilteredRefs: strategyFilteredRefs ?? [],
    indexSnapshot,
    memoryCleanupPlan,
    autonomyGatedDirectLanes,
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

/** Evaluate the real selectors on read-only state, stopping before every writer boundary. */
async function runDryPlanningStage(args: {
  run: ImproveRunSetup;
  collected: Awaited<ReturnType<typeof indexAndCollect>>;
  resolvedStateDbPath: string;
  budgetMs: number;
  initialCleanupWarnings: string[];
  signal: AbortSignal;
}): Promise<AkmImproveResult> {
  const { run, collected, resolvedStateDbPath, budgetMs, initialCleanupWarnings, signal } = args;
  let stateDb: import("../../storage/database").Database | undefined;
  let stateSnapshotUnavailable = false;
  try {
    try {
      stateDb = openSqliteReadSnapshot(resolvedStateDbPath);
      stateSnapshotUnavailable = !stateDb;
    } catch (error) {
      if (!(error instanceof SqliteReadSnapshotUnavailableError)) throw error;
      stateSnapshotUnavailable = true;
    }
    const eventsCtx: EventsContext = {
      ...(stateDb ? { db: stateDb } : { dbPath: resolvedStateDbPath }),
      readOnly: true,
      ...(stateSnapshotUnavailable ? { readOnlySnapshotUnavailable: true } : {}),
    };
    const preparation = await run.runImprovePreparationStageImpl({
      scope: run.scope,
      options: run.options,
      plannedRefs: collected.plannedRefs,
      memoryCleanupPlan: collected.memoryCleanupPlan,
      primaryStashDir: run.primaryStashDir,
      memorySummary: collected.memorySummary,
      reindexFn: run.reindexFn,
      startMs: run.startMs,
      budgetMs,
      eventsCtx,
      initialCleanupWarnings,
      improveProfile: run.improveProfile,
      resolvedPlan: run.resolvedPlan,
      strategyName: run.selectedStrategy.name,
      budgetSignal: signal,
      planOnly: true,
    });
    return buildDryRunResult(run, collected, preparation);
  } finally {
    stateDb?.close();
  }
}

/** The P3 dry-run envelope (plan-only early return). Exported for unit tests. */
export function buildDryRunResult(
  run: ImproveRunSetup,
  collected: Awaited<ReturnType<typeof indexAndCollect>>,
  preparation?: ImprovePreparationResult,
): AkmImproveResult {
  const { selectedStrategy, scope } = run;
  const { guidance, memorySummary, memoryCleanupPlan, plannedRefs, strategyFilteredRefs } = collected;
  const effectiveRefs = preparation?.loopRefs ?? plannedRefs;
  const notices = collectImproveNotices({ resolvedPlan: run.resolvedPlan });
  return {
    schemaVersion: 2,
    ok: true,
    strategy: selectedStrategy.name,
    scope,
    dryRun: true,
    ...(notices.length > 0 ? { notices } : {}),
    ...(guidance ? { guidance } : {}),
    memorySummary,
    ...(memoryCleanupPlan ? { memoryCleanup: shapeMemoryCleanup(memoryCleanupPlan) } : {}),
    plannedRefs: effectiveRefs,
    ...(preparation?.planning
      ? {
          plan: buildResultExecutionPlan(
            run,
            preparation,
            plannedRefs,
            strategyFilteredRefs,
            collected.indexSnapshot,
            true,
          ),
        }
      : {}),
    ...(strategyFilteredRefs.length > 0 ? { strategyFilteredRefs } : {}),
    ...(run.resolvedPlan.engineUnavailable.length > 0 ? { skippedProcesses: run.resolvedPlan.engineUnavailable } : {}),
    ...(preparation?.proactiveMaintenance ? { proactiveMaintenance: preparation.proactiveMaintenance } : {}),
  };
}

/** One public plan projection for the dry and live result assemblers. */
function buildResultExecutionPlan(
  run: ImproveRunSetup,
  preparation: ImprovePreparationResult,
  rawProfileEligibleRefs: readonly ImproveEligibleRef[],
  strategyFilteredRefs: readonly ImproveEligibleRef[],
  indexSnapshot: ImproveIndexSnapshot | undefined,
  dryRun: boolean,
) {
  const { improveProfile, configuredImproveProfile, resolvedPlan, configuredLimits, effectiveLimit, scope } = run;
  const triageConfig = improveProfile.processes?.triage;
  const configuredTriage = configuredImproveProfile.processes?.triage;
  const configuredProactive = configuredImproveProfile.processes?.proactiveMaintenance;
  const configuredConsolidation = configuredImproveProfile.processes?.consolidate;
  const triageEnabled = scope.mode !== "ref" && resolvedPlan.processes.triage.enabled;
  const distillOnlySet = new Set(preparation.distillOnlyRefs.map((entry) => entry.ref));
  const inferenceMinPending = improveProfile.processes?.memoryInference?.minPendingCount;
  const pendingMemories =
    run.primaryStashDir && inferenceMinPending !== undefined && inferenceMinPending > 0
      ? collectPendingMemories(run.primaryStashDir).length
      : undefined;
  const memoryInferenceEnabled =
    resolvedPlan.processes.memoryInference.enabled &&
    !(pendingMemories !== undefined && inferenceMinPending !== undefined && pendingMemories < inferenceMinPending);
  const graphExtractionEnabled = resolvedPlan.processes.graphExtraction.enabled && run.primaryStashDir !== undefined;
  const profileGate = {
    name: "profile" as const,
    removed: strategyFilteredRefs.length,
    reason: "all enabled per-ref processes refuse the asset type",
  };
  // #947 — per-process resolved engine/model/notices, plus how many of this
  // run's effective refs each ref-scoped process (reflect/distill/consolidate)
  // would act on. Counts only (not a per-ref matrix) to bound result_json size.
  const REF_SCOPED_PROCESSES = new Set(["reflect", "distill", "consolidate"]);
  const processes = projectResolvedProcessRouting(resolvedPlan).map((row) => {
    if (!REF_SCOPED_PROCESSES.has(row.process)) return row;
    const eligibleRefs = preparation.loopRefs.filter(
      (entry) =>
        !shouldSkipRef(entry.ref, row.process as "reflect" | "distill" | "consolidate", resolvedPlan.strategy.config)
          .skip,
    ).length;
    return { ...row, eligibleRefs };
  });
  const proactive = preparation.planning.proactive
    ? {
        ...preparation.planning.proactive,
        configured: {
          ...(configuredProactive?.dueDays !== undefined ? { dueDays: configuredProactive.dueDays } : {}),
          ...(configuredProactive?.maxPerRun !== undefined ? { maxPerRun: configuredProactive.maxPerRun } : {}),
          ...(configuredProactive?.limit !== undefined ? { limit: configuredProactive.limit } : {}),
        },
      }
    : undefined;
  const consolidation = {
    ...preparation.planning.consolidation,
    configured: {
      ...(configuredConsolidation?.enabled !== undefined ? { enabled: configuredConsolidation.enabled } : {}),
      ...(configuredConsolidation?.minPoolSize !== undefined
        ? { minPoolSize: configuredConsolidation.minPoolSize }
        : {}),
      ...(configuredConsolidation?.limit !== undefined ? { limit: configuredConsolidation.limit } : {}),
      ...(configuredConsolidation?.maxChunkSize !== undefined
        ? { maxChunkSize: configuredConsolidation.maxChunkSize }
        : {}),
      ...(configuredConsolidation?.incrementalSince !== undefined
        ? { incrementalSince: configuredConsolidation.incrementalSince }
        : {}),
    },
  };
  return buildImproveExecutionPlan({
    dryRun,
    snapshot: indexSnapshot ?? {
      status: "unknown",
      reason: "the injected selector did not report an index snapshot status",
    },
    rawInScope: rawProfileEligibleRefs.length + strategyFilteredRefs.length,
    selectedRefs: preparation.actionableRefs,
    effectiveRefs: preparation.loopRefs,
    distillOnlyRefs: distillOnlySet,
    configuredLimits,
    effectiveLimit,
    replayBudget: preparation.planning.replayBudget,
    gates: [profileGate, ...preparation.planning.gates],
    processes,
    ...(proactive ? { proactive } : {}),
    consolidation,
    stageConfig: {
      extract: {
        enabled: preparation.planning.extract.wouldRun,
        reason: preparation.planning.extract.reason,
      },
      graphExtraction: {
        enabled: graphExtractionEnabled,
        reason: !resolvedPlan.processes.graphExtraction.enabled
          ? "disabled"
          : graphExtractionEnabled
            ? improveProfile.processes?.graphExtraction?.fullScan === true
              ? "enabled for a full-corpus scan"
              : "enabled for refs touched by this run"
            : "enabled but no primary source is available",
      },
      memoryInference: {
        enabled: memoryInferenceEnabled,
        reason: !resolvedPlan.processes.memoryInference.enabled
          ? "disabled"
          : !memoryInferenceEnabled
            ? `${pendingMemories ?? 0} pending memories is below minPendingCount ${inferenceMinPending}`
            : "enabled; the pass discovers pending memories independently of selected refs",
      },
    },
    triage: {
      enabled: triageEnabled,
      configuredMode: configuredTriage?.applyMode ?? "queue",
      mode: triageConfig?.applyMode ?? "queue",
      maxAcceptsPerRun: configuredTriage?.maxAcceptsPerRun ?? 25,
      ...(configuredTriage?.maxDiffLines !== undefined ? { maxDiffLines: configuredTriage.maxDiffLines } : {}),
    },
  });
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

/** A path is never staged by auto-sync when it is (or looks like) a lock file. */
function isSyncExcludedPath(relativePath: string): boolean {
  return path.basename(relativePath).includes(".lock");
}

/**
 * Resolve the EXACT repo-relative path set the auto-sync commit stages (#652).
 *
 * Precedence:
 *
 *   1. **Run-scoped write provenance** (`writtenPaths`, absolute) — the paths
 *      this run actually wrote, created, or removed, intersected with the paths
 *      Git currently reports as changed. The intersection is what makes the set
 *      correct rather than merely plausible: it drops a journaled path whose
 *      final bytes match HEAD (nothing to commit), a journaled path that was
 *      created and then removed again (never existed for Git), and any journaled
 *      path Git ignores (which `saveGitStash` would otherwise reject outright).
 *      A journaled path that was ALREADY dirty when the run started stays IN —
 *      this run rewrote it, so this run owns it.
 *   2. **Dirty-path diff** (pre-#652 behaviour) — only when no journal was open,
 *      which a live run never hits. Kept as the defensive fallback so a future
 *      caller that commits outside the journal window degrades to the previous,
 *      battle-tested heuristic instead of silently committing nothing.
 *
 * `unattributed` counts in-scope paths that became dirty DURING the run without
 * this run writing them: concurrent human edits (correctly excluded) and, if the
 * number is ever surprising, the fingerprint of a missing journal call site.
 */
export function resolveSyncPathSet(input: {
  repoDir: string;
  assetPrefix: string;
  changedPaths: readonly string[];
  initialPaths: ReadonlySet<string>;
  writtenPaths: readonly string[];
  provenance: boolean;
}): { paths: string[]; unattributed: string[] } {
  const { repoDir, assetPrefix, changedPaths, initialPaths, writtenPaths, provenance } = input;
  const inScope = (relativePath: string): boolean =>
    !isSyncExcludedPath(relativePath) &&
    (!assetPrefix || relativePath === assetPrefix || relativePath.startsWith(`${assetPrefix}/`));

  if (!provenance) {
    return { paths: changedPaths.filter((p) => !initialPaths.has(p) && inScope(p)), unattributed: [] };
  }

  const changed = new Set(changedPaths);
  const attributed = new Set<string>();
  for (const absolutePath of writtenPaths) {
    const relativePath = relativeWrittenPath(repoDir, absolutePath);
    if (!relativePath || !changed.has(relativePath) || !inScope(relativePath)) continue;
    attributed.add(relativePath);
  }
  return {
    paths: [...attributed].sort(),
    unattributed: changedPaths.filter((p) => !attributed.has(p) && !initialPaths.has(p) && inScope(p)).sort(),
  };
}

/**
 * Crash-safe / incremental stash sync (#662) — see the factory-returned
 * closure's original doc block: the primary stash writes as a filesystem
 * source DURING the run; this commits them at end-of-run AND from the catch
 * path. Idempotent + NON-FATAL. `getEventsCtx`/`getInitialGitPaths`/
 * `getWriteJournal` are getters because those outer bindings are (re)assigned
 * after this factory runs — the returned closure must observe the live values.
 */
function makeCommitStashBatch(deps: {
  run: ImproveRunSetup;
  getInitialGitPaths: () => Set<string>;
  getWriteJournal: () => WriteProvenanceJournal | undefined;
  getEventsCtx: () => EventsContext;
}): (messageContext: Parameters<typeof renderSyncCommitMessage>[1]) => AkmImproveResult["sync"] | undefined {
  const { writeTarget, primaryStashDir, effectiveSync, options, _earlyConfig, improveProfile } = deps.run;
  return (messageContext) => {
    const eventsCtx = deps.getEventsCtx();
    const initialGitPaths = deps.getInitialGitPaths();
    const writeJournal = deps.getWriteJournal();
    const repoDir = writeTarget?.source.repoPath ?? primaryStashDir;
    if (!primaryStashDir || !repoDir || effectiveSync.enabled === false || !isGitBackedStash(repoDir)) {
      return undefined;
    }
    const saveGitStashFn = options.saveGitStashFn ?? saveGitStash;
    const writableOverride = writeTarget ? resolveWritable(writeTarget.config) : resolveWritableOverride(_earlyConfig);
    const push = options.sync?.push ?? improveProfile.sync?.push ?? true;
    const message = renderSyncCommitMessage(
      effectiveSync.message ?? "akm improve auto-sync",
      messageContext,
      Date.now(),
    );
    try {
      const assetRoot = writeTarget?.source.path ?? primaryStashDir;
      const assetPrefix = assetRoot ? path.relative(repoDir, assetRoot).replaceAll(path.sep, "/") : "";
      const { paths, unattributed } = resolveSyncPathSet({
        repoDir,
        assetPrefix,
        changedPaths: listGitChangedPaths(repoDir),
        initialPaths: initialGitPaths,
        writtenPaths: writeJournal?.writtenPaths() ?? [],
        provenance: writeJournal !== undefined,
      });
      if (unattributed.length > 0) {
        warnVerbose(
          `[improve] auto-sync left ${unattributed.length} path(s) uncommitted — not written by this run: ${unattributed.join(", ")}`,
        );
      }
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
            // #652 provenance audit trail: how many paths this run staged, and
            // how many in-scope paths went dirty during the run that it did NOT
            // write (concurrent edits — deliberately left for their author).
            attributed: paths.length,
            unattributed: unattributed.length,
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
  improveProfile: import("../../core/config/config").ImproveProfileConfig,
): ImprovePreparationResult["loopRefs"] {
  // Re-read cooldown timestamps immediately before execution so external
  // proposal writes that occurred before this run acquired its lock are visible.
  const proactiveLoopRefs = loopRefs.filter((r) => r.eligibilitySource === "proactive");
  let postLockLoopRefs = loopRefs;
  if (proactiveLoopRefs.length > 0) {
    const proactiveRefStrs = proactiveLoopRefs.map((r) => r.ref);
    // Correlate proposal timestamps on each candidate's durable key.
    const proactiveItemRefByRef = new Map(proactiveLoopRefs.map((r) => [r.ref, r.itemRef] as const));
    const freshReflectTs = buildLatestProposalTsMap(proactiveRefStrs, "reflect", proactiveItemRefByRef);
    const freshDistillTs = buildLatestProposalTsMap(proactiveRefStrs, "distill", proactiveItemRefByRef);
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
 * Post-loop stage, or a no-op skip when the shared wall-clock budget is
 * already exhausted. The result still finalizes normally on skip, so
 * scheduled budget exhaustion exits 0 (extracted verbatim from
 * `runImproveStageSequence` — fn-size decomposition, no logic change).
 */
async function runPostLoopStageOrSkip(args: {
  budgetAbortController: AbortController;
  scope: ImproveScope;
  options: AkmImproveOptions;
  primaryStashDir?: string;
  preparation: ImprovePreparationResult;
  memoryRefsForInference: Set<string>;
  reindexFn: (options: { stashDir: string; signal?: AbortSignal }) => Promise<unknown>;
  eventsCtx: EventsContext;
  improveProfile: import("../../core/config/config").ImproveProfileConfig;
  resolvedPlan: ResolvedImprovePlan;
  runImprovePostLoopStageImpl: typeof runImprovePostLoopStage;
}): Promise<ImprovePostLoopResult> {
  const {
    budgetAbortController,
    scope,
    options,
    primaryStashDir,
    preparation,
    memoryRefsForInference,
    reindexFn,
    eventsCtx,
    improveProfile,
    resolvedPlan,
    runImprovePostLoopStageImpl,
  } = args;
  // Do not start new post-loop work after the shared wall-clock budget. The
  // result still finalizes normally, so scheduled budget exhaustion exits 0.
  const emptyPostLoopResult: ImprovePostLoopResult = {
    allWarnings: [],
    memoryInferenceDurationMs: 0,
    graphExtractionDurationMs: 0,
  };
  const remainingBudget = (budgetAbortController.signal as { remainingBudgetMs?: number }).remainingBudgetMs;
  if (budgetAbortController.signal.aborted || (remainingBudget !== undefined && remainingBudget <= 0)) {
    info("[improve] post-loop maintenance skipped (wall-clock budget exhausted)");
    return emptyPostLoopResult;
  }
  return runImprovePostLoopStageImpl({
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
    // R5: floor violations from this run's consolidate pass, for the collapse
    // detector's merge-floor advisory.
    consolidationMergeFloorViolations: preparation.consolidation.mergeFloorViolations ?? 0,
  });
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
  /** Direct lanes the autonomy gate denied on this run (see indexAndCollect). */
  autonomyGatedDirectLanes: AutonomyLane[];
  memorySummary: { eligible: number; derived: number };
  preEnsureCleanupWarnings: string[];
  eventsCtx: EventsContext;
  /** WI-9.10: the run's RunContext, threaded only to the loop stage so far. */
  ctx: RunContext;
}) {
  const {
    strategyFilteredRefs,
    plannedRefs,
    memoryCleanupPlan,
    memorySummary,
    preEnsureCleanupWarnings,
    eventsCtx,
    ctx,
  } = args;
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

  // D8 — one event per lane the autonomy gate downgraded, naming the lane AND
  // the config key that would enable it. This is the difference between a gate
  // and a silent no-op: whatever the user would have seen happen, they now see
  // explained. `health` already aggregates `improve_skipped` by reason
  // (buildImproveSkipSummary), so these surface there without new machinery.
  for (const lane of [...args.run.resolvedPlan.autonomyGated, ...describeGatedLanes(args.autonomyGatedDirectLanes)]) {
    warn(`[improve] ${lane.lane} skipped — it ${lane.reason}. Set \`${lane.configKey}: true\` to enable it.`);
    appendEvent(
      {
        eventType: "improve_skipped",
        ref: undefined,
        metadata: {
          strategy: selectedStrategy.name,
          reason: "autonomy_gated",
          lane: lane.lane,
          configKey: lane.configKey,
        },
      },
      eventsCtx,
    );
  }

  for (const item of resolvedPlan.engineUnavailable) {
    warn(`[improve] ${item.process} skipped — it ${item.reason}.`);
    appendEvent(
      {
        eventType: "improve_skipped",
        ref: undefined,
        metadata: {
          strategy: selectedStrategy.name,
          reason: "engine_unavailable",
          process: item.process,
          configKey: item.configKey,
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
  let reflectsWithErrorContext = 0;
  let memoryInferenceDurationMs = 0;
  let graphExtractionDurationMs = 0;
  let orphansPurged: number | undefined;
  let proposalsExpired: number | undefined;
  // Concatenated arrays.
  const allWarnings: string[] = [];
  let deadUrls: ImprovePostLoopResult["deadUrls"];
  let deadUrlCoverage: ImprovePostLoopResult["deadUrlCoverage"];
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

    const rejectedProposalsByRef = preloadRejectedProposals();

    const runLoop = () => {
      const postLockLoopRefs = refilterProactiveLoopRefs(preparation.loopRefs, improveProfile);

      return runImproveLoopStageImpl({
        ctx,
        primaryStashDir,
        scope,
        options,
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
        improveProfile,
        resolvedPlan,
      });
    };
    const loopResult = await runLoop();
    reflectsWithErrorContext += loopResult.reflectsWithErrorContext;
    memoryRefsForInference = loopResult.memoryRefsForInference;

    // #551: consolidation now runs in the preparation stage (before extract);
    // its result and run-flag are read from `preparation`, not the post-loop.
    consolidation = preparation.consolidation;

    const postLoopResult = await runPostLoopStageOrSkip({
      budgetAbortController,
      scope,
      options,
      primaryStashDir,
      preparation,
      memoryRefsForInference,
      reindexFn,
      eventsCtx,
      improveProfile,
      resolvedPlan,
      runImprovePostLoopStageImpl,
    });
    // Result objects (single pass — no cycle accumulation).
    memoryInference = postLoopResult.memoryInference;
    graphExtraction = postLoopResult.graphExtraction;
    if (postLoopResult.cycleMetrics) cycleMetrics = postLoopResult.cycleMetrics;
    // Summed counters/durations.
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
    if (postLoopResult.deadUrlCoverage !== undefined) {
      deadUrlCoverage = postLoopResult.deadUrlCoverage;
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
    reflectsWithErrorContext,
    memoryInferenceDurationMs,
    graphExtractionDurationMs,
    orphansPurged,
    proposalsExpired,
    allWarnings,
    deadUrls,
    deadUrlCoverage,
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
  rawPlannedRefs: Awaited<ReturnType<typeof collectEligibleRefs>>["plannedRefs"];
  indexSnapshot?: ImproveIndexSnapshot;
  triageDrain?: DrainResult;
  eventsCtx: EventsContext;
}): AkmImproveResult {
  const {
    guidance,
    memorySummary,
    memoryCleanupPlan,
    strategyFilteredRefs,
    rawPlannedRefs,
    indexSnapshot,
    triageDrain,
    eventsCtx,
  } = args;
  const { selectedStrategy, scope, options, primaryStashDir, startMs, resolvedPlan } = args.run;
  const {
    preparation,
    consolidation,
    memoryInference,
    graphExtraction,
    cycleMetrics,
    reflectsWithErrorContext,
    memoryInferenceDurationMs,
    graphExtractionDurationMs,
    orphansPurged,
    proposalsExpired,
    allWarnings,
    deadUrls,
    deadUrlCoverage,
    finalActions,
  } = args.seq;
  // C1 (13-bus-factor): fold the per-ref `distill-skipped` rows (~13k/run,
  // ~91% of result_json bytes) into a bounded aggregate BEFORE persistence.
  // The metric total + per-reason breakdown are preserved on `distillSkipped`;
  // the unbounded row list never reaches result_json. Reflect skip counters
  // below still read `finalActions` (reflect skips are not folded).
  const { actions: persistedActions, aggregate: distillSkippedAggregate } = foldDistillSkipped(finalActions);
  // #944 — this run's LLM call/token accounting, split by process x engine x
  // model, plus which enabled processes made zero calls and why. `llm_usage`
  // events carry no runId column, so bound the read to this run's own wall
  // clock — the same per-run event-scoping technique `health/windows.ts`
  // already uses for wall time. `until` is "now" (assembly happens at
  // teardown, after every LLM call this run will make has already emitted
  // its event).
  const usageEvents = readEvents({ since: new Date(startMs).toISOString(), type: LLM_USAGE_EVENT }, eventsCtx).events;
  const usageReport = buildImproveUsageReport({
    resolvedPlan,
    byProcessEngineModel: summarizeLlmUsageCrossTab(usageEvents),
    strategyFilteredRefsCount: strategyFilteredRefs.length,
    loopRefs: preparation.loopRefs,
    persistedActions,
    distillSkippedAggregate,
  });
  const notices = collectImproveNotices({
    resolvedPlan: args.run.resolvedPlan,
    actions: finalActions,
    schemaRepairs: preparation.schemaRepairs,
    consolidation,
    extract: preparation.extract,
    memoryInference,
    graphExtraction,
    triageDrain,
  });

  const result: AkmImproveResult = {
    schemaVersion: 2,
    ok: true,
    strategy: selectedStrategy.name,
    scope,
    dryRun: false,
    ...(notices.length > 0 ? { notices } : {}),
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
    plannedRefs: preparation.loopRefs,
    ...(preparation.planning
      ? {
          plan: buildResultExecutionPlan(
            args.run,
            preparation,
            rawPlannedRefs,
            strategyFilteredRefs,
            indexSnapshot,
            false,
          ),
        }
      : {}),
    ...(strategyFilteredRefs.length > 0 ? { strategyFilteredRefs } : {}),
    ...(resolvedPlan.engineUnavailable.length > 0 ? { skippedProcesses: resolvedPlan.engineUnavailable } : {}),
    ...(usageReport ? { usageReport } : {}),
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
    // Present whenever the check ran, unlike `deadUrls` above — a clean run
    // (zero dead links) still needs to tell the health report how much of
    // the bundle it actually covered (#892).
    ...(deadUrlCoverage !== undefined ? { deadUrlCoverage } : {}),
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
    ...(triageDrain
      ? {
          triage: {
            promoted: triageDrain.promoted.length,
            rejected: triageDrain.rejected.length,
            deferred: triageDrain.deferred.length,
            failed: triageDrain.failed.length,
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

interface LoweringNoticeCarrier {
  notices?: readonly Readonly<LoweringNotice>[];
}

function collectImproveNotices(args: {
  resolvedPlan: ResolvedImprovePlan;
  actions?: readonly ImproveActionResult[];
  schemaRepairs?: readonly object[];
  consolidation?: object;
  extract?: readonly { sessions?: readonly object[] }[];
  memoryInference?: object;
  graphExtraction?: object;
  triageDrain?: object;
}): readonly Readonly<LoweringNotice>[] {
  const byKey = new Map<string, Readonly<LoweringNotice>>();
  const collect = (carrier: unknown): void => {
    if (typeof carrier !== "object" || carrier === null) return;
    const notices = (carrier as LoweringNoticeCarrier).notices;
    if (!Array.isArray(notices)) return;
    for (const notice of notices) byKey.set(JSON.stringify(notice), notice);
  };

  for (const process of Object.values(args.resolvedPlan.processes)) collect(process);
  for (const notice of args.resolvedPlan.triageJudgmentNotices ?? []) {
    byKey.set(JSON.stringify(notice), notice);
  }
  for (const action of args.actions ?? []) collect(action.result as LoweringNoticeCarrier);
  for (const repair of args.schemaRepairs ?? []) collect(repair);
  collect(args.consolidation);
  for (const extract of args.extract ?? []) {
    collect(extract);
    for (const session of extract.sessions ?? []) collect(session);
  }
  collect(args.memoryInference);
  collect(args.graphExtraction);
  collect(args.triageDrain);
  return Object.freeze([...byKey.values()]);
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
        deadUrlsChecked: result.deadUrlCoverage?.checked ?? 0,
        deadUrlsTotal: result.deadUrlCoverage?.total ?? 0,
        deadUrlsSkipped: result.deadUrlCoverage?.skipped ?? 0,
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
