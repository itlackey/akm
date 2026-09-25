// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Memory→knowledge promotion branch for `akm distill`.
 *
 * This is an entire second command that used to be inlined inside `akmDistill`:
 * when a `memory:*` ref is reinforced enough (per the deterministic stability
 * heuristic in `distill-promotion-policy`), distill graduates it into a
 * `knowledge:*` proposal instead of a lesson. The branch owns its own LLM
 * contradiction-merge (mem0 ADD/UPDATE/NOOP), quality gate, proposal creation,
 * and `distill_invoked` event emit.
 *
 * {@link promoteMemoryToKnowledge} returns the finished {@link AkmDistillResult}
 * when the branch fired, or `null` when the ref is not a promotion candidate —
 * in which case the caller falls through to the ordinary lesson/knowledge LLM
 * path. Logic is byte-identical to the pre-extraction inline code.
 */

import fs from "node:fs";
import { parseFrontmatter } from "../../../core/asset/frontmatter";
import type { AkmConfig, ImproveProfileConfig, LlmConnectionConfig } from "../../../core/config/config";
import { ConfigError } from "../../../core/errors";
import { appendEvent, type EventsContext } from "../../../core/events";
import type { AkmDistillResult } from "../../../core/improve-types";
import { parseEmbeddedJsonResponse } from "../../../core/parse";
import type { LoweringNotice } from "../../../execution/resolved-request";
import type { RunnerSpec } from "../../../integrations/agent/runner";
import type { ChatCompletionOptions, ChatMessage } from "../../../llm/client";
import { callStructured } from "../../../llm/structured-call";
import type { EligibilitySource } from "../../proposal/proposal-types";
import type { Proposal, ProposalsContext } from "../../proposal/repository";
import { assessMemoryKnowledgePromotionCandidate, type MemoryPromotionAssessment } from "../distill-promotion-policy";
import { emitProposal } from "../proposal-envelope";
import { durableImproveRef } from "../source-identity";
import {
  persistOutputEncodingSalience,
  runLessonQualityJudge,
  stageJudgedProposal,
  writeQualityRejection,
} from "./quality-gate";

/**
 * Everything the promotion branch needs from `akmDistill`. Plain data + the
 * two test seams (chat, lookup, fetchSimilarLessonsFn) already resolved by the
 * caller — no class, no DI container.
 */
export interface PromoteMemoryContext {
  targetKind: "lesson" | "knowledge" | "auto";
  inputRef: string;
  /** Source key for durable events/provenance. */
  durableInputRef?: string;
  /**
   * The resolved index entry's fully-qualified item_ref. When absent, the
   * promotion branch uses durableInputRef as its event key.
   */
  itemRef?: string;
  assetContent: string | null;
  /** Filtered feedback events (only `.metadata` is read by the promotion policy). */
  filteredEvents: readonly { metadata?: Record<string, unknown> }[];
  config: AkmConfig;
  strategy?: ImproveProfileConfig;
  /** Preferred production path: exact symbolic runner selected for distill. */
  llmRunner?: Extract<RunnerSpec, { kind: "llm" }>;
  signal?: AbortSignal;
  chat?: (config: LlmConnectionConfig, messages: ChatMessage[], options?: ChatCompletionOptions) => Promise<string>;
  stash: string;
  lookup: (ref: string) => Promise<string | null>;
  fetchSimilarLessonsFn: (query: string, n: number) => Promise<Array<{ ref: string; content: string }>>;
  existingRefVocabulary: Set<string>;
  outcomeWeightEnabled: boolean;
  /** `{ eligibilitySource }` or `{}` — spread into distill_invoked metadata. */
  eligMeta: { eligibilitySource?: EligibilitySource };
  eligibilitySource?: EligibilitySource;
  sourceRun?: string;
  proposalsCtx?: ProposalsContext;
  /**
   * Events context for the run's long-lived state.db handle so the promotion
   * branch's `distill_invoked` emits take appendEvent's fast path (R25).
   */
  eventsCtx?: EventsContext;
  exclusionSetSize: number;
  filteredFeedbackCount: number;
  feedbackFullyFiltered: boolean;
  onNotices?: (notices: readonly Readonly<LoweringNotice>[]) => void;
}

/**
 * Outcome of the destination-conflict resolution pass: either an early terminal
 * result (the LLM judged the existing content authoritative — NOOP) or the
 * content to carry forward into the quality gate + proposal.
 */
type KnowledgePromotionContent = { earlyResult: AkmDistillResult } | { resolvedContent: string };

export interface MemoryKnowledgePromotionPlan {
  promotion: MemoryPromotionAssessment & { promote: true; content: string };
  existingKnowledgeContent: string | null;
}

/** Read-only classification of the deterministic promotion path and destination conflict. */
export async function planMemoryKnowledgePromotion(
  ctx: PromoteMemoryContext,
): Promise<MemoryKnowledgePromotionPlan | null> {
  const durableInputRef = ctx.durableInputRef ?? ctx.inputRef;
  const promotion =
    ctx.targetKind === "lesson"
      ? null
      : assessMemoryKnowledgePromotionCandidate({
          inputRef: durableInputRef,
          assetContent: ctx.assetContent,
          feedbackEvents: ctx.filteredEvents.map((event) => ({
            ...(event.metadata !== undefined ? { metadata: event.metadata } : {}),
          })),
        });
  if (!(promotion?.promote && promotion.content && (ctx.targetKind === "knowledge" || ctx.targetKind === "auto"))) {
    return null;
  }
  const existingKnowledgePath = await ctx.lookup(durableImproveRef(promotion.knowledgeRef));
  let existingKnowledgeContent: string | null = null;
  if (existingKnowledgePath && fs.existsSync(existingKnowledgePath)) {
    try {
      existingKnowledgeContent = fs.readFileSync(existingKnowledgePath, "utf8");
    } catch {
      existingKnowledgeContent = null;
    }
  }
  return { promotion: promotion as MemoryKnowledgePromotionPlan["promotion"], existingKnowledgeContent };
}

/** Whether a classified promotion will actually call merge generation and/or the judge. */
export function memoryKnowledgePromotionRequiresDispatch(
  ctx: PromoteMemoryContext,
  plan: MemoryKnowledgePromotionPlan,
): boolean {
  const hasRunner = Boolean(ctx.llmRunner);
  return (
    (Boolean(plan.existingKnowledgeContent) && hasRunner) ||
    (ctx.strategy?.processes?.distill?.qualityGate?.enabled ?? true)
  );
}

/**
 * Resolve the knowledge content to propose when a memory promotes to knowledge,
 * reconciling it with any existing knowledge file at the destination (D-1 / #369).
 *
 * When the destination already exists and an LLM is configured, follows the
 * mem0 ADD/UPDATE/NOOP pattern (arXiv:2504.19413 §3.2): ADD/UPDATE swap in the
 * merged content, NOOP short-circuits with a terminal "skipped" result. Without
 * an LLM the existing content is appended as reviewer-reference context so the
 * merge can be done by hand. Logic is byte-identical to the prior inline block.
 */
async function resolveKnowledgePromotionContent(
  ctx: PromoteMemoryContext,
  plan: MemoryKnowledgePromotionPlan,
): Promise<KnowledgePromotionContent> {
  const durableInputRef = ctx.durableInputRef ?? ctx.inputRef;
  const baseContent = plan.promotion.content;
  const knowledgeRef = plan.promotion.knowledgeRef;
  let resolvedPromotionContent = baseContent;
  const existingKnowledgeContent = plan.existingKnowledgeContent;

  const runner = ctx.llmRunner;

  if (existingKnowledgeContent && runner) {
    // Existing content found: call LLM for contradiction-resolution merge.
    const mergePrompt = [
      "You are merging two versions of a knowledge document.",
      "Existing content is already committed; new content comes from a memory distillation run.",
      "Choose one of: ADD (combine both), UPDATE (replace existing with new), NOOP (keep existing unchanged).",
      'Return ONLY valid JSON: {"action": "ADD"|"UPDATE"|"NOOP", "content": "<merged markdown if ADD/UPDATE, empty string if NOOP>"}',
      "",
      "## Existing knowledge content",
      "```",
      existingKnowledgeContent.slice(0, 3000),
      "```",
      "",
      "## New content from distillation",
      "```",
      baseContent.slice(0, 3000),
      "```",
    ].join("\n");

    try {
      const mergeResponse = await callStructured<string>({
        feature: "distill",
        runner,
        messages: [
          { role: "system", content: "Return only valid JSON. No prose." },
          { role: "user", content: mergePrompt },
        ],
        request: {
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          ...(ctx.chat ? { chat: ctx.chat } : {}),
        },
        parse: (raw) => raw ?? "",
        onError: () => "",
        fallback: "",
        ...(ctx.onNotices ? { onNotices: ctx.onNotices } : {}),
      });
      const mergeResult = parseEmbeddedJsonResponse<{
        action: "ADD" | "UPDATE" | "NOOP";
        content?: string;
      }>(mergeResponse);

      if (mergeResult?.action === "NOOP") {
        // Existing content is authoritative — no update needed.
        appendEvent(
          {
            eventType: "distill_invoked",
            // Use item_ref when resolved, otherwise the input conceptId.
            ref: ctx.itemRef ?? durableInputRef,
            metadata: {
              outcome: "skipped" as const,
              proposalRef: knowledgeRef,
              message: "D-1: LLM resolved destination conflict as NOOP — existing content kept",
              ...ctx.eligMeta,
            },
          },
          ctx.eventsCtx,
        );
        return {
          earlyResult: {
            schemaVersion: 1,
            ok: true,
            outcome: "skipped",
            inputRef: ctx.inputRef,
            proposalRef: knowledgeRef,
            skipReason: "conflict_noop",
            message: "Existing knowledge content unchanged (contradiction resolution: NOOP)",
          },
        };
      }

      if (mergeResult?.action && (mergeResult.action === "ADD" || mergeResult.action === "UPDATE")) {
        if (mergeResult.content?.trim()) {
          resolvedPromotionContent = mergeResult.content;
        }
      }
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      // LLM merge failed — fall through with the original promotion content.
      // The reviewer will see both versions in the proposal diff.
    }
  } else if (existingKnowledgeContent) {
    // No LLM configured: include existing content as context in the proposal
    // so the reviewer can do the contradiction resolution manually.
    resolvedPromotionContent = [
      baseContent,
      "",
      "---",
      "<!-- D-1 / #369: Existing knowledge content is shown below for reviewer reference. -->",
      "<!-- Review: decide whether to ADD (merge), UPDATE (replace), or NOOP (keep existing). -->",
      "",
      "## Existing content (for reviewer reference)",
      "",
      existingKnowledgeContent,
    ].join("\n");
  }

  return { resolvedContent: resolvedPromotionContent };
}

/**
 * Run the memory→knowledge promotion branch. Returns the finished distill
 * result when promotion fired (all paths terminal), or `null` when the ref is
 * not a promotion candidate and the caller should continue to the ordinary
 * lesson/knowledge distillation path.
 */
export async function promoteMemoryToKnowledge(
  ctx: PromoteMemoryContext,
  planned?: MemoryKnowledgePromotionPlan | null,
): Promise<AkmDistillResult | null> {
  const {
    inputRef,
    assetContent,
    config,
    chat,
    stash,
    fetchSimilarLessonsFn,
    existingRefVocabulary,
    outcomeWeightEnabled,
    eligMeta,
    exclusionSetSize,
    filteredFeedbackCount,
    feedbackFullyFiltered,
  } = ctx;
  const durableInputRef = ctx.durableInputRef ?? inputRef;
  const promotionPlan = planned === undefined ? await planMemoryKnowledgePromotion(ctx) : planned;
  if (!promotionPlan) return null;
  const promotion = promotionPlan.promotion;

  // D-1 / #369: When the destination knowledge file already exists, route
  // through the LLM for contradiction resolution instead of silently
  // overwriting. Follows mem0 ADD/UPDATE/DELETE/NOOP pattern (arXiv:2504.19413 §3.2)
  // and A-MEM dynamic linking (arXiv:2502.12110).
  const merged = await resolveKnowledgePromotionContent(ctx, promotionPlan);
  if ("earlyResult" in merged) return merged.earlyResult;
  const resolvedPromotionContent = merged.resolvedContent;

  // Apply quality gate to fast-path knowledge promotion (Risk 4 fix).
  // D-5 / #388: Three-band system — review_needed band queues to proposal
  // queue with review_needed outcome rather than auto-rejecting.
  let knowledgeJudgeConfidence: number | undefined;
  if (ctx.strategy?.processes?.distill?.qualityGate?.enabled ?? true) {
    // D-4 / #390: retrieve top-3 similar lessons for dedup check in judge.
    const similarLessons = await fetchSimilarLessonsFn(resolvedPromotionContent.slice(0, 500), 3);
    const judgeResult = await runLessonQualityJudge(config, resolvedPromotionContent, assetContent ?? "", chat, {
      ...(similarLessons.length > 0 ? { similarLessons } : {}),
      ...(ctx.llmRunner ? { llmRunner: ctx.llmRunner } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      ...(ctx.onNotices ? { onNotices: ctx.onNotices } : {}),
    });
    if (!judgeResult.pass) {
      const proposalOpts = {
        ...(ctx.proposalsCtx ? { proposalsCtx: ctx.proposalsCtx } : {}),
        ...(ctx.sourceRun !== undefined ? { sourceRun: ctx.sourceRun } : {}),
        ledgerRef: ctx.itemRef ?? durableInputRef,
      };
      if (judgeResult.reviewNeeded) {
        // Uncertainty band (2.5–3.5): queue as review_needed instead of rejecting.
        return writeQualityRejection(
          stash,
          inputRef,
          promotion.knowledgeRef,
          resolvedPromotionContent,
          judgeResult.score,
          judgeResult.reason,
          { reviewNeeded: true, ...(judgeResult.criteria ? { criteria: judgeResult.criteria } : {}) },
          ctx.eligibilitySource,
          ctx.eventsCtx,
          proposalOpts,
        );
      }
      return writeQualityRejection(
        stash,
        inputRef,
        promotion.knowledgeRef,
        resolvedPromotionContent,
        judgeResult.score,
        judgeResult.reason,
        judgeResult.criteria ? { criteria: judgeResult.criteria } : {},
        ctx.eligibilitySource,
        ctx.eventsCtx,
        proposalOpts,
      );
    }
    // Normalize 1-5 judge score to [0, 1]. Only a real passing verdict reaches
    // here (07 P0-2: the judge now fails CLOSED on no-LLM / timeout / parse
    // failure, so those return pass:false and early-return above). The score>0
    // guard defensively leaves confidence undefined for any non-positive score.
    if (judgeResult.score > 0) knowledgeJudgeConfidence = judgeResult.score / 5;
  }
  const knowledgeParsed = parseFrontmatter(resolvedPromotionContent);
  let proposal: Proposal = emitProposal(
    { stashDir: stash, proposalsCtx: ctx.proposalsCtx },
    {
      ref: promotion.knowledgeRef,
      source: "distill",
      ...(ctx.sourceRun !== undefined ? { sourceRun: ctx.sourceRun } : {}),
      payload: {
        content: resolvedPromotionContent,
        ...(Object.keys(knowledgeParsed.data).length > 0 ? { frontmatter: knowledgeParsed.data } : {}),
      },
      ...(knowledgeJudgeConfidence !== undefined ? { confidence: knowledgeJudgeConfidence } : {}),
      // Attribution tagging: persist the eligibility lane on the proposal.
      ...(ctx.eligibilitySource ? { eligibilitySource: ctx.eligibilitySource } : {}),
      // The improve ledger keys the attempt by the input memory, not the knowledge ref.
      attemptedRefs: [ctx.itemRef ?? durableInputRef],
    },
  );
  // A judge scored this content (confidence is set only on a real pass).
  if (knowledgeJudgeConfidence !== undefined) proposal = stageJudgedProposal(stash, proposal, ctx.proposalsCtx);

  // G4: content-score the distilled OUTPUT so it carries a real encoding
  // salience (encoding_source='content') from creation.
  persistOutputEncodingSalience(
    durableImproveRef(promotion.knowledgeRef),
    resolvedPromotionContent,
    existingRefVocabulary,
    outcomeWeightEnabled,
  );
  appendEvent(
    {
      eventType: "distill_invoked",
      // Use item_ref when resolved, otherwise the input conceptId.
      ref: ctx.itemRef ?? durableInputRef,
      metadata: {
        outcome: "queued" as const,
        proposalRef: promotion.knowledgeRef,
        proposalKind: "knowledge" as const,
        proposalId: proposal.id,
        // R3: judge verdicts are longitudinally queryable, not just a one-shot
        // proposal.confidence write (normalized 1–5 score / 5).
        ...(knowledgeJudgeConfidence !== undefined ? { judgeConfidence: knowledgeJudgeConfidence } : {}),
        ...(ctx.sourceRun !== undefined ? { sourceRun: ctx.sourceRun } : {}),
        ...(exclusionSetSize > 0 ? { filteredFeedbackCount } : {}),
        ...eligMeta,
      },
    },
    ctx.eventsCtx,
  );

  return {
    schemaVersion: 1,
    ok: true,
    outcome: "queued",
    inputRef,
    proposalRef: promotion.knowledgeRef,
    proposalKind: "knowledge",
    proposalId: proposal.id,
    proposal,
    ...(exclusionSetSize > 0 ? { filteredFeedbackCount, feedbackFullyFiltered } : {}),
  };
}
