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
import { appendEvent } from "../../../core/events";
import type { EligibilitySource } from "../../../core/improve-types";
import { type ChatMessage, parseEmbeddedJsonResponse } from "../../../llm/client";
import { createProposal, isProposalSkipped, type Proposal, type ProposalsContext } from "../../proposal/repository";
import type { AkmDistillResult } from "../distill";
import { assessMemoryKnowledgePromotionCandidate } from "../distill-promotion-policy";
import { persistOutputEncodingSalience, runLessonQualityJudge, writeQualityRejection } from "./quality-gate";

/**
 * Everything the promotion branch needs from `akmDistill`. Plain data + the
 * two test seams (chat, lookup, fetchSimilarLessonsFn) already resolved by the
 * caller — no class, no DI container.
 */
export interface PromoteMemoryContext {
  targetKind: "lesson" | "knowledge" | "auto";
  inputRef: string;
  assetContent: string | null;
  /** Filtered feedback events (only `.metadata` is read by the promotion policy). */
  filteredEvents: readonly { metadata?: Record<string, unknown> }[];
  config: AkmConfig;
  strategy?: ImproveProfileConfig;
  llmConfig?: LlmConnectionConfig;
  chat: (config: LlmConnectionConfig, messages: ChatMessage[]) => Promise<string>;
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
  exclusionSetSize: number;
  filteredFeedbackCount: number;
  feedbackFullyFiltered: boolean;
}

/**
 * Run the memory→knowledge promotion branch. Returns the finished distill
 * result when promotion fired (all paths terminal), or `null` when the ref is
 * not a promotion candidate and the caller should continue to the ordinary
 * lesson/knowledge distillation path.
 */
export async function promoteMemoryToKnowledge(ctx: PromoteMemoryContext): Promise<AkmDistillResult | null> {
  const {
    targetKind,
    inputRef,
    assetContent,
    config,
    chat,
    stash,
    lookup,
    fetchSimilarLessonsFn,
    existingRefVocabulary,
    outcomeWeightEnabled,
    eligMeta,
    exclusionSetSize,
    filteredFeedbackCount,
    feedbackFullyFiltered,
  } = ctx;

  const promotion =
    targetKind === "lesson"
      ? null
      : assessMemoryKnowledgePromotionCandidate({
          inputRef,
          assetContent,
          feedbackEvents: ctx.filteredEvents.map((event) => ({
            ...(event.metadata !== undefined ? { metadata: event.metadata } : {}),
          })),
        });

  if (!(promotion?.promote && promotion.content && (targetKind === "knowledge" || targetKind === "auto"))) {
    return null;
  }

  // D-1 / #369: When the destination knowledge file already exists, route
  // through the LLM for contradiction resolution instead of silently
  // overwriting. Follows mem0 ADD/UPDATE/DELETE/NOOP pattern (arXiv:2504.19413 §3.2)
  // and A-MEM dynamic linking (arXiv:2502.12110).
  let resolvedPromotionContent = promotion.content;
  const existingKnowledgePath = await lookup(promotion.knowledgeRef);
  const existingKnowledgeContent =
    existingKnowledgePath && fs.existsSync(existingKnowledgePath)
      ? (() => {
          try {
            return fs.readFileSync(existingKnowledgePath, "utf8");
          } catch {
            return null;
          }
        })()
      : null;

  if (existingKnowledgeContent && ctx.llmConfig) {
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
      promotion.content.slice(0, 3000),
      "```",
    ].join("\n");

    try {
      const mergeResponse = await chat(ctx.llmConfig, [
        { role: "system", content: "Return only valid JSON. No prose." },
        { role: "user", content: mergePrompt },
      ]);
      const mergeResult = parseEmbeddedJsonResponse<{
        action: "ADD" | "UPDATE" | "NOOP";
        content?: string;
      }>(mergeResponse);

      if (mergeResult?.action === "NOOP") {
        // Existing content is authoritative — no update needed.
        appendEvent({
          eventType: "distill_invoked",
          ref: inputRef,
          metadata: {
            outcome: "skipped" as const,
            lessonRef: promotion.knowledgeRef,
            message: "D-1: LLM resolved destination conflict as NOOP — existing content kept",
            ...eligMeta,
          },
        });
        return {
          schemaVersion: 1,
          ok: true,
          outcome: "skipped",
          inputRef,
          lessonRef: promotion.knowledgeRef,
          message: "Existing knowledge content unchanged (contradiction resolution: NOOP)",
        };
      }

      if (mergeResult?.action && (mergeResult.action === "ADD" || mergeResult.action === "UPDATE")) {
        if (mergeResult.content?.trim()) {
          resolvedPromotionContent = mergeResult.content;
        }
      }
    } catch {
      // LLM merge failed — fall through with the original promotion content.
      // The reviewer will see both versions in the proposal diff.
    }
  } else if (existingKnowledgeContent) {
    // No LLM configured: include existing content as context in the proposal
    // so the reviewer can do the contradiction resolution manually.
    resolvedPromotionContent = [
      promotion.content,
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

  // Apply quality gate to fast-path knowledge promotion (Risk 4 fix).
  // D-5 / #388: Three-band system — review_needed band queues to proposal
  // queue with review_needed outcome rather than auto-rejecting.
  let knowledgeJudgeConfidence: number | undefined;
  if (ctx.strategy?.processes?.distill?.qualityGate?.enabled ?? true) {
    // D-4 / #390: retrieve top-3 similar lessons for dedup check in judge.
    const similarLessons = await fetchSimilarLessonsFn(resolvedPromotionContent.slice(0, 500), 3);
    const judgeResult = await runLessonQualityJudge(
      config,
      resolvedPromotionContent,
      assetContent ?? "",
      chat,
      similarLessons.length > 0 ? similarLessons : undefined,
      ctx.llmConfig,
    );
    if (!judgeResult.pass) {
      if (judgeResult.reviewNeeded) {
        // Uncertainty band (2.5–3.5): queue as review_needed instead of rejecting.
        return writeQualityRejection(
          stash,
          inputRef,
          promotion.knowledgeRef,
          resolvedPromotionContent,
          judgeResult.score,
          judgeResult.reason,
          { reviewNeeded: true },
          ctx.eligibilitySource,
        );
      }
      return writeQualityRejection(
        stash,
        inputRef,
        promotion.knowledgeRef,
        resolvedPromotionContent,
        judgeResult.score,
        judgeResult.reason,
        {},
        ctx.eligibilitySource,
      );
    }
    // Normalize 1-5 judge score to [0, 1]. Only a real passing verdict reaches
    // here (07 P0-2: the judge now fails CLOSED on no-LLM / timeout / parse
    // failure, so those return pass:false and early-return above). The score>0
    // guard defensively leaves confidence undefined for any non-positive score.
    if (judgeResult.score > 0) knowledgeJudgeConfidence = judgeResult.score / 5;
  }
  const knowledgeParsed = parseFrontmatter(resolvedPromotionContent);
  const proposalResult = createProposal(
    stash,
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
    },
    ctx.proposalsCtx,
  );

  if (isProposalSkipped(proposalResult)) {
    appendEvent({
      eventType: "distill_invoked",
      ref: inputRef,
      metadata: {
        outcome: "skipped" as const,
        lessonRef: promotion.knowledgeRef,
        message: proposalResult.message,
        skipReason: proposalResult.reason,
        ...eligMeta,
      },
    });
    return {
      schemaVersion: 1,
      ok: true,
      outcome: "skipped",
      inputRef,
      lessonRef: promotion.knowledgeRef,
      message: proposalResult.message,
    };
  }

  const proposal: Proposal = proposalResult;
  // G4: content-score the distilled OUTPUT so it carries a real encoding
  // salience (encoding_source='content') from creation.
  persistOutputEncodingSalience(
    promotion.knowledgeRef,
    resolvedPromotionContent,
    existingRefVocabulary,
    outcomeWeightEnabled,
  );
  appendEvent({
    eventType: "distill_invoked",
    ref: inputRef,
    metadata: {
      outcome: "queued" as const,
      lessonRef: promotion.knowledgeRef,
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
  });

  return {
    schemaVersion: 1,
    ok: true,
    outcome: "queued",
    inputRef,
    lessonRef: promotion.knowledgeRef,
    proposalRef: promotion.knowledgeRef,
    proposalKind: "knowledge",
    proposalId: proposal.id,
    proposal,
    ...(exclusionSetSize > 0 ? { filteredFeedbackCount, feedbackFullyFiltered } : {}),
  };
}
