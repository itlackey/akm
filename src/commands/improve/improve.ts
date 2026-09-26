// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm improve`: under one run lock, bootstrap the index, drain the proposal
 * backlog (triage), select candidates, run preparation → loop → post-loop, then
 * commit what the run wrote (auto-sync). A dry run plans on read-only state.
 */

import fs from "node:fs";
import path from "node:path";
import { type AssetRef, parseRefInput } from "../../core/asset/resolve-ref";
import {
  type AkmConfig,
  bundlesToSourceEntries,
  type ImproveProfileConfig,
  loadConfig,
} from "../../core/config/config";
import { ConfigError, rethrowIfTestIsolationError, UsageError } from "../../core/errors";
import { appendEvent, type EventsContext, readEvents } from "../../core/events";
import type { LockOwnership } from "../../core/file-lock";
import type {
  AkmImproveResult,
  ImproveActionMode,
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
import { ensureIndex } from "../../indexer/ensure-index";
import { indexWrittenAssets } from "../../indexer/index-written-assets";
import { akmIndex } from "../../indexer/indexer";
import { collectPendingMemories } from "../../indexer/passes/memory-inference";
import { resolveEntryContentDir, resolveSourceEntries } from "../../indexer/search/search-source";
import { collectEngineCredentialValues } from "../../integrations/agent/engine-resolution";
import { installLlmUsagePersistence, LLM_USAGE_EVENT } from "../../llm/usage-persist";
import { withLlmStage } from "../../llm/usage-telemetry";
import {
  isGitBackedStash,
  listGitChangedPaths,
  resolveWritableOverride,
  saveGitStash,
} from "../../sources/providers/git";
import type { Database } from "../../storage/database";
import { closeDatabase, openExistingDatabase } from "../../storage/repositories/index-connection";
import { getEntryCount } from "../../storage/repositories/index-entries-repository";
import { openSqliteReadSnapshot, SqliteReadSnapshotUnavailableError } from "../../storage/sqlite-read-snapshot";
import { summarizeLlmUsageCrossTab } from "../health/llm-usage";
import { type DrainResult, drainProposals } from "../proposal/drain";
import type { EligibilitySource } from "../proposal/proposal-types";
import { type AutonomyLane, describeGatedLanes, isAutonomyLaneAllowed } from "./autonomy-gate";
import { akmDistill } from "./distill";
import {
  collectEligibleRefs,
  collectEligibleRefsReadOnly,
  memoryCleanupParentRef,
  resolveImproveScope,
  shouldAnalyzeMemoryCleanup,
} from "./eligibility";
import type {
  AkmImproveOptions,
  ImprovePostLoopResult,
  ImprovePreparationResult,
  ImproveScope,
} from "./improve-run-types";
import {
  eligibleRefCount,
  projectResolvedProcessRouting,
  resolveImprovePlan,
  resolveImproveStrategy,
} from "./improve-strategies";
import { buildImproveUsageReport } from "./improve-usage-report";
import { lastAttemptByRef, loadLedgerSnapshot } from "./ledger";
import { improveLockPath, releaseImproveLock, tryAcquireImproveLock } from "./locks";
import { runImproveLoopStage, runImprovePostLoopStage } from "./loop-stages";
import { analyzeMemoryCleanup, type MemoryCleanupPlan } from "./memory/memory-improve";
import { buildImproveExecutionPlan } from "./planner";
import { CONSOLIDATION_CONFIG_KEYS, pickDefined, recordImproveSkip, runImprovePreparationStage } from "./preparation";
import { DEFAULT_DUE_DAYS, filterProactiveDue } from "./proactive-maintenance";
import { akmReflect } from "./reflect";
import { errMessage, type Notice, noticeSet } from "./stage";

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

/**
 * How long the loop waits for its first engine response before printing one
 * "still waiting" line (#957): a dead endpoint otherwise looks like a slow run.
 * Armed when the loop starts, not at run start.
 */
export const FIRST_ENGINE_RESPONSE_HEARTBEAT_MS = 5_000;

/**
 * Abort the run at the budget; force-exit (0 — budget exhaustion is a normal
 * scheduled-task outcome) only if the drain overruns the grace period.
 * Returns an idempotent disposer.
 */
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
    controller.abort("improve budget exhausted");
    hardKillTimer = setTimeoutFn(() => exitFn(0), hardKillGraceMs);
    hardKillTimer.unref?.();
  }, budgetMs);
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
  const { budgetMs, budgetAbortController, scope, selectedStrategy, syncRepoDir, resolvedStateDbPath } = setup;
  let clearBudgetTimer = (): void => {};
  let clearFirstResponseHeartbeat = (): void => {};
  // Set by the usage sink when any engine call terminates, prepass included.
  let firstEngineResponseSeen = false;
  let initialGitPaths = new Set<string>();
  // The write-provenance journal (#652) spans exactly the window this run holds the lock.
  let journal: WriteProvenanceJournal | undefined;
  const closeJournal = () => {
    journal?.end();
    journal = undefined;
  };

  const preEnsureCleanupWarnings: string[] = [];
  let collected!: Awaited<ReturnType<typeof indexAndCollect>>;
  let triageDrain: DrainResult | undefined;
  let ensureIndexDurationMs: number | undefined;
  let improveLockOwnership: LockOwnership | undefined;
  let exitBackstop: (() => void) | undefined;
  let eventsDb: Database | undefined;
  // Boundary-pinned for the prepass; replaced by the long-lived handle after it.
  // The usage sink resolves it per append.
  let eventsCtx: EventsContext = { dbPath: resolvedStateDbPath };
  let disposeLlmUsageSink = (): void => {};
  const releaseRunLock = (): void => {
    const ownership = improveLockOwnership;
    if (!ownership) return;
    improveLockOwnership = undefined;
    try {
      releaseImproveLock(ownership);
    } catch {
      // Best-effort; exact ownership never deletes a successor's lock.
    }
  };
  const teardown = () => {
    // The usage sink goes before eventsDb closes; the journal closes after the
    // crash-safety commit that still needs it.
    disposeLlmUsageSink();
    clearFirstResponseHeartbeat();
    clearBudgetTimer();
    if (exitBackstop) {
      // Only our own listener: removeAllListeners would drop the host's.
      process.removeListener("exit", exitBackstop);
      exitBackstop = undefined;
    }
    releaseRunLock();
    closeJournal();
  };
  const commitStashBatch = makeCommitStashBatch({
    run: setup,
    getInitialGitPaths: () => initialGitPaths,
    getWriteJournal: () => journal,
    getEventsCtx: () => eventsCtx,
  });

  if (!options.dryRun) {
    const remainingBudget = (budgetAbortController.signal as { remainingBudgetMs?: number }).remainingBudgetMs;
    clearBudgetTimer = armBudgetWatchdog(Math.max(1, remainingBudget ?? budgetMs), budgetAbortController);
  }

  try {
    if (!options.dryRun) {
      const acquisition = tryAcquireImproveLock(setup.resolvedLockPath, options.skipIfLocked, {
        dbPath: resolvedStateDbPath,
      });
      if (acquisition.state === "skipped") {
        clearBudgetTimer();
        return buildLockSkippedResult(selectedStrategy.name, scope, options.runId);
      }
      improveLockOwnership = acquisition.ownership;
      disposeLlmUsageSink = installLlmUsagePersistence(
        () => eventsCtx,
        () => {
          firstEngineResponseSeen = true;
          clearFirstResponseHeartbeat();
        },
      );
      exitBackstop = releaseRunLock;
      process.on("exit", exitBackstop);
      initialGitPaths =
        syncRepoDir && isGitBackedStash(syncRepoDir) ? new Set(listGitChangedPaths(syncRepoDir)) : new Set<string>();
      journal = beginWriteProvenance();

      // The index is made current BEFORE triage (R6): triage promotes into the
      // stash, and a reindex after it would always find fresh work.
      const bootstrap = await runIndexBootstrapPass(setup, budgetAbortController.signal);
      preEnsureCleanupWarnings.push(...bootstrap.warnings);
      ensureIndexDurationMs = bootstrap.ensureIndexDurationMs;
      triageDrain = await runTriagePrePass(setup);
      // Index triage's own writes incrementally so selection sees them.
      const triageWrittenPaths = journal?.writtenPaths() ?? [];
      if (setup.primaryStashDir && triageWrittenPaths.length > 0) {
        await indexWrittenAssets(setup.primaryStashDir, triageWrittenPaths);
      }
    }

    collected = await indexAndCollect(setup);
    if (options.dryRun) {
      const result = await runDryPlanningStage(setup, collected, preEnsureCleanupWarnings);
      clearBudgetTimer();
      return result;
    }
  } catch (err) {
    teardown();
    throw err;
  }

  try {
    try {
      eventsDb = openStateDatabase(resolvedStateDbPath);
      eventsCtx = { db: eventsDb };
    } catch (err) {
      rethrowIfTestIsolationError(err);
    }
    if (!firstEngineResponseSeen) {
      const firstResponseTimer = setTimeout(() => {
        warn("[improve] Still waiting for the first engine response...");
      }, FIRST_ENGINE_RESPONSE_HEARTBEAT_MS);
      firstResponseTimer.unref?.();
      clearFirstResponseHeartbeat = () => clearTimeout(firstResponseTimer);
    }

    const seq = await runImproveStageSequence(setup, collected, preEnsureCleanupWarnings, eventsCtx);
    const result = finalizeImproveResult({ run: setup, seq, collected, triageDrain, ensureIndexDurationMs, eventsCtx });
    // The run's write provenance goes on the envelope before the sync, so
    // `writtenPaths` is exactly the set the commit is scoped to.
    const writtenPaths = describeRunWrittenPaths(setup, journal?.writtenPaths() ?? []);
    if (writtenPaths.length > 0) result.writtenPaths = writtenPaths;
    result.sync = commitStashBatch(result);
    return result;
  } catch (err) {
    recordImproveFailure(err, setup, eventsCtx);
    // Crash/abort safety net (#662): commit what this run already wrote.
    // commitStashBatch never throws and no-ops a clean tree.
    commitStashBatch({ scope, plannedRefs: collected.plannedRefs, runId: options.runId });
    throw err;
  } finally {
    teardown();
    try {
      eventsDb?.close();
    } catch {
      // already closed
    }
  }
}

/**
 * The run's journaled paths for `result.writtenPaths`: POSIX-relative to the
 * primary stash when inside it, absolute otherwise; deduped and sorted.
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

interface ImproveReadSource {
  selector?: string;
  source: { name: string; path: string };
}

/**
 * The source a dry run (or `--show-prompt`) inspects, without adapting it into
 * a write target.
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
  if (!selector && fallbackStashDir) return { source: { name: "stash", path: fallbackStashDir } };
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
  if (!implicit) throw new ConfigError("no source configured; run `akm bundle create`", "STASH_DIR_NOT_FOUND");
  return { source: { name: implicit.registryId ?? "stash", path: implicit.path } };
}

/**
 * Run setup, fully synchronous: the budget signal, the invocation plan, the
 * write target, the profile-defaulted options, and the state.db and lock paths
 * pinned before the first await (C2: a later env change cannot redirect them).
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
  const config = options.config ?? loadConfig();
  const configuredImproveProfile = resolveImproveStrategy(options.strategy, config).config;
  // A dry run never dispatches, so an all-disabled strategy must not abort it.
  const resolvedPlan =
    options.resolvedPlan ??
    resolveImprovePlan(options.strategy, config, {
      repairValidationFailures: options.repairValidationFailures,
      allowAllDisabled: options.dryRun,
    });
  const selectedStrategy = resolvedPlan.strategy;
  const improveProfile = selectedStrategy.config;
  const configuredLimits = {
    ...(options.limit !== undefined ? { cli: options.limit } : {}),
    ...(configuredImproveProfile.limit !== undefined ? { profile: configuredImproveProfile.limit } : {}),
    ...(configuredImproveProfile.processes?.reflect?.limit !== undefined
      ? { reflect: configuredImproveProfile.processes.reflect.limit }
      : {}),
  };
  // --limit, then the reflect process limit, then the profile limit.
  const effectiveLimit = options.limit ?? improveProfile?.processes?.reflect?.limit ?? improveProfile.limit;
  const scopedRef = scope.mode === "ref" && scope.value ? parseRefInput(scope.value) : undefined;
  const readSource = options.dryRun
    ? options.writeTarget
      ? { selector: options.writeTarget.selector, source: options.writeTarget.source }
      : resolveImproveReadSource(config, scopedRef, options.target, options.stashDir)
    : undefined;
  const writeTarget = options.dryRun
    ? undefined
    : scopedRef?.origin
      ? resolveMutationTarget(config, scopedRef, options.writeTarget?.source.name ?? options.target).target
      : (options.writeTarget ??
        (options.target || config.defaultWriteTarget || !options.stashDir
          ? resolveWriteTarget(config, options.target)
          : {
              source: { kind: "filesystem" as const, name: "stash", path: options.stashDir },
              config: { type: "filesystem" as const, name: "stash", path: options.stashDir, writable: true },
            }));
  const selectedSource = writeTarget?.source ?? readSource?.source;
  if (!selectedSource) throw new ConfigError("improve could not resolve a source", "STASH_DIR_NOT_FOUND");
  // Every stage reads this one config snapshot; nothing reloads it mid-run.
  options = {
    ...options,
    config,
    target: writeTarget?.selector ?? readSource?.selector,
    sourceName: selectedSource.name,
    ...(writeTarget ? { writeTarget } : {}),
    stashDir: selectedSource.path,
    limit: effectiveLimit,
  };
  let primaryStashDir: string | undefined;
  try {
    primaryStashDir = resolveSourceEntries(options.stashDir)[0]?.path;
  } catch {
    primaryStashDir = undefined;
  }
  return {
    startMs,
    budgetMs,
    budgetAbortController,
    scope,
    reflectFn: options.reflectFn ?? akmReflect,
    distillFn: options.distillFn ?? akmDistill,
    ensureIndexFn: options.ensureIndexFn ?? ensureIndex,
    reindexFn: options.reindexFn ?? akmIndex,
    drainProposalsFn: options.drainProposalsFn ?? drainProposals,
    collectEligibleRefsImpl:
      options.collectEligibleRefsFn ?? (options.dryRun ? collectEligibleRefsReadOnly : collectEligibleRefs),
    runImprovePreparationStageImpl: options.runImprovePreparationStageFn ?? runImprovePreparationStage,
    runImproveLoopStageImpl: options.runImproveLoopStageFn ?? runImproveLoopStage,
    runImprovePostLoopStageImpl: options.runImprovePostLoopStageFn ?? runImprovePostLoopStage,
    config,
    resolvedPlan,
    selectedStrategy,
    improveSensitiveValues: collectEngineCredentialValues(config),
    improveProfile,
    configuredImproveProfile,
    configuredLimits,
    effectiveLimit,
    writeTarget,
    options,
    primaryStashDir,
    syncRepoDir: writeTarget?.source.repoPath ?? primaryStashDir,
    resolvedStateDbPath: getStateDbPathInDataDir(),
    // The run lock is machine-local state, kept outside the bundle (#890).
    resolvedLockPath: improveLockPath(getStashLocksDir(primaryStashDir ?? options.stashDir ?? ".")),
    effectiveSync: { ...improveProfile.sync, ...options.sync },
  };
}

type ImproveRunSetup = ReturnType<typeof resolveImproveRunSetup>;

/** The redacted `improve_failed` event for a crashed run. */
function recordImproveFailure(err: unknown, run: ImproveRunSetup, eventsCtx: EventsContext): void {
  appendEvent(
    {
      eventType: "improve_failed",
      ref: run.scope.mode === "ref" ? run.scope.value : `improve:${run.scope.mode}:${run.scope.value ?? "all"}`,
      metadata: {
        strategy: run.selectedStrategy.name,
        error: redactSensitiveText(errMessage(err), run.improveSensitiveValues),
        durationMs: Date.now() - run.startMs,
      },
    },
    eventsCtx,
  );
}

function probeEntryCount(): number | undefined {
  try {
    if (!fs.existsSync(getDbPath())) return undefined;
    const db = openExistingDatabase();
    try {
      return getEntryCount(db);
    } finally {
      closeDatabase(db);
    }
  } catch (err) {
    rethrowIfTestIsolationError(err);
    return undefined;
  }
}

/**
 * ensureIndex before selection (#339): the eligible-ref query reads `entries`,
 * which a DB version upgrade may just have dropped. An index that was empty
 * and is now populated means an upgrade rebuild happened; say so.
 */
async function runIndexBootstrapPass(
  run: ImproveRunSetup,
  signal: AbortSignal,
): Promise<{ warnings: string[]; ensureIndexDurationMs?: number }> {
  const { primaryStashDir, options } = run;
  const warnings: string[] = [];
  if (!primaryStashDir || options.dryRun) return { warnings };
  const preEnsureEntryCount = probeEntryCount();
  let ensureIndexDurationMs: number | undefined;
  try {
    await run.ensureIndexFn(primaryStashDir, {
      mode: "blocking",
      signal,
      onReindexTiming: ({ durationMs }) => {
        ensureIndexDurationMs = durationMs;
      },
    });
  } catch (err) {
    if (signal.aborted) throw err;
    warnings.push(`ensureIndex failed: ${errMessage(err)}`);
  }
  if (preEnsureEntryCount === 0 && (probeEntryCount() ?? 0) > 0) {
    warn("[improve] index was empty after DB version upgrade — repopulating before continuing");
  }
  return { warnings, ensureIndexDurationMs };
}

/** Candidate selection plus the memory-cleanup plan and the autonomy-gated direct lanes. */
async function indexAndCollect(run: ImproveRunSetup): Promise<{
  plannedRefs: ImproveEligibleRef[];
  memorySummary: { eligible: number; derived: number };
  strategyFilteredRefs: ImproveEligibleRef[];
  indexSnapshot?: ImproveIndexSnapshot;
  memoryCleanupPlan?: MemoryCleanupPlan;
  /** Direct lanes that would have run but the autonomy gate denied. */
  autonomyGatedDirectLanes: AutonomyLane[];
  guidance?: string;
}> {
  const { scope, options, primaryStashDir, improveProfile, config } = run;
  const { plannedRefs, memorySummary, strategyFilteredRefs, indexSnapshot } = await run.collectEligibleRefsImpl(
    scope,
    options.stashDir,
    improveProfile,
    config,
  );
  const cleanupParentRef = memoryCleanupParentRef(scope, options.stashDir);
  const memoryCleanupPlan = shouldAnalyzeMemoryCleanup(scope, memorySummary.eligible, primaryStashDir)
    ? analyzeMemoryCleanup(primaryStashDir as string, cleanupParentRef ? { parentRef: cleanupParentRef } : undefined)
    : undefined;
  // A lane that would not have run anyway was not suppressed by the gate.
  const cleanupWouldMutate = Boolean(
    memoryCleanupPlan &&
      (memoryCleanupPlan.pruneCandidates.length > 0 ||
        memoryCleanupPlan.beliefStateTransitions.length > 0 ||
        memoryCleanupPlan.relativeDateCandidates.length > 0),
  );
  return {
    plannedRefs,
    memorySummary,
    strategyFilteredRefs: strategyFilteredRefs ?? [],
    indexSnapshot,
    memoryCleanupPlan,
    autonomyGatedDirectLanes:
      cleanupWouldMutate && !isAutonomyLaneAllowed("memoryCleanup", config) ? ["memoryCleanup"] : [],
    guidance:
      memorySummary.eligible > 0
        ? "Improve folds memory cleanup into the same proposal queue: speculative promotions still go through reflect/distill proposals, while high-confidence redundant derived memories are moved into a recoverable cleanup archive instead of being left active in the stash."
        : undefined,
  };
}

/** The envelope for a run skipped because another run holds the lock. */
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

/** A dry run: the real selectors on a read-only state.db snapshot, stopping before every writer. */
async function runDryPlanningStage(
  run: ImproveRunSetup,
  collected: Awaited<ReturnType<typeof indexAndCollect>>,
  initialCleanupWarnings: string[],
): Promise<AkmImproveResult> {
  let stateDb: Database | undefined;
  let stateSnapshotUnavailable = false;
  try {
    try {
      stateDb = openSqliteReadSnapshot(run.resolvedStateDbPath);
      stateSnapshotUnavailable = !stateDb;
    } catch (error) {
      if (!(error instanceof SqliteReadSnapshotUnavailableError)) throw error;
      stateSnapshotUnavailable = true;
    }
    const preparation = await run.runImprovePreparationStageImpl({
      ...preparationArgs(run, collected, initialCleanupWarnings),
      eventsCtx: {
        ...(stateDb ? { db: stateDb } : { dbPath: run.resolvedStateDbPath }),
        readOnly: true,
        ...(stateSnapshotUnavailable ? { readOnlySnapshotUnavailable: true } : {}),
      },
      planOnly: true,
    });
    return buildDryRunResult(run, collected, preparation);
  } finally {
    stateDb?.close();
  }
}

function preparationArgs(
  run: ImproveRunSetup,
  collected: Awaited<ReturnType<typeof indexAndCollect>>,
  initialCleanupWarnings: string[],
) {
  return {
    scope: run.scope,
    options: run.options,
    plannedRefs: collected.plannedRefs,
    memoryCleanupPlan: collected.memoryCleanupPlan,
    primaryStashDir: run.primaryStashDir,
    memorySummary: collected.memorySummary,
    reindexFn: run.reindexFn,
    startMs: run.startMs,
    budgetMs: run.budgetMs,
    initialCleanupWarnings,
    improveProfile: run.improveProfile,
    resolvedPlan: run.resolvedPlan,
    strategyName: run.selectedStrategy.name,
    budgetSignal: run.budgetAbortController.signal,
  };
}

/** The plan-only envelope of a dry run. */
export function buildDryRunResult(
  run: ImproveRunSetup,
  collected: Awaited<ReturnType<typeof indexAndCollect>>,
  preparation?: ImprovePreparationResult,
): AkmImproveResult {
  const { guidance, memorySummary, memoryCleanupPlan, plannedRefs, strategyFilteredRefs } = collected;
  const notices = collectImproveNotices(run.resolvedPlan, []);
  return {
    schemaVersion: 2,
    ok: true,
    strategy: run.selectedStrategy.name,
    scope: run.scope,
    dryRun: true,
    ...notices.fields(),
    ...(guidance ? { guidance } : {}),
    memorySummary,
    ...(memoryCleanupPlan ? { memoryCleanup: shapeMemoryCleanup(memoryCleanupPlan) } : {}),
    plannedRefs: preparation?.loopRefs ?? plannedRefs,
    ...(preparation?.planning ? { plan: buildResultExecutionPlan(run, preparation, collected, true) } : {}),
    ...(strategyFilteredRefs.length > 0 ? { strategyFilteredRefs } : {}),
    ...(run.resolvedPlan.engineUnavailable.length > 0 ? { skippedProcesses: run.resolvedPlan.engineUnavailable } : {}),
    ...(run.options.engineProbe !== undefined ? { engineProbe: run.options.engineProbe } : {}),
    ...(preparation?.proactiveMaintenance ? { proactiveMaintenance: preparation.proactiveMaintenance } : {}),
  };
}

/** The public execution-plan projection shared by the dry and live results. */
function buildResultExecutionPlan(
  run: ImproveRunSetup,
  preparation: ImprovePreparationResult,
  collected: Pick<
    Awaited<ReturnType<typeof indexAndCollect>>,
    "plannedRefs" | "strategyFilteredRefs" | "indexSnapshot"
  >,
  dryRun: boolean,
) {
  const { improveProfile, configuredImproveProfile, resolvedPlan, scope } = run;
  const { strategyFilteredRefs } = collected;
  const configuredTriage = configuredImproveProfile.processes?.triage;
  const inferenceMinPending = improveProfile.processes?.memoryInference?.minPendingCount;
  const pendingMemories =
    run.primaryStashDir && inferenceMinPending !== undefined && inferenceMinPending > 0
      ? collectPendingMemories(run.primaryStashDir).length
      : undefined;
  const belowMinPending =
    pendingMemories !== undefined && inferenceMinPending !== undefined && pendingMemories < inferenceMinPending;
  const memoryInferenceEnabled = resolvedPlan.processes.memoryInference.enabled && !belowMinPending;
  const graphExtractionEnabled = resolvedPlan.processes.graphExtraction.enabled && run.primaryStashDir !== undefined;
  // Per-process routing, plus how many effective refs each ref-scoped process would act on (#947).
  const processes = projectResolvedProcessRouting(resolvedPlan).map((row) => {
    const eligibleRefs = eligibleRefCount(preparation.loopRefs, row.process, resolvedPlan.strategy.config);
    return eligibleRefs === undefined ? row : { ...row, eligibleRefs };
  });
  const proactive = preparation.planning.proactive
    ? {
        ...preparation.planning.proactive,
        configured: pickDefined(configuredImproveProfile.processes?.proactiveMaintenance, [
          "dueDays",
          "maxPerRun",
          "limit",
        ]),
      }
    : undefined;
  return buildImproveExecutionPlan({
    dryRun,
    snapshot: collected.indexSnapshot ?? {
      status: "unknown",
      reason: "the injected selector did not report an index snapshot status",
    },
    rawInScope: collected.plannedRefs.length + strategyFilteredRefs.length,
    selectedRefs: preparation.actionableRefs,
    effectiveRefs: preparation.loopRefs,
    distillOnlyRefs: new Set(preparation.distillOnlyRefs.map((entry) => entry.ref)),
    configuredLimits: run.configuredLimits,
    effectiveLimit: run.effectiveLimit,
    gates: [
      {
        name: "profile" as const,
        removed: strategyFilteredRefs.length,
        reason: "all enabled per-ref processes refuse the asset type",
      },
      ...preparation.planning.gates,
    ],
    processes,
    ...(proactive ? { proactive } : {}),
    consolidation: {
      ...preparation.planning.consolidation,
      configured: pickDefined(configuredImproveProfile.processes?.consolidate, CONSOLIDATION_CONFIG_KEYS),
    },
    stageConfig: {
      extract: { enabled: preparation.planning.extract.wouldRun, reason: preparation.planning.extract.reason },
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
      enabled: scope.mode !== "ref" && resolvedPlan.processes.triage.enabled,
      configuredMode: configuredTriage?.applyMode ?? "queue",
      mode: improveProfile.processes?.triage?.applyMode ?? "queue",
      maxAcceptsPerRun: configuredTriage?.maxAcceptsPerRun ?? 25,
    },
  });
}

/** Drain the proposal backlog before generating more (non-fatal; a single-ref scope never drains). */
async function runTriagePrePass(run: ImproveRunSetup): Promise<DrainResult | undefined> {
  const { primaryStashDir, resolvedPlan, scope, options, improveProfile } = run;
  if (!primaryStashDir || !resolvedPlan.processes.triage.enabled) return undefined;
  if (scope.mode === "ref") {
    warn("[improve] triage pre-pass skipped (single-ref scope never drains the whole queue)");
    return undefined;
  }
  try {
    const triageConfig = improveProfile.processes?.triage;
    return await withLlmStage(
      "triage",
      () =>
        run.drainProposalsFn({
          stashDir: primaryStashDir,
          ...(options.target ? { target: options.target } : {}),
          config: options.config,
          applyMode: triageConfig?.applyMode ?? "queue",
          maxAccepts: triageConfig?.maxAcceptsPerRun ?? 25,
          dryRun: false,
          excludeIds: new Set<string>(),
          judgment: resolvedPlan.triageJudgment,
        }),
      { engine: resolvedPlan.triageJudgment?.engine, process: "triage.judgment" },
    );
  } catch (err) {
    warn(`[improve] triage pre-pass failed (non-fatal): ${errMessage(err)}`);
    return undefined;
  }
}

/**
 * The exact repo-relative paths the auto-sync commit stages (#652): the paths
 * this run wrote that Git reports changed (a journaled path already dirty at
 * start stays in — this run rewrote it). Without a journal, the pre-#652
 * dirty-path diff. `unattributed` counts in-scope paths that went dirty during
 * the run without this run writing them (concurrent edits, left alone). Lock
 * files are never staged.
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
    !path.basename(relativePath).includes(".lock") &&
    (!assetPrefix || relativePath === assetPrefix || relativePath.startsWith(`${assetPrefix}/`));
  if (!provenance) {
    return { paths: changedPaths.filter((p) => !initialPaths.has(p) && inScope(p)), unattributed: [] };
  }
  const changed = new Set(changedPaths);
  const attributed = new Set<string>();
  for (const absolutePath of writtenPaths) {
    const relativePath = relativeWrittenPath(repoDir, absolutePath);
    if (relativePath && changed.has(relativePath) && inScope(relativePath)) attributed.add(relativePath);
  }
  return {
    paths: [...attributed].sort(),
    unattributed: changedPaths.filter((p) => !attributed.has(p) && !initialPaths.has(p) && inScope(p)).sort(),
  };
}

/**
 * The auto-sync commit (#662), used at end of run and from the crash path:
 * idempotent and never throws. The getters read bindings reassigned after this
 * factory runs.
 */
function makeCommitStashBatch(deps: {
  run: ImproveRunSetup;
  getInitialGitPaths: () => Set<string>;
  getWriteJournal: () => WriteProvenanceJournal | undefined;
  getEventsCtx: () => EventsContext;
}): (messageContext: Parameters<typeof renderSyncCommitMessage>[1]) => AkmImproveResult["sync"] | undefined {
  const { writeTarget, primaryStashDir, effectiveSync, options, config, improveProfile } = deps.run;
  return (messageContext) => {
    const eventsCtx = deps.getEventsCtx();
    const writeJournal = deps.getWriteJournal();
    const repoDir = writeTarget?.source.repoPath ?? primaryStashDir;
    if (!primaryStashDir || !repoDir || effectiveSync.enabled === false || !isGitBackedStash(repoDir)) {
      return undefined;
    }
    const saveGitStashFn = options.saveGitStashFn ?? saveGitStash;
    const writableOverride = writeTarget ? resolveWritable(writeTarget.config) : resolveWritableOverride(config);
    const push = options.sync?.push ?? improveProfile.sync?.push ?? true;
    const message = renderSyncCommitMessage(
      effectiveSync.message ?? "akm improve auto-sync",
      messageContext,
      Date.now(),
    );
    const record = (metadata: Record<string, unknown>) =>
      appendEvent({ eventType: "stash_synced", metadata }, eventsCtx);
    try {
      const assetRoot = writeTarget?.source.path ?? primaryStashDir;
      const { paths, unattributed } = resolveSyncPathSet({
        repoDir,
        assetPrefix: path.relative(repoDir, assetRoot).replaceAll(path.sep, "/"),
        changedPaths: listGitChangedPaths(repoDir),
        initialPaths: deps.getInitialGitPaths(),
        writtenPaths: writeJournal?.writtenPaths() ?? [],
        provenance: writeJournal !== undefined,
      });
      if (unattributed.length > 0) {
        warnVerbose(
          `[improve] auto-sync left ${unattributed.length} path(s) uncommitted — not written by this run: ${unattributed.join(", ")}`,
        );
      }
      const syncResult = saveGitStashFn(undefined, message, writableOverride, { push, repoDir, paths });
      record({
        committed: syncResult.committed,
        pushed: syncResult.pushed,
        skipped: syncResult.skipped,
        reason: syncResult.reason ?? null,
        attributed: paths.length,
        unattributed: unattributed.length,
      });
      return {
        committed: syncResult.committed,
        pushed: syncResult.pushed,
        skipped: syncResult.skipped,
        ...(syncResult.reason !== undefined ? { reason: syncResult.reason } : {}),
      };
    } catch (syncErr) {
      const reason = errMessage(syncErr);
      warn(`improve: stash sync failed (non-fatal): ${reason}`);
      record({ committed: false, pushed: false, skipped: true, reason });
      return { committed: false, pushed: false, skipped: true, reason };
    }
  };
}

/**
 * Re-read the improve ledger under the lock and drop proactive refs another run
 * attempted after this one planned.
 */
export function refilterProactiveLoopRefs(
  loopRefs: ImprovePreparationResult["loopRefs"],
  improveProfile: ImproveProfileConfig,
  ledgerAccess: { stashDir?: string; eventsCtx?: EventsContext },
): ImprovePreparationResult["loopRefs"] {
  const proactiveLoopRefs = loopRefs.filter((r) => r.eligibilitySource === "proactive");
  if (proactiveLoopRefs.length === 0 || !ledgerAccess.stashDir) return loopRefs;
  const ledger = loadLedgerSnapshot({ eventsCtx: ledgerAccess.eventsCtx }, ledgerAccess.stashDir, [
    "reflect",
    "distill",
  ]);
  const stillDue = new Set(
    filterProactiveDue(
      proactiveLoopRefs,
      lastAttemptByRef(ledger, "reflect", proactiveLoopRefs),
      lastAttemptByRef(ledger, "distill", proactiveLoopRefs),
      improveProfile.processes?.proactiveMaintenance?.dueDays ?? DEFAULT_DUE_DAYS,
      Date.now(),
    ).map((r) => r.ref),
  );
  const dropped = proactiveLoopRefs.filter((r) => !stillDue.has(r.ref));
  if (dropped.length === 0) return loopRefs;
  info(
    `[improve] post-lock cooldown re-filter: dropped ${dropped.length} proactive ref(s) claimed by concurrent run (${dropped.map((r) => r.ref).join(", ")})`,
  );
  return loopRefs.filter((r) => r.eligibilitySource !== "proactive" || stillDue.has(r.ref));
}

/**
 * The audit events for refs and lanes this run will not touch, then
 * preparation → loop → post-loop. No post-loop work starts past the budget; the
 * result still finalizes, so budget exhaustion exits 0.
 */
async function runImproveStageSequence(
  run: ImproveRunSetup,
  collected: Awaited<ReturnType<typeof indexAndCollect>>,
  preEnsureCleanupWarnings: string[],
  eventsCtx: EventsContext,
) {
  const { scope, options, primaryStashDir, improveProfile, resolvedPlan, budgetAbortController } = run;
  const strategy = run.selectedStrategy.name;
  // One count-only row for planner-filtered refs, never one per ref (#592).
  if (collected.strategyFilteredRefs.length > 0) {
    recordImproveSkip(eventsCtx, undefined, {
      strategy,
      reason: "strategy_filtered_all_passes",
      count: collected.strategyFilteredRefs.length,
    });
  }
  // A gated lane names the config key that would enable it.
  for (const lane of [...resolvedPlan.autonomyGated, ...describeGatedLanes(collected.autonomyGatedDirectLanes)]) {
    warn(`[improve] ${lane.lane} skipped — it ${lane.reason}. Set \`${lane.configKey}: true\` to enable it.`);
    recordImproveSkip(eventsCtx, undefined, {
      strategy,
      reason: "autonomy_gated",
      lane: lane.lane,
      configKey: lane.configKey,
    });
  }
  for (const item of resolvedPlan.engineUnavailable) {
    warn(`[improve] ${item.process} skipped — it ${item.reason}.`);
    recordImproveSkip(eventsCtx, undefined, {
      strategy,
      reason: "engine_unavailable",
      process: item.process,
      configKey: item.configKey,
    });
  }

  const preparation = await run.runImprovePreparationStageImpl({
    ...preparationArgs(run, collected, preEnsureCleanupWarnings),
    eventsCtx,
  });
  const loopResult = await run.runImproveLoopStageImpl({
    eventsCtx,
    budgetSignal: budgetAbortController.signal,
    primaryStashDir,
    scope,
    options,
    reflectFn: run.reflectFn,
    distillFn: run.distillFn,
    loopRefs: refilterProactiveLoopRefs(preparation.loopRefs, improveProfile, {
      stashDir: primaryStashDir ?? options.stashDir,
      eventsCtx,
    }),
    actions: preparation.actions,
    signalBearingSet: preparation.signalBearingSet,
    distillCooledRefs: preparation.distillCooledRefs,
    distillOnlyRefs: preparation.distillOnlyRefs,
    recentErrors: preparation.recentErrors,
    startMs: run.startMs,
    budgetMs: run.budgetMs,
    improveProfile,
    resolvedPlan,
  });

  let postLoop: ImprovePostLoopResult = { allWarnings: [], memoryInferenceDurationMs: 0, graphExtractionDurationMs: 0 };
  const remainingBudget = (budgetAbortController.signal as { remainingBudgetMs?: number }).remainingBudgetMs;
  if (budgetAbortController.signal.aborted || (remainingBudget !== undefined && remainingBudget <= 0)) {
    info("[improve] post-loop maintenance skipped (wall-clock budget exhausted)");
  } else {
    postLoop = await run.runImprovePostLoopStageImpl({
      scope,
      options,
      primaryStashDir,
      actionableRefs: preparation.actionableRefs,
      appliedCleanup: preparation.appliedCleanup,
      cleanupWarnings: preparation.cleanupWarnings,
      memoryRefsForInference: loopResult.memoryRefsForInference,
      eventsCtx,
      budgetSignal: budgetAbortController.signal,
      improveProfile,
      resolvedPlan,
    });
  }
  return {
    preparation,
    postLoop,
    reflectsWithErrorContext: loopResult.reflectsWithErrorContext,
    finalActions: [...preparation.actions, ...(postLoop.maintenanceActions ?? [])],
  };
}

/** Assemble the result envelope and emit `improve_completed`. */
function finalizeImproveResult(args: {
  run: ImproveRunSetup;
  seq: Awaited<ReturnType<typeof runImproveStageSequence>>;
  collected: Awaited<ReturnType<typeof indexAndCollect>>;
  triageDrain?: DrainResult;
  ensureIndexDurationMs?: number;
  eventsCtx: EventsContext;
}): AkmImproveResult {
  const { run, collected, triageDrain, ensureIndexDurationMs, eventsCtx } = args;
  const { preparation, postLoop, reflectsWithErrorContext, finalActions } = args.seq;
  const { options, startMs, resolvedPlan } = run;
  const { memoryCleanupPlan, strategyFilteredRefs } = collected;
  const consolidation = preparation.consolidation;
  const { memoryInference, graphExtraction, allWarnings, deadUrls, deadUrlCoverage, orphansPurged, proposalsExpired } =
    postLoop;
  const { memoryInferenceDurationMs, graphExtractionDurationMs } = postLoop;
  // The per-ref distill-skipped rows fold into a bounded aggregate before persistence (C1).
  const { actions: persistedActions, aggregate: distillSkippedAggregate } = foldDistillSkipped(finalActions);
  // This run's LLM accounting (#944): llm_usage rows carry no run id, so the
  // read is bounded by the run's own wall clock.
  const usageEvents = readEvents({ since: new Date(startMs).toISOString(), type: LLM_USAGE_EVENT }, eventsCtx).events;
  const usageReport = buildImproveUsageReport({
    resolvedPlan,
    byProcessEngineModel: summarizeLlmUsageCrossTab(usageEvents),
    strategyFilteredRefsCount: strategyFilteredRefs.length,
    loopRefs: preparation.loopRefs,
    persistedActions,
    distillSkippedAggregate,
  });
  const notices = collectImproveNotices(resolvedPlan, [
    ...finalActions.map((action) => action.result),
    ...preparation.schemaRepairs,
    consolidation,
    ...(preparation.extract ?? []).flatMap((extract) => [extract, ...(extract.sessions ?? [])]),
    memoryInference,
    graphExtraction,
    triageDrain,
  ]);
  const applied = preparation.appliedCleanup;
  const countMode = (mode: ImproveActionMode) => finalActions.filter((a) => a.mode === mode).length;

  const result: AkmImproveResult = {
    schemaVersion: 2,
    ok: true,
    strategy: run.selectedStrategy.name,
    scope: run.scope,
    dryRun: false,
    ...notices.fields(),
    ...(collected.guidance ? { guidance: collected.guidance } : {}),
    memorySummary: collected.memorySummary,
    ...(memoryCleanupPlan
      ? {
          memoryCleanup: {
            ...shapeMemoryCleanup(memoryCleanupPlan),
            ...(applied
              ? {
                  archived: applied.archived,
                  ...(applied.transitionLogPath ? { transitionLogPath: applied.transitionLogPath } : {}),
                  ...(applied.transitionLogEntries !== undefined
                    ? { transitionLogEntries: applied.transitionLogEntries }
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
    ...(preparation.planning ? { plan: buildResultExecutionPlan(run, preparation, collected, false) } : {}),
    ...(strategyFilteredRefs.length > 0 ? { strategyFilteredRefs } : {}),
    ...(resolvedPlan.engineUnavailable.length > 0 ? { skippedProcesses: resolvedPlan.engineUnavailable } : {}),
    ...(options.engineProbe !== undefined ? { engineProbe: options.engineProbe } : {}),
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
    ...(deadUrls !== undefined && deadUrls.length > 0 ? { deadUrls } : {}),
    // Present whenever the check ran, so health knows the coverage of a clean run (#892).
    ...(deadUrlCoverage !== undefined ? { deadUrlCoverage } : {}),
    ...(reflectsWithErrorContext > 0 ? { reflectsWithErrorContext } : {}),
    ...(memoryInference ? { memoryInference } : {}),
    ...(graphExtraction ? { graphExtraction } : {}),
    // Top-level phase durations feed health's wall-time buckets; a phase that
    // did not run is omitted, not zero.
    ...(memoryInferenceDurationMs > 0 ? { memoryInferenceDurationMs } : {}),
    ...(graphExtractionDurationMs > 0 ? { graphExtractionDurationMs } : {}),
    ...(ensureIndexDurationMs !== undefined ? { ensureIndexDurationMs } : {}),
    ...(orphansPurged !== undefined ? { orphansPurged } : {}),
    ...(proposalsExpired !== undefined && proposalsExpired > 0 ? { proposalsExpired } : {}),
    reflectCooldownActions: countMode("reflect-cooldown"),
    reflectSkippedActions: countMode("reflect-skipped"),
    reflectGuardRejectedActions: countMode("reflect-guard-rejected"),
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

/** Every lowering notice the plan and this run's stage results carry, deduplicated. */
function collectImproveNotices(resolvedPlan: ImproveRunSetup["resolvedPlan"], carriers: readonly unknown[]) {
  const notices = noticeSet();
  const collect = (carrier: unknown): void => {
    const list = (carrier as { notices?: unknown } | null | undefined)?.notices;
    if (typeof carrier === "object" && Array.isArray(list)) notices.add(list as Notice[]);
  };
  for (const process of Object.values(resolvedPlan.processes)) collect(process);
  notices.add(resolvedPlan.triageJudgmentNotices ?? []);
  for (const carrier of carriers) collect(carrier);
  return notices;
}

/** `improve_completed` per-mode counters; keyed by every mode so a new one cannot be dropped. */
const ACTION_COUNTER: Record<ImproveActionMode, string> = {
  reflect: "reflectActions",
  distill: "distillActions",
  "distill-skipped": "distillSkippedActions",
  "memory-prune": "memoryPruneActions",
  "memory-inference": "memoryInferenceActions",
  "graph-extraction": "graphExtractionActions",
  error: "errorActions",
  "reflect-failed": "reflectFailedActions",
  "reflect-cooldown": "reflectCooldownActions",
  "reflect-skipped": "reflectSkippedActions",
  "reflect-guard-rejected": "reflectGuardRejectedActions",
};

function emitImproveCompletedEvent(
  result: AkmImproveResult,
  durations: {
    memoryInferenceDurationMs: number;
    graphExtractionDurationMs: number;
    totalDurationMs: number;
    warningCount: number;
    orphansPurged: number;
  },
  eventsCtx?: EventsContext,
): void {
  const counts: Record<string, number> = Object.fromEntries(Object.values(ACTION_COUNTER).map((key) => [key, 0]));
  // The coarse buckets come from the same classifier the persisted metrics use.
  const classCounts = { accepted: 0, rejected: 0, skipped: 0, error: 0, noop: 0 };
  for (const action of result.actions ?? []) {
    const key = ACTION_COUNTER[action.mode];
    if (key) counts[key] = (counts[key] ?? 0) + 1;
    classCounts[classifyImproveAction(action.mode)] += 1;
  }
  // distill-skipped rows were folded into the aggregate; count them back in.
  const distillSkippedTotal = result.distillSkipped?.total ?? 0;
  counts.distillSkippedActions = (counts.distillSkippedActions ?? 0) + distillSkippedTotal;
  classCounts.skipped += distillSkippedTotal;
  const cleanup = result.memoryCleanup;
  const quality = result.graphExtraction?.quality;
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
        ...counts,
        acceptedActions: classCounts.accepted,
        rejectedActions: classCounts.rejected,
        skippedActions: classCounts.skipped,
        noopActions: classCounts.noop,
        reflectsWithErrorContext: result.reflectsWithErrorContext ?? 0,
        coverageGapCount: result.coverageGaps?.length ?? 0,
        deadUrlCount: result.deadUrls?.length ?? 0,
        deadUrlsChecked: result.deadUrlCoverage?.checked ?? 0,
        deadUrlsTotal: result.deadUrlCoverage?.total ?? 0,
        deadUrlsSkipped: result.deadUrlCoverage?.skipped ?? 0,
        memoryEligible: result.memorySummary.eligible,
        memoryDerived: result.memorySummary.derived,
        memoryCleanupPruneCandidates: cleanup?.pruneCandidates.length ?? 0,
        memoryCleanupContradictionCandidates: cleanup?.contradictionCandidates.length ?? 0,
        memoryCleanupBeliefStateTransitions: cleanup?.beliefStateTransitions.length ?? 0,
        memoryCleanupConsolidationCandidates: cleanup?.consolidationCandidates.length ?? 0,
        memoryCleanupArchived: cleanup?.archived?.length ?? 0,
        memoryCleanupWarnings: cleanup?.warnings?.length ?? 0,
        consolidationProcessed: result.consolidation?.processed ?? 0,
        consolidationDurationMs: result.consolidation?.durationMs ?? 0,
        memoryInferenceWrites: result.memoryInference?.writtenFacts ?? 0,
        memoryInferenceDurationMs: durations.memoryInferenceDurationMs,
        graphExtractionExtractedFiles: quality?.extractedFiles ?? 0,
        graphExtractionDurationMs: durations.graphExtractionDurationMs,
        proactiveSelected: result.proactiveMaintenance?.selected ?? 0,
        proactiveDueTotal: result.proactiveMaintenance?.dueTotal ?? 0,
        proactiveNeverReflected: result.proactiveMaintenance?.neverReflected ?? 0,
        durationMs: durations.totalDurationMs,
        warningCount: durations.warningCount,
        orphansPurged: durations.orphansPurged,
        ...(quality
          ? {
              graphCoverage: quality.extractionCoverage,
              graphDensity: quality.density,
              graphEntities: quality.entityCount,
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
