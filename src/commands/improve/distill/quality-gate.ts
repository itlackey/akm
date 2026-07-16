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
import { appendEvent, type EventsContext } from "../../../core/events";
import type { EligibilitySource } from "../../../core/improve-types";
import { withStateDb } from "../../../core/state-db";
import { type ChatCompletionOptions, type ChatMessage, parseEmbeddedJsonResponse } from "../../../llm/client";
import type { LlmFeatureKey } from "../../../llm/feature-gate";
import { callStructured } from "../../../llm/structured-call";
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

function boundedDocument(content: string, maxChars = 6000): string {
  if (content.length <= maxChars) return content;
  const half = Math.floor((maxChars - 80) / 2);
  return `${content.slice(0, half)}\n\n[... middle omitted for bounded judge context ...]\n\n${content.slice(-half)}`;
}

function buildChangedRegion(sourceContent: string, candidateContent: string): string {
  const source = sourceContent.split("\n");
  const candidate = candidateContent.split("\n");
  let prefix = 0;
  while (prefix < source.length && prefix < candidate.length && source[prefix] === candidate[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < source.length - prefix &&
    suffix < candidate.length - prefix &&
    source[source.length - 1 - suffix] === candidate[candidate.length - 1 - suffix]
  ) {
    suffix++;
  }
  const removed = source.slice(prefix, source.length - suffix).join("\n");
  const added = candidate.slice(prefix, candidate.length - suffix).join("\n");
  return boundedDocument(`Removed or replaced:\n${removed || "(none)"}\n\nAdded or replacement:\n${added || "(none)"}`);
}

/** Build quality criteria for revising an existing asset in place. */
export function buildReflectJudgePrompt(candidateContent: string, sourceContent: string, feedback: string[]): string {
  return [
    "You are evaluating a proposed revision to an existing akm asset.",
    "",
    "Score this revision on each criterion from 1 (poor) to 5 (excellent):",
    "1. FEEDBACK ALIGNMENT: Does the revision address the supplied feedback or improve retrieval and clarity?",
    "2. PRESERVATION: Does it retain the source's concrete facts, code, commands, examples, and structure without truncation?",
    "3. QUALITY: Is the revision coherent, actionable, complete, and free of unsupported claims?",
    "",
    "Overlap with the source is expected and must not lower the score by itself; this is an in-place revision, not a new lesson.",
    "",
    "Feedback:",
    "```",
    (feedback.length > 0 ? feedback.join("\n") : "No explicit feedback supplied.").slice(0, 1000),
    "```",
    "",
    "Source asset content:",
    "```",
    boundedDocument(sourceContent),
    "```",
    "",
    "Proposed revision:",
    "```",
    boundedDocument(candidateContent),
    "```",
    "",
    "Changed region:",
    "```",
    buildChangedRegion(sourceContent, candidateContent),
    "```",
    "",
    'Return ONLY valid JSON, no prose: {"score": <average score 1-5 as float>, "reason": "<one sentence>"}',
  ].join("\n");
}

type QualityJudgeResult = { pass: boolean; score: number; reason: string; reviewNeeded?: boolean };
type QualityJudgeChat = (
  llmConfig: LlmConnectionConfig,
  messages: ChatMessage[],
  options?: ChatCompletionOptions,
) => Promise<string>;

export interface QualityJudgeOptions {
  similarLessons?: Array<{ ref: string; content: string }>;
  llmConfig?: LlmConnectionConfig;
  timeoutMs?: number | null;
  signal?: AbortSignal;
}

async function runQualityJudge(
  feature: LlmFeatureKey,
  config: AkmConfig,
  prompt: string,
  chat: QualityJudgeChat | undefined,
  options: QualityJudgeOptions = {},
): Promise<QualityJudgeResult> {
  const llmConfig = options.llmConfig ?? getDefaultLlmConfig(config);
  if (!llmConfig) {
    return { pass: false, score: -1, reason: "no LLM configured — cannot judge, failing closed" };
  }
  try {
    // UNGATED at the seam (no akmConfig): the quality gates' enablement is
    // resolved by the caller before this function runs, and a transport throw
    // propagates into the fail-closed catch below. `feature` labels the call.
    const raw = await callStructured<string>({
      feature,
      config: llmConfig,
      messages: [
        { role: "system", content: "Return only valid JSON. No prose." },
        { role: "user", content: prompt },
      ],
      request: {
        enableThinking: false,
        ...(Object.hasOwn(options, "timeoutMs") ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(chat ? { chat } : {}),
      },
      parse: (rawResponse) => rawResponse ?? "",
      // Unreachable on the ungated path (errors propagate); fail closed anyway.
      onError: () => "",
      fallback: "",
    });
    const parsed = parseEmbeddedJsonResponse<{ score: number; reason: string }>(raw);
    if (
      !parsed ||
      typeof parsed.score !== "number" ||
      !Number.isFinite(parsed.score) ||
      parsed.score < 1 ||
      parsed.score > 5 ||
      typeof parsed.reason !== "string"
    ) {
      return { pass: false, score: -1, reason: "judge parse failed — cannot judge, failing closed" };
    }
    // D-5 / #388: Three-band system (MT-Bench arXiv:2306.05685 — ~±0.5 judge variance).
    //   >= 3.5: auto-queue as pending (pass: true)
    //   2.5–3.5: review-needed band — uncertain, escalate to human (reviewNeeded: true)
    //   < 2.5: auto-reject (pass: false)
    const score = parsed.score;
    const reason = parsed.reason ?? "";
    if (score >= 3.5) return { pass: true, score, reason };
    if (score >= 2.5) return { pass: false, score, reason, reviewNeeded: true };
    return { pass: false, score, reason };
  } catch {
    return { pass: false, score: -1, reason: "judge timeout/error — cannot judge, failing closed" };
  }
}

/**
 * Run the LLM-as-judge quality gate on a proposal's content.
 *
 * Exported so reflect.ts can apply the same gate to reflect proposals (R-5 / #374).
 * The selected strategy's distill/reflect quality-gate setting is resolved by
 * the caller before this function runs.
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
  chat: QualityJudgeChat | undefined,
  options: QualityJudgeOptions = {},
): Promise<QualityJudgeResult> {
  return runQualityJudge(
    "lesson_quality_gate",
    config,
    buildJudgePrompt(lessonContent, sourceContent, options.similarLessons),
    chat,
    options,
  );
}

/** Judge an in-place reflect revision without applying new-lesson novelty criteria. */
export async function runReflectQualityJudge(
  config: AkmConfig,
  candidateContent: string,
  sourceContent: string,
  feedback: string[],
  chat: QualityJudgeChat | undefined,
  options: QualityJudgeOptions = {},
): Promise<QualityJudgeResult> {
  return runQualityJudge(
    "proposal_quality_gate",
    config,
    buildReflectJudgePrompt(candidateContent, sourceContent, feedback),
    chat,
    options,
  );
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
 * @param eventsCtx - Events context so the emit takes appendEvent's fast path (R25).
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
  eventsCtx?: EventsContext,
): AkmDistillResult {
  // D-5 / #388: reviewNeeded flag selects "review_needed" vs "quality_rejected" outcome.
  const outcome: DistillOutcome = extraMeta.reviewNeeded ? "review_needed" : "quality_rejected";
  const rejectDir = path.join(stash, ".akm", "distill-rejected");
  fs.mkdirSync(rejectDir, { recursive: true });
  const ts = timestampForFilename();
  fs.writeFileSync(
    path.join(rejectDir, `${ts}-${lessonRef.replace(/[:/\\]/g, "-")}.md`),
    `---\nscore: ${score}\nreason: ${reason}\noutcome: ${outcome}\n---\n\n${content}`,
    "utf8",
  );
  appendEvent(
    {
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
    },
    eventsCtx,
  );
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
