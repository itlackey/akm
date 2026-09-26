// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The one path every improve stage (reflect, distill, consolidate, extract,
 * triage, memory inference, graph extraction) runs through: pick the stage's
 * runner, call the model, judge what it produced, mint the proposal, and
 * attribute the usage. A stage keeps only its prompt, its parse shape and its
 * target rule.
 */

import type { AkmConfig, ImproveProfileConfig, LlmConnectionConfig } from "../../core/config/config";
import { getImproveProcessConfig } from "../../core/config/config";
import { ConfigError } from "../../core/errors";
import { parseEmbeddedJsonResponse } from "../../core/parse";
import { warn } from "../../core/warn";
import type { LoweringNotice } from "../../execution/resolved-request";
import type { RejectedProposalContext } from "../../integrations/agent/prompts";
import type { RunnerSpec } from "../../integrations/agent/runner";
import { type ChatCompletionOptions, type ChatMessage, LlmCallError } from "../../llm/client";
import type { LlmFeatureKey } from "../../llm/feature-gate";
import { type CallStructuredRequest, callStructured } from "../../llm/structured-call";
import { withLlmStage } from "../../llm/usage-telemetry";
import { isProceduralRejection } from "../proposal/proposal-types";
import {
  type CreateProposalInput,
  createProposal,
  listProposalsReadOnly,
  type Proposal,
  type ProposalGateDecision,
  type ProposalsContext,
  proposalContentHash,
  recordGateDecision,
} from "../proposal/repository";
import { resolveImproveLlmExecution } from "./execution";
import type { ImproveProcessName, ResolvedImprovePlan } from "./improve-strategies";

export type LlmRunner = Extract<RunnerSpec, { kind: "llm" }>;
export type Notice = Readonly<LoweringNotice>;
export type NoticeSink = (notices: readonly Notice[]) => void;

/** Normalize an unknown thrown value to a message. */
export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The lowering notices a stage's dispatches emitted, each once. */
export function noticeSet(forward?: NoticeSink) {
  const byKey = new Map<string, Notice>();
  const add: NoticeSink = (notices) => {
    for (const notice of notices) byKey.set(JSON.stringify(notice), notice);
    forward?.(notices);
  };
  const list = (): readonly Notice[] => Object.freeze([...byKey.values()]);
  return { add, list, fields: (): { notices?: readonly Notice[] } => (byKey.size > 0 ? { notices: list() } : {}) };
}
export type NoticeSet = ReturnType<typeof noticeSet>;

/**
 * A stage's LLM runner: the one the improve plan froze for it (an own
 * `llmRunner` key, `null` meaning "none"), else the process engine cascade.
 */
export function stageRunner(
  frozen: { llmRunner?: LlmRunner | null },
  config: AkmConfig,
  profile: ImproveProfileConfig | undefined,
  processName: ImproveProcessName,
  onNotices?: NoticeSink,
): LlmRunner | undefined {
  if (Object.hasOwn(frozen, "llmRunner")) return frozen.llmRunner ?? undefined;
  const resolved = resolveImproveLlmExecution({
    config,
    profile,
    process: getImproveProcessConfig(processName, profile),
    processName,
  });
  if (resolved) onNotices?.(resolved.notices);
  return resolved?.runner;
}

export type StageLlmOutcome =
  | { ok: true; raw: string }
  | { ok: false; reason: "disabled" | "timeout" | "error"; error?: string };

export interface StageLlmCall {
  feature: LlmFeatureKey;
  runner: LlmRunner;
  prompt: string;
  system?: string;
  /** Earlier turns, sent before the terminal user prompt. */
  history?: ChatMessage[];
  request?: CallStructuredRequest;
  onNotices?: NoticeSink;
  /** Gate the call on the feature flag, with the stage's resolved enablement. */
  gate?: { config: AkmConfig; enabled?: boolean };
}

/**
 * One model call. Provider trouble (transport error, timeout, a disabled
 * feature) comes back as `{ ok: false }`; only a configuration failure throws.
 */
export async function callStage(call: StageLlmCall): Promise<StageLlmOutcome> {
  const messages: ChatMessage[] = [
    ...(call.system ? [{ role: "system" as const, content: call.system }] : []),
    ...(call.history ?? []),
    { role: "user", content: call.prompt },
  ];
  let failure: Extract<StageLlmOutcome, { ok: false }> | undefined;
  try {
    const raw = await callStructured<string | undefined>({
      feature: call.feature,
      ...(call.gate
        ? { akmConfig: call.gate.config, ...(call.gate.enabled !== undefined ? { enabled: call.gate.enabled } : {}) }
        : {}),
      runner: call.runner,
      messages,
      ...(call.request ? { request: call.request } : {}),
      ...(call.onNotices ? { onNotices: call.onNotices } : {}),
      parse: (r) => r ?? "",
      onError: (_cls, err) => {
        failure = { ok: false, reason: "error", error: errMessage(err) };
        return undefined;
      },
      fallback: undefined,
      onFallback: (event) => {
        failure ??= { ok: false, reason: event.reason, ...(event.error ? { error: event.error.message } : {}) };
      },
    });
    return raw === undefined ? (failure ?? { ok: false, reason: "error" }) : { ok: true, raw };
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    const timedOut = err instanceof LlmCallError && err.code === "timeout";
    return { ok: false, reason: timedOut ? "timeout" : "error", error: errMessage(err) };
  }
}

/** Attribute a stage's LLM calls to its process and planned engine (the usage report). */
const STAGE_LABELS = {
  reflect: "reflect",
  distill: "distill",
  consolidate: "consolidate",
  extract: "session-extraction",
  memoryInference: "memory-inference",
  graphExtraction: "graph-extraction",
  validation: "validation",
} as const;

export function attributeStage<T>(
  plan: ResolvedImprovePlan | undefined,
  process: keyof typeof STAGE_LABELS,
  fn: () => T,
): T {
  return withLlmStage(STAGE_LABELS[process], fn, { engine: plan?.processes[process].runner?.engine, process });
}

/** How many prior rejected proposals are shown to the model as "don't repeat this". */
export const MAX_REJECTED_PROPOSALS = 3;

/**
 * Reflexion context: the newest reviewer rejections for `ref`. Procedural
 * refusals (expiry, stale target, missing asset) are not judgements on the
 * content and are left out. Reads never create state.db.
 */
export function rejectedProposalContext(
  stash: string,
  ref: string | undefined,
  ctx?: ProposalsContext,
): RejectedProposalContext[] {
  if (!ref) return [];
  return listProposalsReadOnly(stash, { ref, status: "rejected", includeArchive: true }, ctx)
    .filter((p) => !isProceduralRejection(p))
    .sort((a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime())
    .slice(0, MAX_REJECTED_PROPOSALS)
    .map((p) => ({
      ref: p.ref,
      reason: p.review?.reason ?? "no reason given",
      // `payload.content` is populated on every row, including legacy ones.
      contentPreview: p.payload.content.slice(0, 500),
    }));
}

// ── Mint ─────────────────────────────────────────────────────────────────────

/**
 * Create a stage's proposal. `judged` stamps a `staged` gate decision with the
 * judged content's hash (the triage drain accepts it while the content still
 * matches); `review` leaves it `deferred` for a human (`review_needed` in the
 * improve ledger).
 */
export function mintProposal(
  stash: string,
  proposalsCtx: ProposalsContext | undefined,
  input: CreateProposalInput,
  verdict: { judged?: boolean; review?: Omit<ProposalGateDecision, "outcome" | "decidedAt"> } = {},
): Proposal {
  const proposal = createProposal(stash, input, proposalsCtx);
  if (verdict.review) {
    return recordGateDecision(stash, proposal.id, { outcome: "deferred", ...verdict.review }, proposalsCtx) ?? proposal;
  }
  return verdict.judged ? stageJudgedProposal(stash, proposal, proposalsCtx) : proposal;
}

/**
 * Stamp a proposal the quality judge passed. Best-effort: a failed stamp only
 * means the triage drain judges it again.
 */
export function stageJudgedProposal(stash: string, proposal: Proposal, proposalsCtx?: ProposalsContext): Proposal {
  try {
    return (
      recordGateDecision(
        stash,
        proposal.id,
        {
          outcome: "staged",
          reason: "quality-judge",
          gate: "quality-gate",
          contentHash: proposalContentHash(proposal),
        },
        proposalsCtx,
      ) ?? proposal
    );
  } catch (error) {
    warn(`[akm] failed to record the quality-judge pass for ${proposal.id}: ${errMessage(error)}`);
    return proposal;
  }
}

// ── Judge ────────────────────────────────────────────────────────────────────

export interface QualityJudgeResult {
  pass: boolean;
  score: number;
  reason: string;
  reviewNeeded?: boolean;
  /** Per-criterion 1-5 scores the average came from (absent for the old `{"score"}` shape). */
  criteria?: Record<string, number>;
}

type QualityJudgeChat = (
  connection: LlmConnectionConfig,
  messages: ChatMessage[],
  options?: ChatCompletionOptions,
) => Promise<string>;

export interface QualityJudgeOptions {
  similarLessons?: Array<{ ref: string; content: string }>;
  /** The exact runner selected for this judge. */
  llmRunner?: LlmRunner;
  /** The caller already froze judge selection: no runner means fail closed, never re-resolve. */
  runnerSelectionFrozen?: true;
  timeoutMs?: number | null;
  signal?: AbortSignal;
  onNotices?: NoticeSink;
}

/** Lesson judge prompt; similar existing lessons let it mark near-duplicates down. */
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
    lines.push(
      "",
      "Existing similar lessons (top-3 by similarity). Rate lower if the proposed lesson is substantially similar to any of these:",
    );
    for (const sl of similarLessons)
      lines.push(`\nExisting lesson ref: ${sl.ref}`, "```", sl.content.slice(0, 500), "```");
  }
  lines.push(
    "",
    "Proposed lesson content:",
    "```",
    lessonContent.slice(0, 1000),
    "```",
    "",
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

/** Judge prompt for an in-place revision (overlap with the source is expected). */
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

const LESSON_JUDGE_CRITERIA = ["novelty", "nonRedundancy"] as const;
const REFLECT_JUDGE_CRITERIA = ["feedbackAlignment", "preservation", "quality"] as const;

/**
 * Read a judge response: the per-criterion shape (averaged here) or the older
 * `{"score"}` shape. Only the expected criteria are read; any missing or
 * out-of-range (1..5) value is a parse failure, extra keys are ignored.
 */
function parseJudgeResponse(
  raw: string,
  keys: readonly string[],
): { score: number; reason: string; criteria?: Record<string, number> } | undefined {
  const parsed = parseEmbeddedJsonResponse<{ score?: unknown; scores?: unknown; reason?: unknown }>(raw);
  if (!parsed || typeof parsed.reason !== "string") return undefined;
  const reason = parsed.reason;
  const inRange = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 5;
  if (parsed.scores !== undefined) {
    if (typeof parsed.scores !== "object" || parsed.scores === null || Array.isArray(parsed.scores)) return undefined;
    const scores = parsed.scores as Record<string, unknown>;
    const criteria: Record<string, number> = {};
    for (const key of keys) {
      const value = scores[key];
      if (!inRange(value)) return undefined;
      criteria[key] = value;
    }
    return { score: Object.values(criteria).reduce((a, b) => a + b, 0) / keys.length, reason, criteria };
  }
  return inRange(parsed.score) ? { score: parsed.score, reason } : undefined;
}

function judgeResponseSchema(keys: readonly string[]): Record<string, unknown> {
  return {
    type: "object",
    required: ["scores", "reason"],
    additionalProperties: false,
    properties: {
      scores: {
        type: "object",
        required: [...keys],
        additionalProperties: false,
        properties: Object.fromEntries(keys.map((key) => [key, { type: "integer", minimum: 1, maximum: 5 }])),
      },
      reason: { type: "string" },
    },
  };
}

/**
 * The quality judge. Fails closed: no runner, an unparseable verdict or a
 * provider failure never passes content. Bands: >= 3.5 pass, 2.5-3.5 review,
 * < 2.5 reject. Temperature is pinned to 0 so verdicts do not flip.
 */
async function runQualityJudge(
  feature: LlmFeatureKey,
  config: AkmConfig,
  prompt: string,
  keys: readonly string[],
  chat: QualityJudgeChat | undefined,
  options: QualityJudgeOptions,
): Promise<QualityJudgeResult> {
  const resolved =
    !options.runnerSelectionFrozen && !options.llmRunner
      ? resolveImproveLlmExecution({ config, processName: `${feature}-judge` })
      : null;
  if (resolved) options.onNotices?.(resolved.notices);
  const runner = options.llmRunner ?? resolved?.runner;
  if (!runner) return { pass: false, score: -1, reason: "no LLM configured — cannot judge, failing closed" };
  const outcome = await callStage({
    feature,
    runner,
    system: "Return only valid JSON. No prose.",
    prompt,
    request: {
      enableThinking: false,
      temperature: 0,
      responseSchema: judgeResponseSchema(keys),
      ...(Object.hasOwn(options, "timeoutMs") ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(chat ? { chat } : {}),
    },
    ...(options.onNotices ? { onNotices: options.onNotices } : {}),
  });
  if (!outcome.ok) {
    return { pass: false, score: -1, reason: "judge timeout/error — routed to review", reviewNeeded: true };
  }
  const parsed = parseJudgeResponse(outcome.raw, keys);
  if (!parsed) return { pass: false, score: -1, reason: "judge parse failed — routed to review", reviewNeeded: true };
  const { score, reason, criteria } = parsed;
  const verdict = score >= 3.5 ? { pass: true } : score >= 2.5 ? { pass: false, reviewNeeded: true } : { pass: false };
  return { ...verdict, score, reason, ...(criteria ? { criteria } : {}) };
}

/** Judge a proposed lesson (or knowledge promotion) against its source. */
export function runLessonQualityJudge(
  config: AkmConfig,
  lessonContent: string,
  sourceContent: string,
  chat: QualityJudgeChat | undefined,
  options: QualityJudgeOptions = {},
): Promise<QualityJudgeResult> {
  const prompt = buildJudgePrompt(lessonContent, sourceContent, options.similarLessons);
  return runQualityJudge("lesson_quality_gate", config, prompt, LESSON_JUDGE_CRITERIA, chat, options);
}

/** Judge an in-place reflect revision without new-lesson novelty criteria. */
export function runReflectQualityJudge(
  config: AkmConfig,
  candidateContent: string,
  sourceContent: string,
  feedback: string[],
  chat: QualityJudgeChat | undefined,
  options: QualityJudgeOptions = {},
): Promise<QualityJudgeResult> {
  const prompt = buildReflectJudgePrompt(candidateContent, sourceContent, feedback);
  return runQualityJudge("proposal_quality_gate", config, prompt, REFLECT_JUDGE_CRITERIA, chat, options);
}
