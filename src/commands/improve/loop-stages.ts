// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import path from "node:path";
import { parseAssetRef } from "../../core/asset/asset-ref";
import { daysToMs } from "../../core/common";
import { loadConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import { appendEvent, type EventsContext } from "../../core/events";
import type {
  ImproveActionResult,
  ImproveEligibleRef,
  ProceduralCompilationResult,
  RecombineResult,
} from "../../core/improve-types";
import { openLogsDatabase, purgeOldTaskLogs } from "../../core/logs-db";
import { getDbPath } from "../../core/paths";
import { withStateDb } from "../../core/state-db";
import { info, warn } from "../../core/warn";
import { closeDatabase, openIndexDatabase } from "../../indexer/db/db";
import { type GraphExtractionResult, runGraphExtractionPass } from "../../indexer/graph/graph-extraction";
import { withIndexWriterLease } from "../../indexer/index-writer-lock";
import {
  collectPendingMemories,
  type MemoryInferenceResult,
  runMemoryInferencePass,
} from "../../indexer/passes/memory-inference";
import { getWritableStashDirs, resolveSourceEntries } from "../../indexer/search/search-source";
import { resolveImproveProcessRunner } from "../../integrations/agent/runner";
import { isProcessEnabled } from "../../llm/feature-gate";
import { withLlmStage } from "../../llm/usage-telemetry";
import type { Database } from "../../storage/database";
import { type CycleMetricsRow, purgeOldCycleMetrics } from "../../storage/repositories/canaries-repository";
import { purgeOldEvents } from "../../storage/repositories/events-repository";
import { purgeOldImproveRuns } from "../../storage/repositories/improve-runs-repository";
import {
  createProposal,
  expireStaleProposals,
  isProposalSkipped,
  listProposals,
  purgeOrphanProposals,
} from "../proposal/repository";
import { checkDeadUrls, type DeadUrl } from "../url-checker";
import { DEFAULT_RETENTION_DAYS as CYCLE_METRICS_RETENTION_DAYS, runCollapseDetector } from "./collapse-detector";
import { type AkmDistillResult, deriveLessonRef } from "./distill";
import { deriveKnowledgeRef } from "./distill-promotion-policy";
// Eligibility / candidate-selection predicates live in ./eligibility.
import { findAssetFilePath, isDistillCandidateRef } from "./eligibility";
import { writeEvalCase } from "./eval-cases";
import type {
  AkmImproveOptions,
  ImproveLoopResult,
  ImproveMaintenanceResult,
  ImprovePostLoopResult,
  ImproveRunContext,
  ImproveScope,
} from "./improve";
import { makeGateConfig, runAutoAcceptGate } from "./improve-auto-accept";
import { resolveProcessEnabled, shouldSkipRef } from "./improve-profiles";
import type { applyMemoryCleanup } from "./memory/memory-improve";
// The pre-loop preparation pipeline lives in ./preparation.
import { maybeAutoTuneThreshold } from "./preparation";
import { akmProcedural } from "./procedural";
import { akmRecombine } from "./recombine";
import type { AkmReflectResult } from "./reflect";
import { recordNoOp, resetConsecutiveNoOps } from "./salience";
import { errMessage, refSlug } from "./shared";

// ── improve loop / post-loop / maintenance stages ───────────────────
// The cycle stages run by akmImprove, extracted from improve.ts.

export async function runImproveLoopStage(args: ImproveRunContext): Promise<ImproveLoopResult> {
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
    utilityMap,
    startMs,
    budgetMs,
    eventsCtx,
    improveProfile,
  } = args;

  // O-1 (#364): compute remaining budget at call time so each sub-call
  // receives only its fair share of the wall-clock budget.
  const remainingBudgetMs = () => Math.max(0, budgetMs - (Date.now() - startMs));

  const RECENT_ERRORS_CAP = 3;

  // requirePlannedRefs guard: when the distill profile sets this flag, skip
  // distill for distill-only refs if the reflect phase produced no planned refs.
  // Prevents the distill loop from generating hundreds of distill-skipped events
  // on quiet passes (all refs on reflect cooldown, no new signal to distill).
  const requirePlannedRefs = improveProfile?.processes?.distill?.requirePlannedRefs === true;
  const _distillOnlyRefNames = new Set(distillOnlyRefs.map((r) => r.ref));
  const hasReflectEligibleRefs = loopRefs.some((r) => !_distillOnlyRefNames.has(r.ref));
  const skipDistillDueToRequirePlannedRefs = requirePlannedRefs && !hasReflectEligibleRefs;

  // R-2 / #389: Self-Consistency multi-sample voting helpers.
  // Wang et al. arXiv:2203.11171 — N=3 samples beat single-shot on reasoning tasks.
  const SC_THRESHOLD = options.selfConsistencyThreshold ?? 0.7;
  const SC_N = Math.min(Math.max(2, options.selfConsistencyN ?? 3), 5);

  /**
   * Compute Jaccard token overlap between two strings.
   * Tokenizes by whitespace; returns 0 when both are empty.
   */
  function jaccardSimilarity(a: string, b: string): number {
    const tokensA = new Set(a.split(/\s+/).filter(Boolean));
    const tokensB = new Set(b.split(/\s+/).filter(Boolean));
    if (tokensA.size === 0 && tokensB.size === 0) return 1;
    let intersection = 0;
    for (const t of tokensA) {
      if (tokensB.has(t)) intersection++;
    }
    const union = tokensA.size + tokensB.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  /**
   * Given N reflect results, return the one with the highest average Jaccard
   * similarity to all other successful results (majority-vote winner).
   * Falls back to the first successful result when N < 2.
   */
  function pickMajorityVote(results: AkmReflectResult[]): AkmReflectResult {
    const successful = results.filter((r): r is Extract<AkmReflectResult, { ok: true }> => r.ok);
    if (successful.length === 0)
      return (
        results[0] ?? {
          schemaVersion: 1,
          ok: false,
          reason: "non_zero_exit",
          error: "all samples failed",
          exitCode: null,
        }
      );
    if (successful.length === 1) return successful[0];
    let bestIdx = 0;
    let bestScore = -1;
    for (let i = 0; i < successful.length; i++) {
      let totalSim = 0;
      for (let j = 0; j < successful.length; j++) {
        if (i === j) continue;
        totalSim += jaccardSimilarity(
          successful[i].proposal.payload.content ?? "",
          successful[j].proposal.payload.content ?? "",
        );
      }
      const avgSim = totalSim / (successful.length - 1);
      if (avgSim > bestScore) {
        bestScore = avgSim;
        bestIdx = i;
      }
    }
    return successful[bestIdx] ?? successful[0];
  }

  // O-5 / #378: helper to push per-originator errors into the rolling window.
  function pushRecentError(originator: string, msg: string): void {
    if (!recentErrors[originator]) recentErrors[originator] = [];
    recentErrors[originator].push(msg);
    if (recentErrors[originator].length > RECENT_ERRORS_CAP) recentErrors[originator].shift();
  }
  // Build a Set for O(1) membership test — these refs skip the reflect call (Bug D2).
  const distillOnlyRefSet = new Set(distillOnlyRefs.map((r) => r.ref));
  let completedCount = 0;
  let reflectsWithErrorContext = 0;
  const memoryRefsForInference = new Set<string>();

  // Pre-load all pending proposals once instead of querying per asset in the loop.
  const dedupeStashDirForProposals = primaryStashDir ?? options.stashDir;
  const pendingProposalRefSet = new Set<string>(
    dedupeStashDirForProposals
      ? listProposals(dedupeStashDirForProposals, { status: "pending" }).map((p) => p.ref)
      : [],
  );

  let gateAutoAcceptedCount = 0;
  let gateAutoAcceptFailedCount = 0;
  const reflectGateCfg = makeGateConfig("reflect", {
    globalThreshold: options.autoAccept,
    dryRun: options.dryRun ?? false,
    stashDir: primaryStashDir,
    config: options.config ?? loadConfig(),
    eventsCtx,
    stateDbPath: eventsCtx?.dbPath,
    // candidateCount drives the exploration budget. loopRefs is the per-phase
    // set for reflect/distill; pass it so exploration budget is proportional.
    candidateCount: loopRefs.length,
  });

  const distillGateCfg = makeGateConfig("distill", {
    globalThreshold: options.autoAccept,
    dryRun: options.dryRun ?? false,
    stashDir: primaryStashDir,
    config: options.config ?? loadConfig(),
    eventsCtx,
    stateDbPath: eventsCtx?.dbPath,
    candidateCount: loopRefs.length,
  });

  for (const planned of loopRefs) {
    if (Date.now() - startMs >= budgetMs) {
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
        // Type guard: skip reflect for unsupported types (script, env, task, etc.)
        // and raw wiki directories, driven by the active improve profile.
        const reflectSkip = shouldSkipRef(planned.ref, "reflect", improveProfile);
        if (reflectSkip.skip) {
          actions.push({
            ref: planned.ref,
            mode: "reflect-skipped",
            result: { ok: true, reason: reflectSkip.reason },
          });
        } else {
          // O-5 / #378: only inject reflect-originator errors into the reflect call.
          // Cross-task errors (e.g. schema-repair) must NOT contaminate reflect prompts.
          const reflectErrors = recentErrors.reflect ?? [];
          if (reflectErrors.length > 0) reflectsWithErrorContext++;
          // O-1 (#364): pass remaining budget as timeoutMs so the agent spawn is
          // bounded by the wall-clock deadline rather than the default per-profile timeout.
          const reflectBudgetMs = remainingBudgetMs();
          // Wire profile.processes.reflect.{mode, profile, timeoutMs} into the reflect
          // dispatch when present. Falls back to akmReflect's own config-based resolution
          // (profiles.improve.<name>.processes.reflect → defaults.llm) when the profile
          // does not specify.
          const reflectProfileRunner = resolveImproveProcessRunner(
            improveProfile,
            "reflect",
            options.config ?? loadConfig(),
          );
          const reflectCallArgs = {
            ref: planned.ref,
            task: options.task,
            // Active profile so reflect's per-process reads honor `--profile`.
            ...(improveProfile ? { improveProfile } : {}),
            ...(options.stashDir ? { stashDir: options.stashDir } : {}),
            ...(reflectErrors.length > 0 ? { avoidPatterns: [...reflectErrors] } : {}),
            eventSource: "improve" as const,
            // #639 — resolve the low-value filter from the ACTIVE improve profile
            // (default off when unset), so the running profile decides instead of
            // a hardcoded profiles.improve.default path.
            lowValueFilter: improveProfile.processes?.reflect?.lowValueFilter?.enabled === true,
            ...(reflectBudgetMs > 0 ? { timeoutMs: reflectBudgetMs } : {}),
            ...(reflectProfileRunner ? { runner: reflectProfileRunner } : {}),
            // Attribution: carry the eligibility lane so reflect stamps it on
            // the reflect_invoked event and the persisted proposal.
            ...(planned.eligibilitySource ? { eligibilitySource: planned.eligibilitySource } : {}),
          };
          // R-2 / #389: Self-consistency multi-sample voting for high-utility refs.
          // Self-Consistency arXiv:2203.11171 — N=3 samples beat single-shot quality.
          const refUtility = utilityMap.get(planned.ref) ?? 0;
          const useConsistency = refUtility >= SC_THRESHOLD && SC_N >= 2;
          let reflectResult: AkmReflectResult;
          if (useConsistency) {
            const samples: AkmReflectResult[] = [];
            for (let s = 0; s < SC_N; s++) {
              if (remainingBudgetMs() <= 0) break;
              // draftMode: skip DB write so each sample doesn't create a proposal.
              samples.push(await withLlmStage("reflect", () => reflectFn({ ...reflectCallArgs, draftMode: true })));
            }
            const winner = pickMajorityVote(
              samples.length > 0
                ? samples
                : [await withLlmStage("reflect", () => reflectFn({ ...reflectCallArgs, draftMode: true }))],
            );
            // Persist only the majority-vote winner as a single real proposal.
            if (winner.ok && primaryStashDir) {
              const persistResult = createProposal(primaryStashDir, {
                ref: winner.proposal.ref,
                source: "reflect",
                sourceRun: `reflect-sc-${Date.now()}`,
                payload: winner.proposal.payload,
                // Attribution: the self-consistency path persists the winner here
                // (draftMode skips reflect's own createProposal), so stamp the lane.
                ...(planned.eligibilitySource ? { eligibilitySource: planned.eligibilitySource } : {}),
              });
              reflectResult = isProposalSkipped(persistResult)
                ? {
                    schemaVersion: 2,
                    ok: false,
                    reason: "cooldown" as const,
                    error: `SC proposal skipped: ${persistResult.message}`,
                    ref: winner.ref,
                    engine: winner.engine,
                    exitCode: null,
                  }
                : { ...winner, proposal: persistResult };
            } else {
              reflectResult = winner;
            }
          } else {
            reflectResult = await withLlmStage("reflect", () => reflectFn(reflectCallArgs));
          }
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
          actions.push({
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
            pushRecentError("reflect", errMsg);
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
          if (isNoChange && eventsCtx?.db) {
            try {
              recordNoOp(eventsCtx.db, planned.ref);
            } catch {
              // best-effort: plasticity counter failure never blocks the run
            }
          } else if (reflectResult.ok && eventsCtx?.db) {
            try {
              resetConsecutiveNoOps(eventsCtx.db, planned.ref);
            } catch {
              // best-effort
            }
          }

          if (reflectResult.ok) {
            const reflectGr = await runAutoAcceptGate(
              [{ proposalId: reflectResult.proposal.id, confidence: reflectResult.proposal.confidence }],
              reflectGateCfg,
            );
            gateAutoAcceptedCount += reflectGr.promoted.length;
            gateAutoAcceptFailedCount += reflectGr.failed.length;
          }
        } // end else (reflect type/profile check)
      } else if (!isDistillOnly && planned.ref.endsWith(".derived")) {
        // B6: .derived refs skip reflect; record synthetic skip action.
        actions.push({
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
      // isDistillOnly refs: no reflect action emitted — proceed directly to distill path below.
      const hasRecentFeedbackSignal = signalBearingSet.has(planned.ref);
      const explicitRefScope = scope.mode === "ref";
      // Profile gate: apply the full type-filter / raw-wiki / disabled rules to
      // distill so callers who configure `profile.processes.distill.allowedTypes`
      // or land on raw-wiki refs get a recorded skip action instead of silently
      // proceeding.
      const distillSkip = shouldSkipRef(planned.ref, "distill", improveProfile);
      if (distillSkip.skip) {
        actions.push({
          ref: planned.ref,
          mode: "distill-skipped",
          result: { ok: true, reason: distillSkip.reason },
        });
        completedCount++;
        info(`[improve] ${completedCount}/${loopRefs.length} ${planned.ref}`);
        continue;
      }
      // requirePlannedRefs guard: skip distill for distill-only refs when no
      // reflect-eligible refs were planned this run, preventing mass skip events.
      if (skipDistillDueToRequirePlannedRefs && isDistillOnly) {
        actions.push({
          ref: planned.ref,
          mode: "distill-skipped",
          result: { ok: true, reason: "require_planned_refs" },
        });
        completedCount++;
        info(`[improve] ${completedCount}/${loopRefs.length} ${planned.ref}`);
        continue;
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
        (!distillCooledRefs.has(planned.ref) || explicitRefScope)
      ) {
        // TODO(refactor): single call site needs both lesson+knowledge refs for proposal dedup. If a third target ref type is added, extract deriveAllTargetRefs(inputRef): string[].
        const lessonRef = deriveLessonRef(planned.ref);
        const knowledgeRef = deriveKnowledgeRef(planned.ref);
        const dedupeStashDir = primaryStashDir ?? options.stashDir;
        if (dedupeStashDir) {
          // B2: check both lesson ref and knowledge ref since auto-promoted memories
          // create knowledge: proposals, not lesson: proposals.
          const hasExistingPending = pendingProposalRefSet.has(lessonRef) || pendingProposalRefSet.has(knowledgeRef);
          if (hasExistingPending) {
            actions.push({
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
            completedCount++;
            info(`[improve] ${completedCount}/${loopRefs.length} ${planned.ref}`);
            continue;
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
            (rejectedProposalsByRef.has(lessonRef) || rejectedProposalsByRef.has(knowledgeRef));
          if (recentlyRejectedLesson) {
            const rejectedEntry = rejectedProposalsByRef.get(lessonRef) ?? rejectedProposalsByRef.get(knowledgeRef);
            const rejectedAgeMs = rejectedEntry ? Date.now() - new Date(rejectedEntry.ts).getTime() : 0;
            if (rejectedAgeMs < DISTILL_REJECT_COOLDOWN_MS) {
              actions.push({
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
              completedCount++;
              info(`[improve] ${completedCount}/${loopRefs.length} ${planned.ref}`);
              continue;
            }
          }
        }

        const distillResult = await withLlmStage("distill", () =>
          distillFn({
            ref: planned.ref,
            ...(parsedPlannedRef.type === "memory" ? { proposalKind: "auto" as const } : {}),
            ...(options.stashDir ? { stashDir: options.stashDir } : {}),
            // Active profile so distill's per-process reads honor `--profile`.
            ...(improveProfile ? { improveProfile } : {}),
            // Attribution: carry the eligibility lane so distill stamps it on the
            // distill_invoked event and the persisted proposal.
            ...(planned.eligibilitySource ? { eligibilitySource: planned.eligibilitySource } : {}),
          }),
        );
        actions.push({ ref: planned.ref, mode: "distill", result: distillResult });
        if (distillResult.outcome === "queued" && distillResult.proposal) {
          const distillGr = await runAutoAcceptGate(
            [{ proposalId: distillResult.proposal.id, confidence: distillResult.proposal.confidence }],
            distillGateCfg,
          );
          gateAutoAcceptedCount += distillGr.promoted.length;
          gateAutoAcceptFailedCount += distillGr.failed.length;
        }
        if (parsedPlannedRef.type === "memory") {
          const promotedToKnowledge = distillResult.outcome === "queued" && distillResult.proposalKind === "knowledge";
          if (!promotedToKnowledge) memoryRefsForInference.add(planned.ref);
        }
        // Plasticity counter (plan §WS-1 step 8) for the distill path.
        // quality_rejected: the LLM ran but produced output that didn't pass the
        // quality gate — the asset is not yielding useful distill output.
        // queued: a proposal was produced; reset the no-op counter.
        if (eventsCtx?.db) {
          try {
            if (distillResult.outcome === "quality_rejected" || distillResult.outcome === "skipped") {
              recordNoOp(eventsCtx.db, planned.ref);
            } else if (distillResult.outcome === "queued") {
              resetConsecutiveNoOps(eventsCtx.db, planned.ref);
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
            assetType: parseAssetRef(planned.ref).type ?? "unknown",
            rejectedAt: Date.now(),
            source: "distill_quality_rejected",
            slug: `${slug}-${Date.now()}`,
          });
        }
        // D6: use pre-loaded map instead of per-iteration DB query
        const rejectedProposalEvent = rejectedProposalsByRef.get(planned.ref);
        if (rejectedProposalEvent && primaryStashDir) {
          const slug = refSlug(planned.ref);
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
        appendEvent(
          {
            eventType: "improve_skipped",
            ref: planned.ref,
            metadata: { reason: "memory_distill_requires_feedback" },
          },
          eventsCtx,
        );
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
          result: { ok: false, error: errMessage(err) },
        });
      }
    }
    completedCount++;
    info(`[improve] ${completedCount}/${loopRefs.length} ${planned.ref}`);
  }

  // WS-4: Per-phase threshold auto-tune — runs AFTER the loop so the gate
  // has processed all candidates for this run. Persists each phase's tuned
  // threshold to state.db for the NEXT run's makeGateConfig to read.
  // Best-effort: a tune failure must never fail the improve run.
  const stateDbPathForTune = eventsCtx?.dbPath;
  if (options.autoAccept !== undefined && stateDbPathForTune) {
    const phaseGateCfgMap: Record<string, typeof reflectGateCfg> = {
      reflect: reflectGateCfg,
      distill: distillGateCfg,
    };
    for (const phase of ["reflect", "distill"] as const) {
      const phaseCfg = phaseGateCfgMap[phase];
      try {
        maybeAutoTuneThreshold(
          phaseCfg.phaseThreshold ?? options.autoAccept,
          options.config ?? loadConfig(),
          stateDbPathForTune,
          undefined,
          phase,
        );
      } catch (err) {
        warn(`[improve] calibration auto-tune (${phase}) skipped: ${errMessage(err)}`);
      }
    }
  }

  return { reflectsWithErrorContext, memoryRefsForInference, gateAutoAcceptedCount, gateAutoAcceptFailedCount };
}

export async function runImprovePostLoopStage(args: {
  scope: ImproveScope;
  options: AkmImproveOptions;
  primaryStashDir?: string;
  actionableRefs: ImproveEligibleRef[];
  appliedCleanup?: Awaited<ReturnType<typeof applyMemoryCleanup>>;
  cleanupWarnings: string[];
  memoryRefsForInference: Set<string>;
  reindexFn: (options: { stashDir: string }) => Promise<unknown>;
  eventsCtx?: EventsContext;
  /** O-1 (#364): shared wall-clock AbortSignal; forwarded to maintenance passes. */
  budgetSignal?: AbortSignal;
  /** Active improve profile, resolved from profile name + config. */
  improveProfile?: import("./improve-profiles").ImproveProfileConfig;
  /**
   * #551: whether the consolidation pass (now run in the preparation stage,
   * before extract) actually processed memories. Drives the graph-extraction
   * reindex below — graph extraction must re-read the index if consolidation
   * mutated the memory pool.
   */
  consolidationRan: boolean;
  /** R5: this run's advisory merge-information-floor violation count (consolidate pass). */
  consolidationMergeFloorViolations?: number;
  /** R5: auto-accepted proposal count so far this run (prep + loop gates) — the churn-volume signal. */
  acceptedActions?: number;
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

  // #609 — recombine / synthesize pass. Whole-corpus cross-episodic
  // generalization. Runs in the post-loop stage under consolidate.lock (it
  // reads the consolidated corpus and writes proposals). Opt-in: gated on the
  // `recombine` process being enabled, whole-stash / type scope (never `ref`),
  // and not a dry run. Mirrors the proactiveMaintenance opt-in wiring.
  let recombination: RecombineResult | undefined;
  if (
    primaryStashDir &&
    improveProfile &&
    resolveProcessEnabled("recombine", improveProfile) &&
    scope.mode !== "ref" &&
    !options.dryRun
  ) {
    const recombineFn = options.recombineFn ?? akmRecombine;
    try {
      recombination = await recombineFn({
        stashDir: primaryStashDir,
        config: options.config ?? loadConfig(),
        improveProfile,
        ...(options.runId ? { sourceRun: options.runId } : {}),
        ...(budgetSignal ? { signal: budgetSignal } : {}),
        eligibilitySource: "recombine",
        ...(eventsCtx ? { ctx: eventsCtx } : {}),
        minClusterSize: improveProfile.processes?.recombine?.minClusterSize,
        maxClustersPerRun: improveProfile.processes?.recombine?.maxClustersPerRun,
        relatednessSource: improveProfile.processes?.recombine?.relatednessSource,
        confirmThreshold: improveProfile.processes?.recombine?.confirmThreshold,
        // #632 — clustering-tuning knobs. UNSET = pre-#632 behaviour.
        maxClusterSize: improveProfile.processes?.recombine?.maxClusterSize,
        excludeTags: improveProfile.processes?.recombine?.excludeTags,
        excludeEntities: improveProfile.processes?.recombine?.excludeEntities,
      });
    } catch (e) {
      allWarnings.push(`recombine: ${String(e)}`);
    }
  }

  // #615 — procedural-compilation pass. Detects recurring successful ordered
  // action sequences and compiles them into workflow proposals. Opt-in: gated
  // on the `procedural` process being enabled, whole-stash / type scope (never
  // `ref`), and not a dry run. Mirrors the recombine opt-in wiring.
  let proceduralCompilation: ProceduralCompilationResult | undefined;
  if (
    primaryStashDir &&
    improveProfile &&
    resolveProcessEnabled("procedural", improveProfile) &&
    scope.mode !== "ref" &&
    !options.dryRun
  ) {
    const proceduralFn = options.proceduralFn ?? akmProcedural;
    try {
      proceduralCompilation = await proceduralFn({
        stashDir: primaryStashDir,
        config: options.config ?? loadConfig(),
        ...(improveProfile ? { improveProfile } : {}),
        ...(options.runId ? { sourceRun: options.runId } : {}),
        ...(budgetSignal ? { signal: budgetSignal } : {}),
        eligibilitySource: "procedural",
        ...(eventsCtx ? { ctx: eventsCtx } : {}),
        minRecurrence: improveProfile.processes?.procedural?.minRecurrence,
        maxProposalsPerRun: improveProfile.processes?.procedural?.maxProposalsPerRun,
      });
    } catch (e) {
      allWarnings.push(`procedural: ${String(e)}`);
    }
  }

  // ── R5: collapse/churn detector ────────────────────────────────────────────
  // One snapshot per QUALIFYING cycle: consolidate processed work and/or
  // recombine formed clusters. Runs AFTER the maintenance reindex so FTS sees
  // the post-merge index; one call site covers both passes. Deterministic,
  // observe-only, fail-open (the orchestrator catches everything) — and inert
  // on the ~9-in-10 default-profile runs that touch no merges.
  let cycleMetrics: CycleMetricsRow | undefined;
  const recombineWorked = (recombination?.clustersFormed ?? 0) > 0;
  if (!options.dryRun && (consolidationRan || recombineWorked)) {
    cycleMetrics = runCollapseDetector({
      runId: options.runId ?? "improve-adhoc",
      ...(improveProfile ? { improveProfile } : {}),
      pass: consolidationRan && recombineWorked ? "both" : consolidationRan ? "consolidate" : "recombine",
      // prep+loop gate accepts, PLUS recombine's confirmed-lesson promotions —
      // recombine churn is the historically observed failure mode and its
      // promotions never flow through the prep/loop gates.
      acceptedActions: (args.acceptedActions ?? 0) + (recombination?.lessonsPromoted ?? 0),
      mergeFloorViolations: args.consolidationMergeFloorViolations ?? 0,
      config: options.config ?? loadConfig(),
      ...(eventsCtx ? { eventsCtx } : {}),
    });
  }

  return {
    allWarnings,
    deadUrls,
    ...(cycleMetrics ? { cycleMetrics } : {}),
    ...(recombination ? { recombination } : {}),
    ...(proceduralCompilation ? { proceduralCompilation } : {}),
    ...(maintenanceResult.memoryInference ? { memoryInference: maintenanceResult.memoryInference } : {}),
    ...(maintenanceResult.graphExtraction ? { graphExtraction: maintenanceResult.graphExtraction } : {}),
    ...(maintenanceResult.actions && maintenanceResult.actions.length > 0
      ? { maintenanceActions: maintenanceResult.actions }
      : {}),
    memoryInferenceDurationMs: maintenanceResult.memoryInferenceDurationMs,
    graphExtractionDurationMs: maintenanceResult.graphExtractionDurationMs,
    orphansPurged: maintenanceResult.orphansPurged,
    proposalsExpired: maintenanceResult.proposalsExpired,
    // Consolidation's auto-accept gate counts now accrue in the preparation
    // stage (#551); post-loop no longer runs an auto-accept gate of its own.
    gateAutoAcceptedCount: 0,
    gateAutoAcceptFailedCount: 0,
  };
}

// TODO(refactor): mutates the passed-in `allWarnings` array as a hidden side channel. Return warnings in ImproveMaintenanceResult and merge in caller — invasive signature change deferred to next refactor pass.
// Exported for tests (#584/#585 DB-locking regression coverage); production
// callers reach it only through akmImprove → runImprovePostLoopStage.

// TODO(refactor): mutates the passed-in `allWarnings` array as a hidden side channel. Return warnings in ImproveMaintenanceResult and merge in caller — invasive signature change deferred to next refactor pass.
// Exported for tests (#584/#585 DB-locking regression coverage); production
// callers reach it only through akmImprove → runImprovePostLoopStage.
export async function runImproveMaintenancePasses(args: {
  options: AkmImproveOptions;
  primaryStashDir?: string;
  actionableRefs: ImproveEligibleRef[];
  memoryRefsForInference: Set<string>;
  allWarnings: string[];
  reindexFn: (options: { stashDir: string }) => Promise<unknown>;
  /** D9: true when consolidation ran and wrote at least one record this improve run. */
  consolidationRan?: boolean;
  /** O-1 (#364): shared wall-clock AbortSignal; cancels sub-calls when budget expires. */
  budgetSignal?: AbortSignal;
  eventsCtx?: EventsContext;
  /** Active improve profile, resolved from profile name + config. */
  improveProfile?: import("./improve-profiles").ImproveProfileConfig;
}): Promise<ImproveMaintenanceResult> {
  const {
    options,
    primaryStashDir,
    memoryRefsForInference,
    allWarnings,
    reindexFn,
    consolidationRan,
    budgetSignal,
    eventsCtx,
    improveProfile,
  } = args;
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
  let orphansPurged = 0;
  let proposalsExpired = 0;

  const openIndexDb = () =>
    openIndexDatabase(
      getDbPath(),
      config.embedding?.dimension ? { embeddingDim: config.embedding.dimension } : undefined,
    );

  // #584: reindexFn opens its own write handle on the same index.db WAL file.
  // Holding our handle across that call produced SQLITE_BUSY / "database is
  // locked" failures in production, so the handle is closed BEFORE every
  // reindex and reopened after — the fresh handle also sees the post-reindex
  // state that graph extraction below relies on. The
  // reopen runs in `finally` so a failed reindex still leaves a usable handle.
  const reindexWithIndexDbReleased = async (stashDir: string): Promise<void> => {
    if (db) {
      closeDatabase(db);
      db = undefined;
    }
    try {
      await reindexFn({ stashDir });
    } finally {
      db = openIndexDb();
    }
  };

  await withIndexWriterLease({ purpose: "improve-maintenance", signal: budgetSignal }, async () => {
    try {
      db = openIndexDb();

      // Memory inference candidate-discovery (post-Item 9 fix from
      // memory:akm-improve-critical-review-2026-05-20). Previously this pass
      // was gated on memoryRefsForInference.size > 0 AND passed those refs as a
      // candidateRefs filter. But memoryRefsForInference is populated from refs
      // distilled THIS RUN — by the time that happens, those parents are
      // already split (`inferenceProcessed: true`) and `isPendingMemory` excludes
      // them. The genuinely-pending parents in the stash never entered the
      // filter. Result: 0/0/0 for 25 consecutive runs.
      //
      // Fix: always run the pass when the feature is enabled; let the pass's
      // own `collectPendingMemories` + `isPendingMemory` predicate find
      // candidates from the filesystem-of-truth. The this-run set is still
      // logged as a hint but no longer used as a filter.
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
          memoryInference = await withLlmStage("memory-inference", () =>
            memoryInferenceFn({
              config,
              sources,
              signal: budgetSignal,
              db,
              reEnrich: false,
              onProgress: (event) => {
                const current = event.currentRef ? ` ${event.currentRef}` : "";
                info(
                  `[improve] memory inference ${event.processed}/${event.total}${current} (written ${event.writtenFacts}, skipped ${event.skippedNoFacts})`,
                );
              },
            }),
          );
          memoryInferenceDurationMs = Date.now() - inferenceStart;
          actions.push({ ref: "memory:_inference", mode: "memory-inference", result: memoryInference });
          info(
            `[improve] memory inference complete (${memoryInference.writtenFacts} facts written from ${memoryInference.splitParents} parents)`,
          );
        } catch (err) {
          memoryInferenceDurationMs = Date.now() - inferenceStart;
          allWarnings.push(`memory inference failed: ${errMessage(err)}`);
        }
      }

      if (memoryInference && (memoryInference.splitParents > 0 || memoryInference.writtenFacts > 0)) {
        info("[improve] reindexing after memory inference writes");
        try {
          await reindexWithIndexDbReleased(primaryStashDir);
          reindexedAfterInference = true;
          info("[improve] reindex after memory inference complete");
        } catch (err) {
          allWarnings.push(`reindex after memory inference failed: ${errMessage(err)}`);
        }
      }

      const graphEnabled = isProcessEnabled("index", "graph_extraction", config);
      const graphExtractionDisabledByProfile = improveProfile?.processes?.graphExtraction?.enabled === false;
      const graphExtractionFullScan = improveProfile?.processes?.graphExtraction?.fullScan === true;
      // #624 P2: optional incremental high-signal-first cap. Unset = process all
      // eligible (byte-identical to today; no ranking/slice).
      const graphExtractionTopN = improveProfile?.processes?.graphExtraction?.topN;
      // Build the set of refs actually touched this run.
      const touchedRefs = new Set<string>();
      for (const r of args.actionableRefs) touchedRefs.add(r.ref);
      for (const r of memoryRefsForInference) touchedRefs.add(r);

      // INVARIANT: graph extraction normally runs only on files touched by
      // actionable refs (candidatePaths). Full-corpus scans are opt-in via
      // profile.processes.graphExtraction.fullScan = true (used by the
      // `graph-refresh` built-in profile and its weekly scheduled task).
      // The empty-Set fallback is intentional when no refs were touched —
      // the extractor's filter rejects every file and returns empty, keeping
      // the pass invoked so the action is recorded and tests stay exercised.
      if (graphExtractionDisabledByProfile) {
        info("[improve] graph extraction skipped (disabled by improve profile)");
      } else if (sources.length > 0 && graphEnabled) {
        info(`[improve] graph extraction starting${graphExtractionFullScan ? " (full-corpus scan)" : ""}`);
        const extractionStart = Date.now();
        try {
          // D9: if consolidation ran but memory inference did not reindex, force a reindex
          // so graph extraction sees current DB state after consolidation writes.
          if (consolidationRan && !reindexedAfterInference) {
            info("[improve] reindexing after consolidation (graph extraction needs current state)");
            try {
              await reindexWithIndexDbReleased(primaryStashDir);
              reindexedAfterInference = true;
              info("[improve] reindex after consolidation complete");
            } catch (err) {
              allWarnings.push(`reindex after consolidation failed: ${errMessage(err)}`);
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
              const writableDirSet = new Set(getWritableStashDirs(primaryStashDir).map((d) => path.resolve(d)));
              const resolved = await Promise.all(
                [...touchedRefs].map((ref) =>
                  findAssetFilePath(ref, primaryStashDir, writableDirSet).catch(() => null),
                ),
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
          graphExtraction = await withLlmStage("graph-extraction", () =>
            graphExtractionFn({
              config,
              sources,
              signal: budgetSignal,
              db,
              reEnrich: false,
              onProgress: progressHandler,
              options: { candidatePaths, ...(graphExtractionTopN != null ? { topN: graphExtractionTopN } : {}) },
            }),
          );
          graphExtractionDurationMs = Date.now() - extractionStart;
          actions.push({ ref: "graph:_artifact", mode: "graph-extraction", result: graphExtraction });
          info(
            `[improve] graph extraction complete (${graphExtraction.quality.extractedFiles} files, ${graphExtraction.quality.entityCount} entities, ${graphExtraction.quality.relationCount} relations)`,
          );
        } catch (err) {
          graphExtractionDurationMs = Date.now() - extractionStart;
          allWarnings.push(`graph extraction failed: ${errMessage(err)}`);
        }
      } else if (sources.length > 0 && !graphEnabled) {
        info("[improve] graph extraction skipped (features.index.graph_extraction is disabled)");
      }

      // Orphan proposal purge — reject pending reflect proposals whose target
      // asset no longer exists on disk. Runs after graph extraction so newly
      // promoted assets from accept flows during this run are already present.
      if (primaryStashDir) {
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
              ref: "proposals:_orphan-purge",
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
          allWarnings.push(`orphan purge failed: ${errMessage(err)}`);
        }

        // Phase 6B (Advantage D6b): expire pending proposals that have aged past
        // the retention window. Runs AFTER orphan purge so we never double-archive
        // a proposal that orphan-purge already moved. `expireStaleProposals` emits
        // its own per-proposal `proposal_expired` events; we additionally emit a
        // single roll-up event here for parity with the orphan-purge surface.
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
              ref: "proposals:_expiration",
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
          allWarnings.push(`proposal expiration failed: ${errMessage(err)}`);
        }
      }

      // Fix #2 (observability 0.8.0): trim the events table in state.db so it
      // doesn't grow unbounded. `akm health` writes a `health_probe` row on every
      // invocation, and every command surface emits at least one event besides —
      // without this trim, state.db is a permanent append-only log. Config key
      // `improve.eventRetentionDays` (default 90, set 0 to disable) controls the
      // window. The purge runs against state.db (a different SQLite file from
      // the index `db` above).
      {
        const retentionDays =
          typeof config.improve?.eventRetentionDays === "number" ? config.improve.eventRetentionDays : 90;
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
                  info(
                    `[improve] events purge: ${purgedCount} event(s) older than ${retentionDays}d removed from state.db`,
                  );
                }
                appendEvent(
                  {
                    eventType: "events_purged",
                    ref: "events:_purge",
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
                    ref: "improve_runs:_purge",
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
                      ref: "improve_cycle_metrics:_purge",
                      metadata: { purgedCount: cycleMetricsPurged, retentionDays: cycleRetention },
                    },
                    eventsCtx,
                  );
                }
              },
              { path: eventsCtx?.dbPath, borrowed: eventsCtx?.db },
            );
          } catch (err) {
            allWarnings.push(`events purge failed: ${errMessage(err)}`);
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
                ref: "task_logs:_purge",
                metadata: { purgedCount: taskLogsPurged, retentionDays },
              },
              eventsCtx,
            );
          } catch (err) {
            allWarnings.push(`task_logs purge failed: ${errMessage(err)}`);
          } finally {
            if (logsDb) {
              try {
                logsDb.close();
              } catch {
                // best-effort
              }
            }
          }
        }
      }
    } finally {
      if (db) closeDatabase(db);
    }
  });

  return {
    ...(memoryInference ? { memoryInference } : {}),
    ...(graphExtraction ? { graphExtraction } : {}),
    ...(actions.length > 0 ? { actions } : {}),
    memoryInferenceDurationMs,
    graphExtractionDurationMs,
    orphansPurged,
    proposalsExpired,
  };
}
