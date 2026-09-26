// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The improve preparation stage: consolidation and session extraction (which
 * run before the loop), memory cleanup, structural validation, and candidate
 * selection for the reflect/distill loop.
 *
 * Candidate selection reads the improve ledger plus one set of signals: a ref
 * is eligible for a source when feedback newer than its last attempt landed and
 * no ledger window holds it. Refs without recent feedback can still be picked
 * by the fallback lanes (proactive maintenance, high salience, forgetting
 * safety); the survivors are ranked by salience, checked on disk and capped.
 * A plan-only run evaluates the same selectors against read snapshots and
 * writes nothing.
 */

import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "../../core/asset/frontmatter";
import { daysToMs } from "../../core/common";
import type { ImproveProfileConfig } from "../../core/config/config";
import { loadConfig } from "../../core/config/config";
import { ConfigError, rethrowIfTestIsolationError } from "../../core/errors";
import { appendEvent, type EventsContext, readEvents } from "../../core/events";
import type {
  ConsolidateResult,
  ImproveActionResult,
  ImproveEligibleRef,
  ImproveExecutionPlan,
  ImprovePlanGate,
} from "../../core/improve-types";
import { withStateDb } from "../../core/state-db";
import { info, warn } from "../../core/warn";
import { countUsageEventsByType } from "../../indexer/usage/usage-events";
import { getAvailableHarnesses } from "../../integrations/session-logs";
import type { SessionLogHarness } from "../../integrations/session-logs/types";
import type { Database } from "../../storage/database";
import { getZeroResultSearches } from "../../storage/repositories/index-entries-repository";
import { getRetrievalCounts } from "../../storage/repositories/index-utility-repository";
import { listStateProposals } from "../../storage/repositories/proposals-repository";
import { akmLint } from "../lint/index";
import type { EligibilitySource } from "../proposal/proposal-types";
import { runSchemaRepairPass } from "../sources/schema-repair";
import { isAutonomyLaneAllowed } from "./autonomy-gate";
import {
  akmConsolidate,
  type ConsolidationPoolSnapshot,
  inspectConsolidationPool,
  loadExistingKnowledgeBodyHashes,
  makeConsolidateResult,
} from "./consolidate";
import { computeSafeChunkSize, DEFAULT_CONTEXT_LENGTH_TOKENS } from "./consolidate/chunking";
import {
  assetTypeOf,
  buildUtilityMap,
  dedupeRefs,
  findAssetFilePath,
  isDistillCandidateRef,
  isLessonCandidate,
  resolveImproveScope,
  withIndexDb,
} from "./eligibility";
import { akmExtract, countNewExtractCandidates, type ResolvedExtractPlan } from "./extract";
import { computeValenceScore } from "./feedback-valence";
import type {
  AkmImproveOptions,
  ConsolidationPassResult,
  ImprovePreparationResult,
  ImproveScope,
} from "./improve-run-types";
import type { ResolvedImprovePlan } from "./improve-strategies";
import {
  isLedgerBlocked,
  type LedgerSnapshot,
  lastAttemptByRef,
  ledgerRowFor,
  loadLedgerSnapshot,
  stateKey,
  stripBundle,
} from "./ledger";
import { applyMemoryCleanup, type MemoryCleanupPlan } from "./memory/memory-improve";
import {
  getAllAssetOutcomes,
  getAssetOutcome,
  getOutcomeScoresByRef,
  OUTCOME_SCORE_MAX,
  outcomeScoreToSalience,
  projectAssetOutcome,
  updateAssetOutcome,
} from "./outcome-loop";
import { projectMemoryCleanup, selectEffectiveImproveRefs } from "./planner";
import { DEFAULT_DUE_DAYS, DEFAULT_MAX_PER_RUN, selectProactiveMaintenanceRefs } from "./proactive-maintenance";
import {
  buildRankChangeReport,
  computeSalience,
  getAllRankScores,
  getAssetSalience,
  getLastUseMsByRef,
  isContentEncodingRow,
  SALIENCE_NO_OP_DAMPEN_FACTOR,
  SALIENCE_NO_OP_DAMPEN_THRESHOLD,
  upsertAssetSalience,
} from "./salience";
import { attributeStage, errMessage } from "./stage";

type Salience = ReturnType<typeof computeSalience>;
type FeedbackSignal = { hasSignal: boolean; positive: number; negative: number };

/** The candidate's durable state key (salience, outcome, ledger). */
const keyOf = (r: ImproveEligibleRef): string => stateKey(r.ref, r.itemRef);

/**
 * Run `fn` against the run's state.db (its long-lived handle when there is
 * one). A plan-only run without a handle reads nothing. Best-effort.
 */
function withRunState<T>(
  eventsCtx: EventsContext | undefined,
  persist: boolean,
  fn: (db: Database) => T,
): T | undefined {
  if (!persist && !eventsCtx?.db) return undefined;
  try {
    return withStateDb(fn, { path: eventsCtx?.dbPath, borrowed: eventsCtx?.db });
  } catch (err) {
    rethrowIfTestIsolationError(err);
    return undefined;
  }
}

function fileSize(filePath: string | undefined): number | undefined {
  if (!filePath) return undefined;
  try {
    return fs.statSync(filePath).size;
  } catch {
    return undefined;
  }
}

/** `{ key: value }` for each key `source` defines. */
export function pickDefined<T extends object, K extends keyof T>(
  source: T | undefined,
  keys: readonly K[],
): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  for (const key of keys) if (source?.[key] !== undefined) out[key] = source[key];
  return out;
}

export const CONSOLIDATION_CONFIG_KEYS = [
  "enabled",
  "minPoolSize",
  "limit",
  "maxChunkSize",
  "incrementalSince",
] as const;

/** Emit an aggregate `improve_skipped` row (never one per ref). */
export function recordImproveSkip(
  eventsCtx: EventsContext | undefined,
  ref: string | undefined,
  metadata: Record<string, unknown>,
): void {
  appendEvent({ eventType: "improve_skipped", ref, metadata }, eventsCtx);
}

/** Per-originator rolling error windows (3 each) shown to later prompts as patterns to avoid. */
export function pushRecentError(recentErrors: Record<string, string[]>, originator: string, msg: string): void {
  const window = recentErrors[originator] ?? [];
  window.push(msg);
  if (window.length > 3) window.shift();
  recentErrors[originator] = window;
}

// ── Consolidation ────────────────────────────────────────────────────────────

/**
 * The consolidation gates and pool, with no model call: the profile toggle,
 * `minPoolSize` (not for a named strategy or ref scope, nor once the pool is
 * over the 100-memory volume trigger), and the ledger delta (every memory
 * judged recently and unchanged since means nothing to do).
 */
function planConsolidationPass(args: {
  options: AkmImproveOptions;
  primaryStashDir?: string;
  memorySummary: { eligible: number; derived: number };
  improveProfile?: ImproveProfileConfig;
  resolvedPlan: ResolvedImprovePlan;
  eventsCtx?: EventsContext;
  existingKnowledgeBodyHashes?: Set<string>;
}): {
  poolBelowMinSize: boolean;
  eligiblePoolSize: number;
  minPoolSize: number;
  plan: ImproveExecutionPlan["consolidation"];
} {
  const { options, primaryStashDir, memorySummary, resolvedPlan } = args;
  const processConfig = args.improveProfile?.processes?.consolidate;
  const volumeTriggered = memorySummary.eligible > 100 && resolvedPlan.processes.consolidate.runner !== null;
  const minPoolSize = typeof processConfig?.minPoolSize === "number" ? processConfig.minPoolSize : 0;
  const eligiblePoolSize = typeof memorySummary.eligible === "number" ? memorySummary.eligible : 0;
  const userNamed = options.strategy !== undefined || resolveImproveScope(options.scope).mode === "ref";
  const poolBelowMinSize = !volumeTriggered && !userNamed && minPoolSize > 0 && eligiblePoolSize < minPoolSize;
  const pool: Pick<ConsolidationPoolSnapshot, "poolSize" | "candidatePoolSize" | "judgedUnchanged"> = primaryStashDir
    ? inspectConsolidationPool(
        {
          config: options.config,
          stashDir: options.stashDir,
          writeTarget: options.writeTarget,
          target: options.target,
          limit: processConfig?.limit,
          incrementalSince: processConfig?.incrementalSince,
          neighborsPerChanged: processConfig?.neighborsPerChanged,
          maxChunkSize: processConfig?.maxChunkSize,
        },
        primaryStashDir,
        [],
        args.existingKnowledgeBodyHashes ?? loadExistingKnowledgeBodyHashes(primaryStashDir),
        { readOnly: args.eventsCtx?.readOnly === true },
      )
    : { poolSize: 0, candidatePoolSize: 0, judgedUnchanged: 0 };
  // A credential-unavailable engine still resolved its context length.
  const unavailable = resolvedPlan.engineUnavailable.find((item) => item.process === "consolidate");
  const chunkSize = computeSafeChunkSize(
    resolvedPlan.processes.consolidate.runner?.connection.contextLength ??
      unavailable?.contextLength ??
      DEFAULT_CONTEXT_LENGTH_TOKENS,
    500,
    processConfig?.maxChunkSize,
  );
  const profilePassed = processConfig?.enabled !== false;
  const deltaPassed = pool.candidatePoolSize > 0 || pool.judgedUnchanged === 0;
  const wouldRun = profilePassed && !poolBelowMinSize && deltaPassed && pool.candidatePoolSize > 0;
  const belowMin = `pool ${eligiblePoolSize} is below minPoolSize ${minPoolSize}`;
  const unchanged = "every memory was judged recently and is unchanged since";
  return {
    poolBelowMinSize,
    eligiblePoolSize,
    minPoolSize,
    plan: {
      configured: pickDefined(processConfig, CONSOLIDATION_CONFIG_KEYS),
      effective: {
        enabled: profilePassed,
        minPoolSize,
        ...(processConfig?.limit !== undefined ? { limit: processConfig.limit } : {}),
        chunkSize,
      },
      poolSize: pool.poolSize,
      candidatePoolSize: pool.candidatePoolSize,
      gates: {
        profile: {
          passed: profilePassed,
          reason: profilePassed ? "consolidation enabled" : "disabled by improve profile",
        },
        minimumPool: {
          passed: !poolBelowMinSize,
          reason: poolBelowMinSize ? belowMin : `pool satisfies minPoolSize ${minPoolSize}`,
        },
        delta: {
          passed: deltaPassed,
          reason: !deltaPassed
            ? unchanged
            : pool.judgedUnchanged > 0
              ? `${pool.judgedUnchanged} recently judged, unchanged memories skipped`
              : "no memory was judged recently",
        },
      },
      wouldRun,
      reason: !profilePassed
        ? "disabled by improve profile"
        : poolBelowMinSize
          ? belowMin
          : !deltaPassed
            ? unchanged
            : pool.candidatePoolSize === 0
              ? "candidate pool is empty after narrowing"
              : "all consolidation gates pass",
      estimatedChunks: wouldRun ? Math.ceil(pool.candidatePoolSize / chunkSize) : 0,
    },
  };
}

async function runConsolidationPass(args: ImprovePreparationStageArgs): Promise<ConsolidationPassResult> {
  const { options, primaryStashDir, improveProfile, resolvedPlan, eventsCtx } = args;
  // Walked once and shared with the live pass.
  const existingKnowledgeBodyHashes = primaryStashDir ? loadExistingKnowledgeBodyHashes(primaryStashDir) : undefined;
  const planned = planConsolidationPass({ ...args, existingKnowledgeBodyHashes });
  const processConfig = improveProfile?.processes?.consolidate;
  let consolidation: ConsolidateResult = makeConsolidateResult({ target: "", durationMs: 0 });
  if (!planned.plan.gates.profile.passed) {
    info("[improve] consolidation skipped (disabled by improve profile)");
  } else if (planned.poolBelowMinSize) {
    recordImproveSkip(eventsCtx, "memories/_consolidation", {
      reason: "pool_below_min_size",
      poolSize: planned.eligiblePoolSize,
      minPoolSize: planned.minPoolSize,
    });
    info(`[improve] consolidation skipped (pool ${planned.eligiblePoolSize} < minPoolSize ${planned.minPoolSize})`);
  } else if (!planned.plan.gates.delta.passed) {
    recordImproveSkip(eventsCtx, "memories/_consolidation", { reason: "consolidation_no_memory_updates" });
    info("[improve] consolidation skipped (every memory was judged recently and is unchanged)");
  } else {
    consolidation = await attributeStage(resolvedPlan, "consolidate", () =>
      akmConsolidate({
        target: options.target,
        ...(options.writeTarget ? { writeTarget: options.writeTarget } : {}),
        config: options.config ?? loadConfig(),
        dryRun: options.dryRun ?? false,
        stashDir: options.stashDir,
        improveProfile,
        llmRunner: resolvedPlan.processes.consolidate.runner,
        existingKnowledgeBodyHashes,
        sourceRun: `consolidate-${Date.now()}`,
        limit: processConfig?.limit,
        incrementalSince: processConfig?.incrementalSince,
        neighborsPerChanged: processConfig?.neighborsPerChanged,
        maxChunkSize: processConfig?.maxChunkSize,
        signal: args.budgetSignal,
        p90ChunkSecondsDefault: processConfig?.p90ChunkSecondsDefault,
      }),
    );
  }
  return { consolidation, plan: planned.plan };
}

// ── Session extraction ───────────────────────────────────────────────────────

interface ExtractPassPlan {
  availableHarnesses: SessionLogHarness[];
  minNewSessions: number;
  newCandidateCount?: number;
  belowMinNewSessions: boolean;
  wouldRun: boolean;
  reason: string;
}

/** The extract gates, evaluated once for both the live pass and the dry-run report. */
function inspectExtractPass(args: ImprovePreparationStageArgs, readOnly: boolean): ExtractPassPlan {
  const { options, improveProfile, resolvedPlan, eventsCtx } = args;
  const enabled = resolvedPlan.processes.extract.enabled;
  const hasRunner = resolvedPlan.processes.extract.runner?.engine !== undefined;
  const availableHarnesses = (options.extractHarnesses ?? getAvailableHarnesses()).filter((h) => h.isAvailable());
  const configured = improveProfile.processes?.extract?.minNewSessions;
  const minNewSessions = typeof configured === "number" ? configured : 0;
  let newCandidateCount: number | undefined;
  if (enabled && hasRunner && availableHarnesses.length > 0 && minNewSessions > 0) {
    const defaultSince = improveProfile.processes?.extract?.defaultSince;
    newCandidateCount = (options.extractCandidateCountFn ?? countNewExtractCandidates)(options.config ?? loadConfig(), {
      harnesses: availableHarnesses,
      improveProfile,
      ...(defaultSince ? { since: defaultSince } : {}),
      ...(eventsCtx?.db ? { stateDb: eventsCtx.db } : {}),
      ...(!readOnly && eventsCtx?.dbPath ? { stateDbPath: eventsCtx.dbPath } : {}),
      ...(readOnly ? { readOnly: true } : {}),
    });
  }
  const belowMinNewSessions =
    minNewSessions > 0 && newCandidateCount !== undefined && newCandidateCount < minNewSessions;
  const count = `${newCandidateCount ?? 0} new sessions`;
  return {
    availableHarnesses,
    minNewSessions,
    ...(newCandidateCount !== undefined ? { newCandidateCount } : {}),
    belowMinNewSessions,
    wouldRun: enabled && hasRunner && availableHarnesses.length > 0 && !belowMinNewSessions,
    reason: !enabled
      ? "disabled"
      : !hasRunner
        ? "enabled but no runner is resolved"
        : availableHarnesses.length === 0
          ? "enabled but no session-log harness is available"
          : belowMinNewSessions
            ? `${count} is below minNewSessions ${minNewSessions}`
            : minNewSessions > 0
              ? `${count} satisfies minNewSessions ${minNewSessions}`
              : `enabled with ${availableHarnesses.length} available session-log harness(es); minNewSessions is disabled`,
  };
}

/**
 * One `akmExtract` per available harness under the strategy's frozen plan. A
 * harness that throws is a warning; the `minNewSessions` gate skips the whole
 * pass with no model call.
 */
async function runSessionExtractPass(
  args: ImprovePreparationStageArgs,
  plan: ExtractPassPlan,
): Promise<{ extractResults?: Awaited<ReturnType<typeof akmExtract>>[]; warnings: string[] }> {
  const { options, primaryStashDir, resolvedPlan, eventsCtx } = args;
  const warnings: string[] = [];
  if (!resolvedPlan.processes.extract.enabled) return { warnings };
  const runner = resolvedPlan.processes.extract.runner;
  if (!runner?.engine) {
    throw new ConfigError("Resolved improve plan has no runner for enabled extract process.", "LLM_NOT_CONFIGURED");
  }
  const config = options.config ?? loadConfig();
  const extractPlan: ResolvedExtractPlan = Object.freeze({
    strategy: resolvedPlan.strategy.name,
    engine: runner.engine,
    enabled: true,
    process: resolvedPlan.processes.extract.config,
    runner,
    timeoutMs: runner.timeoutMs === undefined ? 600_000 : runner.timeoutMs,
    embeddingConfig: Object.freeze(structuredClone(config.embedding)),
    ...(resolvedPlan.processes.extract.notices?.length ? { notices: resolvedPlan.processes.extract.notices } : {}),
  });
  if (plan.belowMinNewSessions) {
    recordImproveSkip(eventsCtx, "memories/_extract", {
      reason: "below_min_new_sessions",
      newSessions: plan.newCandidateCount ?? 0,
      minNewSessions: plan.minNewSessions,
    });
    info(
      `[improve] extract skipped (new sessions ${plan.newCandidateCount ?? 0} < minNewSessions ${plan.minNewSessions})`,
    );
  }
  if (!plan.wouldRun) return { warnings };
  const extractResults: Awaited<ReturnType<typeof akmExtract>>[] = [];
  for (const harness of plan.availableHarnesses) {
    try {
      extractResults.push(
        await attributeStage(resolvedPlan, "extract", () =>
          akmExtract({
            type: harness.name,
            ...(primaryStashDir !== undefined ? { stashDir: primaryStashDir } : {}),
            config,
            resolvedPlan: extractPlan,
            dryRun: options.dryRun ?? false,
            signal: args.budgetSignal,
            ...(options.extractHarnesses ? { harnesses: options.extractHarnesses } : {}),
            ...(eventsCtx?.dbPath ? { stateDbPath: eventsCtx.dbPath } : {}),
            eventsCtx,
          }),
        ),
      );
    } catch (err) {
      warnings.push(`extract(${harness.name}) failed: ${errMessage(err)}`);
    }
  }
  // Every harness threw: no `extract` field rather than a misleadingly empty one.
  return { ...(extractResults.length > 0 ? { extractResults } : {}), warnings };
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Structural validation (file on disk, lesson description) with optional LLM
 * schema repair. A repair is advisory: a ref leaves the failure set only when a
 * fresh read of the live asset passes.
 */
export async function runValidationAndRepairPass(args: {
  postCleanupRefs: ImproveEligibleRef[];
  options: AkmImproveOptions;
  startMs: number;
  budgetMs: number;
  primaryStashDir?: string;
  resolvedPlan: ResolvedImprovePlan;
  repairValidationFailures: boolean;
  schemaRepairFn?: typeof runSchemaRepairPass;
}): Promise<{
  validationFailures: Array<{ ref: string; reason: string }>;
  validationFailureRefs: Set<string>;
  schemaRepairs: ImprovePreparationResult["schemaRepairs"];
}> {
  const { postCleanupRefs, options, resolvedPlan, repairValidationFailures } = args;
  const validate = async (candidate: ImproveEligibleRef): Promise<string | undefined> => {
    try {
      const filePath =
        candidate.filePath && fs.existsSync(candidate.filePath)
          ? candidate.filePath
          : await findAssetFilePath(candidate.ref, options.stashDir);
      if (!filePath) return "file not found on disk";
      if (path.extname(filePath).toLowerCase() !== ".md") return undefined;
      if (isLessonCandidate(candidate.ref) && !parseFrontmatter(fs.readFileSync(filePath, "utf8")).data.description) {
        return "missing description";
      }
      return undefined;
    } catch (error) {
      return String(error);
    }
  };
  const validationFailures: Array<{ ref: string; reason: string }> = [];
  for (const candidate of postCleanupRefs) {
    const reason = await validate(candidate);
    if (reason) validationFailures.push({ ref: candidate.ref, reason });
  }
  if (validationFailures.length > 0) {
    info(
      `[improve] ${validationFailures.length} assets have validation issues${repairValidationFailures ? " (will attempt schema repair)" : ""}:`,
    );
    for (const f of validationFailures) info(`  ${f.ref}: ${f.reason}`);
  }
  let schemaRepairs: ImprovePreparationResult["schemaRepairs"] = [];
  const repaired = new Set<string>();
  const runner = resolvedPlan.processes.validation.runner;
  if (repairValidationFailures && validationFailures.length > 0 && runner) {
    const result = await attributeStage(resolvedPlan, "validation", () =>
      (args.schemaRepairFn ?? runSchemaRepairPass)(validationFailures, {
        startMs: args.startMs,
        budgetMs: args.budgetMs,
        llmRunner: runner,
        // The resolved source path, not the raw `--stash-dir` flag.
        stashDir: args.primaryStashDir,
        findFilePath: findAssetFilePath,
        isLessonCandidateFn: isLessonCandidate,
      }),
    );
    schemaRepairs = result.repairs;
    const byRef = new Map(postCleanupRefs.map((candidate) => [candidate.ref, candidate]));
    for (const { ref } of validationFailures) {
      const candidate = byRef.get(ref);
      if (candidate && !(await validate(candidate))) repaired.add(ref);
    }
  }
  const validationFailureRefs = new Set(validationFailures.filter((f) => !repaired.has(f.ref)).map((f) => f.ref));
  if (repaired.size > 0) {
    info(
      `[improve] schema repair fixed ${repaired.size}/${validationFailures.length} validation failures; ${validationFailureRefs.size} remain`,
    );
  }
  return { validationFailures, validationFailureRefs, schemaRepairs };
}

// ── The stage ────────────────────────────────────────────────────────────────

export interface ImprovePreparationStageArgs {
  scope: ImproveScope;
  options: AkmImproveOptions;
  plannedRefs: ImproveEligibleRef[];
  memoryCleanupPlan?: MemoryCleanupPlan;
  primaryStashDir?: string;
  memorySummary: { eligible: number; derived: number };
  reindexFn: (options: { stashDir: string; signal?: AbortSignal }) => Promise<unknown>;
  startMs: number;
  budgetMs: number;
  eventsCtx?: EventsContext;
  /** Warnings from before this stage (e.g. the ensureIndex bootstrap). */
  initialCleanupWarnings?: string[];
  improveProfile: ImproveProfileConfig;
  resolvedPlan: ResolvedImprovePlan;
  /** Strategy name for run-level event metadata. */
  strategyName: string;
  budgetSignal?: AbortSignal;
  /** Evaluate every selector and gate without dispatching or persisting. */
  planOnly?: boolean;
}

export async function runImprovePreparationStage(args: ImprovePreparationStageArgs): Promise<ImprovePreparationResult> {
  const { scope, options, plannedRefs, memoryCleanupPlan, primaryStashDir, eventsCtx, resolvedPlan } = args;
  const planOnly = args.planOnly ?? options.dryRun === true;
  const persist = !planOnly;
  const actions: ImproveActionResult[] = [];
  const cleanupWarnings: string[] = [...(args.initialCleanupWarnings ?? [])];
  const memoryIndexHealth = assessMemoryIndex(primaryStashDir, cleanupWarnings);

  // Consolidation precedes extract, so it only judges memories from earlier runs.
  const consolidationPass: ConsolidationPassResult = planOnly
    ? {
        consolidation: makeConsolidateResult({
          dryRun: true,
          previewOnly: true,
          target: options.target ?? options.stashDir ?? "",
          durationMs: 0,
        }),
        plan: planConsolidationPass(args).plan,
      }
    : await runConsolidationPass(args);
  const extractPlan = inspectExtractPass(args, planOnly);
  const extractPass = planOnly ? { warnings: [] } : await runSessionExtractPass(args, extractPlan);
  cleanupWarnings.push(...extractPass.warnings);
  if (persist) {
    appendEvent(
      {
        eventType: "improve_invoked",
        ref: scope.mode === "ref" ? scope.value : `improve:${scope.mode}:${scope.value ?? "all"}`,
        metadata: {
          strategy: args.strategyName,
          scope,
          dryRun: options.dryRun ?? false,
          eligibleCount: plannedRefs.length,
        },
      },
      eventsCtx,
    );
  }

  // Memory cleanup: archive redundant derived memories (autonomy-gated).
  const allowCleanup = isAutonomyLaneAllowed("memoryCleanup", options.config ?? loadConfig());
  let appliedCleanup: ReturnType<typeof applyMemoryCleanup> | undefined;
  if (persist) {
    try {
      appliedCleanup =
        primaryStashDir && memoryCleanupPlan && allowCleanup
          ? applyMemoryCleanup(primaryStashDir, memoryCleanupPlan)
          : undefined;
    } catch (err) {
      cleanupWarnings.push(`applyMemoryCleanup failed: ${errMessage(err)}`);
    }
  }
  const cleanup = planOnly
    ? projectMemoryCleanup({
        mode: "estimate",
        plannedRefs,
        candidateRefs: memoryCleanupPlan?.pruneCandidates.map((candidate) => candidate.ref) ?? [],
        allowApply: allowCleanup,
      })
    : projectMemoryCleanup({
        mode: "execution",
        plannedRefs,
        archivedRefs: appliedCleanup?.archived.map((record) => record.ref) ?? [],
        allowApply: allowCleanup,
      });
  if (appliedCleanup) {
    for (const candidate of memoryCleanupPlan?.pruneCandidates ?? []) {
      if (!appliedCleanup.archived.some((record) => record.ref === candidate.ref)) continue;
      actions.push({
        ref: candidate.ref,
        mode: "memory-prune",
        result: { ok: true, pruned: true, reason: candidate.reason },
      });
    }
    if ((appliedCleanup.archived.length > 0 || appliedCleanup.beliefStateTransitions.length > 0) && primaryStashDir) {
      try {
        await args.reindexFn({ stashDir: primaryStashDir, signal: args.budgetSignal });
      } catch (err) {
        cleanupWarnings.push(`reindex after cleanup failed: ${errMessage(err)}`);
      }
    }
  }
  const { postCleanupRefs } = cleanup;

  const { validationFailures, validationFailureRefs, schemaRepairs } = await runValidationAndRepairPass({
    postCleanupRefs,
    options,
    startMs: args.startMs,
    budgetMs: args.budgetMs,
    primaryStashDir,
    resolvedPlan,
    repairValidationFailures:
      persist && resolvedPlan.processes.validation.enabled && options.repairValidationFailures !== false,
  });

  let lintSummary: { fixed: number; flagged: number } | undefined;
  if (primaryStashDir) {
    try {
      const lintResult = await akmLint({ fix: false, dir: primaryStashDir });
      lintSummary = { fixed: lintResult.summary.fixed, flagged: lintResult.summary.flagged };
    } catch {
      // lint never blocks improve
    }
  }
  // Schema-repair errors get their own window; they are never shown to reflect.
  const recentErrors: Record<string, string[]> = {};
  for (const repair of schemaRepairs) {
    if (repair.outcome !== "error") continue;
    pushRecentError(recentErrors, "schema-repair", repair.error ?? `schema repair error: ${repair.reason}`);
  }

  const selection = await selectLoopCandidates(args, postCleanupRefs, validationFailureRefs, actions, persist);
  return {
    actions,
    cleanupWarnings,
    appliedCleanup,
    memoryIndexHealth,
    extract: extractPass.extractResults,
    actionableRefs: selection.actionableRefs,
    signalBearingSet: selection.signalBearingSet,
    validationFailures,
    schemaRepairs,
    lintSummary,
    loopRefs: selection.loopRefs,
    distillCooledRefs: selection.distillCooledRefs,
    distillOnlyRefs: selection.distillOnlyRefs,
    coverageGaps: selection.coverageGaps,
    recentErrors,
    consolidation: consolidationPass.consolidation,
    ...(selection.proactive.proactiveMaintenanceSummary
      ? { proactiveMaintenance: selection.proactive.proactiveMaintenanceSummary }
      : {}),
    planning: {
      gates: [
        cleanup.gate,
        { name: "validation", removed: validationFailureRefs.size, reason: "structural validation failures" },
        ...selection.gates,
      ],
      ...(selection.proactive.proactivePlan ? { proactive: selection.proactive.proactivePlan } : {}),
      consolidation: consolidationPass.plan,
      extract: { wouldRun: extractPlan.wouldRun, reason: extractPlan.reason },
    },
  };
}

/** MEMORY.md line budget: warn at 180 of 200 lines. */
function assessMemoryIndex(
  primaryStashDir: string | undefined,
  warnings: string[],
): { lineCount: number; overBudget: boolean } | undefined {
  if (!primaryStashDir) return undefined;
  const memoryMdPath = path.join(primaryStashDir, "memories", "MEMORY.md");
  if (!fs.existsSync(memoryMdPath)) return undefined;
  try {
    const lineCount = fs.readFileSync(memoryMdPath, "utf8").split("\n").length;
    if (lineCount >= 180) {
      warnings.push(`MEMORY.md has ${lineCount} lines (budget: 200). Consolidation strongly recommended.`);
    }
    return { lineCount, overBudget: lineCount >= 180 };
  } catch {
    return undefined;
  }
}

// ── Candidate selection ──────────────────────────────────────────────────────

const FEEDBACK_SIGNAL_WINDOW_DAYS = 30;

/** Feedback that counts as a signal carries a signal or a note (a bare `akm feedback` does not). */
function isSignalEvent(metadata: unknown): boolean {
  const meta = metadata as { signal?: unknown; note?: unknown } | undefined;
  return meta !== undefined && (typeof meta.signal === "string" || typeof meta.note === "string");
}

interface SignalDeltaSnapshot {
  feedbackSinceCutoff: string;
  nowIso: string;
  /** Newest in-window signal per ref. */
  latestFeedbackTs: Map<string, string>;
  ledger: LedgerSnapshot;
  /** `ref → last_attempt_at` from the ledger. */
  lastReflectAttemptAt: Map<string, string>;
  lastDistillAttemptAt: Map<string, string>;
  /** In-window signal plus all-time positive/negative counts, per ref. */
  feedback: Map<string, FeedbackSignal>;
}

/** One read of the feedback events and the ledger's reflect/distill rows. */
export function buildSnapshotManifest(args: {
  postCleanupRefs: ImproveEligibleRef[];
  validationFailureRefs: Set<string>;
  eventsCtx?: EventsContext;
  stashDir?: string;
  readOnly?: boolean;
}): SignalDeltaSnapshot {
  const { eventsCtx, stashDir } = args;
  const feedbackSinceCutoff = new Date(Date.now() - daysToMs(FEEDBACK_SIGNAL_WINDOW_DAYS)).toISOString();
  const candidates = args.postCleanupRefs.filter((r) => !args.validationFailureRefs.has(r.ref));
  const refByKey = new Map(candidates.map((r) => [keyOf(r), r.ref]));
  const latestFeedbackTs = new Map<string, string>();
  const feedback = new Map<string, FeedbackSignal>(
    candidates.map((r) => [r.ref, { hasSignal: false, positive: 0, negative: 0 }]),
  );
  if (candidates.length > 0) {
    for (const e of readEvents({ type: "feedback" }, eventsCtx).events) {
      const ref = e.ref ? refByKey.get(e.ref) : undefined;
      const entry = ref ? feedback.get(ref) : undefined;
      if (!ref || !entry) continue;
      const ts = e.ts ?? "";
      if (ts >= feedbackSinceCutoff && isSignalEvent(e.metadata)) {
        entry.hasSignal = true;
        if (ts > (latestFeedbackTs.get(ref) ?? "")) latestFeedbackTs.set(ref, ts);
      }
      const signal = (e.metadata as { signal?: unknown } | undefined)?.signal;
      if (signal === "positive") entry.positive++;
      else if (signal === "negative") entry.negative++;
    }
  }
  const ledger: LedgerSnapshot = stashDir
    ? loadLedgerSnapshot({ eventsCtx, ...(args.readOnly ? { readOnly: true } : {}) }, stashDir, ["reflect", "distill"])
    : new Map();
  return {
    feedbackSinceCutoff,
    nowIso: new Date().toISOString(),
    latestFeedbackTs,
    ledger,
    lastReflectAttemptAt: lastAttemptByRef(ledger, "reflect", candidates),
    lastDistillAttemptAt: lastAttemptByRef(ledger, "distill", candidates),
    feedback,
  };
}

/**
 * Partition the post-cleanup refs against the ledger:
 *  - eligibleRefs: reflect's signal delta passes (distill may still be cooled);
 *  - distillOnlyRefs: only distill's passes, on a distill candidate;
 *  - noFeedbackPool: no recent feedback and no reflect window, left to the
 *    fallback lanes;
 *  - fullySkippedCount: feedback on record but nothing new, or a live window.
 * An explicit `--scope <ref>` bypasses every gate.
 */
export function partitionBySignalDelta(args: {
  scope: ImproveScope;
  options: AkmImproveOptions;
  postCleanupRefs: ImproveEligibleRef[];
  validationFailureRefs: Set<string>;
  snapshot: Pick<SignalDeltaSnapshot, "latestFeedbackTs" | "ledger" | "nowIso">;
}): {
  distillCooledRefs: Set<string>;
  preCooldownCount: number;
  eligibleRefs: ImproveEligibleRef[];
  distillOnlyRefs: ImproveEligibleRef[];
  noFeedbackPool: ImproveEligibleRef[];
  fullySkippedCount: number;
} {
  const { postCleanupRefs, validationFailureRefs } = args;
  const { latestFeedbackTs, ledger, nowIso } = args.snapshot;
  // Newer feedback lifts a revisit window, never a rejection.
  const deltaPasses = (candidate: ImproveEligibleRef, source: "reflect" | "distill"): boolean => {
    const feedbackAt = latestFeedbackTs.get(candidate.ref);
    if (!feedbackAt) return false;
    const row = ledgerRowFor(ledger, source, candidate.ref, candidate.itemRef);
    return feedbackAt > (row?.lastAttemptAt ?? "") && !isLedgerBlocked(row, nowIso, feedbackAt);
  };
  const out = {
    distillCooledRefs: new Set<string>(),
    preCooldownCount: postCleanupRefs.length,
    eligibleRefs: [] as ImproveEligibleRef[],
    distillOnlyRefs: [] as ImproveEligibleRef[],
    noFeedbackPool: [] as ImproveEligibleRef[],
    fullySkippedCount: 0,
  };
  for (const r of postCleanupRefs) {
    if (validationFailureRefs.has(r.ref)) continue;
    if (args.scope.mode === "ref") {
      out.eligibleRefs.push(r);
      continue;
    }
    const reflectOk = deltaPasses(r, "reflect");
    const distillOk = deltaPasses(r, "distill");
    if (reflectOk) {
      if (!distillOk) out.distillCooledRefs.add(r.ref);
      out.eligibleRefs.push(r);
    } else if (distillOk && isDistillCandidateRef(r.ref, args.options.stashDir)) {
      out.distillOnlyRefs.push(r);
    } else if (
      !latestFeedbackTs.has(r.ref) &&
      !isLedgerBlocked(ledgerRowFor(ledger, "reflect", r.ref, r.itemRef), nowIso)
    ) {
      out.noFeedbackPool.push(r);
    } else {
      out.fullySkippedCount++;
    }
  }
  return out;
}

/**
 * Pick the loop's refs: signal delta, the fallback lanes (unless
 * `--require-feedback-signal`), lane attribution, salience and forgetting
 * safety, the no-op-dampened ranking, the disk check and the limit.
 */
async function selectLoopCandidates(
  args: ImprovePreparationStageArgs,
  postCleanupRefs: ImproveEligibleRef[],
  validationFailureRefs: Set<string>,
  actions: ImproveActionResult[],
  persist: boolean,
) {
  const { scope, options, primaryStashDir, eventsCtx, improveProfile } = args;
  const snapshot = buildSnapshotManifest({
    postCleanupRefs,
    validationFailureRefs,
    eventsCtx,
    stashDir: primaryStashDir ?? options.stashDir,
    readOnly: !persist,
  });
  const partition = partitionBySignalDelta({ scope, options, postCleanupRefs, validationFailureRefs, snapshot });
  const processableRefs = [...partition.eligibleRefs, ...partition.distillOnlyRefs];
  const signalFiltered = processableRefs.filter((c) => snapshot.feedback.get(c.ref)?.hasSignal === true);
  const signalBearingSet = new Set(signalFiltered.map((r) => r.ref));
  const noFeedbackCandidates = dedupeRefs([
    ...processableRefs.filter((r) => !signalBearingSet.has(r.ref)),
    ...partition.noFeedbackPool,
  ]);
  const retrieval = fetchRetrievalSignals(options, signalFiltered, noFeedbackCandidates, eventsCtx, persist);
  const allowFallbacks = options.requireFeedbackSignal !== true;
  const proactive = allowFallbacks
    ? selectProactiveMaintenanceLane(args, noFeedbackCandidates, snapshot, retrieval, persist)
    : { proactiveRefs: [] as ImproveEligibleRef[] };
  const highSalienceRefs = allowFallbacks
    ? selectHighSalienceLane(
        options,
        improveProfile,
        eventsCtx,
        noFeedbackCandidates.filter((r) => !proactive.proactiveRefs.some((p) => p.ref === r.ref)),
        snapshot.lastReflectAttemptAt,
        persist,
      )
    : [];
  // An explicit ref scope always acts on its ref; otherwise usage signals gate the pool.
  const signalAndRetrievalRefs = dedupeRefs([...signalFiltered, ...proactive.proactiveRefs, ...highSalienceRefs]);
  let mergedRefs =
    scope.mode === "ref" ? processableRefs : options.requireFeedbackSignal ? signalFiltered : signalAndRetrievalRefs;

  // Lane attribution, weakest first so the strongest wins: high-salience <
  // proactive < signal-delta, and an explicit ref scope over everything.
  const sourceByRef = new Map<string, EligibilitySource>();
  for (const r of highSalienceRefs) sourceByRef.set(r.ref, "high-salience");
  for (const r of proactive.proactiveRefs) sourceByRef.set(r.ref, "proactive");
  for (const r of signalFiltered) sourceByRef.set(r.ref, "signal-delta");
  if (scope.mode === "ref") for (const r of processableRefs) sourceByRef.set(r.ref, "scope");
  for (const r of mergedRefs) r.eligibilitySource = sourceByRef.get(r.ref) ?? "unknown";

  // Forgetting safety may only reuse this plan's own surviving objects, and
  // never a ref whose reflect window is still open.
  const fallbackEligible = postCleanupRefs.filter((c) => !validationFailureRefs.has(c.ref));
  const forgettingEligible = fallbackEligible.filter(
    (c) => !isLedgerBlocked(ledgerRowFor(snapshot.ledger, "reflect", c.ref, c.itemRef), snapshot.nowIso),
  );
  const scored = scoreSalience(args, mergedRefs, snapshot.feedback, retrieval.retrievalCounts, persist);
  mergedRefs = applyForgettingSafety({
    pendingForgettingRefs: scored.pendingForgettingRefs,
    scope,
    mergedRefs,
    eligibleRefs: forgettingEligible,
    allowFallbacks,
    eligibilitySourceByRef: sourceByRef,
    highSalienceRefs,
    proactiveRefs: proactive.proactiveRefs,
    signalFiltered,
  });

  // Rank by salience; a ref skipped as a no-op repeatedly sorts lower (its stored rank is untouched).
  const noOps = new Map<string, number>();
  withRunState(eventsCtx, persist, (db) => {
    for (const r of mergedRefs) noOps.set(r.ref, getAssetSalience(db, keyOf(r))?.consecutive_no_ops ?? 0);
  });
  const effectiveScore = (ref: string): number => {
    const rank = scored.salienceMap.get(ref)?.rankScore ?? 0;
    return (noOps.get(ref) ?? 0) >= SALIENCE_NO_OP_DAMPEN_THRESHOLD ? rank * SALIENCE_NO_OP_DAMPEN_FACTOR : rank;
  };
  const sorted = [...mergedRefs].sort(
    (a, b) => effectiveScore(b.ref) - effectiveScore(a.ref) || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0),
  );
  const coverageGaps = withIndexDb(!persist, getZeroResultSearches) ?? [];
  const { actionableRefs, missing } = await dropRefsMissingOnDisk(sorted, options, eventsCtx, persist);
  const selection = selectEffectiveImproveRefs({
    rankedRefs: actionableRefs,
    distillOnlyRefs: partition.distillOnlyRefs,
    limit: options.limit,
  });

  if (signalAndRetrievalRefs.length > 0) {
    info(`[improve] ${signalAndRetrievalRefs.length} refs with usage signals (${signalFiltered.length} feedback)`);
  }
  if (validationFailureRefs.size > 0) info(`[improve] ${validationFailureRefs.size} with validation failures excluded`);
  if (persist && missing.length > 0) info(`[improve] ${missing.length} candidates dropped — file not on disk`);
  const deferred = actionableRefs.length - selection.loopRefs.length;
  info(
    `[improve] ${actionableRefs.length} actionable; ${selection.loopRefs.length} will be processed` +
      (options.limit && deferred > 0 ? ` (--limit ${options.limit} applied; ${deferred} deferred)` : ""),
  );

  // Skip observability waits until every fallback lane has finalized the
  // survivors, so a rescued ref is never also reported skipped.
  const survivors = new Set(sorted.map((c) => c.ref));
  const signalSkipped = fallbackEligible.filter((c) => !survivors.has(c.ref));
  for (const ref of partition.distillCooledRefs) {
    actions.push({ ref, mode: "distill-skipped", result: { ok: true, reason: "distill signal-delta" } });
    if (persist) recordImproveSkip(eventsCtx, ref, { reason: "distill_no_new_signal" });
  }
  for (const candidate of signalSkipped) {
    actions.push({
      ref: candidate.ref,
      mode: "distill-skipped",
      result: { ok: true, reason: "no new signal since last proposal" },
    });
  }
  if (persist && signalSkipped.length > 0) {
    recordImproveSkip(eventsCtx, undefined, { reason: "no_new_signal", count: signalSkipped.length });
  }
  const blocked = signalSkipped.length + partition.distillOnlyRefs.length;
  if (blocked > 0) {
    info(
      `[improve] ${blocked} of ${partition.preCooldownCount} indexed refs blocked by reflect signal-delta ` +
        `(${signalSkipped.length} fully skipped, ${partition.distillOnlyRefs.length} routed to distill-only)`,
    );
  }
  const gates: ImprovePlanGate[] = [
    {
      name: "signal",
      removed: signalSkipped.length,
      reason:
        "no fresh signal since the last attempt (or an improve-ledger window) and no fallback lane selected the ref",
    },
    { name: "disk", removed: missing.length, reason: "backing asset is absent on disk" },
    { name: "limit", removed: selection.limitRemoved, reason: "deferred by the effective run limit" },
  ];
  return {
    actionableRefs,
    loopRefs: selection.loopRefs,
    distillOnlyRefs: selection.distillOnlyRefs,
    distillCooledRefs: partition.distillCooledRefs,
    signalBearingSet,
    coverageGaps,
    gates,
    proactive,
  };
}

/** Retrieval counts for every candidate, and last-use times for the zero-feedback pool. */
function fetchRetrievalSignals(
  options: AkmImproveOptions,
  signalFiltered: ImproveEligibleRef[],
  noFeedbackCandidates: ImproveEligibleRef[],
  eventsCtx: EventsContext | undefined,
  persist: boolean,
): { retrievalCounts: Map<string, number>; lastUseMs: Map<string, number> } {
  const out = { retrievalCounts: new Map<string, number>(), lastUseMs: new Map<string, number>() };
  withIndexDb(!persist, (indexDb) => {
    // usage_events live in state.db, entries in index.db.
    withRunState(eventsCtx, persist, (stateDb) => {
      if (countUsageEventsByType(stateDb, "show") === 0) {
        warn(
          "Warning: show events not yet in usage_events — zero-feedback fallback will match only search-retrieved assets.",
        );
      }
      const refs = [...new Set([...signalFiltered, ...noFeedbackCandidates].map((r) => r.ref))];
      out.retrievalCounts = getRetrievalCounts(indexDb, stateDb, refs, { sourceName: options.sourceName });
    });
    out.lastUseMs = getLastUseMsByRef(indexDb, noFeedbackCandidates);
  });
  return out;
}

/**
 * Proactive maintenance (default off, whole-stash/type runs): revisit stable
 * assets on a schedule. The due gate doubles as the rotation cooldown: a
 * freshly reflected asset waits `dueDays` before it is picked again.
 */
function selectProactiveMaintenanceLane(
  args: ImprovePreparationStageArgs,
  candidates: ImproveEligibleRef[],
  snapshot: SignalDeltaSnapshot,
  retrieval: { retrievalCounts: Map<string, number>; lastUseMs: Map<string, number> },
  persist: boolean,
): {
  proactiveRefs: ImproveEligibleRef[];
  proactiveMaintenanceSummary?: ImprovePreparationResult["proactiveMaintenance"];
  proactivePlan?: ImproveExecutionPlan["proactive"];
} {
  if (args.scope.mode === "ref" || !args.resolvedPlan.processes.proactiveMaintenance.enabled) {
    return { proactiveRefs: [] };
  }
  const pmCfg = args.improveProfile.processes?.proactiveMaintenance;
  const dueDays = pmCfg?.dueDays ?? DEFAULT_DUE_DAYS;
  const maxPerRun = pmCfg?.maxPerRun ?? pmCfg?.limit ?? DEFAULT_MAX_PER_RUN;
  const selection = selectProactiveMaintenanceRefs({
    candidates,
    lastReflectTs: snapshot.lastReflectAttemptAt,
    lastDistillTs: snapshot.lastDistillAttemptAt,
    retrievalCounts: retrieval.retrievalCounts,
    lastUseMs: retrieval.lastUseMs,
    sizeBytesOf: (r) => fileSize(r.filePath),
    dueDays,
    maxPerRun,
  });
  const summary = {
    selected: selection.selected.length,
    dueTotal: selection.dueTotal,
    neverReflected: selection.neverReflected,
  };
  if (persist) {
    appendEvent(
      {
        eventType: "proactive_selected",
        ref: undefined,
        metadata: { count: summary.selected, dueTotal: summary.dueTotal, neverReflected: summary.neverReflected },
      },
      args.eventsCtx,
    );
  }
  if (summary.selected > 0) {
    info(
      `[improve] proactive maintenance selected ${summary.selected}/${summary.dueTotal} due refs ` +
        `(${summary.neverReflected} never reflected, dueDays=${dueDays}, maxPerRun=${maxPerRun})`,
    );
  }
  const selectedRefs = selection.selected.map((entry) => entry.ref);
  return {
    proactiveRefs: selection.selected,
    proactiveMaintenanceSummary: { ...summary, selectedRefs },
    proactivePlan: {
      configured: pickDefined(pmCfg, ["dueDays", "maxPerRun", "limit"] as const),
      effective: { dueDays, maxPerRun },
      candidatePool: candidates.length,
      ...summary,
      selectedRefs,
    },
  };
}

/**
 * High salience: zero-feedback refs whose content-derived encoding score (not
 * a per-type stub) reaches `salienceThreshold` and that were never reflected,
 * top-N by score, capped at 10% of the effective limit.
 */
function selectHighSalienceLane(
  options: AkmImproveOptions,
  improveProfile: ImproveProfileConfig,
  eventsCtx: EventsContext | undefined,
  candidates: ImproveEligibleRef[],
  lastReflectAttemptAt: Map<string, string>,
  persist: boolean,
): ImproveEligibleRef[] {
  const threshold = (options.config ?? loadConfig()).improve?.salience?.salienceThreshold ?? 0.75;
  const effectiveLimit = options.limit ?? improveProfile?.processes?.reflect?.limit ?? improveProfile.limit ?? 10;
  const selected =
    withRunState(eventsCtx, persist, (db) =>
      candidates
        .flatMap((r) => {
          const row = getAssetSalience(db, keyOf(r));
          return row &&
            isContentEncodingRow(row) &&
            row.encoding_salience >= threshold &&
            !lastReflectAttemptAt.has(r.ref)
            ? [{ ref: r, score: row.encoding_salience }]
            : [];
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(1, Math.floor(effectiveLimit * 0.1)))
        .map((q) => q.ref),
    ) ?? [];
  if (selected.length > 0) {
    info(
      `[improve] high-salience lane admitted ${selected.length} content-scored ref(s) ` +
        `(threshold=${threshold}, requires content-derived encoding_source)`,
    );
  }
  return selected;
}

/**
 * Score the merged refs: update `asset_outcome` (projected on a plan-only
 * run), compute each salience vector (keeping a stored content-derived
 * encoding score), then persist and compare the stash-wide ranking. A ref that
 * falls from the top 200 to below 500 becomes a forgetting-safety candidate.
 */
function scoreSalience(
  args: ImprovePreparationStageArgs,
  mergedRefs: ImproveEligibleRef[],
  feedback: Map<string, FeedbackSignal>,
  retrievalCounts: Map<string, number>,
  persist: boolean,
): { salienceMap: Map<string, Salience>; pendingForgettingRefs: string[] } {
  const { options, eventsCtx } = args;
  const utilityMap = buildUtilityMap(mergedRefs, !persist);
  const lastUseMsByRef = withIndexDb(!persist, (db) => getLastUseMsByRef(db, mergedRefs)) ?? new Map<string, number>();
  const outcomeSalience = updateOutcomeScores({
    mergedRefs,
    feedback,
    retrievalCounts,
    lastUseMsByRef,
    utilityMap,
    primaryStashDir: args.primaryStashDir,
    eventsCtx,
    persist,
  });
  const outcomeWeightEnabled = (options.config ?? loadConfig()).improve?.salience?.outcomeWeightEnabled !== false;
  const storedEncoding = new Map<string, number>();
  withRunState(eventsCtx, persist, (db) => {
    for (const r of mergedRefs) {
      const row = getAssetSalience(db, keyOf(r));
      if (row && isContentEncodingRow(row)) storedEncoding.set(r.ref, row.encoding_salience);
    }
  });
  const now = Date.now();
  const salienceMap = new Map<string, Salience>();
  for (const r of mergedRefs) {
    const encoding = storedEncoding.get(r.ref);
    salienceMap.set(
      r.ref,
      computeSalience({
        ref: r.ref,
        type: assetTypeOf(r.ref),
        ...(encoding !== undefined ? { encodingSalience: encoding } : {}),
        retrievalFreq: retrievalCounts.get(r.ref) ?? 0,
        lastUseMs: lastUseMsByRef.get(r.ref),
        utilityScore: utilityMap.get(r.ref),
        outcomeSalience: outcomeSalience.get(r.ref),
        sizeBytes: fileSize(r.filePath),
        now,
        outcomeWeightEnabled,
      }),
    );
  }
  const refByKey = new Map(mergedRefs.map((r) => [keyOf(r), r.ref]));
  const pendingForgettingRefs =
    withRunState(eventsCtx, persist, (db) => {
      // Positions are stash-wide: every stored row of this source, with this
      // run's scores overlaid under the same keys.
      const before = new Map<string, number>();
      for (const [ref, score] of getAllRankScores(db)) {
        const boundary = ref.indexOf("//");
        if (options.sourceName && (boundary >= 0 ? ref.slice(0, boundary) : undefined) !== options.sourceName) continue;
        before.set(ref, score);
      }
      let forgetting: string[] = [];
      if (before.size > 0) {
        const after = new Map(before);
        for (const r of mergedRefs) after.set(keyOf(r), salienceMap.get(r.ref)?.rankScore ?? 0);
        const report = buildRankChangeReport(toRankPositions(before), toRankPositions(after));
        if (report.forgettingCandidates.length > 0) {
          const drops = report.forgettingCandidates
            .slice(0, 5)
            .map((e) => `${e.ref} (#${e.oldRank}→#${e.newRank})`)
            .join(", ");
          warn(
            `[improve/salience] WS-1 rank-change report: ${report.forgettingCandidates.length} asset(s) fell from top-200 to below position 500. Top drops: ${drops}`,
          );
          forgetting = report.forgettingCandidates.map((e) => refByKey.get(e.ref) ?? e.ref);
        }
        if (persist) {
          appendEvent(
            {
              eventType: "improve_salience_rank_change",
              ref: undefined,
              metadata: {
                stashSize: before.size,
                totalChanged: report.allChanges.length,
                forgettingCandidates: report.forgettingCandidates.length,
                topDrops: report.forgettingCandidates
                  .slice(0, 10)
                  .map((e) => ({ ref: e.ref, oldRank: e.oldRank, newRank: e.newRank })),
              },
            },
            eventsCtx,
          );
        }
      }
      if (persist) {
        for (const r of mergedRefs) upsertAssetSalience(db, keyOf(r), salienceMap.get(r.ref) as Salience, now);
      }
      return forgetting;
    }) ?? [];
  return { salienceMap, pendingForgettingRefs };
}

/** 1-indexed positions by score desc (ref asc on ties). */
function toRankPositions(scores: Map<string, number>): Map<string, number> {
  const sorted = [...scores.entries()].sort(([refA, a], [refB, b]) =>
    b !== a ? b - a : refA < refB ? -1 : refA > refB ? 1 : 0,
  );
  return new Map(sorted.map(([ref], i) => [ref, i + 1]));
}

/**
 * Update each ref's outcome row and return its outcome salience, normalized
 * against the stash-wide maximum. Without state.db on a plan-only run, the
 * values a live run would insert are projected instead.
 */
function updateOutcomeScores(args: {
  mergedRefs: ImproveEligibleRef[];
  feedback: Map<string, FeedbackSignal>;
  retrievalCounts: Map<string, number>;
  lastUseMsByRef: Map<string, number>;
  utilityMap: Map<string, number>;
  primaryStashDir?: string;
  eventsCtx?: EventsContext;
  persist: boolean;
}): Map<string, number> {
  const { mergedRefs, feedback, eventsCtx, persist } = args;
  const now = Date.now();
  const inputsFor = (r: ImproveEligibleRef, accepted: number) => {
    const fb = feedback.get(r.ref) ?? { positive: 0, negative: 0 };
    return {
      ref: keyOf(r),
      currentRetrievalCount: args.retrievalCounts.get(r.ref) ?? 0,
      lastRetrievedAt: args.lastUseMsByRef.get(r.ref) ?? 0,
      acceptedChangeCount: accepted,
      negativeFeedbackCount: fb.negative,
      valence: computeValenceScore(fb).valence,
      utilityScore: args.utilityMap.get(r.ref),
      now,
    };
  };
  const out = new Map<string, number>();
  if (!persist && !eventsCtx?.db) {
    const projected = new Map(
      mergedRefs.map((r) => [r.ref, projectAssetOutcome(undefined, inputsFor(r, 0)).outcomeScore]),
    );
    const max = Math.min(OUTCOME_SCORE_MAX, Math.max(0, ...projected.values()));
    for (const [ref, score] of projected) out.set(ref, outcomeScoreToSalience(score, max));
    return out;
  }
  withRunState(eventsCtx, persist, (db) => {
    const accepted = new Map<string, number>();
    try {
      const rows = listStateProposals(db, {
        status: "accepted",
        ...(args.primaryStashDir ? { stashDir: args.primaryStashDir } : {}),
      });
      for (const p of rows) accepted.set(p.ref, (accepted.get(p.ref) ?? 0) + 1);
    } catch {
      // Accepted counts stay 0.
    }
    const raw = new Map<string, number>();
    const byKey = new Map<string, number>();
    for (const r of mergedRefs) {
      try {
        const inputs = inputsFor(r, accepted.get(r.ref) ?? 0);
        const result = persist
          ? updateAssetOutcome(db, inputs)
          : projectAssetOutcome(getAssetOutcome(db, inputs.ref), inputs);
        raw.set(r.ref, result.outcomeScore);
        byKey.set(inputs.ref, result.outcomeScore);
      } catch {
        // This ref keeps its stored score.
      }
    }
    // Normalize stash-wide (every row, this run's overlaid), within the writer's bound.
    let max = 0;
    try {
      const scores = new Map(getAllAssetOutcomes(db).map((row) => [row.asset_ref, row.outcome_score]));
      for (const [key, score] of byKey) scores.set(key, score);
      for (const score of scores.values()) if (score > max) max = score;
      max = Math.min(max, OUTCOME_SCORE_MAX);
    } catch {
      max = 0;
    }
    for (const [ref, score] of raw) out.set(ref, outcomeScoreToSalience(score, max));
    const missing = mergedRefs.filter((r) => !raw.has(r.ref));
    if (missing.length > 0) {
      const refByKey = new Map(missing.map((r) => [keyOf(r), r.ref]));
      for (const [key, score] of getOutcomeScoresByRef(db, [...refByKey.keys()])) {
        out.set(refByKey.get(key) ?? key, outcomeScoreToSalience(score, max));
      }
    }
  });
  return out;
}

/**
 * Forgetting safety: inject this plan's own candidates that fell out of the
 * top ranks, past the signal gate (never for a ref scope or with
 * `--require-feedback-signal`). Attribution afterwards: high-salience <
 * proactive < forgetting-safety < signal-delta.
 */
export function applyForgettingSafety(args: {
  pendingForgettingRefs: string[];
  scope: ImproveScope;
  mergedRefs: ImproveEligibleRef[];
  /** This invocation's post-cleanup, post-validation candidates. */
  eligibleRefs: ImproveEligibleRef[];
  allowFallbacks: boolean;
  eligibilitySourceByRef: Map<string, EligibilitySource>;
  highSalienceRefs: ImproveEligibleRef[];
  proactiveRefs: ImproveEligibleRef[];
  signalFiltered: ImproveEligibleRef[];
}): ImproveEligibleRef[] {
  const { eligibilitySourceByRef } = args;
  let mergedRefs = args.mergedRefs;
  if (args.pendingForgettingRefs.length === 0 || args.scope.mode === "ref" || !args.allowFallbacks) return mergedRefs;
  const present = new Set(mergedRefs.map((r) => r.ref));
  const byRef = new Map(args.eligibleRefs.map((c) => [c.ref, c]));
  const byItemRef = new Map(args.eligibleRefs.flatMap((c) => (c.itemRef ? [[c.itemRef, c] as const] : [])));
  const added: ImproveEligibleRef[] = [];
  const forgetting = new Set<string>();
  for (const stored of args.pendingForgettingRefs) {
    // A qualified spelling must match this plan's exact item_ref.
    const candidate = byItemRef.get(stored) ?? (stored.includes("//") ? undefined : byRef.get(stripBundle(stored)));
    if (!candidate || forgetting.has(candidate.ref)) continue;
    forgetting.add(candidate.ref);
    if (!present.has(candidate.ref)) {
      added.push(candidate);
      present.add(candidate.ref);
    }
  }
  if (added.length > 0) mergedRefs = dedupeRefs([...mergedRefs, ...added]);
  if (forgetting.size === 0) return mergedRefs;
  for (const r of args.highSalienceRefs) eligibilitySourceByRef.set(r.ref, "high-salience");
  for (const r of args.proactiveRefs) eligibilitySourceByRef.set(r.ref, "proactive");
  for (const ref of forgetting) eligibilitySourceByRef.set(ref, "forgetting-safety");
  for (const r of args.signalFiltered) eligibilitySourceByRef.set(r.ref, "signal-delta");
  for (const r of mergedRefs) r.eligibilitySource = eligibilitySourceByRef.get(r.ref) ?? "unknown";
  return mergedRefs;
}

/** Drop candidates whose file vanished since planning, with one aggregate event. */
async function dropRefsMissingOnDisk(
  sorted: ImproveEligibleRef[],
  options: AkmImproveOptions,
  eventsCtx: EventsContext | undefined,
  persist: boolean,
): Promise<{ actionableRefs: ImproveEligibleRef[]; missing: string[] }> {
  const actionableRefs: ImproveEligibleRef[] = [];
  const missing: string[] = [];
  for (const candidate of sorted) {
    const filePath =
      candidate.filePath && fs.existsSync(candidate.filePath)
        ? candidate.filePath
        : await findAssetFilePath(candidate.ref, options.stashDir);
    if (filePath && fs.existsSync(filePath)) actionableRefs.push(candidate);
    else missing.push(candidate.ref);
  }
  if (persist && missing.length > 0) {
    recordImproveSkip(eventsCtx, undefined, {
      reason: "asset_missing_on_disk",
      count: missing.length,
      refs: missing.slice(0, 50),
    });
  }
  return { actionableRefs, missing };
}
