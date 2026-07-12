// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Distill quality-gate cluster — LLM-as-judge, quality-rejection envelope
 * writer, and output-salience persistence. Extracted verbatim from
 * `distill.ts` so the main `akmDistill` orchestrator and the memory→knowledge
 * promotion branch (`promote-memory.ts`) can share the same helpers without a
 * circular import. Logic is byte-identical to the pre-extraction inline code.
 */

import fs from "node:fs";
import path from "node:path";
import { parseAssetRef } from "../../../core/asset/asset-ref";
import { timestampForFilename } from "../../../core/common";
import { type AkmConfig, getDefaultLlmConfig, type LlmConnectionConfig } from "../../../core/config/config";
import { appendEvent } from "../../../core/events";
import type { EligibilitySource } from "../../../core/improve-types";
import { withStateDb } from "../../../core/state-db";
import { type ChatMessage, parseEmbeddedJsonResponse } from "../../../llm/client";
import { akmSearch } from "../../read/search";
import type { AkmDistillResult, DistillOutcome } from "../distill";
import { scoreEncodingSalience } from "../encoding-salience";
import { computeSalience, upsertAssetSalience } from "../salience";

// ── D-4 / #390: Top-3 similar lessons retrieval ──────────────────────────────

/**
 * Default implementation: use akmSearch to find top-N similar lesson assets.
 * Returns empty array when search fails or returns no results.
 * Requires embedding configured for semantic similarity; degrades gracefully.
 */
export async function fetchTopSimilarLessons(
  query: string,
  n: number,
  _stashDir?: string,
): Promise<Array<{ ref: string; content: string }>> {
  try {
    const result = await akmSearch({
      query,
      type: "lesson",
      limit: n,
      skipLogging: true,
      eventSource: "improve",
    });
    const hits = result?.hits ?? [];
    return hits
      .filter((h): h is import("../../../sources/types").SourceSearchHit => "path" in h && typeof h.path === "string")
      .slice(0, n)
      .map((h) => {
        let content = "";
        try {
          if (h.path && fs.existsSync(h.path)) {
            content = fs.readFileSync(h.path, "utf8");
          }
        } catch {
          /* best-effort */
        }
        return { ref: h.ref, content };
      });
  } catch {
    return [];
  }
}

// ── LLM-as-judge quality gate (P2-B) ────────────────────────────────────────

/**
 * D-4 / #390: Build the LLM-as-judge prompt.
 *
 * When similarLessons are provided (top-3 by embedding similarity), they are
 * included in the context so the judge can lower the score for near-duplicates.
 * Voyager arXiv:2305.16291 — skill library admission requires similarity check
 * against the existing library. A-MEM arXiv:2502.12110 — new notes are checked
 * against existing notes before linking.
 */
export function buildJudgePrompt(
  lessonContent: string,
  sourceContent: string,
  similarLessons?: Array<{ ref: string; content: string }>,
): string {
  const lines = [
    "You are evaluating a proposed lesson asset for an akm knowledge base.",
    "",
    "Score this lesson on each criterion from 1 (poor) to 5 (excellent):",
    "1. NOVELTY: Does the lesson add information not already present in the source asset?",
    "2. ACTIONABILITY: Can an agent follow this lesson without additional context?",
    "3. NON-REDUNDANCY: Is this lesson meaningfully different from what the source already says?",
    "",
    "Source asset content:",
    "```",
    sourceContent.slice(0, 2000),
    "```",
  ];

  if (similarLessons && similarLessons.length > 0) {
    lines.push("");
    lines.push(
      "Existing similar lessons (top-3 by similarity). Rate lower if the proposed lesson is substantially similar to any of these:",
    );
    for (const sl of similarLessons) {
      lines.push(`\nExisting lesson ref: ${sl.ref}`);
      lines.push("```");
      lines.push(sl.content.slice(0, 500));
      lines.push("```");
    }
  }

  lines.push("");
  lines.push("Proposed lesson content:");
  lines.push("```");
  lines.push(lessonContent.slice(0, 1000));
  lines.push("```");
  lines.push("");
  lines.push('Return ONLY valid JSON, no prose: {"score": <average score 1-5 as float>, "reason": "<one sentence>"}');
  return lines.join("\n");
}

/**
 * Run the LLM-as-judge quality gate on a proposal's content.
 *
 * Exported so reflect.ts can apply the same gate to reflect proposals (R-5 / #374).
 * Gated by the flag name `lesson_quality_gate` (or its alias
 * `proposal_quality_gate`) via {@link isLlmFeatureEnabled} — which reads
 * the selected strategy's `processes.distill.qualityGate.enabled` (and the
 * corresponding `.reflect.qualityGate.enabled` for proposals).
 *
 * Fail-CLOSED (07 P0-2): returns `pass: false` (score -1) on timeout, parse
 * failure, or missing LLM. Minted content that cannot be judged is rejected,
 * not passed through — an unverifiable judge must never wave content into the
 * stash. The rejection is `quality_rejected`, not `review_needed`.
 */
export async function runLessonQualityJudge(
  config: AkmConfig,
  lessonContent: string,
  sourceContent: string,
  chat: (llmConfig: LlmConnectionConfig, messages: ChatMessage[]) => Promise<string>,
  /** D-4 / #390: top-3 similar existing lessons for dedup check. */
  similarLessons?: Array<{ ref: string; content: string }>,
  llmConfigOverride?: LlmConnectionConfig,
): Promise<{ pass: boolean; score: number; reason: string; reviewNeeded?: boolean }> {
  const llmConfig = llmConfigOverride ?? getDefaultLlmConfig(config);
  if (!llmConfig) {
    return { pass: false, score: -1, reason: "no LLM configured — cannot judge, failing closed" };
  }
  const judgeLlmConfig = llmConfig;
  const JUDGE_TIMEOUT_MS = 8_000;
  try {
    const raw = await Promise.race([
      chat(judgeLlmConfig, [
        { role: "system", content: "Return only valid JSON. No prose." },
        { role: "user", content: buildJudgePrompt(lessonContent, sourceContent, similarLessons) },
      ]),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("judge timeout")), JUDGE_TIMEOUT_MS)),
    ]);
    const parsed = parseEmbeddedJsonResponse<{ score: number; reason: string }>(raw);
    if (!parsed || typeof parsed.score !== "number") {
      return { pass: false, score: -1, reason: "judge parse failed — cannot judge, failing closed" };
    }
    // D-5 / #388: Three-band system (MT-Bench arXiv:2306.05685 — ~±0.5 judge variance).
    //   >= 3.5: auto-queue as pending (pass: true)
    //   2.5–3.5: review-needed band — uncertain, escalate to human (reviewNeeded: true)
    //   < 2.5: auto-reject (pass: false)
    const score = parsed.score;
    const reason = parsed.reason ?? "";
    if (score >= 3.5) {
      return { pass: true, score, reason };
    }
    if (score >= 2.5) {
      // Uncertainty band: treat as failed for auto-queuing but flag for review.
      return { pass: false, score, reason, reviewNeeded: true };
    }
    return { pass: false, score, reason };
  } catch {
    return { pass: false, score: -1, reason: "judge timeout/error — cannot judge, failing closed" };
  }
}

// ── Quality-rejection helper ─────────────────────────────────────────────────

/**
 * Write a rejected lesson to `.akm/distill-rejected/`, append a `distill_invoked`
 * quality-rejected event, and return the `quality_rejected` envelope.
 *
 * @param stash     - Root stash directory.
 * @param inputRef  - The original input ref (for the event).
 * @param lessonRef - The proposed lesson/knowledge ref.
 * @param content   - The raw content that failed the quality gate.
 * @param score     - Quality score from the judge.
 * @param reason    - Human-readable rejection reason.
 * @param extraMeta - Optional additional metadata for the event.
 */
export function writeQualityRejection(
  stash: string,
  inputRef: string,
  lessonRef: string,
  content: string,
  score: number,
  reason: string,
  extraMeta: Record<string, unknown> = {},
  eligibilitySource?: EligibilitySource,
): AkmDistillResult {
  // D-5 / #388: reviewNeeded flag selects "review_needed" vs "quality_rejected" outcome.
  const outcome: DistillOutcome = extraMeta.reviewNeeded ? "review_needed" : "quality_rejected";
  const rejectDir = path.join(stash, ".akm", "distill-rejected");
  fs.mkdirSync(rejectDir, { recursive: true });
  const ts = timestampForFilename();
  fs.writeFileSync(
    path.join(rejectDir, `${ts}-${lessonRef}.md`),
    `---\nscore: ${score}\nreason: ${reason}\noutcome: ${outcome}\n---\n\n${content}`,
    "utf8",
  );
  appendEvent({
    eventType: "distill_invoked",
    ref: inputRef,
    metadata: {
      outcome,
      lessonRef,
      score,
      reason,
      ...extraMeta,
      // Attribution tagging: stamp the eligibility lane so distill_invoked can be
      // sliced by lane downstream. See EligibilitySource.
      ...(eligibilitySource ? { eligibilitySource } : {}),
    },
  });
  return {
    schemaVersion: 1,
    ok: true,
    outcome,
    inputRef,
    lessonRef,
    score,
    reason,
    ...extraMeta,
  };
}

/**
 * G4 — content-score a distilled OUTPUT (lesson/knowledge proposal body) and
 * persist it to state.db :: asset_salience with `encoding_source: "content"`.
 *
 * Lessons are refused as distill INPUTS (`DISTILL_REFUSED_INPUT_TYPES`), so
 * this creation-time write is their only chance to earn a real content-derived
 * encoding score instead of sitting on the type-weight stub forever. Best-effort:
 * never blocks or fails the proposal flow.
 */
export function persistOutputEncodingSalience(
  ref: string,
  body: string,
  existingRefVocabulary: Set<string>,
  // Operator opt-out (improve.salience.outcomeWeightEnabled: false) must apply
  // here too, or distill-written rank_score rows would use WS-2 weights while
  // preparation uses parity weights — inconsistent salience semantics.
  outcomeWeightEnabled: boolean,
): void {
  try {
    const parsedRef = parseAssetRef(ref);
    const salienceResult = scoreEncodingSalience({
      body,
      type: parsedRef.type,
      existingRefVocabulary,
      revisionCount: 0, // a freshly distilled output IS a first encounter
    });
    withStateDb((stateDb) => {
      const vector = computeSalience({
        ref,
        type: parsedRef.type,
        retrievalFreq: 0,
        encodingSalience: salienceResult.score,
        outcomeWeightEnabled,
      });
      upsertAssetSalience(stateDb, ref, vector);
    });
  } catch {
    // Best-effort — scoring must never block proposal creation.
  }
}
