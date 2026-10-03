// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The one path every improve stage (reflect, distill, consolidate, extract,
 * triage, memory inference) runs through: pick the stage's runner, call the
 * model, judge what it produced, mint the proposal, and attribute the usage.
 * A stage keeps only its prompt, its parse shape and its target rule.
 */

import type { AkmConfig, ImproveProfileConfig, LlmConnectionConfig } from "../../core/config/config";
import { getImproveProcessConfig } from "../../core/config/config";
import { ConfigError } from "../../core/errors";
import type { EventsContext } from "../../core/events";
import { parseEmbeddedJsonResponse } from "../../core/parse";
import { defaultFeedback } from "../../core/structured";
import { warn } from "../../core/warn";
import type { LoweringNotice } from "../../execution/resolved-request";
import type { UnresolvedExecutionDefaults } from "../../execution/source";
import type { RejectedProposalContext } from "../../integrations/agent/prompts";
import { type RunnerSpec, runnerLlmConnection } from "../../integrations/agent/runner";
import type { AgentRunResult } from "../../integrations/agent/spawn";
import type { ChatCompletionOptions, ChatMessage } from "../../llm/client";
import type { LlmFeatureKey } from "../../llm/feature-gate";
import {
  type CallStructuredRequest,
  callStructured,
  dispatchFailureReason,
  dispatchFailureResult,
} from "../../llm/structured-call";
import { currentLlmStage, withLlmStage } from "../../llm/usage-telemetry";
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
import { resolveImproveExecution } from "./execution";
import type { ImproveProcessName, ResolvedImprovePlan } from "./improve-strategies";

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
 * A stage's runner: the one the improve plan froze for it (an own
 * `llmRunner` key, `null` meaning "none"), else the process engine cascade.
 */
export function stageRunner(
  frozen: { llmRunner?: RunnerSpec | null },
  config: AkmConfig,
  profile: ImproveProfileConfig | undefined,
  processName: ImproveProcessName,
  onNotices?: NoticeSink,
): RunnerSpec | undefined {
  if (Object.hasOwn(frozen, "llmRunner")) return frozen.llmRunner ?? undefined;
  const resolved = resolveImproveExecution({
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
  | {
      ok: false;
      reason: "disabled" | "timeout" | "aborted" | "error";
      error?: string;
      /** The failed dispatch's own result (an agent's exit code and stderr, say), when the call reached a transport. */
      result?: AgentRunResult;
    };

export interface StageLlmCall {
  feature: LlmFeatureKey;
  runner: RunnerSpec;
  prompt: string;
  system?: string;
  /** Earlier turns, sent before the terminal user prompt. */
  history?: ChatMessage[];
  request?: CallStructuredRequest;
  /** The stage's own parser of the reply, `undefined` for one it rejects. Default: any JSON in it is accepted. */
  parse?: (raw: string) => unknown;
  /** Additional exact invocation fields for this call (the child environment of an agent, say). */
  current?: UnresolvedExecutionDefaults;
  onNotices?: NoticeSink;
  /** Gate the call on the feature flag, with the stage's resolved enablement. */
  gate?: { config: AkmConfig; enabled?: boolean };
}

/**
 * One model call. Provider trouble (transport error, timeout, abort, a
 * disabled feature) comes back as `{ ok: false }`; only a configuration
 * failure throws. A reply to a call with `request.responseSchema` that the
 * stage's own `parse` rejects gets one corrective retry; the last reply comes
 * back either way, and the caller parses it again.
 */
export async function callStage(call: StageLlmCall): Promise<StageLlmOutcome> {
  const reply = await callStageOnce(call);
  if (!reply.ok || !call.request?.responseSchema) return reply;
  if ((call.parse ?? parseEmbeddedJsonResponse)(reply.raw) !== undefined) return reply;
  const feedback = defaultFeedback({ reason: "parse_error", errors: [] });
  const retry = await callStageOnce({ ...call, prompt: `${call.prompt}\n\n${feedback}` });
  // A retry that fails in transport keeps the first reply, which the caller may still accept.
  return retry.ok ? retry : reply;
}

/** Timeout and abort come from the dispatch's own reason, whatever the runner's kind. */
function failureReason(err: unknown): "timeout" | "aborted" | "error" {
  const reason = dispatchFailureReason(err);
  return reason === "timeout" || reason === "aborted" ? reason : "error";
}

/** A failed call: its reason and message, and the dispatch's own result when it reached a transport. */
function failedCall(err: unknown): Extract<StageLlmOutcome, { ok: false }> {
  const result = dispatchFailureResult(err);
  return { ok: false, reason: failureReason(err), error: errMessage(err), ...(result ? { result } : {}) };
}

/**
 * One dispatch with no validation, for a caller that parses and repairs the
 * reply itself (reflect's repair turn, extract's own structured loop).
 */
export async function callStageOnce(call: StageLlmCall): Promise<StageLlmOutcome> {
  const messages: ChatMessage[] = [
    ...(call.system ? [{ role: "system" as const, content: call.system }] : []),
    ...(call.history ?? []),
    { role: "user", content: call.prompt },
  ];
  let failure: Extract<StageLlmOutcome, { ok: false }> | undefined;
  try {
    const dispatch = () =>
      callStructured<string | undefined>({
        feature: call.feature,
        ...(call.gate
          ? { akmConfig: call.gate.config, ...(call.gate.enabled !== undefined ? { enabled: call.gate.enabled } : {}) }
          : {}),
        runner: call.runner,
        messages,
        ...(call.request ? { request: call.request } : {}),
        ...(call.current ? { current: call.current } : {}),
        ...(call.onNotices ? { onNotices: call.onNotices } : {}),
        parse: (r) => r ?? "",
        onError: (_cls, err) => {
          failure = failedCall(err);
          return undefined;
        },
        fallback: undefined,
        onFallback: (event) => {
          failure ??= { ok: false, reason: event.reason, ...(event.error ? { error: event.error.message } : {}) };
        },
      });
    // Usage is credited to the engine that serves the call, which for a gate's own judge
    // (#1011) is not the stage's planned engine.
    const stage = currentLlmStage();
    const raw = await (stage === undefined
      ? dispatch()
      : withLlmStage(stage, dispatch, { engine: call.runner.engine }));
    return raw === undefined ? (failure ?? { ok: false, reason: "error" }) : { ok: true, raw };
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    return failedCall(err);
  }
}

/** Attribute a stage's LLM calls to its process and planned engine (the usage report). */
const STAGE_LABELS = {
  reflect: "reflect",
  distill: "distill",
  consolidate: "consolidate",
  extract: "session-extraction",
  memoryInference: "memory-inference",
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
 * content and are left out. Reads never create state.db, and an improve run's
 * live connection (`eventsCtx.db`) is read through, not copied.
 */
export function rejectedProposalContext(
  stash: string,
  ref: string | undefined,
  ctx?: ProposalsContext,
  eventsCtx?: EventsContext,
): RejectedProposalContext[] {
  if (!ref) return [];
  const proposalsCtx = eventsCtx?.db ? { ...ctx, db: eventsCtx.db } : ctx;
  return listProposalsReadOnly(stash, { ref, status: "rejected", includeArchive: true }, proposalsCtx)
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
 * Create a stage's proposal. `judged` (the passing verdict) stamps a `staged`
 * gate decision with the judged content's hash and the judge's scores and reason
 * (the triage drain accepts it while the content still matches); `review`
 * leaves it `deferred` for a human (`review_needed` in the improve ledger).
 */
export function mintProposal(
  stash: string,
  proposalsCtx: ProposalsContext | undefined,
  input: CreateProposalInput,
  verdict: {
    judged?: Pick<QualityJudgeResult, "criteria" | "reason">;
    review?: Omit<ProposalGateDecision, "outcome" | "decidedAt">;
  } = {},
): Proposal {
  const proposal = createProposal(stash, input, proposalsCtx);
  if (verdict.review) {
    return recordGateDecision(stash, proposal.id, { outcome: "deferred", ...verdict.review }, proposalsCtx) ?? proposal;
  }
  return verdict.judged ? stageJudgedProposal(stash, proposal, verdict.judged, proposalsCtx) : proposal;
}

/**
 * Stamp a proposal the quality judge passed. Best-effort: a failed stamp only
 * means the triage drain judges it again.
 */
export function stageJudgedProposal(
  stash: string,
  proposal: Proposal,
  judged?: Pick<QualityJudgeResult, "criteria" | "reason">,
  proposalsCtx?: ProposalsContext,
): Proposal {
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
          ...(judged?.criteria ? { scores: judged.criteria } : {}),
          ...(judged ? { judgeReason: judged.reason } : {}),
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

/**
 * The judge a quality gate names for itself (#1011): the gate's `engine`,
 * `model`, `timeoutMs` and `llm` over the process's own settings, as
 * `processes.triage.judgment` resolves over triage. `undefined` when the gate
 * is off or sets none of them, so the caller keeps its own judge. The engine
 * may be of any kind; config validation has required one that confines the
 * model-work tool policy. Throws when they resolve to no engine at all,
 * before anything is generated: the gate never falls back to another judge.
 */
export function resolveQualityGateJudge(
  config: AkmConfig,
  profile: ImproveProfileConfig | undefined,
  processName: "reflect" | "distill",
  onNotices?: NoticeSink,
): RunnerSpec | undefined {
  const process = profile?.processes?.[processName];
  const gate = process?.qualityGate;
  if (!gate || gate.enabled === false) return undefined;
  if (!["engine", "model", "timeoutMs", "llm"].some((key) => Object.hasOwn(gate, key))) return undefined;
  const resolved = resolveImproveExecution({
    config,
    processName: `${processName}-quality-judge`,
    ...(profile ? { profile } : {}),
    ...(process ? { process } : {}),
    current: gate,
  });
  if (!resolved) {
    throw new ConfigError(
      `The ${processName} quality gate's judge has no engine. Set processes.${processName}.qualityGate.engine.`,
      "INVALID_CONFIG_FILE",
    );
  }
  onNotices?.(resolved.notices);
  return resolved.runner;
}

export interface QualityJudgeOptions {
  similarLessons?: Array<{ ref: string; content: string }>;
  /** The exact runner selected for this judge. */
  llmRunner?: RunnerSpec;
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
    "3. GROUNDING: Is the lesson about what the source asset is about? Score 1-2 only if it is about a different subject than the source; 3 if it is on the source's subject but goes beyond or corrects what the source says (it may draw on feedback you are not shown); 4-5 if the source supports it. A lesson may generalize the source's point.",
    "",
    "Source asset content:",
    "```",
    // The window distill generates from (buildDistillPrompt): grounding can reject, so the judge reads all of it.
    sourceContent.slice(0, 3000),
    "```",
  ];
  if (similarLessons && similarLessons.length > 0) {
    lines.push(
      "",
      "Existing similar lessons (top-3 by similarity). Rate NOVELTY and NON-REDUNDANCY lower if the proposed lesson is substantially similar to any of these:",
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
    'Return ONLY valid JSON, no prose: {"scores": {"novelty": <1-5 integer>, "nonRedundancy": <1-5 integer>, "grounding": <1-5 integer>}, "reason": "<one sentence>"}',
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

/** Judge prompt for an in-place revision. */
export function buildReflectJudgePrompt(candidateContent: string, sourceContent: string, feedback: string[]): string {
  return [
    "You are evaluating a proposed revision to an existing akm asset.",
    "",
    "Score this revision on each criterion from 1 (poor) to 5 (excellent):",
    "1. NEED: Does the revision fix a concrete problem in the source? Concrete problems are: something the feedback reports as wrong or missing; a factual error; or broken, garbled, truncated or missing text, including frontmatter fields such as description or when_to_use. Score 4-5 when it fixes one, even a small one. Score 1-2 when the source was already correct and the revision only rewords, restates, reformats, or adds headings, an introduction or a table of contents.",
    "2. PRESERVATION: Does it keep every concrete fact, identifier, command, path, number and example from the source, without truncation?",
    "3. QUALITY: Is it coherent and accurate, with no claims, steps or details that the source or the feedback does not support?",
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
    'Return ONLY valid JSON, no prose: {"scores": {"need": <1-5 integer>, "preservation": <1-5 integer>, "quality": <1-5 integer>}, "reason": "<one sentence>"}',
  ].join("\n");
}

/**
 * `grounding` is scored with the other lesson criteria but left out of their
 * mean: a lesson about a different subject than its source reads as novel and
 * non-redundant, so they would pass it (or, in the review band, mint it as
 * a pending proposal). The rubric reserves 1-2 for a different subject. A score
 * of {@link UNGROUNDED_MAX_SCORE} or less is a rejection whatever the mean says
 * (#999). A higher score up to {@link BORDERLINE_GROUNDING_MAX_SCORE} is only
 * borderline: a lesson on its source's subject that advises beyond it has scored
 * 2, and a score can move a point between runs (see `runQualityJudge`), so it
 * goes to a person unless the mean alone already rejects it. A lesson that goes
 * beyond or corrects its source is on its subject: distill folds feedback into
 * the lesson, and the judge is never shown it. A contradiction of the source is
 * the optional fidelity check's to send to a human (`judgeAndQueue` in
 * distill.ts), so the rubric must not pre-empt it.
 */
const GROUNDING_CRITERION = "grounding";
const UNGROUNDED_MAX_SCORE = 1;
const BORDERLINE_GROUNDING_MAX_SCORE = 2;

const LESSON_JUDGE_CRITERIA = ["novelty", "nonRedundancy", GROUNDING_CRITERION] as const;
const REFLECT_JUDGE_CRITERIA = ["need", "preservation", "quality"] as const;

/**
 * Read a judge response: the per-criterion shape (averaged here, `grounding`
 * aside; `lowest` is the lowest score in that mean) or the older `{"score"}`
 * shape. Only the expected criteria are read; any missing or out-of-range
 * (1..5) value is a parse failure, extra keys are ignored.
 */
function parseJudgeResponse(
  raw: string,
  keys: readonly string[],
): { score: number; lowest: number; reason: string; criteria?: Record<string, number> } | undefined {
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
    const averaged = Object.entries(criteria)
      .filter(([key]) => key !== GROUNDING_CRITERION)
      .map(([, value]) => value);
    return {
      score: averaged.reduce((a, b) => a + b, 0) / averaged.length,
      lowest: Math.min(...averaged),
      reason,
      criteria,
    };
  }
  return inRange(parsed.score) ? { score: parsed.score, lowest: parsed.score, reason } : undefined;
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
 * provider failure never passes content. Bands: every criterion in the mean
 * >= 4 passes, otherwise a mean >= 2.5 is review and a lower one reject; a
 * `grounding` score of {@link UNGROUNDED_MAX_SCORE} or less rejects whatever
 * the mean is, and one of {@link BORDERLINE_GROUNDING_MAX_SCORE} routes a lesson
 * that would pass to review (a mean that rejects stays a rejection).
 * Temperature is set to 0, which reduces run-to-run variation but does not
 * remove it: on some servers (llama.cpp batching, for one) the same request can
 * score a point apart, so the routing rules are chosen with that margin in mind.
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
      ? resolveImproveExecution({ config, processName: `${feature}-judge` })
      : null;
  if (resolved) options.onNotices?.(resolved.notices);
  const runner = options.llmRunner ?? resolved?.runner;
  if (!runner) return { pass: false, score: -1, reason: "no engine configured — cannot judge, failing closed" };
  const outcome = await callStage({
    feature,
    runner,
    system: "Return only valid JSON. No prose.",
    prompt,
    request: {
      // Off unless the judge's own engine enables thinking (a slower, separate judge engine, #1011).
      enableThinking: runnerLlmConnection(runner)?.enableThinking === true,
      temperature: 0,
      responseSchema: judgeResponseSchema(keys),
      ...(Object.hasOwn(options, "timeoutMs") ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(chat ? { chat } : {}),
    },
    parse: (raw) => parseJudgeResponse(raw, keys),
    ...(options.onNotices ? { onNotices: options.onNotices } : {}),
  });
  if (!outcome.ok) {
    return { pass: false, score: -1, reason: "judge timeout/error — routed to review", reviewNeeded: true };
  }
  const parsed = parseJudgeResponse(outcome.raw, keys);
  if (!parsed) return { pass: false, score: -1, reason: "judge parse failed — routed to review", reviewNeeded: true };
  const { score, lowest, reason, criteria } = parsed;
  const grounding = criteria?.[GROUNDING_CRITERION];
  if (criteria && grounding !== undefined && grounding <= UNGROUNDED_MAX_SCORE) {
    return {
      pass: false,
      score,
      reason: `Off-subject for its source (grounding ${grounding}/5): ${reason}`,
      criteria,
    };
  }
  const verdict = lowest >= 4 ? { pass: true } : score >= 2.5 ? { pass: false, reviewNeeded: true } : { pass: false };
  // Borderline grounding is a person's call even when the lesson would pass; a mean that rejects stays rejected.
  if (
    criteria &&
    grounding !== undefined &&
    grounding <= BORDERLINE_GROUNDING_MAX_SCORE &&
    (verdict.pass || verdict.reviewNeeded)
  ) {
    return {
      pass: false,
      reviewNeeded: true,
      score,
      reason: `Borderline on grounding (${grounding}/5), routed to review: ${reason}`,
      criteria,
    };
  }
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
