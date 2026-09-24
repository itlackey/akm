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
import { parseRefInput } from "../../../core/asset/resolve-ref";
import { timestampForFilename } from "../../../core/common";
import type { AkmConfig, LlmConnectionConfig } from "../../../core/config/config";
import { ConfigError } from "../../../core/errors";
import { appendEvent, type EventsContext } from "../../../core/events";
import type { AkmDistillResult, DistillOutcome } from "../../../core/improve-types";
import { parseEmbeddedJsonResponse } from "../../../core/parse";
import { getDistillRejectedDir } from "../../../core/paths";
import { withStateDb } from "../../../core/state-db";
import { warn } from "../../../core/warn";
import { recordWrittenPath } from "../../../core/write-provenance";
import type { LoweringNotice } from "../../../execution/resolved-request";
import type { LoweredExecutionDispatchLease } from "../../../integrations/agent/execution-lowering";
import type { RunnerSpec } from "../../../integrations/agent/runner";
import type { ChatCompletionOptions, ChatMessage } from "../../../llm/client";
import type { LlmFeatureKey } from "../../../llm/feature-gate";
import { callStructured } from "../../../llm/structured-call";
import type { EligibilitySource } from "../../proposal/proposal-types";
import { archiveProposal, isProposalSkipped, type Proposal, type ProposalsContext } from "../../proposal/repository";
import { akmSearch } from "../../read/search";
import { scoreEncodingSalience } from "../encoding-salience";
import { resolveImproveLlmExecution } from "../execution";
import { emitProposal } from "../proposal-envelope";
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
    "2. NON-REDUNDANCY: Is this lesson meaningfully different from what the source already says?",
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
  lines.push(
    'Return ONLY valid JSON, no prose: {"scores": {"novelty": <1-5 integer>, "nonRedundancy": <1-5 integer>}, "reason": "<one sentence>"}',
  );
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
    'Return ONLY valid JSON, no prose: {"scores": {"feedbackAlignment": <1-5 integer>, "preservation": <1-5 integer>, "quality": <1-5 integer>}, "reason": "<one sentence>"}',
  ].join("\n");
}

type QualityJudgeResult = {
  pass: boolean;
  score: number;
  reason: string;
  reviewNeeded?: boolean;
  /** Per-criterion 1-5 scores the average was computed from. Absent for the old `{"score": float}` shape. */
  criteria?: Record<string, number>;
};
type QualityJudgeChat = (
  connection: LlmConnectionConfig,
  messages: ChatMessage[],
  options?: ChatCompletionOptions,
) => Promise<string>;

export interface QualityJudgeOptions {
  similarLessons?: Array<{ ref: string; content: string }>;
  /** Preferred production path: exact symbolic runner selected for this improve process. */
  llmRunner?: Extract<RunnerSpec, { kind: "llm" }>;
  /** The caller already froze judge selection; absence of llmRunner must fail closed without re-resolution. */
  runnerSelectionFrozen?: true;
  lease?: LoweredExecutionDispatchLease;
  timeoutMs?: number | null;
  signal?: AbortSignal;
  onNotices?: (notices: readonly Readonly<LoweringNotice>[]) => void;
}

/**
 * Criterion keys `buildJudgePrompt` asks the lesson judge to score.
 * R16: ACTIONABILITY dropped (splinter measured AUC 0.46 against accept/reject
 * outcomes — no signal — and averaging it pulled scores toward the review band).
 */
const LESSON_JUDGE_CRITERIA_KEYS = ["novelty", "nonRedundancy"] as const;
/** Criterion keys `buildReflectJudgePrompt` asks the reflect judge to score. */
const REFLECT_JUDGE_CRITERIA_KEYS = ["feedbackAlignment", "preservation", "quality"] as const;

/**
 * R16 / r2-2 / JUDGE2: parse the judge's JSON response, accepting either the
 * current per-criterion shape (`{"scores": {...}, "reason"}`, averaged in
 * code) or the old averaged-float shape (`{"score": 1-5, "reason"}`) a model
 * may still return. `expectedCriteriaKeys` names the criteria this judge's
 * prompt asked for; only those keys are read, validated, and averaged — a
 * `scores` object missing any of them is a parse failure (a truncated or
 * partial response can't auto-pass on whatever keys happened to arrive), and
 * any OTHER key present (e.g. a model spelling a key differently, or echoing
 * a criterion the prompt didn't ask for) is silently ignored rather than
 * changing the score or failing the parse. Each expected criterion (or the
 * bare score) must be a finite number in 1..5; anything else — an
 * out-of-range or non-finite value, a non-string `reason` — is a parse
 * failure so the caller routes to review exactly as before.
 */
function parseJudgeResponse(
  raw: string,
  expectedCriteriaKeys: readonly string[],
): { score: number; reason: string; criteria?: Record<string, number> } | undefined {
  const parsed = parseEmbeddedJsonResponse<{ score?: unknown; scores?: unknown; reason?: unknown }>(raw);
  if (!parsed || typeof parsed.reason !== "string") return undefined;
  const reason = parsed.reason;

  if (parsed.scores !== undefined) {
    if (typeof parsed.scores !== "object" || parsed.scores === null || Array.isArray(parsed.scores)) return undefined;
    const scores = parsed.scores as Record<string, unknown>;
    const criteria: Record<string, number> = {};
    let sum = 0;
    for (const key of expectedCriteriaKeys) {
      const value = scores[key];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > 5) return undefined;
      criteria[key] = value;
      sum += value;
    }
    const score = sum / expectedCriteriaKeys.length;
    return { score, reason, criteria };
  }

  if (typeof parsed.score === "number" && Number.isFinite(parsed.score) && parsed.score >= 1 && parsed.score <= 5) {
    return { score: parsed.score, reason };
  }

  return undefined;
}

/**
 * JUDGE2: strict JSON Schema for a judge response, sent through the same
 * `supportsJsonSchema`-gated `request.responseSchema` path
 * `src/llm/graph-extract.ts` (`GRAPH_EXTRACTION_JSON_SCHEMA`) uses — a
 * provider that doesn't opt in (`runner.connection.supportsJsonSchema`) sees
 * no change. Built from `expectedCriteriaKeys` so each judge's schema matches
 * exactly the criteria its own prompt asks for; `additionalProperties: false`
 * at both levels means a model that spells a key differently is rejected by
 * a schema-enforcing provider rather than silently producing a parse failure.
 */
function buildJudgeResponseSchema(expectedCriteriaKeys: readonly string[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const key of expectedCriteriaKeys) {
    properties[key] = { type: "integer", minimum: 1, maximum: 5 };
  }
  return {
    type: "object",
    required: ["scores", "reason"],
    additionalProperties: false,
    properties: {
      scores: {
        type: "object",
        required: [...expectedCriteriaKeys],
        additionalProperties: false,
        properties,
      },
      reason: { type: "string" },
    },
  };
}

async function runQualityJudge(
  feature: LlmFeatureKey,
  config: AkmConfig,
  prompt: string,
  expectedCriteriaKeys: readonly string[],
  chat: QualityJudgeChat | undefined,
  options: QualityJudgeOptions = {},
): Promise<QualityJudgeResult> {
  const resolvedDefault =
    !options.runnerSelectionFrozen && !options.llmRunner
      ? resolveImproveLlmExecution({ config, processName: `${feature}-judge` })
      : null;
  if (resolvedDefault) options.onNotices?.(resolvedDefault.notices);
  const runner = options.llmRunner ?? resolvedDefault?.runner;
  if (!runner) {
    return { pass: false, score: -1, reason: "no LLM configured — cannot judge, failing closed" };
  }
  try {
    // UNGATED at the seam (no akmConfig): the quality gates' enablement is
    // resolved by the caller before this function runs, and a transport throw
    // propagates into the fail-closed catch below. `feature` labels the call.
    const raw = await callStructured<string>({
      feature,
      runner,
      ...(options.lease ? { lease: options.lease } : {}),
      messages: [
        { role: "system", content: "Return only valid JSON. No prose." },
        { role: "user", content: prompt },
      ],
      request: {
        enableThinking: false,
        // R13: the judge must not inherit the generation runner's temperature
        // (measured: 10/16 verdict flips at 0.3, 0/16 at 0). Pinned regardless
        // of what `engines.<name>.temperature` the runner resolves.
        temperature: 0,
        // JUDGE2: bounds the response to exactly this judge's criteria on
        // providers that opt into structured output; a no-op otherwise.
        responseSchema: buildJudgeResponseSchema(expectedCriteriaKeys),
        ...(Object.hasOwn(options, "timeoutMs") ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(chat ? { chat } : {}),
      },
      parse: (rawResponse) => rawResponse ?? "",
      // Unreachable on the ungated path (errors propagate); fail closed anyway.
      onError: () => "",
      fallback: "",
      ...(options.onNotices ? { onNotices: options.onNotices } : {}),
    });
    const parsed = parseJudgeResponse(raw, expectedCriteriaKeys);
    if (!parsed) {
      return { pass: false, score: -1, reason: "judge parse failed — routed to review", reviewNeeded: true };
    }
    // D-5 / #388: Three-band system (MT-Bench arXiv:2306.05685 — ~±0.5 judge variance).
    //   >= 3.5: auto-queue as pending (pass: true)
    //   2.5–3.5: review-needed band — uncertain, escalate to human (reviewNeeded: true)
    //   < 2.5: auto-reject (pass: false)
    const { score, reason, criteria } = parsed;
    if (score >= 3.5) return { pass: true, score, reason, ...(criteria ? { criteria } : {}) };
    if (score >= 2.5) return { pass: false, score, reason, reviewNeeded: true, ...(criteria ? { criteria } : {}) };
    return { pass: false, score, reason, ...(criteria ? { criteria } : {}) };
  } catch (error) {
    // Invalid symbolic credentials are configuration failures, not a negative
    // content verdict. Provider/runtime failures retain the fail-closed result.
    if (error instanceof ConfigError) throw error;
    return { pass: false, score: -1, reason: "judge timeout/error — routed to review", reviewNeeded: true };
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
    LESSON_JUDGE_CRITERIA_KEYS,
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
    REFLECT_JUDGE_CRITERIA_KEYS,
    chat,
    options,
  );
}

// ── Quality-rejection helper ─────────────────────────────────────────────────

/**
 * Write a rejected lesson to `$STATE/improve/distill-rejected/<stash>/`
 * (itlackey/akm#890), persist it as a real `proposals` row, append a
 * `distill_invoked` quality-rejected event, and return the `quality_rejected`
 * envelope.
 *
 * R10: the proposal row is minted through the same `createProposal`
 * (`emitProposal`) path every other distill proposal takes, so `source:
 * "distill"` fingerprint/backoff bookkeeping (proposal/repository.ts
 * `checkFingerprintAndBackoff`) and the Reflexion "previously rejected"
 * context (distill.ts's `buildDistillMessages`, reflect.ts's
 * `readRejectedProposals`) can see it — before this, a quality rejection
 * left only an event and a `$STATE`-side file nothing read, so the same ref
 * was re-selected and re-rejected on every run. `review_needed` stays
 * `pending` for a human to triage in the normal queue (matching what
 * promote-memory.ts's comment always claimed); `quality_rejected` is minted
 * pending, then immediately archived to `rejected` with the judge's reason.
 * A fingerprint/backoff guard hit here (rare pre-R9; the pre-generation
 * guard is item R9) just means no new row — the envelope + event below are
 * written either way.
 *
 * @param stash     - Root stash directory.
 * @param inputRef  - The original input ref (for the event).
 * @param proposalRef - The proposed lesson/knowledge ref.
 * @param content   - The raw content that failed the quality gate.
 * @param score     - Quality score from the judge.
 * @param reason    - Human-readable rejection reason.
 * @param extraMeta - Optional additional metadata for the event.
 * @param eventsCtx - Events context so the emit takes appendEvent's fast path (R25).
 * @param proposalOpts - Test seam / attribution passthrough for the minted proposal row.
 */
export function writeQualityRejection(
  stash: string,
  inputRef: string,
  proposalRef: string,
  content: string,
  score: number,
  reason: string,
  extraMeta: Record<string, unknown> = {},
  eligibilitySource?: EligibilitySource,
  eventsCtx?: EventsContext,
  proposalOpts: { proposalsCtx?: ProposalsContext; sourceRun?: string; modelId?: string } = {},
): AkmDistillResult {
  // D-5 / #388: reviewNeeded flag selects "review_needed" vs "quality_rejected" outcome.
  const outcome: DistillOutcome = extraMeta.reviewNeeded ? "review_needed" : "quality_rejected";

  // r2-1: the mint-time canonical validator inside createProposal (via
  // emitProposal) throws UsageError for structurally-invalid content (e.g. a
  // lessons/ ref missing description/when_to_use). The proposal row here is
  // bookkeeping for backoff/Reflexion, never the authoritative record of the
  // rejection, so a validator throw degrades to "no row minted" — the same
  // bucket as the fingerprint/backoff skip below, not a caller-visible error.
  // r3-1: the archiveProposal call below is guarded the same way, for the
  // same reason.
  let mintedProposal: ReturnType<typeof emitProposal> | undefined;
  try {
    mintedProposal = emitProposal(
      { stashDir: stash, ...(proposalOpts.proposalsCtx ? { proposalsCtx: proposalOpts.proposalsCtx } : {}) },
      {
        ref: proposalRef,
        source: "distill",
        ...(proposalOpts.sourceRun !== undefined ? { sourceRun: proposalOpts.sourceRun } : {}),
        ...(proposalOpts.modelId !== undefined ? { modelId: proposalOpts.modelId } : {}),
        payload: { content },
        ...(eligibilitySource ? { eligibilitySource } : {}),
      },
    );
  } catch {
    mintedProposal = undefined;
  }
  let proposal: Proposal | undefined;
  if (mintedProposal && !isProposalSkipped(mintedProposal)) {
    if (outcome === "quality_rejected") {
      try {
        proposal = archiveProposal(stash, mintedProposal.id, "rejected", reason, proposalOpts.proposalsCtx);
      } catch (error) {
        warn(
          `[akm] writeQualityRejection: failed to archive proposal ${mintedProposal.id} as rejected: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else {
      proposal = mintedProposal;
    }
  }

  const rejectDir = getDistillRejectedDir(stash);
  fs.mkdirSync(rejectDir, { recursive: true });
  const ts = timestampForFilename();
  const rejectPath = path.join(rejectDir, `${ts}-${proposalRef.replace(/[:/\\]/g, "-")}.md`);
  // R16: surface the judge's per-criterion scores in the envelope frontmatter
  // when the caller supplied them (a judge-based rejection), same as the event.
  const criteria =
    extraMeta.criteria && typeof extraMeta.criteria === "object" && !Array.isArray(extraMeta.criteria)
      ? (extraMeta.criteria as Record<string, number>)
      : undefined;
  const criteriaFrontmatter = criteria
    ? `criteria:\n${Object.entries(criteria)
        .map(([key, value]) => `  ${key}: ${value}`)
        .join("\n")}\n`
    : "";
  fs.writeFileSync(
    rejectPath,
    `---\nscore: ${score}\nreason: ${reason}\noutcome: ${outcome}\n${criteriaFrontmatter}---\n\n${content}`,
    "utf8",
  );
  // #652 / itlackey/akm#890: journal it even though it now lands under
  // `$STATE`, outside the stash's git repo — `result.writtenPaths` reports
  // every path a run touched, in or out of the stash (describeRunWrittenPaths
  // in improve.ts falls back to the absolute path for anything outside the
  // stash root), and the auto-sync commit's own containment check
  // (resolveSyncPathSet's `relativeWrittenPath`) already drops anything
  // outside `repoDir` from what gets staged — recording it here cannot cause
  // it to be committed.
  recordWrittenPath(rejectPath);
  appendEvent(
    {
      eventType: "distill_invoked",
      ref: inputRef,
      metadata: {
        outcome,
        proposalRef,
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
    proposalRef,
    score,
    reason,
    ...(proposal ? { proposalId: proposal.id, proposal } : {}),
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
    const parsedRef = parseRefInput(ref);
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
