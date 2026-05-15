import type { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { makeAssetRef, parseAssetRef } from "../core/asset-ref";
import type { AkmConfig } from "../core/config";
import { loadConfig } from "../core/config";
import { ConfigError, NotFoundError, UsageError } from "../core/errors";
import { appendEvent, type EventEnvelope, type EventsContext, readEvents } from "../core/events";
import { parseFrontmatter } from "../core/frontmatter";
import {
  type ArchivedMemoryCleanupRecord,
  analyzeMemoryCleanup,
  applyMemoryCleanup,
  type MemoryBeliefStateTransition,
  type MemoryCleanupPlan,
  type MemoryConsolidationCandidate,
  type MemoryContradictionCandidate,
  type MemoryPruneCandidate,
  type RelativeDateCandidate,
} from "../core/memory-improve";
import { getDbPath } from "../core/paths";
import { listProposals } from "../core/proposals";
import { openStateDatabase } from "../core/state-db";
import { info, warn } from "../core/warn";
import {
  closeDatabase,
  getAllEntries,
  getRetrievalCounts,
  getUtilityScoresByIds,
  getZeroResultSearches,
  openDatabase,
  openExistingDatabase,
} from "../indexer/db";
import { ensureIndex } from "../indexer/ensure-index";
import { type GraphExtractionResult, runGraphExtractionPass } from "../indexer/graph-extraction";
import { akmIndex } from "../indexer/indexer";
import {
  type MemoryInferencePassOptions,
  type MemoryInferenceResult,
  runMemoryInferencePass,
} from "../indexer/memory-inference";
import { resolveAssetPath } from "../indexer/path-resolver";
import { getWritableStashDirs, resolveSourceEntries } from "../indexer/search-source";
import { getExecutionLogCandidates } from "../integrations/session-logs";
import { type AkmConsolidateOptions, akmConsolidate, type ConsolidateResult } from "./consolidate";
import { type AkmDistillResult, akmDistill, deriveLessonRef } from "./distill";
import { deriveKnowledgeRef } from "./distill-promotion-policy";
import { countEvalCases, writeEvalCase } from "./eval-cases";
import { akmLint } from "./lint/index";
import { type AkmReflectResult, akmReflect } from "./reflect";
import { runSchemaRepairPass } from "./schema-repair";
import { checkDeadUrls, type DeadUrl } from "./url-checker";

export interface AkmImproveOptions {
  scope?: string;
  task?: string;
  dryRun?: boolean;
  target?: string;
  autoAccept?: "safe";
  stashDir?: string;
  config?: AkmConfig;
  /** Wall-clock budget for the entire improve run in milliseconds. Defaults to 2 hours. */
  timeoutMs?: number;
  limit?: number;
  consolidateOptions?: Omit<AkmConsolidateOptions, "config" | "stashDir">;
  /** Number of eligible memory assets above which consolidation is forced even if the memory_consolidation feature flag is not set. Defaults to 100. */
  memoryVolumeConsolidationThreshold?: number;
  reflectFn?: (options: NonNullable<Parameters<typeof akmReflect>[0]>) => Promise<AkmReflectResult>;
  distillFn?: (options: NonNullable<Parameters<typeof akmDistill>[0]>) => Promise<AkmDistillResult>;
  memoryInferenceFn?: (
    config: AkmConfig,
    sources: ReturnType<typeof resolveSourceEntries>,
    signal?: AbortSignal,
    db?: Database,
    reEnrich?: boolean,
    onProgress?: Parameters<typeof runMemoryInferencePass>[5],
    options?: MemoryInferencePassOptions,
  ) => Promise<MemoryInferenceResult>;
  graphExtractionFn?: (
    config: AkmConfig,
    sources: ReturnType<typeof resolveSourceEntries>,
    signal?: AbortSignal,
    db?: Database,
    reEnrich?: boolean,
    onProgress?: Parameters<typeof runGraphExtractionPass>[5],
    options?: Parameters<typeof runGraphExtractionPass>[6],
  ) => Promise<GraphExtractionResult>;
  ensureIndexFn?: (stashDir: string) => Promise<unknown>;
  reindexFn?: (options: { stashDir: string }) => Promise<unknown>;
  /** When true (default), attempt LLM-driven schema repair on validation failures before skipping. Requires llm config. */
  repairValidationFailures?: boolean;
  /** Cooldown in days before re-reflecting an asset that was recently reflected. Defaults to 7. Set to 0 to disable. Only for this run; does not persist to config. */
  reflectCooldownDays?: number;
  /** Cooldown in days before re-distilling an asset with a recent accepted proposal. Defaults to 30. Set to 0 to disable. Only for this run; does not persist to config. */
  distillCooldownDays?: number;
  /** Cooldown in days before re-consolidating memories. Defaults to 14. Set to 0 to disable. Only for this run; does not persist to config. */
  consolidateCooldownDays?: number;
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
}

export interface ImproveEligibleRef {
  ref: string;
  reason: "scope-ref" | "scope-type" | "memory-cleanup";
}

export interface ImproveActionResult {
  ref: string;
  mode:
    | "reflect"
    | "reflect-failed"
    | "distill"
    | "distill-skipped"
    | "memory-prune"
    | "memory-inference"
    | "graph-extraction"
    | "error";
  result:
    | AkmReflectResult
    | AkmDistillResult
    | MemoryInferenceResult
    | GraphExtractionResult
    | { ok: true; pruned: boolean; reason: MemoryPruneCandidate["reason"] }
    | { ok: true; reason: string }
    | { ok: false; error: string };
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
  schemaVersion: 1;
  ok: true;
  scope: {
    mode: "all" | "type" | "ref";
    value?: string;
  };
  dryRun: boolean;
  guidance?: string;
  memorySummary: {
    eligible: number;
    derived: number;
  };
  memoryCleanup?: ImproveMemoryCleanupResult;
  plannedRefs: ImproveEligibleRef[];
  actions?: ImproveActionResult[];
  validationFailures?: Array<{ ref: string; reason: string }>;
  schemaRepairs?: Array<{
    ref: string;
    reason: string;
    outcome: "written" | "skipped" | "error";
    error?: string;
  }>;
  consolidation?: ConsolidateResult;
  lintSummary?: { fixed: number; flagged: number };
  memoryIndexHealth?: { lineCount: number; overBudget: boolean };
  coverageGaps?: string[];
  executionLogCandidates?: string[];
  evalCasesWritten?: number;
  deadUrls?: DeadUrl[];
  /** Number of reflect calls that had at least one error in the rolling window at call time. */
  reflectsWithErrorContext?: number;
  memoryInference?: MemoryInferenceResult;
  graphExtraction?: GraphExtractionResult;
}

type ImproveScope = ReturnType<typeof resolveImproveScope>;

interface ImprovePreparationResult {
  actions: ImproveActionResult[];
  cleanupWarnings: string[];
  appliedCleanup?: Awaited<ReturnType<typeof applyMemoryCleanup>>;
  memoryIndexHealth?: { lineCount: number; overBudget: boolean };
  executionLogCandidates: string[];
  actionableRefs: ImproveEligibleRef[];
  signalBearingSet: Set<string>;
  validationFailures: Array<{ ref: string; reason: string }>;
  schemaRepairs: Array<{
    ref: string;
    reason: string;
    outcome: "written" | "skipped" | "error";
    error?: string;
  }>;
  lintSummary?: { fixed: number; flagged: number };
  loopRefs: ImproveEligibleRef[];
  distillCooledRefs: Set<string>;
  /** Refs on reflect cooldown but eligible for distill-only processing (Bug D2). */
  distillOnlyRefs: ImproveEligibleRef[];
  coverageGaps: string[];
  recentErrors: string[];
}

interface ImproveLoopResult {
  reflectsWithErrorContext: number;
  memoryRefsForInference: Set<string>;
}

interface ImprovePostLoopResult {
  allWarnings: string[];
  consolidation: ConsolidateResult;
  deadUrls?: DeadUrl[];
  memoryInference?: MemoryInferenceResult;
  graphExtraction?: GraphExtractionResult;
  maintenanceActions?: ImproveActionResult[];
  memoryInferenceDurationMs: number;
  graphExtractionDurationMs: number;
}

interface ImproveMaintenanceResult {
  memoryInference?: MemoryInferenceResult;
  graphExtraction?: GraphExtractionResult;
  actions?: ImproveActionResult[];
  memoryInferenceDurationMs: number;
  graphExtractionDurationMs: number;
}

function resolveImproveScope(scope: string | undefined): { mode: "all" | "type" | "ref"; value?: string } {
  const trimmed = scope?.trim();
  if (!trimmed) return { mode: "all" };
  try {
    parseAssetRef(trimmed);
    return { mode: "ref", value: trimmed };
  } catch {
    return { mode: "type", value: trimmed };
  }
}

async function collectEligibleRefs(
  scope: { mode: "all" | "type" | "ref"; value?: string },
  stashDir?: string,
): Promise<{
  plannedRefs: ImproveEligibleRef[];
  memorySummary: { eligible: number; derived: number };
}> {
  if (scope.mode === "ref" && scope.value) {
    const parsed = parseAssetRef(scope.value);
    const writableDirs = new Set(getWritableStashDirs(stashDir).map((dir) => path.resolve(dir)));
    const filePath = await findAssetFilePath(scope.value, stashDir, writableDirs);
    if (!filePath) {
      return {
        plannedRefs: [],
        memorySummary: { eligible: 0, derived: 0 },
      };
    }
    return {
      plannedRefs: [{ ref: scope.value, reason: "scope-ref" }],
      memorySummary: {
        eligible: parsed.type === "memory" ? 1 : 0,
        derived: parsed.type === "memory" && parsed.name.endsWith(".derived") ? 1 : 0,
      },
    };
  }

  let sources: ReturnType<typeof resolveSourceEntries>;
  try {
    sources = resolveSourceEntries(stashDir);
  } catch {
    return { plannedRefs: [], memorySummary: { eligible: 0, derived: 0 } };
  }
  if (sources.length === 0) {
    return { plannedRefs: [], memorySummary: { eligible: 0, derived: 0 } };
  }

  // Only operate on writable sources — never mutate read-only registry caches
  // or remote stashes that the user did not mark writable.
  let writableDirs: string[];
  try {
    writableDirs = getWritableStashDirs(stashDir);
  } catch {
    writableDirs = sources.slice(0, 1).map((s) => s.path); // fallback: primary only
  }
  const writableDirSet = new Set(writableDirs.map((d) => path.resolve(d)));

  let db: Database | undefined;
  try {
    db = openExistingDatabase();
    const entries = getAllEntries(db, scope.mode === "type" ? scope.value : undefined).filter((indexed) => {
      // First apply the existing stashDir-scope filter (no-op when stashDir is unset).
      if (!isEntryInScope(indexed.stashDir, indexed.filePath, stashDir)) return false;
      // Then restrict to writable sources only.
      return isEntryInWritableSource(indexed.stashDir, indexed.filePath, writableDirSet);
    });
    const planned = new Map<string, ImproveEligibleRef>();
    let memoryEligible = 0;
    let memoryDerived = 0;
    for (const indexed of entries) {
      const ref = makeAssetRef(indexed.entry.type, indexed.entry.name);
      if (!planned.has(ref)) {
        planned.set(ref, {
          ref,
          reason:
            scope.mode === "type" ? "scope-type" : indexed.entry.type === "memory" ? "memory-cleanup" : "scope-type",
        });
      }
      if (indexed.entry.type === "memory") {
        memoryEligible += 1;
        if (indexed.entry.name.endsWith(".derived")) memoryDerived += 1;
      }
    }
    return {
      plannedRefs: [...planned.values()],
      memorySummary: { eligible: memoryEligible, derived: memoryDerived },
    };
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof Error) {
      return { plannedRefs: [], memorySummary: { eligible: 0, derived: 0 } };
    }
    throw error;
  } finally {
    if (db) closeDatabase(db);
  }
}

function isEntryInScope(entryStashDir: string, filePath: string, stashDir?: string): boolean {
  if (!stashDir) return true;
  const resolvedEntryStashDir = path.resolve(entryStashDir);
  const resolvedFilePath = path.resolve(filePath);
  const resolvedScopeStashDir = path.resolve(stashDir);
  return (
    resolvedEntryStashDir === resolvedScopeStashDir ||
    resolvedEntryStashDir.startsWith(`${resolvedScopeStashDir}${path.sep}`) ||
    resolvedFilePath.startsWith(`${resolvedScopeStashDir}${path.sep}`)
  );
}

/**
 * Return true when the indexed entry belongs to one of the writable source
 * directories. Entries from read-only registry caches or remote stashes that
 * the user has not marked writable must never enter the improve/distill loop.
 */
function isEntryInWritableSource(entryStashDir: string, filePath: string, writableDirSet: Set<string>): boolean {
  const resolvedEntryStashDir = path.resolve(entryStashDir);
  const resolvedFilePath = path.resolve(filePath);
  for (const writableDir of writableDirSet) {
    if (
      resolvedEntryStashDir === writableDir ||
      resolvedEntryStashDir.startsWith(`${writableDir}${path.sep}`) ||
      resolvedFilePath.startsWith(`${writableDir}${path.sep}`)
    ) {
      return true;
    }
  }
  return false;
}

function memoryCleanupParentRef(
  scope: { mode: "all" | "type" | "ref"; value?: string },
  stashDir?: string,
): string | undefined {
  if (scope.mode !== "ref" || !scope.value) return undefined;
  const parsed = parseAssetRef(scope.value);
  if (parsed.type !== "memory") return undefined;
  if (!parsed.name.endsWith(".derived")) return scope.value;

  const sources = resolveSourceEntries(stashDir);
  for (const source of sources) {
    const candidate = path.join(source.path, "memories", `${parsed.name}.md`);
    if (!fs.existsSync(candidate)) continue;
    const raw = fs.readFileSync(candidate, "utf8");
    const fm = parseFrontmatter(raw).data;
    const sourceRef = typeof fm.source === "string" ? fm.source : undefined;
    if (sourceRef) {
      try {
        const parent = parseAssetRef(sourceRef.trim());
        if (parent.type === "memory") return makeAssetRef(parent.type, parent.name);
      } catch {}
    }
  }

  return makeAssetRef("memory", parsed.name.slice(0, -".derived".length));
}

function isLessonCandidate(ref: string): boolean {
  const parsed = parseAssetRef(ref);
  return parsed.type !== "lesson" && parsed.type !== "memory";
}

function shouldDistillMemoryRef(ref: string, stashDir?: string): boolean {
  const parsed = parseAssetRef(ref);
  if (parsed.type !== "memory") return false;
  const sources = resolveSourceEntries(stashDir);
  for (const source of sources) {
    const candidate = `${source.path}/memories/${parsed.name}.md`;
    if (!fs.existsSync(candidate)) continue;
    const raw = fs.readFileSync(candidate, "utf8");
    const fm = parseFrontmatter(raw).data;
    const quality = typeof fm.quality === "string" ? fm.quality : undefined;
    if (quality === "proposed") return false;
    return !parsed.name.endsWith(".derived");
  }
  return !parsed.name.endsWith(".derived");
}

export async function akmImprove(options: AkmImproveOptions = {}): Promise<AkmImproveResult> {
  const scope: ImproveScope = resolveImproveScope(options.scope);
  const { plannedRefs, memorySummary } = await collectEligibleRefs(scope, options.stashDir);
  const reflectFn = options.reflectFn ?? akmReflect;
  const distillFn = options.distillFn ?? akmDistill;
  const ensureIndexFn = options.ensureIndexFn ?? ensureIndex;
  const reindexFn = options.reindexFn ?? akmIndex;
  let primaryStashDir: string | undefined;
  try {
    primaryStashDir = resolveSourceEntries(options.stashDir)[0]?.path;
  } catch {
    primaryStashDir = undefined;
  }
  const cleanupParentRef = memoryCleanupParentRef(scope, options.stashDir);
  const memoryCleanupPlan = shouldAnalyzeMemoryCleanup(scope, memorySummary.eligible, primaryStashDir)
    ? analyzeMemoryCleanup(primaryStashDir as string, cleanupParentRef ? { parentRef: cleanupParentRef } : undefined)
    : undefined;
  const guidance =
    memorySummary.eligible > 0
      ? "Improve folds memory cleanup into the same proposal queue: speculative promotions still go through reflect/distill proposals, while high-confidence redundant derived memories are moved into a recoverable cleanup archive instead of being left active in the stash."
      : undefined;

  if (options.dryRun) {
    const result: AkmImproveResult = {
      schemaVersion: 1,
      ok: true,
      scope,
      dryRun: true,
      ...(guidance ? { guidance } : {}),
      memorySummary,
      ...(memoryCleanupPlan ? { memoryCleanup: shapeMemoryCleanup(memoryCleanupPlan) } : {}),
      plannedRefs,
    };
    return result;
  }

  const resolvedLockPath = primaryStashDir
    ? path.join(primaryStashDir, ".akm", "improve.lock")
    : path.join(options.stashDir ?? ".", ".akm", "improve.lock");
  const MAX_LOCK_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours

  fs.mkdirSync(path.dirname(resolvedLockPath), { recursive: true });

  const acquireLock = (): void => {
    let lockFd = -1;
    try {
      lockFd = fs.openSync(resolvedLockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      fs.writeSync(lockFd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      fs.closeSync(lockFd);
    } catch {
      // Lock file already exists — read it and check staleness
      if (lockFd !== -1) {
        try {
          fs.closeSync(lockFd);
        } catch {
          /* ignore */
        }
      }
      let lock: { pid: number; startedAt: string } | null = null;
      try {
        lock = JSON.parse(fs.readFileSync(resolvedLockPath, "utf8")) as { pid: number; startedAt: string };
      } catch {
        // Unreadable lock file — treat as stale
      }

      let lockAgeMs = MAX_LOCK_AGE_MS + 1; // default: treat as stale if stat fails
      try {
        const lockStat = fs.statSync(resolvedLockPath);
        lockAgeMs = Date.now() - lockStat.mtimeMs;
      } catch {
        // ignore
      }

      let pidIsAlive = false;
      if (lock !== null) {
        try {
          process.kill(lock.pid, 0);
          pidIsAlive = true;
        } catch {
          /* dead */
        }
      }

      if (!pidIsAlive || lockAgeMs > MAX_LOCK_AGE_MS) {
        // Stale lock — remove and retry once with O_EXCL
        try {
          fs.unlinkSync(resolvedLockPath);
        } catch {
          /* ignore */
        }
        let retryFd = -1;
        try {
          retryFd = fs.openSync(
            resolvedLockPath,
            fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
            0o600,
          );
          fs.writeSync(retryFd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
          fs.closeSync(retryFd);
        } catch {
          if (retryFd !== -1) {
            try {
              fs.closeSync(retryFd);
            } catch {
              /* ignore */
            }
          }
          throw new ConfigError(
            `akm improve is already running. Delete ${resolvedLockPath} to force.`,
            "INVALID_CONFIG_FILE",
          );
        }
      } else {
        throw new ConfigError(
          `akm improve is already running (PID ${lock?.pid}, started ${lock?.startedAt}). Delete ${resolvedLockPath} to force.`,
          "INVALID_CONFIG_FILE",
        );
      }
    }
  };
  acquireLock();

  const budgetMs = options.timeoutMs ?? 2 * 60 * 60 * 1000; // default 2 hours
  const startMs = Date.now();

  // I1: open a single state.db connection for the entire improve run so all
  // appendEvent calls reuse one handle instead of open/migrate/close per call.
  let eventsDb: import("bun:sqlite").Database | undefined;
  let eventsCtx: EventsContext;
  try {
    eventsDb = openStateDatabase();
    eventsCtx = { db: eventsDb };
  } catch {
    // If we cannot open state.db up-front, fall back to per-call opens.
    eventsCtx = {};
  }

  try {
    const preparation = await runImprovePreparationStage({
      scope,
      options,
      plannedRefs,
      memoryCleanupPlan,
      primaryStashDir,
      memorySummary,
      ensureIndexFn,
      reindexFn,
      startMs,
      budgetMs,
    });

    // D6: pre-load all proposal_rejected events from the last 30 days once,
    // so the per-asset loop can use a Map lookup instead of N DB round trips.
    const REJECTED_PROPOSAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
    const rejectedProposalSince = new Date(Date.now() - REJECTED_PROPOSAL_WINDOW_MS).toISOString();
    const allRejectedProposalEvents = readEvents({ type: "proposal_rejected", since: rejectedProposalSince }).events;
    const rejectedProposalsByRef = new Map<string, EventEnvelope>();
    for (const e of allRejectedProposalEvents) {
      if (e.ref && (!rejectedProposalsByRef.has(e.ref) || e.ts > (rejectedProposalsByRef.get(e.ref)?.ts ?? ""))) {
        rejectedProposalsByRef.set(e.ref, e);
      }
    }

    const { reflectsWithErrorContext, memoryRefsForInference } = await runImproveLoopStage({
      scope,
      options,
      primaryStashDir,
      reflectFn,
      distillFn,
      loopRefs: preparation.loopRefs,
      actions: preparation.actions,
      signalBearingSet: preparation.signalBearingSet,
      distillCooledRefs: preparation.distillCooledRefs,
      distillOnlyRefs: preparation.distillOnlyRefs,
      recentErrors: preparation.recentErrors,
      rejectedProposalsByRef,
      startMs,
      budgetMs,
    });

    const {
      allWarnings,
      consolidation,
      deadUrls,
      memoryInference,
      graphExtraction,
      maintenanceActions,
      memoryInferenceDurationMs,
      graphExtractionDurationMs,
    } = await runImprovePostLoopStage({
      scope,
      options,
      primaryStashDir,
      actionableRefs: preparation.actionableRefs,
      appliedCleanup: preparation.appliedCleanup,
      cleanupWarnings: preparation.cleanupWarnings,
      memorySummary,
      memoryRefsForInference,
      reindexFn,
    });

    const finalActions =
      maintenanceActions && maintenanceActions.length > 0
        ? [...preparation.actions, ...maintenanceActions]
        : preparation.actions;

    const result: AkmImproveResult = {
      schemaVersion: 1,
      ok: true,
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
      actions: finalActions,
      ...(preparation.validationFailures.length > 0 ? { validationFailures: preparation.validationFailures } : {}),
      ...(preparation.schemaRepairs.length > 0 ? { schemaRepairs: preparation.schemaRepairs } : {}),
      ...(consolidation.processed > 0 || consolidation.warnings.length > 0 ? { consolidation } : {}),
      ...(preparation.lintSummary !== undefined ? { lintSummary: preparation.lintSummary } : {}),
      ...(preparation.memoryIndexHealth !== undefined ? { memoryIndexHealth: preparation.memoryIndexHealth } : {}),
      ...(preparation.coverageGaps.length > 0 ? { coverageGaps: preparation.coverageGaps } : {}),
      ...(preparation.executionLogCandidates.length > 0
        ? { executionLogCandidates: preparation.executionLogCandidates }
        : {}),
      ...(primaryStashDir !== undefined ? { evalCasesWritten: countEvalCases(primaryStashDir) } : {}),
      ...(deadUrls !== undefined && deadUrls.length > 0 ? { deadUrls } : {}),
      ...(reflectsWithErrorContext > 0 ? { reflectsWithErrorContext } : {}),
      ...(memoryInference ? { memoryInference } : {}),
      ...(graphExtraction ? { graphExtraction } : {}),
    };
    if (!result.dryRun)
      emitImproveCompletedEvent(result, { memoryInferenceDurationMs, graphExtractionDurationMs }, eventsCtx);
    return result;
  } catch (err) {
    // D3: emit improve_failed on unexpected crash so dashboards can detect failures.
    appendEvent({
      eventType: "improve_failed",
      ref: scope.mode === "ref" ? scope.value : `improve:${scope.mode}:${scope.value ?? "all"}`,
      metadata: {
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startMs,
      },
    });
    throw err;
  } finally {
    try {
      fs.unlinkSync(resolvedLockPath);
    } catch {
      // ignore
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
  durations: { memoryInferenceDurationMs: number; graphExtractionDurationMs: number },
  eventsCtx?: EventsContext,
): void {
  const actionCounts = {
    reflect: 0,
    reflectFailed: 0,
    distill: 0,
    distillSkipped: 0,
    memoryPrune: 0,
    memoryInference: 0,
    graphExtraction: 0,
    error: 0,
  };
  for (const action of result.actions ?? []) {
    switch (action.mode) {
      case "reflect":
        actionCounts.reflect += 1;
        break;
      case "reflect-failed":
        actionCounts.reflectFailed += 1;
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
    }
  }

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
        reflectsWithErrorContext: result.reflectsWithErrorContext ?? 0,
        coverageGapCount: result.coverageGaps?.length ?? 0,
        executionLogCandidateCount: result.executionLogCandidates?.length ?? 0,
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
        feedbackRatioUsed: true,
      },
    },
    eventsCtx,
  );
}

async function runImprovePreparationStage(args: {
  scope: ImproveScope;
  options: AkmImproveOptions;
  plannedRefs: ImproveEligibleRef[];
  memoryCleanupPlan?: MemoryCleanupPlan;
  primaryStashDir?: string;
  memorySummary: { eligible: number; derived: number };
  ensureIndexFn: (stashDir: string) => Promise<unknown>;
  reindexFn: (options: { stashDir: string }) => Promise<unknown>;
  startMs: number;
  budgetMs: number;
}): Promise<ImprovePreparationResult> {
  const {
    scope,
    options,
    plannedRefs,
    memoryCleanupPlan,
    primaryStashDir,
    ensureIndexFn,
    reindexFn,
    startMs,
    budgetMs,
  } = args;

  const actions: ImproveActionResult[] = [];
  const cleanupWarnings: string[] = [];

  // Phase 0 — MEMORY.md budget check (200-line cap; warn at 180)
  let memoryIndexHealth: { lineCount: number; overBudget: boolean } | undefined;
  if (primaryStashDir) {
    const memoryMdPath = path.join(primaryStashDir, "memories", "MEMORY.md");
    if (fs.existsSync(memoryMdPath)) {
      try {
        const lines = fs.readFileSync(memoryMdPath, "utf8").split("\n").length;
        const overBudget = lines >= 180;
        memoryIndexHealth = { lineCount: lines, overBudget };
        if (overBudget) {
          cleanupWarnings.push(`MEMORY.md has ${lines} lines (budget: 200). Consolidation strongly recommended.`);
        }
      } catch {
        // best-effort
      }
    }
  }

  // Phase 0 — execution log synthesis
  let executionLogCandidates: string[] = [];
  try {
    const logEntries = getExecutionLogCandidates(7);
    executionLogCandidates = logEntries.filter((e) => e.isFailurePattern).map((e) => e.topic);
  } catch {
    // best-effort
  }

  // eligibleCount = raw pre-filter count (before cooldown/signal/cleanup filters).
  // improve_completed.plannedRefs = post-filter count of refs that actually entered the loop.
  appendEvent({
    eventType: "improve_invoked",
    ref: scope.mode === "ref" ? scope.value : `improve:${scope.mode}:${scope.value ?? "all"}`,
    metadata: { scope, dryRun: options.dryRun ?? false, eligibleCount: plannedRefs.length },
  });

  if (primaryStashDir) {
    try {
      await ensureIndexFn(primaryStashDir);
    } catch (err) {
      cleanupWarnings.push(`ensureIndex failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let appliedCleanup: Awaited<ReturnType<typeof applyMemoryCleanup>> | undefined;
  try {
    appliedCleanup =
      primaryStashDir && memoryCleanupPlan ? applyMemoryCleanup(primaryStashDir, memoryCleanupPlan) : undefined;
  } catch (err) {
    cleanupWarnings.push(`applyMemoryCleanup failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const archivedRefs = appliedCleanup?.archived.map((record) => record.ref) ?? [];
  const removed = new Set(archivedRefs);
  const postCleanupRefs = archivedRefs.length === 0 ? plannedRefs : plannedRefs.filter((r) => !removed.has(r.ref));

  // Gap 6: only surface feedback signals from the last 30 days so that
  // ancient one-off feedback events don't permanently lock an asset into
  // every improve run. Assets with only stale signals fall through to the
  // high-retrieval path (P0-A) or are skipped until new signals arrive.
  const FEEDBACK_SIGNAL_WINDOW_DAYS = 30;
  const feedbackSinceCutoff = new Date(Date.now() - FEEDBACK_SIGNAL_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const signalFiltered = postCleanupRefs.filter((candidate) => {
    const { events } = readEvents({ type: "feedback", ref: candidate.ref });
    return events.some(
      (e) =>
        (e.ts ?? "") >= feedbackSinceCutoff &&
        ((e.metadata !== undefined && typeof e.metadata.signal === "string") ||
          (e.metadata !== undefined && typeof e.metadata.note === "string")),
    );
  });

  // P0-A: also surface zero-feedback assets that have been retrieved many times.
  const RETRIEVAL_COUNT_THRESHOLD = options.minRetrievalCount ?? 5;

  const signalBearingSet = new Set(signalFiltered.map((r) => r.ref));
  const noFeedbackCandidates = postCleanupRefs.filter((r) => !signalBearingSet.has(r.ref));

  let highRetrievalRefs: typeof postCleanupRefs = [];
  let dbForRetrieval: import("bun:sqlite").Database | undefined;
  try {
    dbForRetrieval = openExistingDatabase();
    const showEventCount = (
      dbForRetrieval.prepare("SELECT COUNT(*) AS cnt FROM usage_events WHERE event_type = 'show'").get() as {
        cnt: number;
      }
    ).cnt;
    if (showEventCount === 0) {
      warn(
        "Warning: show events not yet in usage_events — zero-feedback fallback will match only search-retrieved assets.",
      );
    }
    const retrievalCounts = getRetrievalCounts(
      dbForRetrieval,
      noFeedbackCandidates.map((r) => r.ref),
    );
    highRetrievalRefs = noFeedbackCandidates.filter(
      (r) => (retrievalCounts.get(r.ref) ?? 0) >= RETRIEVAL_COUNT_THRESHOLD,
    );
  } catch {
    // best-effort: if DB unavailable, highRetrievalRefs stays empty
  } finally {
    if (dbForRetrieval) closeDatabase(dbForRetrieval);
  }

  // If the user explicitly scoped to a single ref, always act on it —
  // skip the signal/retrieval filter entirely. The filter exists to avoid
  // noisy "improve everything" runs; it should not gate an intentional
  // per-ref invocation where the user's explicit choice is the signal.
  //
  // For type/all scope with no signals yet (fresh environment), fall back
  // to all postCleanupRefs so that the first improve run is not a no-op.
  const signalAndRetrievalRefs = [...signalFiltered, ...highRetrievalRefs];
  const mergedRefs =
    scope.mode === "ref"
      ? postCleanupRefs
      : options.requireFeedbackSignal
        ? signalFiltered
        : signalAndRetrievalRefs.length === 0
          ? postCleanupRefs
          : signalAndRetrievalRefs;

  const utilityMap = buildUtilityMap(mergedRefs);

  // Load feedback ratio per ref and blend into sort key
  const feedbackRatios = new Map<string, number>();
  for (const ref of mergedRefs) {
    const { events } = readEvents({ type: "feedback", ref: ref.ref });
    const positive = events.filter((e) => e.metadata?.signal === "positive").length;
    const negative = events.filter((e) => e.metadata?.signal === "negative").length;
    const total = positive + negative;
    // ratio = negative proportion (high = needs more improvement)
    feedbackRatios.set(ref.ref, total > 0 ? negative / total : 0);
  }

  // Sort: combine utility (desc) with feedback negativity (desc) — high-negative assets rank higher
  const sorted = [...mergedRefs].sort((a, b) => {
    const utilA = utilityMap.get(a.ref) ?? 0;
    const utilB = utilityMap.get(b.ref) ?? 0;
    const ratioA = feedbackRatios.get(a.ref) ?? 0;
    const ratioB = feedbackRatios.get(b.ref) ?? 0;
    // Combined score: 70% utility, 30% negative ratio
    const scoreA = utilA * 0.7 + ratioA * 0.3;
    const scoreB = utilB * 0.7 + ratioB * 0.3;
    return scoreB - scoreA;
  });
  // Phase 0: surface coverage gaps from zero-result search queries
  let coverageGaps: string[] = [];
  try {
    const dbForGaps = openExistingDatabase();
    try {
      coverageGaps = getZeroResultSearches(dbForGaps);
    } finally {
      closeDatabase(dbForGaps);
    }
  } catch {
    // best-effort
  }

  // Bug B1: keep the full sorted set for reporting/telemetry; --limit is applied
  // AFTER all cooldown filters so that cooled assets cannot consume limit slots
  // and displace uncooled assets that would receive LLM calls.
  const actionableRefs = sorted;

  if (appliedCleanup) {
    for (const candidate of memoryCleanupPlan?.pruneCandidates ?? []) {
      const archived = appliedCleanup.archived.find((record) => record.ref === candidate.ref);
      if (!archived) continue;
      actions.push({
        ref: candidate.ref,
        mode: "memory-prune",
        result: { ok: true, pruned: true, reason: candidate.reason },
      });
    }
    if ((appliedCleanup.archived.length > 0 || appliedCleanup.beliefStateTransitions.length > 0) && primaryStashDir) {
      try {
        await reindexFn({ stashDir: primaryStashDir });
      } catch (err) {
        cleanupWarnings.push(`reindex after cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const validationFailures: Array<{ ref: string; reason: string }> = [];
  for (const candidate of actionableRefs) {
    try {
      const filePath = await findAssetFilePath(candidate.ref, options.stashDir);
      if (!filePath) {
        validationFailures.push({ ref: candidate.ref, reason: "file not found on disk" });
        continue;
      }
      if (isLessonCandidate(candidate.ref)) {
        const raw = fs.readFileSync(filePath, "utf8");
        const fm = parseFrontmatter(raw).data;
        if (!fm.description) validationFailures.push({ ref: candidate.ref, reason: "missing description" });
      }
    } catch (e) {
      validationFailures.push({ ref: candidate.ref, reason: String(e) });
    }
  }
  if (validationFailures.length > 0) {
    info(`[improve] ${validationFailures.length} assets have validation issues (will be skipped):`);
    for (const f of validationFailures) info(`  ${f.ref}: ${f.reason}`);
  }

  let schemaRepairs: ImprovePreparationResult["schemaRepairs"] = [];
  let repairedRefs = new Set<string>();

  // Schema repair pass: attempt to fix validation failures via LLM before skipping.
  if (validationFailures.length > 0 && options.repairValidationFailures !== false) {
    const baseConfigForRepair = options.config ?? loadConfig();
    const llmCfg = baseConfigForRepair.llm;
    if (llmCfg) {
      const result = await runSchemaRepairPass(validationFailures, {
        startMs,
        budgetMs,
        llmConfig: llmCfg,
        stashDir: options.stashDir,
        findFilePath: findAssetFilePath,
        isLessonCandidateFn: isLessonCandidate,
      });
      schemaRepairs = result.repairs;
      repairedRefs = result.repairedRefs;
    }
  }

  const validationFailureRefs = new Set(validationFailures.filter((f) => !repairedRefs.has(f.ref)).map((f) => f.ref));

  // Phase 0.5 — structural hygiene pass
  let lintSummary: { fixed: number; flagged: number } | undefined;
  if (primaryStashDir) {
    try {
      const lintResult = akmLint({ fix: true, dir: primaryStashDir });
      lintSummary = { fixed: lintResult.summary.fixed, flagged: lintResult.summary.flagged };
    } catch {
      // lint is best-effort; never block improve
    }
  }

  const recentErrors: string[] = []; // rolling window, last 3 failures
  const RECENT_ERRORS_CAP = 3;

  // Seed the rolling window from any schema repair errors that occurred before the main loop.
  for (const repair of schemaRepairs) {
    if (repair.outcome === "error") {
      const errMsg = repair.error ?? `schema repair error: ${repair.reason}`;
      recentErrors.push(errMsg);
      if (recentErrors.length > RECENT_ERRORS_CAP) recentErrors.shift();
    }
  }

  // ── Cooldown pre-filter ───────────────────────────────────────────────────
  // Read all cooldown-relevant events in 4 bulk queries and materialise two
  // Sets that the loop checks with O(1) Set.has() instead of N per-ref
  // readEvents() + listProposals() calls. This eliminates the N×3 DB/FS
  // round trips that caused per-asset "reflect cooldown" noise for every
  // asset in the stash.
  //
  // SM-2 tier for reflect uses promoted/rejected events (recorded by
  // `akm proposal accept/reject`) rather than the per-ref listProposals()
  // filesystem scan, giving identical tier logic without touching the disk.
  const REFLECT_COOLDOWN_DAYS = options.reflectCooldownDays ?? 7;
  const DISTILL_COOLDOWN_DAYS = options.distillCooldownDays ?? 30;

  const reflectCooledRefs = new Set<string>();
  const distillCooledRefs = new Set<string>();

  const effectiveReflectCooldown = REFLECT_COOLDOWN_DAYS;
  const effectiveDistillCooldown = DISTILL_COOLDOWN_DAYS;

  if (effectiveReflectCooldown > 0 || effectiveDistillCooldown > 0) {
    const bulkWindowMs = Math.max(effectiveReflectCooldown, effectiveDistillCooldown) * 24 * 60 * 60 * 1000;
    const bulkSince = new Date(Date.now() - bulkWindowMs).toISOString();

    const bulkReflects = readEvents({ type: "reflect_invoked", since: bulkSince }).events;
    const bulkDistills = readEvents({ type: "distill_invoked", since: bulkSince }).events;
    const bulkPromoted = readEvents({ type: "promoted", since: bulkSince }).events;
    const bulkRejected = readEvents({ type: "rejected", since: bulkSince }).events;

    const promotedTs = new Map<string, string>();
    for (const e of bulkPromoted) {
      if (e.ref && (e.ts ?? "") > (promotedTs.get(e.ref) ?? "")) promotedTs.set(e.ref, e.ts ?? "");
    }
    const rejectedTs = new Map<string, string>();
    for (const e of bulkRejected) {
      if (e.ref && (e.ts ?? "") > (rejectedTs.get(e.ref) ?? "")) rejectedTs.set(e.ref, e.ts ?? "");
    }

    if (REFLECT_COOLDOWN_DAYS > 0) {
      const latestReflect = new Map<string, string>();
      for (const e of bulkReflects) {
        if (e.ref && (e.ts ?? "") > (latestReflect.get(e.ref) ?? "")) latestReflect.set(e.ref, e.ts ?? "");
      }
      for (const [ref, lastTs] of latestReflect) {
        if (!lastTs) continue;
        const hasAccepted = (promotedTs.get(ref) ?? "") > lastTs;
        const hasRejected = (rejectedTs.get(ref) ?? "") > lastTs;
        let effectiveCooldownDays = REFLECT_COOLDOWN_DAYS;
        if (hasAccepted) continue;
        else if (hasRejected) effectiveCooldownDays = Math.min(REFLECT_COOLDOWN_DAYS, 3);
        if (Date.now() - new Date(lastTs).getTime() < effectiveCooldownDays * 24 * 60 * 60 * 1000) {
          reflectCooledRefs.add(ref);
        }
      }
    }

    if (DISTILL_COOLDOWN_DAYS > 0) {
      const distillCooldownMs = DISTILL_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
      // B5: track both queued and validation_failed outcomes for cooldown.
      // validation_failed assets previously were never cooled so they re-distilled on every run.
      const validationFailedCooldownMs = Math.ceil(DISTILL_COOLDOWN_DAYS / 2) * 24 * 60 * 60 * 1000;
      const latestQueuedDistill = new Map<string, string>();
      const latestValidationFailed = new Map<string, string>();
      for (const e of bulkDistills) {
        if (e.ref && e.metadata?.outcome === "queued" && (e.ts ?? "") > (latestQueuedDistill.get(e.ref) ?? "")) {
          latestQueuedDistill.set(e.ref, e.ts ?? "");
        }
        if (
          e.ref &&
          e.metadata?.outcome === "validation_failed" &&
          (e.ts ?? "") > (latestValidationFailed.get(e.ref) ?? "")
        ) {
          latestValidationFailed.set(e.ref, e.ts ?? "");
        }
      }
      for (const [ref, lastTs] of latestQueuedDistill) {
        if (lastTs && Date.now() - new Date(lastTs).getTime() < distillCooldownMs) {
          distillCooledRefs.add(ref);
        }
      }
      for (const [ref, lastTs] of latestValidationFailed) {
        if (lastTs && Date.now() - new Date(lastTs).getTime() < validationFailedCooldownMs) {
          distillCooledRefs.add(ref);
        }
      }
    }
  }

  // ── Cooldown pre-filter (Bugs B1, D1, D2) ──────────────────────────────────
  // Three buckets:
  //   reflectAndDistillRefs  — not reflect-cooled, not validation-failed (normal path)
  //   distillOnlyRefs        — reflect-cooled, distill-cooldown expired, is a distill
  //                            candidate → skip reflect but allow distill (Bug D2)
  //   emit-only              — reflect-cooled AND (distill-cooled OR not a candidate)
  //                            → emit synthetic skip action and exclude entirely
  //
  // Bug D1: distill-cooled distill-candidates that are NOT reflect-cooled have their
  // synthetic distill-skipped action emitted here before any LLM call or budget check.
  const DISTILL_COOLDOWN_DAYS_PREFILT = options.distillCooldownDays ?? 30;
  const reflectAndDistillRefs: ImproveEligibleRef[] = [];
  const distillOnlyRefs: ImproveEligibleRef[] = [];

  for (const r of actionableRefs) {
    if (validationFailureRefs.has(r.ref)) continue;

    const onReflectCooldown = reflectCooledRefs.has(r.ref);
    const onDistillCooldown = DISTILL_COOLDOWN_DAYS_PREFILT > 0 && distillCooledRefs.has(r.ref);
    const isDistillCandidate = isLessonCandidate(r.ref) || shouldDistillMemoryRef(r.ref, options.stashDir);

    if (!onReflectCooldown) {
      if (onDistillCooldown && isDistillCandidate) {
        // Bug D1: pre-emit synthetic distill-skipped action before any LLM call.
        actions.push({ ref: r.ref, mode: "distill-skipped", result: { ok: true, reason: "distill cooldown" } });
        appendEvent({
          eventType: "improve_skipped",
          ref: r.ref,
          metadata: { reason: "distill_cooldown", cooldownDays: DISTILL_COOLDOWN_DAYS_PREFILT },
        });
      }
      // Asset is not on reflect cooldown — allow reflect (distill guard is in the loop).
      reflectAndDistillRefs.push(r);
    } else {
      if (!onDistillCooldown && isDistillCandidate) {
        // Bug D2: reflect-cooled but distill cooldown expired and is a distill candidate.
        distillOnlyRefs.push(r);
      } else {
        // Fully cooled or not a distill candidate — emit synthetic skip and exclude.
        actions.push({
          ref: r.ref,
          mode: "distill-skipped",
          result: { ok: true, reason: "reflect cooldown (pre-filtered)" },
        });
        appendEvent({ eventType: "improve_skipped", ref: r.ref, metadata: { reason: "reflect_cooldown" } });
      }
    }
  }

  // Bug B1 final step: apply --limit to the actually-processable set.
  const allLoopRefs = [...reflectAndDistillRefs, ...distillOnlyRefs];
  const loopRefs = options.limit ? allLoopRefs.slice(0, options.limit) : allLoopRefs;

  const reflectCooledCount = actionableRefs.filter(
    (r) => reflectCooledRefs.has(r.ref) && !distillOnlyRefs.some((d) => d.ref === r.ref),
  ).length;
  if (reflectCooledCount > 0) {
    info(`[improve] ${reflectCooledCount}/${actionableRefs.length} assets on reflect cooldown — skipping`);
  }
  if (distillOnlyRefs.length > 0) {
    info(`[improve] ${distillOnlyRefs.length} reflect-cooled assets will run distill-only path`);
  }
  if (validationFailureRefs.size > 0) {
    info(`[improve] ${validationFailureRefs.size} assets with validation failures excluded from loop`);
  }

  return {
    actions,
    cleanupWarnings,
    appliedCleanup,
    memoryIndexHealth,
    executionLogCandidates,
    actionableRefs,
    signalBearingSet,
    validationFailures,
    schemaRepairs,
    lintSummary,
    loopRefs,
    distillCooledRefs,
    distillOnlyRefs,
    coverageGaps,
    recentErrors,
  };
}

async function runImproveLoopStage(args: {
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
  recentErrors: string[];
  /** D6: pre-loaded map of most-recent proposal_rejected event per ref (last 30d). */
  rejectedProposalsByRef: Map<string, EventEnvelope>;
  startMs: number;
  budgetMs: number;
}): Promise<ImproveLoopResult> {
  const {
    scope,
    options,
    primaryStashDir,
    reflectFn,
    distillFn,
    loopRefs,
    actions,
    signalBearingSet,
    distillCooledRefs,
    distillOnlyRefs,
    recentErrors,
    rejectedProposalsByRef,
    startMs,
    budgetMs,
  } = args;

  const RECENT_ERRORS_CAP = 3;
  // Build a Set for O(1) membership test — these refs skip the reflect call (Bug D2).
  const distillOnlyRefSet = new Set(distillOnlyRefs.map((r) => r.ref));
  let completedCount = 0;
  let reflectsWithErrorContext = 0;
  const memoryRefsForInference = new Set<string>();

  for (const planned of loopRefs) {
    if (Date.now() - startMs >= budgetMs) {
      const remaining = loopRefs.length - completedCount;
      info(
        `[improve] budget exhausted after ${Math.round((Date.now() - startMs) / 60000)}min — ${remaining} assets skipped`,
      );
      appendEvent({
        eventType: "improve_skipped",
        ref: planned.ref,
        metadata: {
          reason: "budget_exhausted",
          remaining,
        },
      });
      // B11: Emit improve_skipped for all remaining assets that will not be processed.
      for (const remainingRef of loopRefs.slice(completedCount + 1)) {
        appendEvent({
          eventType: "improve_skipped",
          ref: remainingRef.ref,
          metadata: { reason: "budget_exhausted_batch", remaining: loopRefs.length - completedCount - 1 },
        });
      }
      actions.push({
        ref: planned.ref,
        mode: "error",
        result: { ok: false, error: "timeout: improve wall-clock budget exhausted" },
      });
      break;
    }
    try {
      // Bug D2: distillOnlyRefs skip the reflect call but still run the distill path.
      // Bug D1: in-loop distill-cooldown check removed — distill-cooled candidates
      //         have their synthetic actions emitted in runImprovePreparationStage.
      const isDistillOnly = distillOnlyRefSet.has(planned.ref);

      const parsedPlannedRef = parseAssetRef(planned.ref);
      // B6: derived memories are machine-generated; skip reflect to avoid noisy proposals.
      // shouldDistillMemoryRef already returns false for .derived refs, so the distill
      // path is also a no-op for them — we just avoid unnecessary agent spawns.
      // D2: distillOnlyRefs also skip the reflect call (reflect-cooled, distill path only).
      if (!isDistillOnly && !planned.ref.endsWith(".derived")) {
        if (recentErrors.length > 0) reflectsWithErrorContext++;
        const reflectResult = await reflectFn({
          ref: planned.ref,
          task: options.task,
          ...(options.stashDir ? { stashDir: options.stashDir } : {}),
          ...(recentErrors.length > 0 ? { avoidPatterns: [...recentErrors] } : {}),
          agentProcess: options.agentProcess ?? "reflect",
        });
        actions.push({
          ref: planned.ref,
          mode: reflectResult.ok ? "reflect" : "reflect-failed",
          result: reflectResult,
        });
        if (!reflectResult.ok) {
          const errMsg = reflectResult.error ?? reflectResult.reason ?? "unknown reflect error";
          recentErrors.push(errMsg);
          if (recentErrors.length > RECENT_ERRORS_CAP) recentErrors.shift();
        }
      } else if (!isDistillOnly && planned.ref.endsWith(".derived")) {
        // B6: .derived refs skip reflect; record synthetic skip action.
        actions.push({
          ref: planned.ref,
          mode: "distill-skipped",
          result: { ok: true, reason: "derived-memory-reflect-skipped" },
        });
      }
      // isDistillOnly refs: no reflect action emitted — proceed directly to distill path below.
      const hasRecentFeedbackSignal = signalBearingSet.has(planned.ref);
      const explicitRefScope = scope.mode === "ref";
      const shouldAttemptDistill =
        isLessonCandidate(planned.ref) || shouldDistillMemoryRef(planned.ref, options.stashDir);
      const skipMemoryDistillForWeakSignal =
        parsedPlannedRef.type === "memory" && !hasRecentFeedbackSignal && !explicitRefScope;

      // distillCooledRefs guard: pre-filter emitted synthetic actions for distill-candidate
      // refs; non-candidate refs in the set are blocked here.
      if (shouldAttemptDistill && !skipMemoryDistillForWeakSignal && !distillCooledRefs.has(planned.ref)) {
        const lessonRef = deriveLessonRef(planned.ref);
        const knowledgeRef = deriveKnowledgeRef(planned.ref);
        const dedupeStashDir = primaryStashDir ?? options.stashDir;
        if (dedupeStashDir) {
          // B2: check both lesson ref and knowledge ref since auto-promoted memories
          // create knowledge: proposals, not lesson: proposals.
          const pendingProposals = listProposals(dedupeStashDir, { status: "pending" });
          const hasExistingPending = pendingProposals.some((p) => p.ref === lessonRef || p.ref === knowledgeRef);
          if (hasExistingPending) {
            actions.push({
              ref: planned.ref,
              mode: "distill-skipped",
              result: { ok: true, reason: "pending proposal exists" },
            });
            appendEvent({
              eventType: "improve_skipped",
              ref: planned.ref,
              metadata: { reason: "pending_proposal_exists" },
            });
            completedCount++;
            info(`[improve] ${completedCount}/${loopRefs.length} ${planned.ref}`);
            continue;
          }
        }

        const distillResult = await distillFn({
          ref: planned.ref,
          ...(parsedPlannedRef.type === "memory" ? { proposalKind: "auto" as const } : {}),
          ...(options.stashDir ? { stashDir: options.stashDir } : {}),
        });
        actions.push({ ref: planned.ref, mode: "distill", result: distillResult });
        if (parsedPlannedRef.type === "memory") {
          const promotedToKnowledge = distillResult.outcome === "queued" && distillResult.proposalKind === "knowledge";
          if (!promotedToKnowledge) memoryRefsForInference.add(planned.ref);
        }
        if (distillResult.outcome === "quality_rejected" && primaryStashDir) {
          const slug = planned.ref
            .replace(/[^a-z0-9]/gi, "-")
            .toLowerCase()
            .slice(0, 60);
          writeEvalCase(primaryStashDir, {
            ref: planned.ref,
            failureReason: distillResult.reason ?? "quality gate rejected",
            assetType: parseAssetRef(planned.ref).type ?? "unknown",
            rejectedAt: Date.now(),
            source: "distill_quality_rejected",
            slug: `${slug}-${Date.now()}`,
          });
        }
        // D6: use pre-loaded map instead of per-iteration DB query
        const rejectedProposalEvent = rejectedProposalsByRef.get(planned.ref);
        if (rejectedProposalEvent && primaryStashDir) {
          const slug = planned.ref
            .replace(/[^a-z0-9]/gi, "-")
            .toLowerCase()
            .slice(0, 60);
          writeEvalCase(primaryStashDir, {
            ref: planned.ref,
            failureReason: (rejectedProposalEvent.metadata?.reason as string | undefined) ?? "proposal rejected",
            assetType: parseAssetRef(planned.ref).type ?? "unknown",
            rejectedAt: new Date(rejectedProposalEvent.ts).getTime(),
            source: "proposal_rejected",
            slug: `${slug}-rejected`,
          });
        }
      } else if (skipMemoryDistillForWeakSignal) {
        actions.push({
          ref: planned.ref,
          mode: "distill-skipped",
          result: { ok: true, reason: "memory requires recent feedback signal" },
        });
        appendEvent({
          eventType: "improve_skipped",
          ref: planned.ref,
          metadata: { reason: "memory_distill_requires_feedback" },
        });
      }
    } catch (err) {
      // B7: UsageError thrown by akmDistill on validation_failed should be recorded
      // as mode:"distill" with outcome:"validation_failed", NOT as a generic error.
      // The distill_invoked event was already emitted inside akmDistill before the throw.
      if (err instanceof UsageError) {
        actions.push({
          ref: planned.ref,
          mode: "distill",
          result: { ok: false, outcome: "validation_failed", error: err.message } as unknown as AkmDistillResult,
        });
      } else {
        actions.push({
          ref: planned.ref,
          mode: "error",
          result: { ok: false, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }
    completedCount++;
    info(`[improve] ${completedCount}/${loopRefs.length} ${planned.ref}`);
  }

  return { reflectsWithErrorContext, memoryRefsForInference };
}

async function runImprovePostLoopStage(args: {
  scope: ImproveScope;
  options: AkmImproveOptions;
  primaryStashDir?: string;
  actionableRefs: ImproveEligibleRef[];
  appliedCleanup?: Awaited<ReturnType<typeof applyMemoryCleanup>>;
  cleanupWarnings: string[];
  memorySummary: { eligible: number; derived: number };
  memoryRefsForInference: Set<string>;
  reindexFn: (options: { stashDir: string }) => Promise<unknown>;
}): Promise<ImprovePostLoopResult> {
  const {
    scope,
    options,
    primaryStashDir,
    actionableRefs,
    appliedCleanup,
    cleanupWarnings,
    memorySummary,
    memoryRefsForInference,
    reindexFn,
  } = args;
  const allWarnings = [...cleanupWarnings, ...(appliedCleanup?.warnings ?? [])];

  const baseConfig = options.config ?? loadConfig();
  const MEMORY_VOLUME_THRESHOLD = options.memoryVolumeConsolidationThreshold ?? 100;
  const hasLlm = !!(baseConfig.llm || baseConfig.agent);
  const volumeTriggered =
    typeof memorySummary.eligible === "number" && memorySummary.eligible > MEMORY_VOLUME_THRESHOLD && hasLlm;
  const consolidationConfig: AkmConfig = volumeTriggered
    ? {
        ...baseConfig,
        ...(baseConfig.llm
          ? {
              llm: {
                ...baseConfig.llm,
                features: { ...baseConfig.llm.features, memory_consolidation: true },
              },
            }
          : {}),
      }
    : baseConfig;

  const consolidateCooldownDays = options.consolidateCooldownDays ?? 14;
  const CONSOLIDATE_COOLDOWN_MS = consolidateCooldownDays * 24 * 60 * 60 * 1000;
  const recentConsolidations = readEvents({ type: "consolidate_completed" });
  const lastConsolidation = recentConsolidations.events
    .filter((e) => e.metadata?.processed && Number(e.metadata.processed) > 0)
    .sort((a, b) => new Date(b.ts ?? 0).getTime() - new Date(a.ts ?? 0).getTime())[0];
  const consolidationOnCooldown =
    !volumeTriggered &&
    consolidateCooldownDays > 0 &&
    lastConsolidation?.ts &&
    Date.now() - new Date(lastConsolidation.ts).getTime() < CONSOLIDATE_COOLDOWN_MS;

  let consolidation: ConsolidateResult = {
    schemaVersion: 1,
    ok: true,
    shape: "consolidate-result",
    dryRun: false,
    previewOnly: false,
    target: "",
    processed: 0,
    merged: 0,
    deleted: 0,
    promoted: [],
    warnings: [],
    durationMs: 0,
  };
  if (!consolidationOnCooldown) {
    consolidation = await akmConsolidate({
      ...options.consolidateOptions,
      config: consolidationConfig,
      stashDir: options.stashDir,
      autoTriggered: volumeTriggered,
      autoAccept: "safe",
    });
    if (consolidation.processed > 0) {
      appendEvent({
        eventType: "consolidate_completed",
        ref: "memory:_consolidation",
        metadata: { processed: consolidation.processed, merged: consolidation.merged },
      });
    }
  } else {
    const daysAgo = Math.round((Date.now() - new Date(lastConsolidation?.ts ?? 0).getTime()) / 86400000);
    appendEvent({
      eventType: "improve_skipped",
      ref: "memory:_consolidation",
      metadata: {
        reason: "consolidation_cooldown",
        cooldownDays: 14,
        lastEventTs: lastConsolidation?.ts ?? null,
      },
    });
    info(`[improve] consolidation skipped (last ran ${daysAgo}d ago, cooldown 14d)`);
  }

  // D9: track whether consolidation wrote any data so graph extraction can reindex if needed
  const consolidationRan = !consolidationOnCooldown && consolidation.processed > 0;

  info("[improve] post-loop maintenance starting");
  const maintenanceResult = await runImproveMaintenancePasses({
    options,
    primaryStashDir,
    actionableRefs,
    memoryRefsForInference,
    allWarnings,
    reindexFn,
    consolidationRan,
  });

  let deadUrls: DeadUrl[] | undefined;
  if (scope.mode === "all" && primaryStashDir && actionableRefs.length > 0) {
    try {
      const knowledgeEntries = actionableRefs
        .filter((r) => {
          try {
            return parseAssetRef(r.ref).type === "knowledge";
          } catch {
            return false;
          }
        })
        .slice(0, 10)
        .map((r) => ({ ref: r.ref, body: "" }));
      if (knowledgeEntries.length > 0) {
        info(`[improve] checking URLs in ${knowledgeEntries.length} knowledge refs`);
        deadUrls = await checkDeadUrls(primaryStashDir, knowledgeEntries);
        info(`[improve] URL check complete (${deadUrls.length} dead/timeout URLs)`);
      }
    } catch {
      // best-effort
    }
  }

  return {
    allWarnings,
    consolidation,
    deadUrls,
    ...(maintenanceResult.memoryInference ? { memoryInference: maintenanceResult.memoryInference } : {}),
    ...(maintenanceResult.graphExtraction ? { graphExtraction: maintenanceResult.graphExtraction } : {}),
    ...(maintenanceResult.actions && maintenanceResult.actions.length > 0
      ? { maintenanceActions: maintenanceResult.actions }
      : {}),
    memoryInferenceDurationMs: maintenanceResult.memoryInferenceDurationMs,
    graphExtractionDurationMs: maintenanceResult.graphExtractionDurationMs,
  };
}

async function runImproveMaintenancePasses(args: {
  options: AkmImproveOptions;
  primaryStashDir?: string;
  actionableRefs: ImproveEligibleRef[];
  memoryRefsForInference: Set<string>;
  allWarnings: string[];
  reindexFn: (options: { stashDir: string }) => Promise<unknown>;
  /** D9: true when consolidation ran and wrote at least one record this improve run. */
  consolidationRan?: boolean;
}): Promise<ImproveMaintenanceResult> {
  const { options, primaryStashDir, memoryRefsForInference, allWarnings, reindexFn, consolidationRan } = args;
  if (!primaryStashDir) return { memoryInferenceDurationMs: 0, graphExtractionDurationMs: 0 };

  const config = options.config ?? loadConfig();
  const sources = resolveSourceEntries(options.stashDir, config);
  const memoryInferenceFn = options.memoryInferenceFn ?? runMemoryInferencePass;
  const graphExtractionFn = options.graphExtractionFn ?? runGraphExtractionPass;

  let db: Database | undefined;
  let memoryInference: MemoryInferenceResult | undefined;
  let graphExtraction: GraphExtractionResult | undefined;
  let reindexedAfterInference = false;
  const actions: ImproveActionResult[] = [];
  let memoryInferenceDurationMs = 0;
  let graphExtractionDurationMs = 0;

  try {
    db = openDatabase(
      getDbPath(),
      config.embedding?.dimension ? { embeddingDim: config.embedding.dimension } : undefined,
    );

    if (memoryRefsForInference.size > 0) {
      info(`[improve] memory inference starting (${memoryRefsForInference.size} candidate refs)`);
      const inferenceStart = Date.now();
      try {
        memoryInference = await memoryInferenceFn(
          config,
          sources,
          undefined,
          db,
          false,
          (event) => {
            const current = event.currentRef ? ` ${event.currentRef}` : "";
            info(
              `[improve] memory inference ${event.processed}/${event.total}${current} (written ${event.writtenFacts}, skipped ${event.skippedNoFacts})`,
            );
          },
          {
            candidateRefs: memoryRefsForInference,
          } satisfies MemoryInferencePassOptions,
        );
        memoryInferenceDurationMs = Date.now() - inferenceStart;
        actions.push({ ref: "memory:_inference", mode: "memory-inference", result: memoryInference });
        info(
          `[improve] memory inference complete (${memoryInference.writtenFacts} facts written from ${memoryInference.splitParents} parents)`,
        );
      } catch (err) {
        memoryInferenceDurationMs = Date.now() - inferenceStart;
        allWarnings.push(`memory inference failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (memoryInference && (memoryInference.splitParents > 0 || memoryInference.writtenFacts > 0)) {
      info("[improve] reindexing after memory inference writes");
      try {
        await reindexFn({ stashDir: primaryStashDir });
        reindexedAfterInference = true;
        info("[improve] reindex after memory inference complete");
      } catch (err) {
        allWarnings.push(`reindex after memory inference failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (sources.length > 0) {
      info("[improve] graph extraction starting");
      const extractionStart = Date.now();
      try {
        // D9: if consolidation ran but memory inference did not reindex, force a reindex
        // so graph extraction sees current DB state after consolidation writes.
        if (consolidationRan && !reindexedAfterInference) {
          info("[improve] reindexing after consolidation (graph extraction needs current state)");
          try {
            await reindexFn({ stashDir: primaryStashDir });
            reindexedAfterInference = true;
            info("[improve] reindex after consolidation complete");
          } catch (err) {
            allWarnings.push(`reindex after consolidation failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (db && reindexedAfterInference) {
          closeDatabase(db);
          db = openDatabase(
            getDbPath(),
            config.embedding?.dimension ? { embeddingDim: config.embedding.dimension } : undefined,
          );
        }
        graphExtraction = await graphExtractionFn(config, sources, undefined, db, false, (event) => {
          const current = event.currentPath ? ` ${path.basename(event.currentPath)}` : "";
          info(
            `[improve] graph extraction ${event.processed}/${event.total}${current} (extracted ${event.extracted}, entities ${event.totalEntities}, relations ${event.totalRelations})`,
          );
        });
        graphExtractionDurationMs = Date.now() - extractionStart;
        actions.push({ ref: "graph:_artifact", mode: "graph-extraction", result: graphExtraction });
        info(
          `[improve] graph extraction complete (${graphExtraction.quality.extractedFiles} files, ${graphExtraction.quality.entityCount} entities, ${graphExtraction.quality.relationCount} relations)`,
        );
      } catch (err) {
        graphExtractionDurationMs = Date.now() - extractionStart;
        allWarnings.push(`graph extraction failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    if (db) closeDatabase(db);
  }

  return {
    ...(memoryInference ? { memoryInference } : {}),
    ...(graphExtraction ? { graphExtraction } : {}),
    ...(actions.length > 0 ? { actions } : {}),
    memoryInferenceDurationMs,
    graphExtractionDurationMs,
  };
}

function shouldAnalyzeMemoryCleanup(
  scope: { mode: "all" | "type" | "ref"; value?: string },
  eligibleMemories: number,
  primaryStashDir: string | undefined,
): boolean {
  if (!primaryStashDir || eligibleMemories === 0) return false;
  if (scope.mode === "all") return true;
  if (scope.mode === "type") return scope.value === "memory";
  if (!scope.value) return false;
  return parseAssetRef(scope.value).type === "memory";
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

function buildUtilityMap(refs: ImproveEligibleRef[]): Map<string, number> {
  const map = new Map<string, number>();
  if (refs.length === 0) return map;
  const refSet = new Set(refs.map((r) => r.ref));
  let db: Database | undefined;
  try {
    db = openExistingDatabase();
    const allDbEntries = getAllEntries(db);
    const idToRef = new Map<number, string>();
    for (const indexed of allDbEntries) {
      const ref = makeAssetRef(indexed.entry.type, indexed.entry.name);
      if (refSet.has(ref)) idToRef.set(indexed.id, ref);
    }
    const ids = [...idToRef.keys()];
    if (ids.length > 0) {
      const scores = getUtilityScoresByIds(db, ids);
      for (const [id, score] of scores) {
        const ref = idToRef.get(id);
        if (ref) map.set(ref, score.utility);
      }
    }
  } catch {
    // best-effort: if DB unavailable, all utilities default to 0
  } finally {
    if (db) closeDatabase(db);
  }
  return map;
}

async function findAssetFilePath(ref: string, stashDir?: string, writableDirSet?: Set<string>): Promise<string | null> {
  return resolveAssetPath(ref, {
    stashDir,
    mode: "disk-only",
    writableDirSet,
    directoryIndexNames: ["SKILL.md"],
    preserveDirectNameFallback: true,
    honorOrigin: false,
  });
}
