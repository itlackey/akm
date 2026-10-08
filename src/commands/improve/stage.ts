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
  related?: Array<{ ref: string; content: string }>;
  /** Distill: the feedback lines the writer was given. */
  feedback?: string[];
  /** Reflect: the ref of the asset the candidate revises, for a judge on an agent engine to read. */
  ref?: string;
  /** The exact runner selected for this judge. */
  llmRunner?: RunnerSpec;
  /** The caller already froze judge selection: no runner means fail closed, never re-resolve. */
  runnerSelectionFrozen?: true;
  timeoutMs?: number | null;
  signal?: AbortSignal;
  onNotices?: NoticeSink;
}

/** Lesson judge prompt: what the writer was given (the source and its feedback), the assets nearest the new lesson, the lesson. */
export function buildJudgePrompt(
  lessonContent: string,
  sourceContent: string,
  related?: Array<{ ref: string; content: string }>,
  feedback?: string[],
): string {
  const lines = [
    "You are evaluating a lesson an agent wrote from a memory and the feedback about it, for an akm knowledge base.",
    "",
    "Score this lesson on each criterion from 1 (poor) to 5 (excellent):",
    "1. REUSABLE: Does the lesson state a rule an agent can use on another occasion, with the reason it holds? Score 1-2 when it only records what was done, shipped, decided, found or is pending, on a date or for one build, machine or project, or how a system is set up now, however it is phrased. Score 4-5 for a rule with its reason.",
    '2. NON-REDUNDANCY: Compare the lesson only with the assets listed under "Existing assets nearest the new lesson" (each starts with "Existing asset ref:"); never with the source memory. When that list is absent, score 5. Score 1-2 when a listed asset already states the same rule, or states most of what the lesson says in broader words. Score 4-5 when the lesson gives a rule none of the listed assets gives, or when they are on other subjects.',
    "3. GROUNDING: Is every statement in the lesson stated by the source or its feedback, in any words? Check each cause, step, number, rule and limit in the lesson against them. Score 4-5 when each is stated. Score 3 when one stretches what the source says. Score 1-2 when any is in neither, when the lesson drops a limit the source states (one place checked, not confirmed, a guess) and says more than it, or when it is about another subject than the source.",
    "",
    "Source memory:",
    "```",
    // The window distill generates from (buildDistillPrompt): grounding can reject, so the judge reads all of it.
    sourceContent.slice(0, 3000),
    "```",
  ];
  if (feedback && feedback.length > 0) {
    lines.push(
      "",
      "Feedback recorded about the memory (the writer saw it too):",
      "```",
      feedback.join("\n").slice(0, 1500),
      "```",
    );
  }
  if (related && related.length > 0) {
    lines.push("", "Existing assets nearest the new lesson (they may be on another subject):");
    for (const asset of related)
      lines.push(`\nExisting asset ref: ${asset.ref}`, "```", asset.content.slice(0, 600), "```");
  }
  lines.push(
    "",
    "Proposed lesson:",
    "```",
    lessonContent.slice(0, 2000),
    "```",
    "",
    'Return ONLY valid JSON, no prose: {"scores": {"reusable": <1-5 integer>, "nonRedundancy": <1-5 integer>, "grounding": <1-5 integer>}, "reason": "<one sentence naming the weakest criterion>"}',
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

/**
 * What the judge may do with tools when it runs on an agent engine: verify a
 * fact the revision adds or alters, and nothing else. The plain judge's prompt
 * is unchanged (its rubric is tuned and measured without this paragraph).
 */
function reflectJudgeToolRules(ref: string | undefined): string {
  const asset = ref ? `The asset is \`${ref}\`: read it with akm_show, ` : "Read an asset with akm_show ";
  return `Tools: ${asset}or an asset the changed region names, only to verify a fact the revision adds or alters; the text above already shows every change. Do not search, do not read anything else, and do not use a tool to judge structure or wording. One or two reads at most. Before scoring, check two lists: (1) every statement the revision adds: find each in the asset, or as a fact the feedback states about the subject, and score QUALITY 1-2 if any is in neither; a statement is found only when the asset or the feedback says it, in any words: a new step, cause, consequence or detail that merely seems to follow is not found; feedback says what to fix and is not content, so an added statement about how the asset was used, found or verified is unsupported; (2) every fact, caveat and field of the source: find each in the revision, and score PRESERVATION 1-3 if any is missing. A read that finds nothing wrong raises no score above what these lists support. Then reply with the JSON.`;
}

/**
 * The reflect judge's rubric, for the frontmatter-only revisions reflect makes, and the paragraph that says what
 * drove the revision: negative feedback (any `[negative]` line) or maintenance. Tuned on the production model
 * against 113 reviewed proposals (the stash's eval/judge-gate/tuning/reflect/judge-fm, rubric f07).
 */
const REFLECT_JUDGE_INTRO =
  "You are evaluating a proposed revision of an existing akm asset's frontmatter. The revision may change only the `description`, the `when_to_use` and the title (a level-1 heading added when the body has none); the body is unchanged.";
const REFLECT_JUDGE_NEGATIVE =
  "This revision answers negative feedback. It cannot change the body, so it need not resolve the feedback: judge only the fields it changes, and never fault it for a field it leaves as it was. Most negative feedback says the asset did not help with a task it was retrieved for: a retrieval miss, not a defect. It justifies changing a field only when the field claims more than the body covers (narrow it to what the body covers), or when the feedback calls the asset stale, outdated, superseded or historical (a new `when_to_use` must then name the version or date the body records). Feedback about a task the asset never claims to cover justifies no change. Repairing a missing or broken field is always needed, whatever the feedback says.";
const REFLECT_JUDGE_MAINTENANCE =
  "This revision is maintenance: there is no negative feedback. Only a missing or broken field needs a change; rewording a sound `description` or `when_to_use` is churn, however accurate.";

/** Judge prompt for an in-place revision. `tools` is set when the judge runs on an agent engine. */
export function buildReflectJudgePrompt(
  candidateContent: string,
  sourceContent: string,
  feedback: string[],
  tools?: { ref?: string },
): string {
  return [
    REFLECT_JUDGE_INTRO,
    "",
    feedback.some((line) => line.startsWith("[negative]")) ? REFLECT_JUDGE_NEGATIVE : REFLECT_JUDGE_MAINTENANCE,
    "",
    "Score this revision on each criterion from 1 (poor) to 5 (excellent):",
    "1. NEED: Does every changed field fix a real problem? Real problems: a missing `description`, `when_to_use` or title; a broken description (a sentence split by a stray period at a line wrap, an escaped or unbalanced quote, a truncated ending, a heading fragment); and, for a revision answering negative feedback, a field that claims more than the body covers, or a stale note's `when_to_use` that does not name the version or date the body records. Replacing a stray period that splits a sentence with a comma, a word or nothing repairs a broken description, however small the change looks. Score 4-5 when every changed field fixes one. Score 1-2 when any changed field rewrites a sound field. Score NEED on the changed fields alone: leaving negative feedback about the body unresolved never lowers it.",
    "2. PRESERVATION: Does the new description keep every fact the old one carried: names, identifiers, numbers, versions, paths, qualifiers and status words such as 'Proposal' or 'draft'? Are all other frontmatter fields unchanged? Score 1-3 when anything is dropped or changed.",
    "3. QUALITY: Is every new value supported by the body, without inventing, over-claiming or misdescribing? Check each new value as a claim against the body; restating the body in other words is supported. Score only values the revision adds or changes: a field it leaves as it was, however stale, is never this revision's fault. Score 1-2 when a new value says something the body does not support or the opposite of what it says, keeps a truncated or garbled fragment, or offers a dated or historical note for current work: when the feedback calls the note stale, outdated, superseded or historical, or the body records the version or date it was true for, a new `when_to_use` that does not name that version or date, or a new value that calls a dated snapshot 'current', scores 1-2.",
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
    ...(tools ? [reflectJudgeToolRules(tools.ref), ""] : []),
    'Return ONLY valid JSON, no prose: {"scores": {"need": <1-5 integer>, "preservation": <1-5 integer>, "quality": <1-5 integer>}, "reason": "<one sentence>"}',
  ].join("\n");
}

/**
 * `grounding` is scored with the other lesson criteria but left out of their
 * mean. A lesson criterion scored {@link LESSON_REJECT_MAX_SCORE} or less is a
 * rejection whatever the mean says: the mean would hide it (4 and 1 average
 * 2.5, a review), and a reviewer was reading every lesson that was not rejected,
 * 17 of 19 of them bad on 2026-10-05. The rubric reserves 1-2 for a lesson that
 * records what was done instead of a rule, repeats an asset the library holds,
 * or states what neither its source nor its feedback does. The judge is shown
 * the feedback the writer saw, so a statement it supports is not an invention. A
 * contradiction of the source is the optional fidelity check's to send to a
 * human (`judgeAndQueue` in distill.ts).
 */
const GROUNDING_CRITERION = "grounding";
const LESSON_REJECT_MAX_SCORE = 2;

const LESSON_JUDGE_CRITERIA = ["reusable", "nonRedundancy", GROUNDING_CRITERION] as const;
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

export function judgeResponseSchema(keys: readonly string[]): Record<string, unknown> {
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
 * lesson criterion (`grounding` included) of {@link LESSON_REJECT_MAX_SCORE}
 * or less rejects whatever the mean is.
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
  // A lesson criterion at 2 or below is a defect the mean would hide (4 and 1 average 2.5, a review): it rejects.
  if (criteria && criteria[GROUNDING_CRITERION] !== undefined) {
    const [weakest, low] = Object.entries(criteria).sort((x, y) => x[1] - y[1])[0] as [string, number];
    if (low <= LESSON_REJECT_MAX_SCORE)
      return { pass: false, score, reason: `${weakest} ${low}/5: ${reason}`, criteria };
  }
  const verdict = lowest >= 4 ? { pass: true } : score >= 2.5 ? { pass: false, reviewNeeded: true } : { pass: false };
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
  const prompt = buildJudgePrompt(lessonContent, sourceContent, options.related, options.feedback);
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
  // A judge on an agent engine gets the tool rules; the runner is the frozen one or none.
  const tools = options.llmRunner && options.llmRunner.kind !== "llm" ? { ref: options.ref } : undefined;
  const prompt = buildReflectJudgePrompt(candidateContent, sourceContent, feedback, tools);
  return runQualityJudge("proposal_quality_gate", config, prompt, REFLECT_JUDGE_CRITERIA, chat, options);
}
