// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { parseRefInput } from "../../core/asset/resolve-ref";
import { daysToMs } from "../../core/common";
import { type AkmConfig, DEFAULT_GRAPH_EXTRACTION_BATCH_SIZE, loadConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import { appendEvent, type EventsContext } from "../../core/events";
import type {
  AkmDistillResult,
  AkmReflectResult,
  ImproveActionResult,
  ImproveEligibleRef,
} from "../../core/improve-types";
import { openLogsDatabase, purgeOldTaskLogs } from "../../core/logs-db";
import { getDbPath, getTaskLogDir } from "../../core/paths";
import { withStateDb } from "../../core/state-db";
import { info } from "../../core/warn";
import {
  DEFAULT_GRAPH_EXTRACTION_INCLUDE_TYPES,
  type GraphExtractionResult,
  runGraphExtractionPass,
} from "../../indexer/graph/graph-extraction";
import { deriveWritableBundleIds } from "../../indexer/installations";
import {
  collectPendingMemories,
  type MemoryInferenceResult,
  runMemoryInferencePass,
} from "../../indexer/passes/memory-inference";
import { resolveSourceEntries } from "../../indexer/search/search-source";
import { isProcessEnabled } from "../../llm/feature-gate";
import { withLlmStage } from "../../llm/usage-telemetry";
import type { Database } from "../../storage/database";
import { type CycleMetricsRow, purgeOldCycleMetrics } from "../../storage/repositories/canaries-repository";
import { purgeOldEvents } from "../../storage/repositories/events-repository";
import { purgeOldImproveRuns } from "../../storage/repositories/improve-runs-repository";
import { closeDatabase, openIndexDatabase } from "../../storage/repositories/index-connection";
import { getEntryByRef } from "../../storage/repositories/index-entries-repository";
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
import { purgeOldTaskLogFiles } from "../../tasks/run/task-log";
import { expireStaleProposals, listProposals, purgeOrphanProposals } from "../proposal/repository";
import { checkDeadUrls, type DeadUrl, type DeadUrlCoverage } from "../url-checker";
import { DEFAULT_RETENTION_DAYS as CYCLE_METRICS_RETENTION_DAYS, runCollapseDetector } from "./collapse-detector";
import { deriveLessonRef } from "./distill";
import { deriveKnowledgeRef } from "./distill-promotion-policy";
// Eligibility / candidate-selection predicates live in ./eligibility.
import { findAssetFilePath, isDistillCandidateRef } from "./eligibility";
import { writeEvalCase } from "./eval-cases";
import type {
  AkmImproveOptions,
  ImproveLoopResult,
  ImproveLoopState,
  ImproveMaintenanceResult,
  ImprovePostLoopResult,
  ImproveScope,
} from "./improve-run-types";
import { type ResolvedImprovePlan, shouldSkipRef } from "./improve-strategies";
import type { applyMemoryCleanup } from "./memory/memory-improve";
import type { AkmReflectOptions } from "./reflect";
import { recordNoOp, resetConsecutiveNoOps } from "./salience";
import { errMessage, refSlug } from "./shared";
import { bareImproveRef, durableImproveRef } from "./source-identity";

// ── improve loop / post-loop / maintenance stages ───────────────────
// The cycle stages run by akmImprove, extracted from improve.ts.

/** O-5 / #378: rolling per-originator error-window cap. */
const RECENT_ERRORS_CAP = 3;

/** O-5 / #378: push a per-originator error into the rolling window. */
function pushRecentError(recentErrors: Record<string, string[]>, originator: string, msg: string): void {
  if (!recentErrors[originator]) recentErrors[originator] = [];
  recentErrors[originator].push(msg);
  if (recentErrors[originator].length > RECENT_ERRORS_CAP) recentErrors[originator].shift();
}

/**
 * Per-run environment shared by every per-ref pass of the improve loop —
 * everything that is constant across refs. Built once by
 * {@link prepareImproveLoopEnv} so the per-ref passes take `(ref, env, tally)`
 * instead of closing over `runImproveLoopStage` locals.
 */
export interface ImproveLoopEnv {
  scope: ImproveScope;
  options: AkmImproveOptions;
  primaryStashDir?: string;
  reflectFn: ImproveLoopState["reflectFn"];
  distillFn: ImproveLoopState["distillFn"];
  signalBearingSet: Set<string>;
  distillCooledRefs: Set<string>;
  /** O(1) membership test — these refs skip the reflect call (Bug D2). */
  distillOnlyRefSet: Set<string>;
  /**
   * Per-originator rolling error windows (O-5 / #378). Read-only inside the
   * passes; pushes are returned on the {@link LoopRefTally} and folded into
   * this record by the orchestrator between refs.
   */
  recentErrors: Record<string, string[]>;
  /** D6: pre-loaded map of most-recent proposal_rejected event per ref (last 30d). */
  rejectedProposalsByRef: ImproveLoopState["rejectedProposalsByRef"];
  eventsCtx?: EventsContext;
  /** Active improve profile, resolved from profile name + config. */
  improveProfile: ImproveLoopState["improveProfile"];
  /** Engine/materialized-connection snapshot shared by every process in this run. */
  resolvedPlan: ResolvedImprovePlan;
  budgetSignal?: AbortSignal;
  /**
   * requirePlannedRefs guard: when the distill profile sets this flag, skip
   * distill for distill-only refs if the reflect phase produced no planned refs.
   * Prevents the distill loop from generating hundreds of distill-skipped events
   * on quiet passes (all refs on reflect cooldown, no new signal to distill).
   */
  skipDistillDueToRequirePlannedRefs: boolean;
  /** Pending proposals pre-loaded once instead of queried per asset in the loop. */
  pendingProposalRefSet: Set<string>;
  /** O-1 (#364): remaining wall-clock budget, computed at call time. */
  remainingBudgetMs: () => number;
}

/**
 * Build the per-run loop environment from the run context: the derived guards
 * and the pending-proposal preload.
 */
export function prepareImproveLoopEnv(args: ImproveLoopState): ImproveLoopEnv {
  const {
    ctx,
    scope,
    options,
    reflectFn,
    distillFn,
    loopRefs,
    signalBearingSet,
    distillCooledRefs,
    distillOnlyRefs,
    recentErrors,
    rejectedProposalsByRef,
    startMs,
    budgetMs,
    improveProfile,
    resolvedPlan,
  } = args;
  // WI-9.10: the legacy dual context's optional eventsCtx/budgetSignal are
  // now RunContext's required eventsCtx / optional signal — renamed local
  // aliases so the rest of this function (and the ImproveLoopEnv object
  // literal below) is unchanged. `primaryStashDir` deliberately comes from
  // the state's honest optional field, NOT `ctx.stashDir`: the rare
  // unresolvable-primary path must keep skipping the `if (primaryStashDir)`
  // guards below (see the field's doc in ./improve-run-types).
  const primaryStashDir = args.primaryStashDir;
  const eventsCtx = ctx.eventsCtx;
  const budgetSignal = ctx.signal;

  // O-1 (#364): compute remaining budget at call time so each sub-call
  // receives only its fair share of the wall-clock budget.
  const remainingBudgetMs = () => Math.max(0, budgetMs - (Date.now() - startMs));

  // Build a Set for O(1) membership test — these refs skip the reflect call (Bug D2).
  const distillOnlyRefSet = new Set(distillOnlyRefs.map((r) => r.ref));

  // requirePlannedRefs guard: when the distill profile sets this flag, skip
  // distill for distill-only refs if the reflect phase produced no planned refs.
  // Prevents the distill loop from generating hundreds of distill-skipped events
  // on quiet passes (all refs on reflect cooldown, no new signal to distill).
  const requirePlannedRefs = improveProfile?.processes?.distill?.requirePlannedRefs === true;
  const hasReflectEligibleRefs = loopRefs.some((r) => !distillOnlyRefSet.has(r.ref));
  const skipDistillDueToRequirePlannedRefs = requirePlannedRefs && !hasReflectEligibleRefs;

  // Pre-load all pending proposals once instead of querying per asset in the loop.
  const dedupeStashDirForProposals = primaryStashDir ?? options.stashDir;
  const pendingProposalRefSet = new Set<string>(
    dedupeStashDirForProposals
      ? listProposals(dedupeStashDirForProposals, { status: "pending" }).map((p) => p.ref)
      : [],
  );

  return {
    scope,
    options,
    primaryStashDir,
    reflectFn,
    distillFn,
    signalBearingSet,
    distillCooledRefs,
    distillOnlyRefSet,
    recentErrors,
    rejectedProposalsByRef,
    eventsCtx,
    improveProfile,
    resolvedPlan,
    budgetSignal,
    skipDistillDueToRequirePlannedRefs,
    pendingProposalRefSet,
    remainingBudgetMs,
  };
}

/**
 * Tally of one per-ref loop iteration, folded into run-level state by the
 * orchestrator. Sub-passes append to THIS object and never touch run-level
 * state, so the run counters stop being shared mutable closures. The tally is
 * threaded INTO the sub-passes (rather than assembled from pure returns)
 * deliberately: the per-ref try/catch must preserve actions that were already
 * recorded when a later side effect throws — exactly as the pre-decomposition
 * inline loop body did.
 */
export interface LoopRefTally {
  /** Actions recorded for this ref, in emission order. */
  actions: ImproveActionResult[];
  /** 1 when the reflect call carried recent-error avoidPatterns (O-5 / #378). */
  reflectsWithErrorContext: number;
  /** Errors to fold into the per-originator rolling windows (O-5 / #378). */
  recentErrorPushes: { originator: string; message: string }[];
  /** Memory refs distilled-but-not-promoted this ref — queued for inference. */
  memoryRefsForInference: string[];
}

/**
 * One improve-loop iteration for a single planned ref: the reflect pass, then
 * the distill pass, with the per-ref error classification (B7) around both.
 * `continue` in the old inline loop body is an early `return` inside the
 * passes; the orchestrator folds the returned tally and owns the run counters.
 */
export async function processImproveLoopRef(planned: ImproveEligibleRef, env: ImproveLoopEnv): Promise<LoopRefTally> {
  const tally: LoopRefTally = {
    actions: [],
    reflectsWithErrorContext: 0,
    recentErrorPushes: [],
    memoryRefsForInference: [],
  };
  try {
    // Bug D2: distillOnlyRefs skip the reflect call but still run the distill path.
    // Bug D1: in-loop distill-cooldown check removed — distill-cooled candidates
    //         have their synthetic actions emitted in runImprovePreparationStage.
    const isDistillOnly = env.distillOnlyRefSet.has(planned.ref);
    const parsedPlannedRef = parseRefInput(planned.ref);
    await runLoopReflectPass(planned, isDistillOnly, env, tally);
    // isDistillOnly refs: no reflect action emitted — proceed directly to the distill pass.
    await runLoopDistillPass(planned, parsedPlannedRef, isDistillOnly, env, tally);
  } catch (err) {
    // B7: UsageError thrown by akmDistill on validation_failed should be recorded
    // as mode:"distill" with outcome:"validation_failed", NOT as a generic error.
    // The distill_invoked event was already emitted inside akmDistill before the throw.
    if (err instanceof UsageError) {
      tally.actions.push({
        ref: planned.ref,
        mode: "distill",
        result: { ok: false, outcome: "validation_failed", error: err.message } as unknown as AkmDistillResult,
      });
    } else {
      tally.actions.push({
        ref: planned.ref,
        mode: "error",
        result: { ok: false, error: errMessage(err) },
      });
    }
  }
  return tally;
}

/**
 * Reflect half of one loop iteration: type/profile gates, the reflect call with
 * recent-error avoidPatterns, outcome classification (cooldown / guard-reject /
 * type-refused / noise-gate), and plasticity counters. Records onto the per-ref
 * tally only.
 */
async function runLoopReflectPass(
  planned: ImproveEligibleRef,
  isDistillOnly: boolean,
  env: ImproveLoopEnv,
  tally: LoopRefTally,
): Promise<void> {
  const { options, primaryStashDir, reflectFn, eventsCtx, improveProfile, resolvedPlan, budgetSignal } = env;
  // B6: derived memories are machine-generated; skip reflect to avoid noisy proposals.
  // shouldDistillMemoryRef already returns false for .derived refs, so the distill
  // path is also a no-op for them — we just avoid unnecessary agent spawns.
  // D2: distillOnlyRefs also skip the reflect call (reflect-cooled, distill path only).
  if (!isDistillOnly && !planned.ref.endsWith(".derived")) {
    // Type guard: skip reflect for unsupported types (script, env, task, etc.)
    // and raw wiki directories, driven by the active improve profile.
    const reflectSkip = shouldSkipRef(planned.ref, "reflect", improveProfile);
    if (reflectSkip.skip) {
      tally.actions.push({
        ref: planned.ref,
        mode: "reflect-skipped",
        result: { ok: true, reason: reflectSkip.reason },
      });
    } else {
      // O-5 / #378: only inject reflect-originator errors into the reflect call.
      // Cross-task errors (e.g. schema-repair) must NOT contaminate reflect prompts.
      const reflectErrors = env.recentErrors.reflect ?? [];
      if (reflectErrors.length > 0) tally.reflectsWithErrorContext++;
      // O-1 (#364): pass remaining budget as timeoutMs so the agent spawn is
      // bounded by the wall-clock deadline rather than the default per-profile timeout.
      const reflectBudgetMs = env.remainingBudgetMs();
      // Re-enter canonical named-engine lowering with the config snapshot and
      // process profile frozen into the invocation plan. The loop never injects
      // a RunnerSpec seam or observes later caller-config mutations.
      const reflectCallArgs = {
        ref: planned.ref,
        // Carry the resolved item_ref so reflect uses the same durable key for
        // events and state reads.
        ...(planned.itemRef ? { itemRef: planned.itemRef } : {}),
        task: options.task,
        // Active strategy supplies non-engine process tuning.
        ...(improveProfile ? { improveProfile } : {}),
        config: resolvedPlan.config as AkmConfig,
        ...(primaryStashDir ? { stashDir: primaryStashDir } : {}),
        ...(options.sourceName && primaryStashDir
          ? { target: { source: options.sourceName, root: primaryStashDir } }
          : {}),
        ...(reflectErrors.length > 0 ? { avoidPatterns: [...reflectErrors] } : {}),
        eventSource: "improve" as const,
        // #639 — resolve the low-value filter from the ACTIVE improve profile
        // (default off when unset), so the running strategy decides.
        lowValueFilter: improveProfile.processes?.reflect?.lowValueFilter?.enabled === true,
        ...(reflectBudgetMs > 0 ? { timeoutMs: reflectBudgetMs } : {}),
        signal: budgetSignal,
        // R25: reflect's event emits reuse the run's long-lived state.db handle.
        eventsCtx: env.eventsCtx,
        // Attribution: carry the eligibility lane so reflect stamps it on
        // the reflect_invoked event and the persisted proposal.
        ...(planned.eligibilitySource ? { eligibilitySource: planned.eligibilitySource } : {}),
      } satisfies AkmReflectOptions;
      const reflectResult: AkmReflectResult = await withLlmStage("reflect", () => reflectFn(reflectCallArgs), {
        engine: resolvedPlan.processes.reflect.runner?.engine,
        process: "reflect",
      });
      const isCooldown = !reflectResult.ok && reflectResult.reason === "cooldown";
      // Content-policy guard hits (reflect size-rail rejections) are NOT
      // LLM faults — the agent responded fine, the downstream guard
      // blocked the output. Route them to a distinct `reflect-guard-rejected`
      // mode so health metrics can split deterministic guard hits out of
      // true LLM failures. See
      // `/tmp/akm-health-investigations/metrics-taxonomy-review.md` §1a.
      const isGuardReject = !reflectResult.ok && reflectResult.reason === "content_policy_reject";
      // Type-guard rejection (reflect refused a script/env/task ref) is
      // also NOT an LLM failure — the LLM is never invoked. Route to the
      // existing `reflect-skipped` bucket so it does not inflate the
      // failure-rate numerator. ~9% of `reflect-failed` events in the
      // user's stack were this case; see review §1a row "Reflect refused
      // asset type".
      const isTypeRefused = !reflectResult.ok && reflectResult.reason === "unsupported_type";
      // Noise-gate suppression (#580): the candidate edit was an empty
      // diff or a cosmetic-only reformat of the current asset. Like
      // `unsupported_type`, this is a deterministic skip — not an LLM
      // fault — so it routes to the `reflect-skipped` bucket and stays
      // out of recentErrors/avoidPatterns.
      const isNoChange = !reflectResult.ok && reflectResult.reason === "no_change";
      tally.actions.push({
        ref: planned.ref,
        mode: reflectResult.ok
          ? "reflect"
          : isCooldown
            ? "reflect-cooldown"
            : isGuardReject
              ? "reflect-guard-rejected"
              : isTypeRefused || isNoChange
                ? "reflect-skipped"
                : "reflect-failed",
        result: reflectResult,
      });
      // Cooldown skips, guard rejects, type-refused skips, and noise-gate
      // skips are not failures — do not pollute recentErrors with them
      // (those get injected as `avoidPatterns` into the next reflect
      // prompt). Guard rejects ARE worth showing the LLM as a learn-signal
      // so the next iteration sees "your last expansion was too large";
      // type-refused and no-change are deterministic and add no learning
      // signal.
      if (!reflectResult.ok && !isCooldown && !isTypeRefused && !isNoChange) {
        const errMsg = reflectResult.error ?? reflectResult.reason ?? "unknown reflect error";
        tally.recentErrorPushes.push({ originator: "reflect", message: errMsg });
      }
      // improve_reflect_outcome — per-asset metric for tuning the reflect path.
      appendEvent(
        {
          eventType: "improve_reflect_outcome",
          ref: planned.ref,
          metadata: {
            ok: reflectResult.ok,
            durationMs: reflectResult.ok ? reflectResult.durationMs : undefined,
            engine: reflectResult.engine,
            reason: reflectResult.ok ? undefined : reflectResult.reason,
          },
        },
        eventsCtx,
      );

      // Plasticity counter (plan §WS-1 step 8): record no-ops so the
      // WS-1 selection comparator (effectiveScore, ~line 3073) can dampen
      // repeatedly-silent assets during consolidation-selection.
      // A no_change reflect means the LLM was invoked but found nothing to
      // improve — the asset is stable. Track it. A successful reflect means
      // the asset changed; reset the counter so the dampener lifts.
      // Use the same item_ref-or-conceptId salience key as preparation/distill.
      const plasticityKey = planned.itemRef ?? durableImproveRef(planned.ref);
      if (isNoChange && eventsCtx?.db) {
        try {
          recordNoOp(eventsCtx.db, plasticityKey);
        } catch {
          // best-effort: plasticity counter failure never blocks the run
        }
      } else if (reflectResult.ok && eventsCtx?.db) {
        try {
          resetConsecutiveNoOps(eventsCtx.db, plasticityKey);
        } catch {
          // best-effort
        }
      }
    } // end else (reflect type/profile check)
  } else if (!isDistillOnly && planned.ref.endsWith(".derived")) {
    // B6: .derived refs skip reflect; record synthetic skip action.
    tally.actions.push({
      ref: planned.ref,
      mode: "distill-skipped",
      result: { ok: true, reason: "derived-memory-reflect-skipped" },
    });
    appendEvent(
      {
        eventType: "improve_skipped",
        ref: planned.ref,
        metadata: { reason: "derived_memory_reflect_skipped" },
      },
      eventsCtx,
    );
  }
}

/**
 * Distill half of one loop iteration: the profile / requirePlannedRefs /
 * candidate-type / weak-signal / cooldown gates, then the pending-proposal and
 * reject-grace dedup checks, then {@link invokeDistillAndRecord}. Each gate
 * that was a `continue` in the old inline loop body is an early `return` here.
 */
async function runLoopDistillPass(
  planned: ImproveEligibleRef,
  parsedPlannedRef: ReturnType<typeof parseRefInput>,
  isDistillOnly: boolean,
  env: ImproveLoopEnv,
  tally: LoopRefTally,
): Promise<void> {
  const { options, primaryStashDir, eventsCtx, improveProfile } = env;
  const hasRecentFeedbackSignal = env.signalBearingSet.has(planned.ref);
  const explicitRefScope = env.scope.mode === "ref";
  // Profile gate: apply the full type-filter / raw-wiki / disabled rules to
  // distill so callers who configure `profile.processes.distill.allowedTypes`
  // or land on raw-wiki refs get a recorded skip action instead of silently
  // proceeding.
  const distillSkip = shouldSkipRef(planned.ref, "distill", improveProfile);
  if (distillSkip.skip) {
    tally.actions.push({
      ref: planned.ref,
      mode: "distill-skipped",
      result: { ok: true, reason: distillSkip.reason },
    });
    return;
  }
  // requirePlannedRefs guard: skip distill for distill-only refs when no
  // reflect-eligible refs were planned this run, preventing mass skip events.
  if (env.skipDistillDueToRequirePlannedRefs && isDistillOnly) {
    tally.actions.push({
      ref: planned.ref,
      mode: "distill-skipped",
      result: { ok: true, reason: "require_planned_refs" },
    });
    return;
  }
  // See `isDistillCandidateRef` — excludes `lesson:*` (and anything else in
  // DISTILL_REFUSED_INPUT_TYPES) so distill never gets queued for an input
  // it will refuse.
  const shouldAttemptDistill = isDistillCandidateRef(planned.ref, options.stashDir);
  const skipMemoryDistillForWeakSignal =
    !isDistillOnly && parsedPlannedRef.type === "memory" && !hasRecentFeedbackSignal && !explicitRefScope;

  // distillCooledRefs guard: pre-filter emitted synthetic actions for distill-candidate
  // refs; non-candidate refs in the set are blocked here.
  // O-2 (#365): bypass the distill cooldown when the user explicitly targeted
  // this ref via --scope — their intent overrides unattended-run policies.
  if (
    shouldAttemptDistill &&
    !skipMemoryDistillForWeakSignal &&
    (!env.distillCooledRefs.has(planned.ref) || explicitRefScope)
  ) {
    // TODO(refactor): single call site needs both lesson+knowledge refs for proposal dedup. If a third target ref type is added, extract deriveAllTargetRefs(inputRef): string[].
    const lessonRef = deriveLessonRef(planned.ref);
    const knowledgeRef = deriveKnowledgeRef(planned.ref);
    const dedupeStashDir = primaryStashDir ?? options.stashDir;
    if (dedupeStashDir) {
      // B2: check both lesson ref and knowledge ref since auto-promoted memories
      // create knowledge: proposals, not lesson: proposals.
      const hasExistingPending =
        env.pendingProposalRefSet.has(lessonRef) || env.pendingProposalRefSet.has(knowledgeRef);
      if (hasExistingPending) {
        tally.actions.push({
          ref: planned.ref,
          mode: "distill-skipped",
          result: { ok: true, reason: "pending proposal exists" },
        });
        appendEvent(
          {
            eventType: "improve_skipped",
            ref: planned.ref,
            metadata: { reason: "pending_proposal_exists" },
          },
          eventsCtx,
        );
        return;
      }

      // D-2 (#370): reject-aware cooldown for distill. When the reviewer
      // recently rejected a distilled lesson or knowledge proposal for this
      // asset, skip re-distillation for a 1-day grace window. Prevents the
      // same rejected proposal from being regenerated immediately. The
      // window is fixed (the 0.8.0 redesign moved per-ref cooldowns to
      // signal-delta gates and dropped --distill-cooldown-days; a short
      // reject grace is preserved here so a fresh rejection isn't
      // overridden by the same run).
      // References: ExpeL arXiv:2308.10144, STaR arXiv:2203.14465.
      const DISTILL_REJECT_COOLDOWN_MS = daysToMs(1);
      const recentlyRejectedLesson =
        !explicitRefScope && // O-2: bypass when --scope <ref> is explicit
        (env.rejectedProposalsByRef.has(lessonRef) || env.rejectedProposalsByRef.has(knowledgeRef));
      if (recentlyRejectedLesson) {
        const rejectedEntry = env.rejectedProposalsByRef.get(lessonRef) ?? env.rejectedProposalsByRef.get(knowledgeRef);
        const rejectedAgeMs = rejectedEntry ? Date.now() - new Date(rejectedEntry.ts).getTime() : 0;
        if (rejectedAgeMs < DISTILL_REJECT_COOLDOWN_MS) {
          tally.actions.push({
            ref: planned.ref,
            mode: "distill-skipped",
            result: { ok: true, reason: "distill reject grace window" },
          });
          appendEvent(
            {
              eventType: "improve_skipped",
              ref: planned.ref,
              metadata: {
                reason: "distill_reject_grace_window",
              },
            },
            eventsCtx,
          );
          return;
        }
      }
    }

    await invokeDistillAndRecord(planned, parsedPlannedRef, env, tally);
  } else if (skipMemoryDistillForWeakSignal) {
    tally.actions.push({
      ref: planned.ref,
      mode: "distill-skipped",
      result: { ok: true, reason: "memory requires recent feedback signal" },
    });
    appendEvent(
      {
        eventType: "improve_skipped",
        ref: planned.ref,
        metadata: { reason: "memory_distill_requires_feedback" },
      },
      eventsCtx,
    );
  }
}

/**
 * The distill invocation for one ref that passed every gate: the `distillFn`
 * call, memory-inference queueing, plasticity counters, and the
 * quality-rejected / proposal-rejected eval-case writes.
 */
async function invokeDistillAndRecord(
  planned: ImproveEligibleRef,
  parsedPlannedRef: ReturnType<typeof parseRefInput>,
  env: ImproveLoopEnv,
  tally: LoopRefTally,
): Promise<void> {
  const { options, primaryStashDir, distillFn, eventsCtx, improveProfile, resolvedPlan, budgetSignal } = env;
  const distillResult = await withLlmStage(
    "distill",
    () =>
      distillFn({
        ref: planned.ref,
        // Carry the resolved item_ref so distill matches preparation's state key.
        ...(planned.itemRef ? { itemRef: planned.itemRef } : {}),
        ...(parsedPlannedRef.type === "memory" ? { proposalKind: "auto" as const } : {}),
        ...(primaryStashDir ? { stashDir: primaryStashDir } : {}),
        // Active profile so distill's per-process reads honor `--profile`.
        ...(improveProfile ? { improveProfile } : {}),
        config: options.config,
        llmRunner: resolvedPlan.processes.distill.runner,
        signal: budgetSignal,
        // R25: distill's event emits reuse the run's long-lived state.db handle.
        eventsCtx,
        // Attribution: carry the eligibility lane so distill stamps it on the
        // distill_invoked event and the persisted proposal.
        ...(planned.eligibilitySource ? { eligibilitySource: planned.eligibilitySource } : {}),
      }),
    { engine: resolvedPlan.processes.distill.runner?.engine, process: "distill" },
  );
  tally.actions.push({ ref: planned.ref, mode: "distill", result: distillResult });
  if (parsedPlannedRef.type === "memory") {
    const promotedToKnowledge = distillResult.outcome === "queued" && distillResult.proposalKind === "knowledge";
    if (!promotedToKnowledge) tally.memoryRefsForInference.push(planned.ref);
  }
  // Plasticity counter (plan §WS-1 step 8) for the distill path.
  // quality_rejected: the LLM ran but produced output that didn't pass the
  // quality gate — the asset is not yielding useful distill output.
  // queued: a proposal was produced; reset the no-op counter.
  if (eventsCtx?.db) {
    // Use the same item_ref-or-conceptId key as the distill/preparation writers.
    const plasticityKey = planned.itemRef ?? durableImproveRef(planned.ref);
    try {
      if (distillResult.outcome === "quality_rejected" || distillResult.outcome === "skipped") {
        recordNoOp(eventsCtx.db, plasticityKey);
      } else if (distillResult.outcome === "queued") {
        resetConsecutiveNoOps(eventsCtx.db, plasticityKey);
      }
    } catch {
      // best-effort: plasticity counter failure never blocks the run
    }
  }
  if (distillResult.outcome === "quality_rejected" && primaryStashDir) {
    const slug = refSlug(planned.ref);
    writeEvalCase(primaryStashDir, {
      ref: planned.ref,
      failureReason: distillResult.reason ?? "quality gate rejected",
      assetType: parseRefInput(planned.ref).type ?? "unknown",
      rejectedAt: Date.now(),
      source: "distill_quality_rejected",
      slug: `${slug}-${Date.now()}`,
    });
  }
  // D6: use pre-loaded map instead of per-iteration DB query
  const rejectedProposalEvent = env.rejectedProposalsByRef.get(planned.ref);
  if (rejectedProposalEvent && primaryStashDir) {
    const slug = refSlug(planned.ref);
    writeEvalCase(primaryStashDir, {
      ref: planned.ref,
      failureReason: (rejectedProposalEvent.metadata?.reason as string | undefined) ?? "proposal rejected",
      assetType: parseRefInput(planned.ref).type ?? "unknown",
      rejectedAt: new Date(rejectedProposalEvent.ts).getTime(),
      source: "proposal_rejected",
      slug: `${slug}-rejected`,
    });
  }
}

/**
 * Wall-clock budget exhausted mid-loop (O-1 / #364): emit the improve_skipped
 * events for the current and remaining refs (B11) and return the terminal
 * error action for the orchestrator to record before breaking out of the loop.
 */
function recordBudgetExhausted(args: {
  planned: ImproveEligibleRef;
  loopRefs: ImproveEligibleRef[];
  completedCount: number;
  startMs: number;
  eventsCtx?: EventsContext;
}): ImproveActionResult {
  const { planned, loopRefs, completedCount, startMs, eventsCtx } = args;
  const remaining = loopRefs.length - completedCount;
  info(
    `[improve] budget exhausted after ${Math.round((Date.now() - startMs) / 60000)}min — ${remaining} assets skipped`,
  );
  appendEvent(
    {
      eventType: "improve_skipped",
      ref: planned.ref,
      metadata: {
        reason: "budget_exhausted",
        remaining,
      },
    },
    eventsCtx,
  );
  // B11: Emit improve_skipped for all remaining assets that will not be processed.
  for (const remainingRef of loopRefs.slice(completedCount + 1)) {
    appendEvent(
      {
        eventType: "improve_skipped",
        ref: remainingRef.ref,
        metadata: { reason: "budget_exhausted_batch", remaining: loopRefs.length - completedCount - 1 },
      },
      eventsCtx,
    );
  }
  return {
    ref: planned.ref,
    mode: "error",
    result: { ok: false, error: "timeout: improve wall-clock budget exhausted" },
  };
}

export async function runImproveLoopStage(args: ImproveLoopState): Promise<ImproveLoopResult> {
  const { ctx, loopRefs, actions, recentErrors, startMs, budgetMs } = args;
  const eventsCtx = ctx.eventsCtx;
  const env = prepareImproveLoopEnv(args);

  let completedCount = 0;
  let reflectsWithErrorContext = 0;
  const memoryRefsForInference = new Set<string>();

  for (const planned of loopRefs) {
    if (Date.now() - startMs >= budgetMs) {
      actions.push(recordBudgetExhausted({ planned, loopRefs, completedCount, startMs, eventsCtx }));
      break;
    }
    const tally = await processImproveLoopRef(planned, env);
    // Fold the per-ref tally into run-level state — the passes never touch it.
    actions.push(...tally.actions);
    for (const push of tally.recentErrorPushes) pushRecentError(recentErrors, push.originator, push.message);
    reflectsWithErrorContext += tally.reflectsWithErrorContext;
    for (const ref of tally.memoryRefsForInference) memoryRefsForInference.add(ref);
    completedCount++;
    info(`[improve] ${completedCount}/${loopRefs.length} ${planned.ref}`);
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
  reindexFn: (options: { stashDir: string; signal?: AbortSignal }) => Promise<unknown>;
  eventsCtx?: EventsContext;
  /** O-1 (#364): shared wall-clock AbortSignal; forwarded to maintenance passes. */
  budgetSignal?: AbortSignal;
  /** Active improve profile, resolved from profile name + config. */
  improveProfile?: import("../../core/config/config").ImproveProfileConfig;
  resolvedPlan?: ResolvedImprovePlan;
  /**
   * #551: whether the consolidation pass (now run in the preparation stage,
   * before extract) actually processed memories. Drives the graph-extraction
   * reindex below — graph extraction must re-read the index if consolidation
   * mutated the memory pool.
   */
  consolidationRan: boolean;
  /** R5: this run's advisory merge-information-floor violation count (consolidate pass). */
  consolidationMergeFloorViolations?: number;
}): Promise<ImprovePostLoopResult> {
  const {
    scope,
    options,
    primaryStashDir,
    actionableRefs,
    appliedCleanup,
    cleanupWarnings,
    memoryRefsForInference,
    reindexFn,
    eventsCtx,
    budgetSignal,
    improveProfile,
    resolvedPlan,
    consolidationRan,
  } = args;
  const allWarnings = [...cleanupWarnings, ...(appliedCleanup?.warnings ?? [])];
  info("[improve] post-loop maintenance starting");
  const maintenanceResult = await runImproveMaintenancePasses({
    options,
    primaryStashDir,
    actionableRefs,
    memoryRefsForInference,
    allWarnings,
    reindexFn,
    consolidationRan,
    // O-1 (#364): forward the budget signal to memory inference + graph extraction.
    budgetSignal,
    eventsCtx,
    improveProfile,
    resolvedPlan,
  });

  let deadUrls: DeadUrl[] | undefined;
  let deadUrlCoverage: DeadUrlCoverage | undefined;
  if (scope.mode === "all" && primaryStashDir && actionableRefs.length > 0) {
    try {
      // Every actionable knowledge ref is scanned for URLs — there used to be
      // a `.slice(0, 10)` here, capping the scan to the first ten refs while
      // `deadUrlCoverage.total` counted only those, so a real bundle reported
      // checked === total while most refs were never looked at (#892). URL
      // extraction (a regex over already-loaded text) is cheap; it is the
      // network requests that are expensive, and those are bounded by
      // `checkDeadUrls`'s concurrency limit, not by trimming what gets scanned.
      const knowledgeEntries = actionableRefs
        .filter((r) => {
          try {
            return parseRefInput(r.ref).type === "knowledge";
          } catch {
            return false;
          }
        })
        .map((r) => {
          // The URL scan needs the document body; filePath is pre-resolved on
          // eligible refs at planning time (#591). Best-effort — an unreadable
          // or unresolved file contributes no URLs, same as before.
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

  // ── R5: collapse/churn detector ────────────────────────────────────────────
  // One snapshot per QUALIFYING cycle: consolidate processed work. Runs AFTER
  // the maintenance reindex so FTS sees the post-merge index. Deterministic,
  // observe-only, fail-open (the orchestrator catches everything) — and inert
  // on the ~9-in-10 default-profile runs that touch no merges.
  let cycleMetrics: CycleMetricsRow | undefined;
  if (!options.dryRun && consolidationRan) {
    cycleMetrics = runCollapseDetector({
      runId: options.runId ?? "improve-adhoc",
      ...(improveProfile ? { improveProfile } : {}),
      pass: "consolidate",
      mergeFloorViolations: args.consolidationMergeFloorViolations ?? 0,
      config: options.config ?? loadConfig(),
      ...(eventsCtx ? { eventsCtx } : {}),
    });
  }

  return {
    allWarnings,
    deadUrls,
    ...(deadUrlCoverage ? { deadUrlCoverage } : {}),
    ...(cycleMetrics ? { cycleMetrics } : {}),
    ...(maintenanceResult.memoryInference ? { memoryInference: maintenanceResult.memoryInference } : {}),
    ...(maintenanceResult.graphExtraction ? { graphExtraction: maintenanceResult.graphExtraction } : {}),
    ...(maintenanceResult.actions && maintenanceResult.actions.length > 0
      ? { maintenanceActions: maintenanceResult.actions }
      : {}),
    memoryInferenceDurationMs: maintenanceResult.memoryInferenceDurationMs,
    graphExtractionDurationMs: maintenanceResult.graphExtractionDurationMs,
    orphansPurged: maintenanceResult.orphansPurged,
    proposalsExpired: maintenanceResult.proposalsExpired,
  };
}

// TODO(refactor): `runImproveMaintenancePasses` mutates the passed-in `allWarnings` array as a hidden side channel. Return warnings in ImproveMaintenanceResult and merge in caller — invasive signature change deferred to next refactor pass. (The extracted passes below already return their warnings; only the exported signature keeps the side channel.)

/**
 * The one irreducible mutable seam of the maintenance stage: the index.db
 * handle. `reindexWithIndexDbReleased` must close the CURRENT handle before a
 * reindex and reopen a fresh one in `finally` even when the reindex throws
 * (#584), and the lease-scoped `finally` must close whatever handle is current
 * — neither can be expressed as a pure return value, so the passes share this
 * cell instead of a closure-mutated `let`.
 */
export interface IndexDbCell {
  current?: Database;
}

/** Run-scoped carriers shared by every maintenance pass (built once per run). */
export interface MaintenanceCtx {
  config: AkmConfig;
  sources: ReturnType<typeof resolveSourceEntries>;
  primaryStashDir: string;
  eventsCtx?: EventsContext;
  /** O-1 (#364): shared wall-clock AbortSignal; cancels sub-calls when budget expires. */
  budgetSignal?: AbortSignal;
  /** Active improve profile, resolved from profile name + config. */
  improveProfile?: import("../../core/config/config").ImproveProfileConfig;
  resolvedPlan?: ResolvedImprovePlan;
  memoryInferenceFn: typeof runMemoryInferencePass;
  graphExtractionFn: typeof runGraphExtractionPass;
  /**
   * #584: reindexFn opens its own write handle on the same index.db WAL file.
   * Holding our handle across that call produced SQLITE_BUSY / "database is
   * locked" failures in production, so the handle is closed BEFORE every
   * reindex and reopened after — the fresh handle also sees the post-reindex
   * state that graph extraction relies on. The reopen runs in `finally` so a
   * failed reindex still leaves a usable handle.
   */
  reindexWithIndexDbReleased: (stashDir: string) => Promise<void>;
}

// Exported for tests (#584/#585 DB-locking regression coverage); production
// callers reach it only through akmImprove → runImprovePostLoopStage.
export async function runImproveMaintenancePasses(args: {
  options: AkmImproveOptions;
  primaryStashDir?: string;
  actionableRefs: ImproveEligibleRef[];
  memoryRefsForInference: Set<string>;
  allWarnings: string[];
  reindexFn: (options: { stashDir: string; signal?: AbortSignal }) => Promise<unknown>;
  /** D9: true when consolidation ran and wrote at least one record this improve run. */
  consolidationRan?: boolean;
  /** O-1 (#364): shared wall-clock AbortSignal; cancels sub-calls when budget expires. */
  budgetSignal?: AbortSignal;
  eventsCtx?: EventsContext;
  /** Active improve profile, resolved from profile name + config. */
  improveProfile?: import("../../core/config/config").ImproveProfileConfig;
  resolvedPlan?: ResolvedImprovePlan;
}): Promise<ImproveMaintenanceResult> {
  const { options, primaryStashDir, memoryRefsForInference, allWarnings, reindexFn, budgetSignal, eventsCtx } = args;
  if (!primaryStashDir) return { memoryInferenceDurationMs: 0, graphExtractionDurationMs: 0 };
  if (budgetSignal?.aborted) return { memoryInferenceDurationMs: 0, graphExtractionDurationMs: 0 };

  const config = options.config ?? loadConfig();
  const sources = resolveSourceEntries(options.stashDir, config);
  const memoryInferenceFn = options.memoryInferenceFn ?? runMemoryInferencePass;
  const graphExtractionFn = options.graphExtractionFn ?? runGraphExtractionPass;

  const openIndexDb = () =>
    openIndexDatabase(
      getDbPath(),
      config.embedding?.dimension ? { embeddingDim: config.embedding.dimension } : undefined,
    );

  const dbCell: IndexDbCell = {};

  // #584: see the MaintenanceCtx.reindexWithIndexDbReleased doc — close before
  // every reindex, reopen in `finally` so a failed reindex still leaves a
  // usable handle in the cell.
  const reindexWithIndexDbReleased = async (stashDir: string): Promise<void> => {
    if (dbCell.current) {
      closeDatabase(dbCell.current);
      dbCell.current = undefined;
    }
    try {
      await reindexFn({ stashDir, signal: budgetSignal });
    } finally {
      dbCell.current = openIndexDb();
    }
  };

  const ctx: MaintenanceCtx = {
    config,
    sources,
    primaryStashDir,
    eventsCtx,
    budgetSignal,
    improveProfile: args.improveProfile,
    resolvedPlan: args.resolvedPlan,
    memoryInferenceFn,
    graphExtractionFn,
    reindexWithIndexDbReleased,
  };

  const collected = await runMaintenancePassesUnderLease(ctx, dbCell, {
    actionableRefs: args.actionableRefs,
    memoryRefsForInference,
    consolidationRan: args.consolidationRan,
    allWarnings,
    openIndexDb,
  });

  return {
    ...(collected.memoryInference ? { memoryInference: collected.memoryInference } : {}),
    ...(collected.graphExtraction ? { graphExtraction: collected.graphExtraction } : {}),
    ...(collected.actions.length > 0 ? { actions: collected.actions } : {}),
    memoryInferenceDurationMs: collected.memoryInferenceDurationMs,
    graphExtractionDurationMs: collected.graphExtractionDurationMs,
    orphansPurged: collected.orphansPurged,
    proposalsExpired: collected.proposalsExpired,
  };
}

/** Everything the lease-scoped maintenance sequence accumulates for the caller. */
interface MaintenanceUnderLeaseResult {
  memoryInference?: MemoryInferenceResult;
  graphExtraction?: GraphExtractionResult;
  actions: ImproveActionResult[];
  memoryInferenceDurationMs: number;
  graphExtractionDurationMs: number;
  orphansPurged: number;
  proposalsExpired: number;
}

/**
 * The maintenance sequence (formerly the ~389-line anonymous
 * `withIndexWriterLease` callback, before #872 removed the index-rebuild
 * lease): memory inference → reindex-after-inference → graph extraction →
 * proposal hygiene (orphan purge, expiration) → retention purges. Each pass
 * returns its results and warnings; this orchestrator folds warnings into the
 * caller's `allWarnings` sink at the same points the inline code pushed them.
 */
async function runMaintenancePassesUnderLease(
  ctx: MaintenanceCtx,
  dbCell: IndexDbCell,
  args: {
    actionableRefs: ImproveEligibleRef[];
    memoryRefsForInference: Set<string>;
    consolidationRan?: boolean;
    allWarnings: string[];
    openIndexDb: () => Database;
  },
): Promise<MaintenanceUnderLeaseResult> {
  const { allWarnings } = args;
  const actions: ImproveActionResult[] = [];
  let reindexedAfterInference = false;
  try {
    dbCell.current = args.openIndexDb();

    const inference = await runMemoryInferenceMaintenancePass(ctx, dbCell, args.memoryRefsForInference);
    if (inference.action) actions.push(inference.action);
    allWarnings.push(...inference.warnings);
    const memoryInference = inference.memoryInference;

    if (memoryInference && (memoryInference.splitParents > 0 || memoryInference.writtenFacts > 0)) {
      info("[improve] reindexing after memory inference writes");
      try {
        await ctx.reindexWithIndexDbReleased(ctx.primaryStashDir);
        reindexedAfterInference = true;
        info("[improve] reindex after memory inference complete");
      } catch (err) {
        allWarnings.push(`reindex after memory inference failed: ${errMessage(err)}`);
      }
    }

    const graph = await runGraphExtractionMaintenancePass(ctx, dbCell, {
      actionableRefs: args.actionableRefs,
      memoryRefsForInference: args.memoryRefsForInference,
      consolidationRan: args.consolidationRan,
      reindexedAfterInference,
    });
    if (graph.action) actions.push(graph.action);
    allWarnings.push(...graph.warnings);

    const orphan = runOrphanProposalPurgePass(ctx);
    allWarnings.push(...orphan.warnings);

    // #733: orphan-state GC — stamps/clears/(optionally) collects
    // asset_salience/asset_outcome rows whose ref no longer resolves in
    // index.db. Needs the SAME already-open index.db handle (dbCell.current)
    // the passes above share.
    const stateGc = runOrphanStateGcPass(ctx, dbCell);
    allWarnings.push(...stateGc.warnings);

    const expiration = runProposalExpirationPass(ctx);
    allWarnings.push(...expiration.warnings);

    allWarnings.push(...runRetentionPurgePass(ctx).warnings);

    return {
      memoryInference,
      graphExtraction: graph.graphExtraction,
      actions,
      memoryInferenceDurationMs: inference.durationMs,
      graphExtractionDurationMs: graph.durationMs,
      orphansPurged: orphan.orphansPurged,
      proposalsExpired: expiration.proposalsExpired,
    };
  } finally {
    if (dbCell.current) closeDatabase(dbCell.current);
  }
}

/**
 * Memory inference candidate-discovery (post-Item 9 fix from
 * memories/akm-improve-critical-review-2026-05-20). Previously this pass
 * was gated on memoryRefsForInference.size > 0 AND passed those refs as a
 * candidateRefs filter. But memoryRefsForInference is populated from refs
 * distilled THIS RUN — by the time that happens, those parents are
 * already split (`inferenceProcessed: true`) and `isPendingMemory` excludes
 * them. The genuinely-pending parents in the stash never entered the
 * filter. Result: 0/0/0 for 25 consecutive runs.
 *
 * Fix: always run the pass when the feature is enabled; let the pass's
 * own `collectPendingMemories` + `isPendingMemory` predicate find
 * candidates from the filesystem-of-truth. The this-run set is still
 * logged as a hint but no longer used as a filter.
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
  const { config, sources, primaryStashDir, budgetSignal, improveProfile, resolvedPlan, memoryInferenceFn } = ctx;
  const warnings: string[] = [];
  let memoryInference: MemoryInferenceResult | undefined;
  let durationMs = 0;
  let action: ImproveActionResult | undefined;

  const memoryInferenceDisabledByProfile = improveProfile?.processes?.memoryInference?.enabled === false;
  const minPendingCount = improveProfile?.processes?.memoryInference?.minPendingCount;
  const pendingBelowMinCount = (() => {
    if (!primaryStashDir || minPendingCount === undefined || minPendingCount <= 0) return false;
    const pending = collectPendingMemories(primaryStashDir).length;
    if (pending < minPendingCount) {
      info(`[improve] memory inference skipped (${pending} pending < minPendingCount ${minPendingCount})`);
      return true;
    }
    return false;
  })();
  if (memoryInferenceDisabledByProfile) {
    info("[improve] memory inference skipped (disabled by improve profile)");
  } else if (pendingBelowMinCount) {
    // skipped — message already emitted above
  } else {
    const hintRefs = memoryRefsForInference.size;
    info(
      hintRefs > 0
        ? `[improve] memory inference starting (${hintRefs} hint refs touched this run; pass discovers all pending)`
        : "[improve] memory inference starting (discovering pending parents)",
    );
    const inferenceStart = Date.now();
    try {
      // O-1 (#364): pass budget signal so a hung inference call is cancelled.
      memoryInference = await withLlmStage(
        "memory-inference",
        () =>
          memoryInferenceFn({
            config,
            ...(resolvedPlan
              ? {
                  llmRunner: resolvedPlan.processes.memoryInference.runner,
                }
              : {}),
            sources,
            signal: budgetSignal,
            db: dbCell.current,
            reEnrich: false,
            onProgress: (event) => {
              const current = event.currentRef ? ` ${event.currentRef}` : "";
              info(
                `[improve] memory inference ${event.processed}/${event.total}${current} (written ${event.writtenFacts}, skipped ${event.skippedNoFacts})`,
              );
            },
          }),
        { engine: resolvedPlan?.processes.memoryInference.runner?.engine, process: "memoryInference" },
      );
      durationMs = Date.now() - inferenceStart;
      // Synthetic sentinel ref (ref-grammar decision D-R3): a colon-free
      // `<domain>/_<marker>` label on the event row, never parsed as an asset
      // ref. The domain is the asset stash-subdir for asset-scoped sentinels
      // (`memories/…`) and the subsystem name for maintenance/artifact sentinels
      // (`graph/…`, `events/…`, `proposals/…`, `health/…`, …). Readers match the
      // event by `eventType`, never by this string.
      action = { ref: "memories/_inference", mode: "memory-inference", result: memoryInference };
      info(
        `[improve] memory inference complete (${memoryInference.writtenFacts} facts written from ${memoryInference.splitParents} parents)`,
      );
    } catch (err) {
      durationMs = Date.now() - inferenceStart;
      warnings.push(`memory inference failed: ${errMessage(err)}`);
    }
  }

  return { memoryInference, durationMs, action, warnings };
}

/**
 * Graph-extraction maintenance pass.
 *
 * INVARIANT: graph extraction normally runs only on files touched by
 * actionable refs (candidatePaths). Full-corpus scans are opt-in via
 * profile.processes.graphExtraction.fullScan = true (used by the
 * `graph-refresh` built-in profile and its weekly scheduled task).
 * The empty-Set fallback is intentional when no refs were touched —
 * the extractor's filter rejects every file and returns empty, keeping
 * the pass invoked so the action is recorded and tests stay exercised.
 */
export async function runGraphExtractionMaintenancePass(
  ctx: MaintenanceCtx,
  dbCell: IndexDbCell,
  args: {
    actionableRefs: ImproveEligibleRef[];
    memoryRefsForInference: Set<string>;
    /** D9: true when consolidation ran and wrote at least one record this improve run. */
    consolidationRan?: boolean;
    /** True when the memory-inference reindex already refreshed the handle. */
    reindexedAfterInference: boolean;
  },
): Promise<{
  graphExtraction?: GraphExtractionResult;
  durationMs: number;
  action?: ImproveActionResult;
  warnings: string[];
}> {
  const { config, sources, primaryStashDir, budgetSignal, improveProfile, resolvedPlan, graphExtractionFn } = ctx;
  const warnings: string[] = [];
  let graphExtraction: GraphExtractionResult | undefined;
  let durationMs = 0;
  let action: ImproveActionResult | undefined;
  let reindexedAfterInference = args.reindexedAfterInference;

  const graphEnabled = resolvedPlan ? true : isProcessEnabled("index", "graph_extraction", config);
  const graphExtractionDisabledByProfile = improveProfile?.processes?.graphExtraction?.enabled === false;
  const graphExtractionFullScan = improveProfile?.processes?.graphExtraction?.fullScan === true;
  // #624 P2: optional incremental high-signal-first cap. Unset = process all
  // eligible (byte-identical to today; no ranking/slice).
  const graphExtractionTopN = improveProfile?.processes?.graphExtraction?.topN;
  const graphExtractionIncludeTypes = improveProfile?.processes?.graphExtraction?.includeTypes ?? [
    ...DEFAULT_GRAPH_EXTRACTION_INCLUDE_TYPES,
  ];
  const graphExtractionBatchSize =
    improveProfile?.processes?.graphExtraction?.batchSize ?? DEFAULT_GRAPH_EXTRACTION_BATCH_SIZE;
  // Build the set of refs actually touched this run.
  const touchedRefs = new Set<string>();
  for (const r of args.actionableRefs) touchedRefs.add(r.ref);
  for (const r of args.memoryRefsForInference) touchedRefs.add(r);

  if (graphExtractionDisabledByProfile) {
    info("[improve] graph extraction skipped (disabled by improve profile)");
  } else if (sources.length > 0 && graphEnabled) {
    info(`[improve] graph extraction starting${graphExtractionFullScan ? " (full-corpus scan)" : ""}`);
    const extractionStart = Date.now();
    try {
      // D9: if consolidation ran but memory inference did not reindex, force a reindex
      // so graph extraction sees current DB state after consolidation writes.
      if (args.consolidationRan && !reindexedAfterInference) {
        info("[improve] reindexing after consolidation (graph extraction needs current state)");
        try {
          await ctx.reindexWithIndexDbReleased(primaryStashDir);
          reindexedAfterInference = true;
          info("[improve] reindex after consolidation complete");
        } catch (err) {
          warnings.push(`reindex after consolidation failed: ${errMessage(err)}`);
        }
      }
      // #584: no close/reopen needed here — reindexWithIndexDbReleased
      // already swapped in a fresh post-reindex handle.
      // Resolve touched refs to absolute file paths. Skipped for fullScan
      // (candidatePaths stays undefined → extractor processes all files).
      let candidatePaths: Set<string> | undefined;
      if (!graphExtractionFullScan) {
        candidatePaths = new Set<string>();
        if (primaryStashDir && touchedRefs.size > 0) {
          const writableBundleIds = deriveWritableBundleIds(resolveSourceEntries(primaryStashDir));
          const resolved = await Promise.all(
            [...touchedRefs].map((ref) => findAssetFilePath(ref, primaryStashDir, writableBundleIds).catch(() => null)),
          );
          for (const p of resolved) {
            if (typeof p === "string" && p.length > 0) candidatePaths.add(p);
          }
        }
      }
      const progressHandler = (event: {
        processed: number;
        total: number;
        extracted: number;
        totalEntities: number;
        totalRelations: number;
        currentPath?: string;
      }) => {
        const current = event.currentPath ? ` ${path.basename(event.currentPath)}` : "";
        info(
          `[improve] graph extraction ${event.processed}/${event.total}${current} (extracted ${event.extracted}, entities ${event.totalEntities}, relations ${event.totalRelations})`,
        );
      };
      // O-1 (#364): pass budget signal so a hung graph extraction call is cancelled.
      graphExtraction = await withLlmStage(
        "graph-extraction",
        () =>
          graphExtractionFn({
            config,
            ...(resolvedPlan
              ? {
                  llmRunner: resolvedPlan.processes.graphExtraction.runner,
                }
              : {}),
            sources,
            signal: budgetSignal,
            db: dbCell.current,
            reEnrich: false,
            onProgress: progressHandler,
            options: {
              candidatePaths,
              includeTypes: graphExtractionIncludeTypes,
              batchSize: graphExtractionBatchSize,
              ...(graphExtractionTopN != null ? { topN: graphExtractionTopN } : {}),
            },
          }),
        { engine: resolvedPlan?.processes.graphExtraction.runner?.engine, process: "graphExtraction" },
      );
      durationMs = Date.now() - extractionStart;
      // Synthetic sentinel ref (D-R3): `graph` has no asset stash-subdir, so the
      // colon-free `graph/_artifact` names the subsystem, per the sentinel
      // convention documented at the memory-inference writer above.
      action = { ref: "graph/_artifact", mode: "graph-extraction", result: graphExtraction };
      info(
        `[improve] graph extraction complete (${graphExtraction.quality.extractedFiles} files, ${graphExtraction.quality.entityCount} entities, ${graphExtraction.quality.relationCount} relations)`,
      );
    } catch (err) {
      durationMs = Date.now() - extractionStart;
      warnings.push(`graph extraction failed: ${errMessage(err)}`);
    }
  } else if (sources.length > 0 && !graphEnabled) {
    info("[improve] graph extraction skipped (features.index.graph_extraction is disabled)");
  }

  return { graphExtraction, durationMs, action, warnings };
}

/**
 * Orphan proposal purge — reject pending reflect proposals whose target
 * asset no longer exists on disk. Runs after graph extraction so newly
 * promoted assets from accept flows during this run are already present.
 */
function runOrphanProposalPurgePass(ctx: MaintenanceCtx): { orphansPurged: number; warnings: string[] } {
  const { primaryStashDir, sources, eventsCtx } = ctx;
  const warnings: string[] = [];
  let orphansPurged = 0;
  try {
    const purgeResult = purgeOrphanProposals(
      primaryStashDir,
      sources.map((s) => s.path),
    );
    orphansPurged = purgeResult.rejected;
    if (purgeResult.rejected > 0) {
      info(
        `[improve] orphan purge: ${purgeResult.rejected}/${purgeResult.checked} orphaned proposals rejected (${purgeResult.durationMs}ms)`,
      );
    }
    appendEvent(
      {
        eventType: "proposal_orphan_purge",
        ref: "proposals/_orphan-purge",
        metadata: {
          checked: purgeResult.checked,
          rejected: purgeResult.rejected,
          durationMs: purgeResult.durationMs,
          byType: purgeResult.byType,
          orphans: purgeResult.orphans.map((o) => o.ref),
        },
      },
      eventsCtx,
    );
  } catch (err) {
    warnings.push(`orphan purge failed: ${errMessage(err)}`);
  }
  return { orphansPurged, warnings };
}

/**
 * Phase 6B (Advantage D6b): expire pending proposals that have aged past
 * the retention window. Runs AFTER orphan purge so we never double-archive
 * a proposal that orphan-purge already moved. `expireStaleProposals` emits
 * its own per-proposal `proposal_expired` events; we additionally emit a
 * single roll-up event here for parity with the orphan-purge surface.
 */
function runProposalExpirationPass(ctx: MaintenanceCtx): { proposalsExpired: number; warnings: string[] } {
  const { primaryStashDir, config, eventsCtx } = ctx;
  const warnings: string[] = [];
  let proposalsExpired = 0;
  try {
    const expireResult = expireStaleProposals(primaryStashDir, config);
    proposalsExpired = expireResult.expired;
    if (expireResult.expired > 0) {
      info(
        `[improve] expiration: ${expireResult.expired}/${expireResult.checked} pending proposals expired ` +
          `(retention=${expireResult.retentionDays}d, ${expireResult.durationMs}ms)`,
      );
    }
    appendEvent(
      {
        eventType: "proposal_expiration_pass",
        ref: "proposals/_expiration",
        metadata: {
          checked: expireResult.checked,
          expired: expireResult.expired,
          durationMs: expireResult.durationMs,
          retentionDays: expireResult.retentionDays,
          expiredProposals: expireResult.expiredProposals,
        },
      },
      eventsCtx,
    );
  } catch (err) {
    warnings.push(`proposal expiration failed: ${errMessage(err)}`);
  }
  return { proposalsExpired, warnings };
}

/**
 * Fix #2 (observability 0.8.0): trim the events table in state.db so it
 * doesn't grow unbounded. `akm health` writes a `health_probe` row on every
 * invocation, and every command surface emits at least one event besides —
 * without this trim, state.db is a permanent append-only log. Config key
 * `improve.eventRetentionDays` (default 90, set 0 to disable) controls the
 * window. The purge runs against state.db (a different SQLite file from
 * the index handle the other passes use).
 */
export function runRetentionPurgePass(ctx: MaintenanceCtx): { warnings: string[] } {
  const { config, eventsCtx } = ctx;
  const warnings: string[] = [];
  const retentionDays = typeof config.improve?.eventRetentionDays === "number" ? config.improve.eventRetentionDays : 90;
  if (retentionDays > 0) {
    // #585: reuse the long-lived eventsCtx.db connection when akmImprove
    // opened one — opening a second state.db write connection while
    // eventsDb is still live made two simultaneous writers contend on the
    // same WAL file ("database is locked"). Only the eventsCtx.dbPath
    // fallback path (state.db failed to open up-front) opens — and then
    // owns and closes — its own handle. C2 still holds: the fallback uses
    // the boundary-pinned path, never a live `process.env` re-read.
    try {
      withStateDb(
        (stateDb) => {
          const purgedCount = purgeOldEvents(stateDb, retentionDays);
          if (purgedCount > 0) {
            info(`[improve] events purge: ${purgedCount} event(s) older than ${retentionDays}d removed from state.db`);
          }
          appendEvent(
            {
              eventType: "events_purged",
              ref: "events/_purge",
              metadata: { purgedCount, retentionDays },
            },
            eventsCtx,
          );

          // improve_runs uses the same retention window as events — both are
          // observability/audit data, both grow append-only, both have a
          // dedicated purge helper. Mirroring the events purge here means a
          // single retention knob (improve.eventRetentionDays) governs both.
          const improveRunsPurged = purgeOldImproveRuns(stateDb, retentionDays);
          if (improveRunsPurged > 0) {
            info(
              `[improve] improve_runs purge: ${improveRunsPurged} run(s) older than ${retentionDays}d removed from state.db`,
            );
          }
          appendEvent(
            {
              eventType: "improve_runs_purged",
              ref: "improve_runs/_purge",
              metadata: { purgedCount: improveRunsPurged, retentionDays },
            },
            eventsCtx,
          );

          // R5: improve_cycle_metrics has its OWN retention window
          // (default 365d — a slow collapse needs a longer trend than
          // the 90d events window). canary_queries rows are never purged.
          const cycleRetention = config.improve?.collapseDetector?.retentionDays ?? CYCLE_METRICS_RETENTION_DAYS;
          const cycleMetricsPurged = purgeOldCycleMetrics(stateDb, cycleRetention);
          if (cycleMetricsPurged > 0) {
            info(
              `[improve] cycle-metrics purge: ${cycleMetricsPurged} row(s) older than ${cycleRetention}d removed from state.db`,
            );
            appendEvent(
              {
                // Dedicated type (mirrors improve_runs_purged) so consumers
                // never have to disambiguate purge targets via the ref string.
                eventType: "improve_cycle_metrics_purged",
                ref: "improve_cycle_metrics/_purge",
                metadata: { purgedCount: cycleMetricsPurged, retentionDays: cycleRetention },
              },
              eventsCtx,
            );
          }
        },
        { path: eventsCtx?.dbPath, borrowed: eventsCtx?.db },
      );
    } catch (err) {
      warnings.push(`events purge failed: ${errMessage(err)}`);
    }

    // task_logs in logs.db (#579) shares the same retention window as
    // events/improve_runs — all three are observability data governed by
    // the single improve.eventRetentionDays knob. Separate try/finally
    // because logs.db is a different file: a locked/missing logs.db must
    // not block the state.db purges above.
    let logsDb: ReturnType<typeof openLogsDatabase> | undefined;
    try {
      logsDb = openLogsDatabase();
      const taskLogsPurged = purgeOldTaskLogs(logsDb, retentionDays);
      if (taskLogsPurged > 0) {
        info(
          `[improve] task_logs purge: ${taskLogsPurged} log line(s) older than ${retentionDays}d removed from logs.db`,
        );
      }
      appendEvent(
        {
          eventType: "task_logs_purged",
          ref: "task_logs/_purge",
          metadata: { purgedCount: taskLogsPurged, retentionDays },
        },
        eventsCtx,
      );
    } catch (err) {
      warnings.push(`task_logs purge failed: ${errMessage(err)}`);
    } finally {
      if (logsDb) {
        try {
          logsDb.close();
        } catch {
          // best-effort
        }
      }
    }

    // Per-run flat log files under getTaskLogDir() (#951): logs.db above is
    // the durable record and already retention-purged, so the transitional
    // `<taskId>/<timestamp>.log` tail files can be deleted on the same
    // window without losing anything. A separate try/catch — a filesystem
    // problem here must not block the DB purges above.
    try {
      const taskLogFilesPurged = purgeOldTaskLogFiles(undefined, retentionDays);
      if (taskLogFilesPurged > 0) {
        info(
          `[improve] task log files purge: ${taskLogFilesPurged} file(s) older than ${retentionDays}d removed from ${getTaskLogDir()}`,
        );
      }
      appendEvent(
        {
          eventType: "task_log_files_purged",
          ref: "task_log_files/_purge",
          metadata: { purgedCount: taskLogFilesPurged, retentionDays },
        },
        eventsCtx,
      );
    } catch (err) {
      warnings.push(`task log files purge failed: ${errMessage(err)}`);
    }
  }
  return { warnings };
}

// ── #733 — orphan-state GC pass (Workstream C) ──────────────────────────────
//
// Deliberately lean: one maintenance pass, one additive migration (021), one
// event type (asset_state_gc), one config gate (improve.stateGc.collect,
// default false). See docs/architecture/specs/0.9.0-close-out-plan.md
// Workstream C for the full design rationale. No quarantine archive, no
// circuit breaker, no health-advisory plumbing, no new tables.

/**
 * Grace window (ms) before an unresolved `asset_salience` / `asset_outcome`
 * row becomes delete-eligible — only when `improve.stateGc.collect` is true.
 * A named constant, not a config knob (owner ruling — see the close-out
 * plan's Workstream C). Mirrors `TXN_SWEEP_GRACE_MS` (src/core/fs-txn.ts:298).
 */
export const STATE_GC_GRACE_MS = daysToMs(7);

/**
 * Resolve one state-table's stored `asset_ref` against the live index.
 *
 * "ref not present in entries.item_ref" is the authoritative-deletion
 * predicate (see the pass doc comment below), so this is a thin wrapper
 * around the same single-ref probe the rest of improve uses
 * (`getEntryByRef`, index-entries-repository.ts) — which already resolves
 * both storage spellings a write can produce (`salienceWriteKey`/
 * `outcomeWriteKey` = `itemRef ?? ref`): an exact bundle-qualified item_ref,
 * or a bare conceptId matched by suffix across all bundles.
 *
 * On top of that, falls back to the BARE conceptId form (`bareImproveRef` —
 * the same primitive `preparation.ts`'s `normalizeStoredKey` map is built
 * from via `improveStateReadRefs`) when the stored ref carries a bundle
 * prefix that no longer matches exactly. This is the legacy-spelling
 * normalization trap: a naive `asset_ref NOT IN (SELECT item_ref FROM
 * entries)` would treat a live asset whose row predates bundle-qualification
 * (or whose bundle prefix is stale) as an orphan and delete it. Preferring
 * "never delete a live row" over "never miss a genuinely dead one" mirrors
 * `getEntryByRef`'s own bare-conceptId suffix-match trade-off.
 */
function isStateRefLive(indexDb: Database, storedRef: string): boolean {
  if (getEntryByRef(indexDb, storedRef) !== null) return true;
  const bare = bareImproveRef(storedRef);
  return bare !== storedRef && getEntryByRef(indexDb, bare) !== null;
}

/** Per-table sweep result — the {pending, collected} shape the event and pass summary report. */
interface StateGcTableResult {
  pending: number;
  collected: number;
}

/** The four repository operations {@link gcOneStateTable} needs, injected so both tables share one sweep body. */
interface StateGcTableOps {
  refRows: ReadonlyArray<{ asset_ref: string; missing_since: number | null }>;
  stamp: (refs: string[], now: number) => number;
  clear: (refs: string[]) => number;
  deleteOlderThan: (cutoffMs: number) => number;
  countPending: () => number;
}

/**
 * Sweep ONE state table: stamp refs that just went unresolved, clear refs
 * that resolved again, and — only when `collect` is true — delete rows whose
 * `missing_since` is older than {@link STATE_GC_GRACE_MS}. `pending` is a
 * point-in-time snapshot taken AFTER stamp/clear/delete (re-queried, not
 * accumulated), so it reflects the current backlog rather than this run's
 * delta — "every run emits the counts either way, so live data accumulates
 * proof" (close-out plan, Workstream C).
 */
function gcOneStateTable(
  args: { indexDb: Database; now: number; collect: boolean } & StateGcTableOps,
): StateGcTableResult {
  const { refRows, indexDb, now, collect, stamp, clear, deleteOlderThan, countPending } = args;
  const toStamp: string[] = [];
  const toClear: string[] = [];
  for (const row of refRows) {
    const live = isStateRefLive(indexDb, row.asset_ref);
    if (!live && row.missing_since == null) toStamp.push(row.asset_ref);
    else if (live && row.missing_since != null) toClear.push(row.asset_ref);
  }
  if (toStamp.length > 0) stamp(toStamp, now);
  if (toClear.length > 0) clear(toClear);

  const collected = collect ? deleteOlderThan(now - STATE_GC_GRACE_MS) : 0;
  const pending = countPending();

  return { pending, collected };
}

/**
 * Orphan-state GC — #733 (Workstream C). For each of the two per-asset state
 * tables (`asset_salience`, `asset_outcome`), stamps `missing_since` on refs
 * that no longer resolve against `entries.item_ref` in index.db, clears the
 * stamp on refs that resolve again, and — only when `improve.stateGc.collect`
 * is true — deletes rows whose stamp is older than {@link STATE_GC_GRACE_MS}.
 *
 * "ref not present in entries.item_ref" IS the authoritative-deletion
 * predicate: "absent ≠ deleted" is inherited from the indexer, not
 * re-implemented here — an incomplete or failed source scan preserves that
 * source's last-known-good `entries` rows (indexer.ts ~1195-1199), and
 * mass-wipe is already gated upstream (`preserveExistingIndex` +
 * `fullDelete && scanComplete`). A temporarily unreachable source therefore
 * never surfaces candidates; no separate scan-status tracking is needed.
 *
 * Runs under the SAME index-writer lease / borrowed-state.db-connection
 * discipline as the neighboring maintenance passes: `dbCell.current` supplies
 * the already-open index.db handle (#584), and state.db access goes through
 * `withStateDb(..., { borrowed: eventsCtx?.db })` so this never opens a
 * second live writer alongside a long-lived `eventsCtx.db` connection — see
 * the #585 comment on {@link runRetentionPurgePass}'s events-purge call for
 * why that matters ("database is locked").
 *
 * Exported for direct test coverage (tests/integration/commands/improve/
 * state-gc.test.ts), mirroring the `runMemoryInferenceMaintenancePass` /
 * `runGraphExtractionMaintenancePass` / `runRetentionPurgePass` precedent;
 * production callers reach it only through `runMaintenancePassesUnderLease`.
 */
export function runOrphanStateGcPass(
  ctx: MaintenanceCtx,
  dbCell: IndexDbCell,
): { pending: number; collected: number; warnings: string[] } {
  const { eventsCtx, config } = ctx;
  const warnings: string[] = [];
  const indexDb = dbCell.current;
  if (!indexDb) {
    warnings.push("orphan state GC skipped: no index.db handle available");
    return { pending: 0, collected: 0, warnings };
  }

  const collect = config.improve?.stateGc?.collect === true;
  const now = Date.now();
  let pending = 0;
  let collected = 0;

  try {
    withStateDb(
      (stateDb) => {
        const salienceResult = gcOneStateTable({
          refRows: listAssetSalienceMissingState(stateDb),
          indexDb,
          now,
          collect,
          stamp: (refs, ts) => stampAssetSalienceMissing(stateDb, refs, ts),
          clear: (refs) => clearAssetSalienceMissing(stateDb, refs),
          deleteOlderThan: (cutoffMs) => deleteAssetSalienceMissingBefore(stateDb, cutoffMs),
          countPending: () => countAssetSalienceMissing(stateDb),
        });

        const outcomeResult = gcOneStateTable({
          refRows: listAssetOutcomeMissingState(stateDb),
          indexDb,
          now,
          collect,
          stamp: (refs, ts) => stampAssetOutcomeMissing(stateDb, refs, ts),
          clear: (refs) => clearAssetOutcomeMissing(stateDb, refs),
          deleteOlderThan: (cutoffMs) => deleteAssetOutcomeMissingBefore(stateDb, cutoffMs),
          countPending: () => countAssetOutcomeMissing(stateDb),
        });

        // Table-name-shaped keys ("salience"/"outcome", not the guarded
        // "asset_salience"/"asset_outcome" table names) — this file sits
        // outside src/storage/repositories/**, where the state-table-sql
        // lint rule (#672) forbids naming those tables even in a log string
        // or an object key, not just in raw SQL.
        const byTable = { salience: salienceResult, outcome: outcomeResult };
        pending = salienceResult.pending + outcomeResult.pending;
        collected = salienceResult.collected + outcomeResult.collected;

        if (pending > 0 || collected > 0) {
          info(
            `[improve] orphan state GC: ${pending} pending, ${collected} collected ` +
              `(salience ${salienceResult.pending}/${salienceResult.collected}, ` +
              `outcome ${outcomeResult.pending}/${outcomeResult.collected})`,
          );
          // #733 — asset_state_gc reports the current per-table backlog
          // snapshot (`pending`) plus this run's deletions (`collected`);
          // emitted only when there is something to report (mirrors the
          // rekey script's no-op-stays-silent precedent) so a perpetually
          // clean stash never accumulates events.
          appendEvent(
            {
              eventType: "asset_state_gc",
              ref: "asset_state/_gc",
              metadata: { pending, collected, byTable },
            },
            eventsCtx,
          );
        }
      },
      { path: eventsCtx?.dbPath, borrowed: eventsCtx?.db },
    );
  } catch (err) {
    warnings.push(`orphan state GC failed: ${errMessage(err)}`);
  }

  return { pending, collected, warnings };
}
