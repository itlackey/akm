// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The improve loop (reflect + distill per ref), the post-loop checks and the maintenance passes. */

import fs from "node:fs";
import path from "node:path";
import { parseRefInput } from "../../core/asset/resolve-ref";
import { daysToMs } from "../../core/common";
import {
  type AkmConfig,
  DEFAULT_GRAPH_EXTRACTION_BATCH_SIZE,
  type ImproveProfileConfig,
  loadConfig,
} from "../../core/config/config";
import { UsageError } from "../../core/errors";
import { appendEvent, type EventsContext } from "../../core/events";
import type { AkmDistillResult, ImproveActionResult, ImproveEligibleRef } from "../../core/improve-types";
import { openLogsDatabase, purgeOldTaskLogs } from "../../core/logs-db";
import { getDbPath, getTaskLogDir } from "../../core/paths";
import { withStateDb } from "../../core/state-db";
import { info } from "../../core/warn";
import {
  DEFAULT_GRAPH_EXTRACTION_INCLUDE_TYPES,
  type GraphExtractionResult,
  runGraphExtractionPass,
} from "../../indexer/graph/graph-extraction";
import { indexWrittenAssets } from "../../indexer/index-written-assets";
import { deriveWritableBundleIds } from "../../indexer/installations";
import {
  collectPendingMemories,
  type MemoryInferenceResult,
  runMemoryInferencePass,
} from "../../indexer/passes/memory-inference";
import { resolveSourceEntries } from "../../indexer/search/search-source";
import { isProcessEnabled } from "../../llm/feature-gate";
import type { Database } from "../../storage/database";
import { purgeOldEvents } from "../../storage/repositories/events-repository";
import { purgeOldImproveRuns } from "../../storage/repositories/improve-runs-repository";
import { closeDatabase, openIndexDatabase } from "../../storage/repositories/index-connection";
import {
  getLiveRefSnapshot,
  isRefLiveInSnapshot,
  type LiveRefSnapshot,
} from "../../storage/repositories/index-entries-repository";
import {
  clearAssetOutcomeMissing,
  countAssetOutcomeMissing,
  deleteAssetOutcomeMissingBefore,
  listAssetOutcomeMissingState,
  stampAssetOutcomeMissing,
} from "../../storage/repositories/outcome-repository";
import {
  clearAssetSalienceMissing,
  countAssetSalienceMissing,
  deleteAssetSalienceMissingBefore,
  listAssetSalienceMissingState,
  stampAssetSalienceMissing,
} from "../../storage/repositories/salience-repository";
import { readFreelistInfo, vacuumStateDbIfReclaimable } from "../../storage/state-db-integrity";
import { purgeOldTaskLogFiles } from "../../tasks/run/task-log";
import { expireStaleProposals, purgeOrphanProposals } from "../proposal/repository";
import { checkDeadUrls, type DeadUrl, type DeadUrlCoverage } from "../url-checker";
import { findAssetFilePath, isDistillCandidateRef } from "./eligibility";
import type {
  AkmImproveOptions,
  ImproveLoopResult,
  ImproveLoopState,
  ImproveMaintenanceResult,
  ImprovePostLoopResult,
  ImproveScope,
} from "./improve-run-types";
import { type ResolvedImprovePlan, shouldSkipRef } from "./improve-strategies";
import { type ImproveLedgerOutcome, recordLedgerAttempt, stateKey, stripBundle } from "./ledger";
import type { applyMemoryCleanup } from "./memory/memory-improve";
import { pushRecentError } from "./preparation";
import type { AkmReflectOptions } from "./reflect";
import { recordNoOp, resetConsecutiveNoOps } from "./salience";
import { attributeStage, errMessage } from "./stage";

/** Everything constant across the loop's per-ref passes. */
export interface ImproveLoopEnv {
  scope: ImproveScope;
  options: AkmImproveOptions;
  primaryStashDir?: string;
  reflectFn: ImproveLoopState["reflectFn"];
  distillFn: ImproveLoopState["distillFn"];
  signalBearingSet: Set<string>;
  distillCooledRefs: Set<string>;
  /** These refs skip the reflect call and only distill. */
  distillOnlyRefSet: Set<string>;
  /** Per-originator rolling error windows; pushes come back on the tally. */
  recentErrors: Record<string, string[]>;
  eventsCtx?: EventsContext;
  improveProfile: ImproveProfileConfig;
  resolvedPlan: ResolvedImprovePlan;
  budgetSignal?: AbortSignal;
  /** `distill.requirePlannedRefs` with no reflect-eligible ref in the loop: distill-only refs skip. */
  skipDistillDueToRequirePlannedRefs: boolean;
  remainingBudgetMs: () => number;
}

export function prepareImproveLoopEnv(args: ImproveLoopState): ImproveLoopEnv {
  const distillOnlyRefSet = new Set(args.distillOnlyRefs.map((r) => r.ref));
  const requirePlannedRefs = args.improveProfile?.processes?.distill?.requirePlannedRefs === true;
  return {
    scope: args.scope,
    options: args.options,
    primaryStashDir: args.primaryStashDir,
    reflectFn: args.reflectFn,
    distillFn: args.distillFn,
    signalBearingSet: args.signalBearingSet,
    distillCooledRefs: args.distillCooledRefs,
    distillOnlyRefSet,
    recentErrors: args.recentErrors,
    eventsCtx: args.eventsCtx,
    improveProfile: args.improveProfile,
    resolvedPlan: args.resolvedPlan,
    budgetSignal: args.budgetSignal,
    skipDistillDueToRequirePlannedRefs: requirePlannedRefs && args.loopRefs.every((r) => distillOnlyRefSet.has(r.ref)),
    remainingBudgetMs: () => Math.max(0, args.budgetMs - (Date.now() - args.startMs)),
  };
}

/** What one ref's iteration produced; the orchestrator folds it into run state. */
export interface LoopRefTally {
  actions: ImproveActionResult[];
  /** 1 when the reflect call carried recent-error avoidPatterns. */
  reflectsWithErrorContext: number;
  recentErrorPushes: { originator: string; message: string }[];
  /** Memory refs distilled but not promoted this ref — queued for inference. */
  memoryRefsForInference: string[];
}

/**
 * Record a loop attempt in the improve ledger. Proposals and quality
 * rejections record themselves; the loop records what they cannot see.
 */
function recordLoopAttempt(
  planned: ImproveEligibleRef,
  env: ImproveLoopEnv,
  source: "reflect" | "distill",
  outcome: ImproveLedgerOutcome,
  detail?: string,
): void {
  const stashDir = env.primaryStashDir ?? env.options.stashDir;
  if (!stashDir || env.options.dryRun) return;
  recordLedgerAttempt(
    { eventsCtx: env.eventsCtx },
    {
      stashDir,
      ref: stateKey(planned.ref, planned.itemRef),
      source,
      outcome,
      ...(detail !== undefined ? { detail } : {}),
    },
  );
}

/** Plasticity counter: repeated no-ops dampen an asset's selection score; a change lifts it. */
function recordPlasticity(env: ImproveLoopEnv, planned: ImproveEligibleRef, outcome: "noop" | "changed" | undefined) {
  const db = env.eventsCtx?.db;
  if (!db || !outcome) return;
  const key = stateKey(planned.ref, planned.itemRef);
  try {
    if (outcome === "noop") recordNoOp(db, key);
    else resetConsecutiveNoOps(db, key);
  } catch {
    // best-effort
  }
}

function recordSkip(tally: LoopRefTally, ref: string, reason: string, event?: { env: ImproveLoopEnv; reason: string }) {
  tally.actions.push({ ref, mode: "distill-skipped", result: { ok: true, reason } });
  if (event)
    appendEvent({ eventType: "improve_skipped", ref, metadata: { reason: event.reason } }, event.env.eventsCtx);
}

/** One loop iteration: reflect, then distill. A distill UsageError is a validation failure. */
export async function processImproveLoopRef(planned: ImproveEligibleRef, env: ImproveLoopEnv): Promise<LoopRefTally> {
  const tally: LoopRefTally = {
    actions: [],
    reflectsWithErrorContext: 0,
    recentErrorPushes: [],
    memoryRefsForInference: [],
  };
  try {
    const isDistillOnly = env.distillOnlyRefSet.has(planned.ref);
    const parsed = parseRefInput(planned.ref);
    if (!isDistillOnly) await runLoopReflectPass(planned, env, tally);
    await runLoopDistillPass(planned, parsed.type, isDistillOnly, env, tally);
  } catch (err) {
    if (err instanceof UsageError) {
      recordLoopAttempt(planned, env, "distill", "failed", err.message);
      tally.actions.push({
        ref: planned.ref,
        mode: "distill",
        result: { ok: false, outcome: "validation_failed", error: err.message } as unknown as AkmDistillResult,
      });
    } else {
      tally.actions.push({ ref: planned.ref, mode: "error", result: { ok: false, error: errMessage(err) } });
    }
  }
  return tally;
}

async function runLoopReflectPass(planned: ImproveEligibleRef, env: ImproveLoopEnv, tally: LoopRefTally) {
  const { options, primaryStashDir, improveProfile, resolvedPlan } = env;
  // Derived memories are machine-generated: never reflected.
  if (planned.ref.endsWith(".derived")) {
    recordSkip(tally, planned.ref, "derived-memory-reflect-skipped", { env, reason: "derived_memory_reflect_skipped" });
    return;
  }
  const reflectSkip = shouldSkipRef(planned.ref, "reflect", improveProfile);
  if (reflectSkip.skip) {
    tally.actions.push({ ref: planned.ref, mode: "reflect-skipped", result: { ok: true, reason: reflectSkip.reason } });
    return;
  }
  // Only reflect's own recent errors reach its prompt.
  const reflectErrors = env.recentErrors.reflect ?? [];
  if (reflectErrors.length > 0) tally.reflectsWithErrorContext++;
  const budgetMs = env.remainingBudgetMs();
  const reflectArgs = {
    ref: planned.ref,
    ...(planned.itemRef ? { itemRef: planned.itemRef } : {}),
    task: options.task,
    ...(improveProfile ? { improveProfile } : {}),
    config: resolvedPlan.config as AkmConfig,
    ...(primaryStashDir ? { stashDir: primaryStashDir } : {}),
    ...(options.sourceName && primaryStashDir ? { target: { source: options.sourceName, root: primaryStashDir } } : {}),
    ...(reflectErrors.length > 0 ? { avoidPatterns: [...reflectErrors] } : {}),
    eventSource: "improve" as const,
    lowValueFilter: improveProfile.processes?.reflect?.lowValueFilter?.enabled === true,
    ...(budgetMs > 0 ? { timeoutMs: budgetMs } : {}),
    signal: env.budgetSignal,
    eventsCtx: env.eventsCtx,
    ...(planned.eligibilitySource ? { eligibilitySource: planned.eligibilitySource } : {}),
  } satisfies AkmReflectOptions;
  const result = await attributeStage(resolvedPlan, "reflect", () => env.reflectFn(reflectArgs));
  const reason = result.ok ? undefined : result.reason;
  // A refused type or an unchanged asset is a deterministic skip, not an LLM
  // fault; a guard rejection (size rail) gets its own bucket for health.
  const skipped = reason === "unsupported_type" || reason === "no_change";
  tally.actions.push({
    ref: planned.ref,
    mode: result.ok
      ? "reflect"
      : reason === "content_policy_reject"
        ? "reflect-guard-rejected"
        : skipped
          ? "reflect-skipped"
          : "reflect-failed",
    result,
  });
  // A quality rejection recorded itself, and the judge's text is no lesson for
  // the next prompt; skips revisit on the `unchanged` cadence.
  if (!result.ok && reason !== "quality_rejected") {
    recordLoopAttempt(planned, env, "reflect", skipped ? "unchanged" : "failed", reason);
    if (!skipped) {
      tally.recentErrorPushes.push({
        originator: "reflect",
        message: result.error ?? reason ?? "unknown reflect error",
      });
    }
  }
  appendEvent(
    {
      eventType: "improve_reflect_outcome",
      ref: planned.ref,
      metadata: {
        ok: result.ok,
        durationMs: result.ok ? result.durationMs : undefined,
        engine: result.engine,
        reason,
      },
    },
    env.eventsCtx,
  );
  recordPlasticity(env, planned, reason === "no_change" ? "noop" : result.ok ? "changed" : undefined);
}

async function runLoopDistillPass(
  planned: ImproveEligibleRef,
  refType: string,
  isDistillOnly: boolean,
  env: ImproveLoopEnv,
  tally: LoopRefTally,
) {
  const { options, primaryStashDir, improveProfile, resolvedPlan } = env;
  const distillSkip = shouldSkipRef(planned.ref, "distill", improveProfile);
  if (distillSkip.skip) return recordSkip(tally, planned.ref, distillSkip.reason);
  if (env.skipDistillDueToRequirePlannedRefs && isDistillOnly) {
    return recordSkip(tally, planned.ref, "require_planned_refs");
  }
  const explicitRefScope = env.scope.mode === "ref";
  const weakMemorySignal =
    !isDistillOnly && refType === "memory" && !env.signalBearingSet.has(planned.ref) && !explicitRefScope;
  if (weakMemorySignal) {
    return recordSkip(tally, planned.ref, "memory requires recent feedback signal", {
      env,
      reason: "memory_distill_requires_feedback",
    });
  }
  // The ledger holds cooled refs; an explicit `--scope` ref overrides it.
  if (!isDistillCandidateRef(planned.ref, options.stashDir)) return;
  if (env.distillCooledRefs.has(planned.ref) && !explicitRefScope) return;

  const result = await attributeStage(resolvedPlan, "distill", () =>
    env.distillFn({
      ref: planned.ref,
      ...(planned.itemRef ? { itemRef: planned.itemRef } : {}),
      ...(refType === "memory" ? { proposalKind: "auto" as const } : {}),
      ...(primaryStashDir ? { stashDir: primaryStashDir } : {}),
      ...(improveProfile ? { improveProfile } : {}),
      config: options.config,
      llmRunner: resolvedPlan.processes.distill.runner,
      signal: env.budgetSignal,
      eventsCtx: env.eventsCtx,
      ...(planned.eligibilitySource ? { eligibilitySource: planned.eligibilitySource } : {}),
    }),
  );
  tally.actions.push({ ref: planned.ref, mode: "distill", result });
  // `queued` and the quality outcomes recorded themselves; a transport failure
  // or a disabled process is not an attempt, so the ref stays eligible.
  if (result.outcome === "skipped") {
    recordLoopAttempt(planned, env, "distill", "unchanged", result.skipReason ?? result.message);
  }
  if (refType === "memory" && !(result.outcome === "queued" && result.proposalKind === "knowledge")) {
    tally.memoryRefsForInference.push(planned.ref);
  }
  recordPlasticity(
    env,
    planned,
    result.outcome === "quality_rejected" || result.outcome === "skipped"
      ? "noop"
      : result.outcome === "queued"
        ? "changed"
        : undefined,
  );
}

export async function runImproveLoopStage(args: ImproveLoopState): Promise<ImproveLoopResult> {
  const { loopRefs, actions, recentErrors, startMs, budgetMs, eventsCtx } = args;
  const env = prepareImproveLoopEnv(args);
  let reflectsWithErrorContext = 0;
  const memoryRefsForInference = new Set<string>();

  for (const [index, planned] of loopRefs.entries()) {
    if (Date.now() - startMs >= budgetMs) {
      const remaining = loopRefs.length - index;
      info(
        `[improve] budget exhausted after ${Math.round((Date.now() - startMs) / 60000)}min — ${remaining} assets skipped`,
      );
      appendEvent(
        { eventType: "improve_skipped", ref: planned.ref, metadata: { reason: "budget_exhausted", remaining } },
        eventsCtx,
      );
      for (const rest of loopRefs.slice(index + 1)) {
        appendEvent(
          {
            eventType: "improve_skipped",
            ref: rest.ref,
            metadata: { reason: "budget_exhausted_batch", remaining: remaining - 1 },
          },
          eventsCtx,
        );
      }
      actions.push({
        ref: planned.ref,
        mode: "error",
        result: { ok: false, error: "timeout: improve wall-clock budget exhausted" },
      });
      break;
    }
    const tally = await processImproveLoopRef(planned, env);
    actions.push(...tally.actions);
    for (const push of tally.recentErrorPushes) pushRecentError(recentErrors, push.originator, push.message);
    reflectsWithErrorContext += tally.reflectsWithErrorContext;
    for (const ref of tally.memoryRefsForInference) memoryRefsForInference.add(ref);
    info(`[improve] ${index + 1}/${loopRefs.length} ${planned.ref}`);
  }

  return { reflectsWithErrorContext, memoryRefsForInference };
}

export async function runImprovePostLoopStage(args: {
  scope: ImproveScope;
  options: AkmImproveOptions;
  primaryStashDir?: string;
  actionableRefs: ImproveEligibleRef[];
  appliedCleanup?: Awaited<ReturnType<typeof applyMemoryCleanup>>;
  cleanupWarnings: string[];
  memoryRefsForInference: Set<string>;
  eventsCtx?: EventsContext;
  budgetSignal?: AbortSignal;
  improveProfile?: ImproveProfileConfig;
  resolvedPlan?: ResolvedImprovePlan;
}): Promise<ImprovePostLoopResult> {
  const { scope, primaryStashDir, actionableRefs } = args;
  const allWarnings = [...args.cleanupWarnings, ...(args.appliedCleanup?.warnings ?? [])];
  info("[improve] post-loop maintenance starting");
  const maintenance = await runImproveMaintenancePasses({ ...args, allWarnings });

  let deadUrls: DeadUrl[] | undefined;
  let deadUrlCoverage: DeadUrlCoverage | undefined;
  if (scope.mode === "all" && primaryStashDir && actionableRefs.length > 0) {
    try {
      // Every actionable knowledge ref is scanned; checkDeadUrls bounds the
      // network concurrency (#892).
      const knowledgeEntries = actionableRefs
        .filter((r) => {
          try {
            return parseRefInput(r.ref).type === "knowledge";
          } catch {
            return false;
          }
        })
        .map((r) => {
          let body = "";
          if (r.filePath) {
            try {
              body = fs.readFileSync(r.filePath, "utf8");
            } catch {
              // best-effort
            }
          }
          return { ref: r.ref, body };
        });
      if (knowledgeEntries.length > 0) {
        info(`[improve] checking URLs in ${knowledgeEntries.length} knowledge refs`);
        const urlCheck = await checkDeadUrls(primaryStashDir, knowledgeEntries);
        deadUrls = urlCheck.deadUrls;
        deadUrlCoverage = urlCheck.coverage;
        info(
          `[improve] URL check complete (${deadUrls.length} dead/timeout URLs; checked ${urlCheck.coverage.checked} of ${urlCheck.coverage.total})`,
        );
      }
    } catch {
      // best-effort
    }
  }

  return {
    allWarnings,
    deadUrls,
    ...(deadUrlCoverage ? { deadUrlCoverage } : {}),
    ...(maintenance.memoryInference ? { memoryInference: maintenance.memoryInference } : {}),
    ...(maintenance.graphExtraction ? { graphExtraction: maintenance.graphExtraction } : {}),
    ...(maintenance.actions && maintenance.actions.length > 0 ? { maintenanceActions: maintenance.actions } : {}),
    memoryInferenceDurationMs: maintenance.memoryInferenceDurationMs,
    graphExtractionDurationMs: maintenance.graphExtractionDurationMs,
    orphansPurged: maintenance.orphansPurged,
    proposalsExpired: maintenance.proposalsExpired,
  };
}

/**
 * The index.db handle the maintenance passes share. A pass that writes the
 * index itself closes it first and reopens it after, even on failure (#584).
 */
export interface IndexDbCell {
  current?: Database;
}

export interface MaintenanceCtx {
  config: AkmConfig;
  sources: ReturnType<typeof resolveSourceEntries>;
  primaryStashDir: string;
  eventsCtx?: EventsContext;
  budgetSignal?: AbortSignal;
  improveProfile?: ImproveProfileConfig;
  resolvedPlan?: ResolvedImprovePlan;
  memoryInferenceFn: typeof runMemoryInferencePass;
  graphExtractionFn: typeof runGraphExtractionPass;
}

/**
 * Memory inference → index what it wrote → graph extraction → proposal hygiene
 * (orphan purge, expiration) → orphan-state GC → retention purges. Warnings go
 * to `allWarnings`.
 */
export async function runImproveMaintenancePasses(args: {
  options: AkmImproveOptions;
  primaryStashDir?: string;
  actionableRefs: ImproveEligibleRef[];
  memoryRefsForInference: Set<string>;
  allWarnings: string[];
  budgetSignal?: AbortSignal;
  eventsCtx?: EventsContext;
  improveProfile?: ImproveProfileConfig;
  resolvedPlan?: ResolvedImprovePlan;
}): Promise<ImproveMaintenanceResult> {
  const { options, primaryStashDir, allWarnings, budgetSignal, eventsCtx } = args;
  if (!primaryStashDir || budgetSignal?.aborted) return { memoryInferenceDurationMs: 0, graphExtractionDurationMs: 0 };
  const config = options.config ?? loadConfig();
  const ctx: MaintenanceCtx = {
    config,
    sources: resolveSourceEntries(options.stashDir, config),
    primaryStashDir,
    eventsCtx,
    budgetSignal,
    improveProfile: args.improveProfile,
    resolvedPlan: args.resolvedPlan,
    memoryInferenceFn: options.memoryInferenceFn ?? runMemoryInferencePass,
    graphExtractionFn: options.graphExtractionFn ?? runGraphExtractionPass,
  };
  const openIndexDb = () =>
    openIndexDatabase(
      getDbPath(),
      config.embedding?.dimension ? { embeddingDim: config.embedding.dimension } : undefined,
    );
  const dbCell: IndexDbCell = {};
  const actions: ImproveActionResult[] = [];
  try {
    dbCell.current = openIndexDb();

    const inference = await runMemoryInferenceMaintenancePass(ctx, dbCell, args.memoryRefsForInference);
    if (inference.action) actions.push(inference.action);
    allWarnings.push(...inference.warnings);
    const written = inference.memoryInference?.writtenPaths ?? [];
    if (written.length > 0) {
      // Index exactly the files inference wrote. indexWrittenAssets opens its
      // own write handle, so ours closes first and reopens after.
      info(`[improve] indexing ${written.length} file(s) written by memory inference`);
      try {
        if (dbCell.current) closeDatabase(dbCell.current);
        dbCell.current = undefined;
        try {
          await indexWrittenAssets(primaryStashDir, written);
        } finally {
          dbCell.current = openIndexDb();
        }
        info("[improve] indexing after memory inference complete");
      } catch (err) {
        allWarnings.push(`indexing after memory inference failed: ${errMessage(err)}`);
      }
    }

    const graph = await runGraphExtractionMaintenancePass(ctx, dbCell, args);
    if (graph.action) actions.push(graph.action);
    allWarnings.push(...graph.warnings);

    const hygiene = runProposalHygienePass(ctx);
    allWarnings.push(...hygiene.warnings);
    allWarnings.push(...runOrphanStateGcPass(ctx, dbCell).warnings);
    allWarnings.push(...runRetentionPurgePass(ctx).warnings);

    return {
      ...(inference.memoryInference ? { memoryInference: inference.memoryInference } : {}),
      ...(graph.graphExtraction ? { graphExtraction: graph.graphExtraction } : {}),
      ...(actions.length > 0 ? { actions } : {}),
      memoryInferenceDurationMs: inference.durationMs,
      graphExtractionDurationMs: graph.durationMs,
      orphansPurged: hygiene.orphansPurged,
      proposalsExpired: hygiene.proposalsExpired,
    };
  } finally {
    if (dbCell.current) closeDatabase(dbCell.current);
  }
}

interface LlmPassOutcome<T> {
  result?: T;
  durationMs: number;
  warnings: string[];
}

/** Time one LLM maintenance pass; a throw becomes a `<label> failed: …` warning. */
async function timedLlmPass<T>(label: string, run: () => Promise<T>): Promise<LlmPassOutcome<T>> {
  const start = Date.now();
  try {
    const result = await run();
    return { result, durationMs: Date.now() - start, warnings: [] };
  } catch (err) {
    return { durationMs: Date.now() - start, warnings: [`${label} failed: ${errMessage(err)}`] };
  }
}

/**
 * Memory inference over every pending parent in the stash. The pass discovers
 * its own candidates; the refs distilled this run are only logged as a hint.
 */
export async function runMemoryInferenceMaintenancePass(
  ctx: MaintenanceCtx,
  dbCell: IndexDbCell,
  memoryRefsForInference: Set<string>,
): Promise<{
  memoryInference?: MemoryInferenceResult;
  durationMs: number;
  action?: ImproveActionResult;
  warnings: string[];
}> {
  const { config, sources, primaryStashDir, resolvedPlan } = ctx;
  const settings = ctx.improveProfile?.processes?.memoryInference;
  if (settings?.enabled === false) {
    info("[improve] memory inference skipped (disabled by improve profile)");
    return { durationMs: 0, warnings: [] };
  }
  const minPendingCount = settings?.minPendingCount;
  if (primaryStashDir && minPendingCount !== undefined && minPendingCount > 0) {
    const pending = collectPendingMemories(primaryStashDir).length;
    if (pending < minPendingCount) {
      info(`[improve] memory inference skipped (${pending} pending < minPendingCount ${minPendingCount})`);
      return { durationMs: 0, warnings: [] };
    }
  }
  const hintRefs = memoryRefsForInference.size;
  info(
    hintRefs > 0
      ? `[improve] memory inference starting (${hintRefs} hint refs touched this run; pass discovers all pending)`
      : "[improve] memory inference starting (discovering pending parents)",
  );
  const pass = await timedLlmPass("memory inference", () =>
    attributeStage(resolvedPlan, "memoryInference", () =>
      ctx.memoryInferenceFn({
        config,
        ...(resolvedPlan ? { llmRunner: resolvedPlan.processes.memoryInference.runner } : {}),
        sources,
        signal: ctx.budgetSignal,
        db: dbCell.current,
        reEnrich: false,
        onProgress: (event) => {
          const current = event.currentRef ? ` ${event.currentRef}` : "";
          info(
            `[improve] memory inference ${event.processed}/${event.total}${current} (written ${event.writtenFacts}, skipped ${event.skippedNoFacts})`,
          );
        },
      }),
    ),
  );
  const memoryInference = pass.result;
  if (!memoryInference) return { durationMs: pass.durationMs, warnings: pass.warnings };
  info(
    `[improve] memory inference complete (${memoryInference.writtenFacts} facts written from ${memoryInference.splitParents} parents)`,
  );
  return {
    memoryInference,
    durationMs: pass.durationMs,
    // Sentinel refs (`<domain>/_<marker>`) label maintenance events; never parsed as assets.
    action: { ref: "memories/_inference", mode: "memory-inference", result: memoryInference },
    warnings: pass.warnings,
  };
}

/**
 * Graph extraction over the files this run touched, or the whole corpus when
 * the profile sets `graphExtraction.fullScan` (the `graph-refresh` strategy).
 * With nothing touched the pass still runs and extracts nothing.
 */
export async function runGraphExtractionMaintenancePass(
  ctx: MaintenanceCtx,
  dbCell: IndexDbCell,
  args: { actionableRefs: ImproveEligibleRef[]; memoryRefsForInference: Set<string> },
): Promise<{
  graphExtraction?: GraphExtractionResult;
  durationMs: number;
  action?: ImproveActionResult;
  warnings: string[];
}> {
  const { config, sources, primaryStashDir, resolvedPlan } = ctx;
  const settings = ctx.improveProfile?.processes?.graphExtraction;
  const graphEnabled = resolvedPlan ? true : isProcessEnabled("index", "graph_extraction", config);
  if (settings?.enabled === false) {
    info("[improve] graph extraction skipped (disabled by improve profile)");
    return { durationMs: 0, warnings: [] };
  }
  if (sources.length === 0) return { durationMs: 0, warnings: [] };
  if (!graphEnabled) {
    info("[improve] graph extraction skipped (features.index.graph_extraction is disabled)");
    return { durationMs: 0, warnings: [] };
  }
  const fullScan = settings?.fullScan === true;
  info(`[improve] graph extraction starting${fullScan ? " (full-corpus scan)" : ""}`);
  const pass = await timedLlmPass("graph extraction", async () => {
    let candidatePaths: Set<string> | undefined;
    if (!fullScan) {
      candidatePaths = new Set<string>();
      const touched = new Set([...args.actionableRefs.map((r) => r.ref), ...args.memoryRefsForInference]);
      if (primaryStashDir && touched.size > 0) {
        const writableBundleIds = deriveWritableBundleIds(resolveSourceEntries(primaryStashDir));
        const resolved = await Promise.all(
          [...touched].map((ref) => findAssetFilePath(ref, primaryStashDir, writableBundleIds).catch(() => null)),
        );
        for (const p of resolved) if (typeof p === "string" && p.length > 0) candidatePaths.add(p);
      }
    }
    return attributeStage(resolvedPlan, "graphExtraction", () =>
      ctx.graphExtractionFn({
        config,
        ...(resolvedPlan ? { llmRunner: resolvedPlan.processes.graphExtraction.runner } : {}),
        sources,
        signal: ctx.budgetSignal,
        db: dbCell.current,
        reEnrich: false,
        onProgress: (event) => {
          const current = event.currentPath ? ` ${path.basename(event.currentPath)}` : "";
          info(
            `[improve] graph extraction ${event.processed}/${event.total}${current} (extracted ${event.extracted}, entities ${event.totalEntities}, relations ${event.totalRelations})`,
          );
        },
        options: {
          candidatePaths,
          includeTypes: settings?.includeTypes ?? [...DEFAULT_GRAPH_EXTRACTION_INCLUDE_TYPES],
          batchSize: settings?.batchSize ?? DEFAULT_GRAPH_EXTRACTION_BATCH_SIZE,
          ...(settings?.topN != null ? { topN: settings.topN } : {}),
          ...(settings?.maxChunksPerAsset != null ? { maxChunksPerAsset: settings.maxChunksPerAsset } : {}),
        },
      }),
    );
  });
  const graphExtraction = pass.result;
  if (!graphExtraction) return { durationMs: pass.durationMs, warnings: pass.warnings };
  info(
    `[improve] graph extraction complete (${graphExtraction.quality.extractedFiles} files, ${graphExtraction.quality.entityCount} entities, ${graphExtraction.quality.relationCount} relations)`,
  );
  return {
    graphExtraction,
    durationMs: pass.durationMs,
    action: { ref: "graph/_artifact", mode: "graph-extraction", result: graphExtraction },
    warnings: pass.warnings,
  };
}

/**
 * Reject pending proposals whose target no longer exists, then expire pending
 * proposals past the retention window; each emits a roll-up event.
 */
function runProposalHygienePass(ctx: MaintenanceCtx): {
  orphansPurged: number;
  proposalsExpired: number;
  warnings: string[];
} {
  const { primaryStashDir, eventsCtx } = ctx;
  const warnings: string[] = [];
  let orphansPurged = 0;
  let proposalsExpired = 0;
  try {
    const purge = purgeOrphanProposals(
      primaryStashDir,
      ctx.sources.map((s) => s.path),
    );
    orphansPurged = purge.rejected;
    if (purge.rejected > 0) {
      info(
        `[improve] orphan purge: ${purge.rejected}/${purge.checked} orphaned proposals rejected (${purge.durationMs}ms)`,
      );
    }
    appendEvent(
      {
        eventType: "proposal_orphan_purge",
        ref: "proposals/_orphan-purge",
        metadata: {
          checked: purge.checked,
          rejected: purge.rejected,
          durationMs: purge.durationMs,
          byType: purge.byType,
          orphans: purge.orphans.map((o) => o.ref),
        },
      },
      eventsCtx,
    );
  } catch (err) {
    warnings.push(`orphan purge failed: ${errMessage(err)}`);
  }
  try {
    const expiry = expireStaleProposals(primaryStashDir, ctx.config);
    proposalsExpired = expiry.expired;
    if (expiry.expired > 0) {
      info(
        `[improve] expiration: ${expiry.expired}/${expiry.checked} pending proposals expired ` +
          `(retention=${expiry.retentionDays}d, ${expiry.durationMs}ms)`,
      );
    }
    appendEvent(
      {
        eventType: "proposal_expiration_pass",
        ref: "proposals/_expiration",
        metadata: {
          checked: expiry.checked,
          expired: expiry.expired,
          durationMs: expiry.durationMs,
          retentionDays: expiry.retentionDays,
          expiredProposals: expiry.expiredProposals,
        },
      },
      eventsCtx,
    );
  } catch (err) {
    warnings.push(`proposal expiration failed: ${errMessage(err)}`);
  }
  return { orphansPurged, proposalsExpired, warnings };
}

/**
 * Trim the observability data that grows append-only — state.db events and
 * improve_runs, logs.db task_logs, and the per-run task log files — to
 * `improve.eventRetentionDays` (default 90; 0 disables), then VACUUM state.db
 * when enough pages are free. Each store fails on its own. state.db work
 * borrows the run's long-lived handle: a second writer on the same WAL file
 * locks (#585).
 */
export function runRetentionPurgePass(ctx: MaintenanceCtx): { warnings: string[] } {
  const { config, eventsCtx } = ctx;
  const warnings: string[] = [];
  const retentionDays = typeof config.improve?.eventRetentionDays === "number" ? config.improve.eventRetentionDays : 90;
  if (retentionDays <= 0) return { warnings };
  const report = (eventType: string, ref: string, purgedCount: number, what: string) => {
    if (purgedCount > 0) info(`[improve] ${eventType}: ${purgedCount} ${what} older than ${retentionDays}d removed`);
    appendEvent({ eventType, ref, metadata: { purgedCount, retentionDays } }, eventsCtx);
  };

  try {
    withStateDb(
      (stateDb) => {
        report("events_purged", "events/_purge", purgeOldEvents(stateDb, retentionDays), "event(s)");
        report("improve_runs_purged", "improve_runs/_purge", purgeOldImproveRuns(stateDb, retentionDays), "run(s)");
        const vacuum = vacuumStateDbIfReclaimable(stateDb, readFreelistInfo(stateDb), eventsCtx);
        if (vacuum.ran) info(`[improve] state.db vacuum: ${vacuum.pagesBefore} -> ${vacuum.pagesAfter} pages`);
      },
      { path: eventsCtx?.dbPath, borrowed: eventsCtx?.db },
    );
  } catch (err) {
    warnings.push(`events purge failed: ${errMessage(err)}`);
  }

  let logsDb: ReturnType<typeof openLogsDatabase> | undefined;
  try {
    logsDb = openLogsDatabase();
    report("task_logs_purged", "task_logs/_purge", purgeOldTaskLogs(logsDb, retentionDays), "log line(s)");
  } catch (err) {
    warnings.push(`task_logs purge failed: ${errMessage(err)}`);
  } finally {
    try {
      logsDb?.close();
    } catch {
      // best-effort
    }
  }

  try {
    report(
      "task_log_files_purged",
      "task_log_files/_purge",
      purgeOldTaskLogFiles(undefined, retentionDays),
      `file(s) under ${getTaskLogDir()}`,
    );
  } catch (err) {
    warnings.push(`task log files purge failed: ${errMessage(err)}`);
  }
  return { warnings };
}

/**
 * Grace window before an unresolved salience/outcome row may be deleted (only
 * when `improve.stateGc.collect` is true).
 */
export const STATE_GC_GRACE_MS = daysToMs(7);

/**
 * A stored state ref is live when it, or its bare conceptId, resolves in the
 * index. The bare fallback keeps a live asset whose row predates
 * bundle-qualification from being collected.
 */
function isStateRefLive(snapshot: LiveRefSnapshot, storedRef: string): boolean {
  if (isRefLiveInSnapshot(snapshot, storedRef)) return true;
  const bare = stripBundle(storedRef);
  return bare !== storedRef && isRefLiveInSnapshot(snapshot, bare);
}

interface StateGcTable {
  rows: ReadonlyArray<{ asset_ref: string; missing_since: number | null }>;
  stamp: (refs: string[], now: number) => number;
  clear: (refs: string[]) => number;
  deleteOlderThan: (cutoffMs: number) => number;
  countPending: () => number;
}

/**
 * Orphan-state GC (#733) over `asset_salience` and `asset_outcome`: stamp
 * `missing_since` on refs that no longer resolve in index.db, clear it on refs
 * that resolve again, and — only with `improve.stateGc.collect` — delete rows
 * stamped longer ago than {@link STATE_GC_GRACE_MS}. An unreachable source keeps
 * its last-known index rows, so it never surfaces candidates. `pending` is the
 * backlog after the sweep; the event is emitted only when there is something to
 * report.
 */
export function runOrphanStateGcPass(
  ctx: MaintenanceCtx,
  dbCell: IndexDbCell,
): { pending: number; collected: number; warnings: string[] } {
  const { eventsCtx } = ctx;
  const indexDb = dbCell.current;
  if (!indexDb)
    return { pending: 0, collected: 0, warnings: ["orphan state GC skipped: no index.db handle available"] };
  const collect = ctx.config.improve?.stateGc?.collect === true;
  const now = Date.now();
  let pending = 0;
  let collected = 0;
  try {
    const liveRefs = getLiveRefSnapshot(indexDb);
    const sweep = (table: StateGcTable) => {
      const toStamp: string[] = [];
      const toClear: string[] = [];
      for (const row of table.rows) {
        const live = isStateRefLive(liveRefs, row.asset_ref);
        if (!live && row.missing_since == null) toStamp.push(row.asset_ref);
        else if (live && row.missing_since != null) toClear.push(row.asset_ref);
      }
      if (toStamp.length > 0) table.stamp(toStamp, now);
      if (toClear.length > 0) table.clear(toClear);
      const removed = collect ? table.deleteOlderThan(now - STATE_GC_GRACE_MS) : 0;
      return { pending: table.countPending(), collected: removed };
    };
    withStateDb(
      (stateDb) => {
        // Keys avoid the state table names: the state-table-sql lint rule (#672)
        // forbids them outside the repositories.
        const byTable = {
          salience: sweep({
            rows: listAssetSalienceMissingState(stateDb),
            stamp: (refs, ts) => stampAssetSalienceMissing(stateDb, refs, ts),
            clear: (refs) => clearAssetSalienceMissing(stateDb, refs),
            deleteOlderThan: (cutoff) => deleteAssetSalienceMissingBefore(stateDb, cutoff),
            countPending: () => countAssetSalienceMissing(stateDb),
          }),
          outcome: sweep({
            rows: listAssetOutcomeMissingState(stateDb),
            stamp: (refs, ts) => stampAssetOutcomeMissing(stateDb, refs, ts),
            clear: (refs) => clearAssetOutcomeMissing(stateDb, refs),
            deleteOlderThan: (cutoff) => deleteAssetOutcomeMissingBefore(stateDb, cutoff),
            countPending: () => countAssetOutcomeMissing(stateDb),
          }),
        };
        pending = byTable.salience.pending + byTable.outcome.pending;
        collected = byTable.salience.collected + byTable.outcome.collected;
        if (pending > 0 || collected > 0) {
          info(
            `[improve] orphan state GC: ${pending} pending, ${collected} collected ` +
              `(salience ${byTable.salience.pending}/${byTable.salience.collected}, ` +
              `outcome ${byTable.outcome.pending}/${byTable.outcome.collected})`,
          );
          appendEvent(
            { eventType: "asset_state_gc", ref: "asset_state/_gc", metadata: { pending, collected, byTable } },
            eventsCtx,
          );
        }
      },
      { path: eventsCtx?.dbPath, borrowed: eventsCtx?.db },
    );
  } catch (err) {
    return { pending, collected, warnings: [`orphan state GC failed: ${errMessage(err)}`] };
  }
  return { pending, collected, warnings: [] };
}
