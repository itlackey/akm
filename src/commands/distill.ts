/**
 * `akm distill <ref>` — feedback distillation into lesson proposals (#228).
 *
 * The command reads a target asset and any recent feedback events about it,
 * asks an LLM to distil a *lesson* (per v1 spec §13) the agent should
 * remember next time, and queues the result as a {@link Proposal} (source
 * `"distill"`). The proposal queue is the *only* path to a live asset — this
 * command never mutates source files directly. Acceptance is a human (or
 * automated) decision via `akm proposal accept`.
 *
 * # Architectural seams
 *
 *   - **Single bounded in-tree LLM call.** Wrapped in {@link tryLlmFeature}
 *     under the `feedback_distillation` gate (v1 spec §14). The wrapper
 *     enforces the 30 s hard timeout and converts disable / throw / timeout
 *     into a `null` return from `fn`, which we treat as a graceful
 *     "skipped" outcome (exit 0, no proposal, `distill_invoked` event with
 *     `outcome: "skipped"`).
 *   - **Stateless.** No module-level state — every callable is a pure
 *     function of its arguments and an injectable `chat` seam. The
 *     architecture seam test (`tests/architecture/llm-stateless-seam.test.ts`)
 *     applies.
 *   - **Output substrate.** Proposal creation goes through the `proposals`
 *     module so distill shares its persistence + validation pipeline with
 *     `akm reflect` / `akm propose`. Validation failures (LLM returned a
 *     lesson without required `description` / `when_to_use` frontmatter) are
 *     a *different* graceful path: no proposal is created, the structured
 *     error is surfaced, and the command exits non-zero.
 *
 * # Lesson-name derivation rule
 *
 * The proposed lesson ref is `lesson:<original-ref-slug>-lesson`, where
 * `<original-ref-slug>` is `<type>-<name>` from the parsed input ref (so
 * `skill:deploy` → `lesson:skill-deploy-lesson`, and `team//memory:auth-tips`
 * → `lesson:memory-auth-tips-lesson`). Origin prefixes are dropped from the
 * derived name so two sources with the same asset-type/name collapse onto
 * the same lesson queue entry rather than each generating its own — the
 * proposal queue tolerates duplicate refs (id is a UUID), so the human
 * reviewer can decide which one to accept.
 *
 * # Why we do not call `runAgent`
 *
 * Distillation is in-tree per the v1 spec ("bounded in-tree LLM call"). The
 * agent dispatch path is a heavier shell-out used by the curator/agent
 * surfaces — distill must be cheap, deterministic-ish, and bounded so it can
 * be invoked from CI / automation without spinning up an agent harness.
 */

import fs from "node:fs";
import path from "node:path";
import { parseAssetRef } from "../core/asset-ref";
import { resolveStashDir, timestampForFilename } from "../core/common";
import type { AkmConfig, LlmConnectionConfig } from "../core/config";
import { loadConfig } from "../core/config";
import { ConfigError, UsageError } from "../core/errors";
import { appendEvent, readEvents } from "../core/events";
import { parseFrontmatter } from "../core/frontmatter";
import { lintLessonContent } from "../core/lesson-lint";
import { stripMarkdownFences } from "../core/markdown";
import { createProposal, type Proposal, type ProposalsContext } from "../core/proposals";
import { warnVerbose } from "../core/warn";
import { resolveAssetPath } from "../indexer/path-resolver";
import { type ChatMessage, chatCompletion, parseEmbeddedJsonResponse } from "../llm/client";
import { isLlmFeatureEnabled, tryLlmFeature } from "../llm/feature-gate";
import { assessMemoryKnowledgePromotionCandidate, deriveKnowledgeRef } from "./distill-promotion-policy";

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * Outcome reported on every `distill` invocation. Mirrors the metadata stored
 * on the corresponding `distill_invoked` event so observers can read either
 * the command result or the events stream and see the same picture.
 *
 *   - `queued`           — LLM returned valid lesson content; proposal created.
 *   - `skipped`          — Feature gate disabled OR LLM call failed/timed out.
 *                          No proposal. Exit 0.
 *   - `validation_failed`— LLM returned content but it failed lesson lint.
 *                          No proposal. Exit non-zero (UsageError).
 */
export type DistillOutcome = "queued" | "skipped" | "validation_failed" | "quality_rejected";

export interface AkmDistillOptions {
  /** Asset ref to distil from (`[origin//]type:name`). */
  ref: string;
  /**
   * Proposal target mode. `lesson` preserves the legacy behaviour.
   * `auto` lets memory refs graduate into knowledge proposals when a
   * deterministic stability heuristic says they are reinforced enough.
   */
  proposalKind?: "lesson" | "knowledge" | "auto";
  /** Override the resolved stash root (test seam). */
  stashDir?: string;
  /** Override the loaded config (test seam). */
  config?: AkmConfig;
  /**
   * Optional chat seam for tests. Defaults to {@link chatCompletion}.
   * Stateless — no module-level fallback, callers always pass a function.
   */
  chat?: (config: LlmConnectionConfig, messages: ChatMessage[]) => Promise<string>;
  /** Override the proposals clock / id generator (test seam). */
  ctx?: ProposalsContext;
  /**
   * Test seam — read events through this function instead of the global
   * events.jsonl. Defaults to {@link readEvents}.
   */
  readEventsFn?: typeof readEvents;
  /**
   * Test seam — look up the asset by ref. Defaults to the indexer's
   * `lookup`. The function returns the absolute file path, or `null` when
   * no entry is indexed yet (the LLM is still asked to distil from
   * available signal in that case).
   */
  lookupFn?: (ref: string) => Promise<string | null>;
  /** Optional source-run identifier propagated onto the queued proposal. */
  sourceRun?: string;
  /**
   * Asset refs whose feedback events MUST be filtered out before the LLM
   * sees them (#267). Each event whose `ref` matches an entry in this list
   * is dropped from the prompt; the underlying events.jsonl is untouched.
   *
   * Used by `bench evolve` to keep eval-slice gold refs out of distillation
   * input — replacing the previous "hard skip" behaviour with surgical
   * filtering that still lets distill run on tasks where the target ref is
   * unrelated to the evaluator's gold refs.
   *
   * Each entry MUST be a valid `[origin//]type:name` ref; the CLI validates
   * before plumbing here.
   */
  excludeFeedbackFromRefs?: readonly string[];
  /**
   * Exclude feedback events whose metadata.tags contain any of these tags.
   */
  excludeTags?: string[];
  /**
   * Only include feedback events whose metadata.tags contain ALL of these tags.
   */
  includeTags?: string[];
}

export interface AkmDistillResult {
  schemaVersion: 1;
  ok: boolean;
  outcome: DistillOutcome;
  /** Original input ref (verbatim). */
  inputRef: string;
  /**
   * Historical field name kept for compatibility. Carries the queued proposal
   * ref, which may now be a `knowledge:` ref when memory promotion fires.
   */
  lessonRef: string;
  /** Explicit queued proposal ref. Mirrors `lessonRef`. */
  proposalRef?: string;
  /** Type of proposal the invocation targeted or queued. */
  proposalKind?: "lesson" | "knowledge";
  /** Proposal id when `outcome === "queued"`. */
  proposalId?: string;
  /** Human-readable hint surfaced when the call was skipped. */
  message?: string;
  /** Validation findings when `outcome === "validation_failed"`. */
  findings?: { kind: string; field: string; message: string }[];
  /** The full proposal object when `outcome === "queued"`. */
  proposal?: Proposal;
  /**
   * Diagnostic — number of feedback events filtered out by
   * `excludeFeedbackFromRefs` (#267). Always present when the option was
   * supplied, even when the count is 0. Callers (e.g. `bench evolve`) use
   * this to surface filter-applied notes in their `warnings[]`.
   */
  filteredFeedbackCount?: number;
  /**
   * True when `excludeFeedbackFromRefs` reduced the feedback set to empty
   * AND there were originally events for the target ref. Lets callers
   * distinguish "no feedback was ever recorded" from "we suppressed all
   * recorded feedback" — the LLM-input contract is identical (no feedback
   * shown) but the operator-visible meaning differs.
   */
  feedbackFullyFiltered?: boolean;
  /**
   * Judge score (1–5 float) when `outcome === "quality_rejected"`.
   * Also present as -1 when the judge failed/timed out and fell back to pass-through.
   */
  score?: number;
  /**
   * One-sentence reason from the LLM judge when `outcome === "quality_rejected"`.
   */
  reason?: string;
}

// ── Lesson-ref derivation ───────────────────────────────────────────────────

/** Derive the proposed lesson ref from the input ref. See module docblock. */
export function deriveLessonRef(inputRef: string): string {
  const parsed = parseAssetRef(inputRef);
  // Strip origin: a feedback signal recorded against `team//skill:deploy`
  // distils into the same lesson namespace as `skill:deploy`. The proposal
  // id (a UUID) keeps the queue entries distinct, so collisions are not a
  // problem — and reviewers want to see them next to each other anyway.
  const slug = `${parsed.type}-${parsed.name}`.toLowerCase();
  // Replace anything outside the canonical asset-name charset with `-`. Keep
  // it deterministic so re-runs produce the same ref.
  const safe = slug
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `lesson:${safe}-lesson`;
}

interface DistillValidationFinding {
  kind: string;
  field: string;
  message: string;
}

// ── Prompt assembly ─────────────────────────────────────────────────────────

const LESSON_SYSTEM_PROMPT = [
  "You are the akm `distill` distiller.",
  "Given an asset and recent feedback events about it, produce a single",
  "concise *lesson* an agent should remember next time it works on this",
  "asset's domain.",
  "",
  "Output MUST be a complete markdown file with YAML frontmatter:",
  "  ---",
  "  description: <one-line summary of what the lesson teaches>",
  "  when_to_use: <one-line trigger that should make a caller apply it>",
  "  ---",
  "",
  "  <lesson body, plain markdown, 1–3 short paragraphs>",
  "",
  "Both `description` and `when_to_use` MUST be non-empty single-line strings.",
  "Output ONLY the lesson file contents — no prose, no fences, no preamble.",
].join("\n");

const KNOWLEDGE_SYSTEM_PROMPT = [
  "You are the akm `distill` distiller.",
  "Given an asset and recent feedback events about it, produce a concise",
  "*knowledge* markdown document capturing the durable, reusable facts.",
  "Prefer stable guidance over narrative recap.",
  "If you include YAML frontmatter, keep it compatible with normal knowledge",
  "assets (for example `description`, `tags`, `sources`, `observed_at`).",
  "Include a meaningful markdown body.",
  "Output ONLY the knowledge file contents — no prose, no fences, no preamble.",
].join("\n");

function validateKnowledgeContent(content: string, inputRef: string): DistillValidationFinding[] {
  const parsed = parseFrontmatter(content);
  if (parsed.content.trim().length > 0) return [];
  return [
    {
      kind: "missing-body",
      field: "body",
      message: `Distilled knowledge for ${inputRef} must include a non-empty markdown body.`,
    },
  ];
}

interface BuildPromptInput {
  inputRef: string;
  assetContent: string | null;
  feedback: { ts: string; eventType: string; metadata?: Record<string, unknown> }[];
  proposalKind?: "lesson" | "knowledge";
}

/** Pure: build the user-prompt body. Exported for tests. */
export function buildDistillPrompt(input: BuildPromptInput): string {
  const lines: string[] = [];
  lines.push(`Asset ref: ${input.inputRef}`);
  lines.push("");
  lines.push("Asset content:");
  if (input.assetContent) {
    const body = input.assetContent.trim().slice(0, 3000);
    lines.push("```");
    lines.push(body);
    lines.push("```");
  } else {
    lines.push("(asset is not currently indexed; distil from feedback signal alone)");
  }
  lines.push("");
  lines.push("Recent feedback events (most recent last):");
  if (input.feedback.length === 0) {
    lines.push("(no feedback events recorded — distil from the asset itself)");
  } else {
    for (const event of input.feedback) {
      const meta = event.metadata ? ` ${JSON.stringify(event.metadata)}` : "";
      lines.push(`- ${event.ts} ${event.eventType}${meta}`);
    }
  }
  lines.push("");
  lines.push(`Produce the ${input.proposalKind === "knowledge" ? "knowledge" : "lesson"} markdown file now.`);
  return lines.join("\n");
}

// ── LLM-as-judge quality gate (P2-B) ────────────────────────────────────────

function buildJudgePrompt(lessonContent: string, sourceContent: string): string {
  return [
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
    "",
    "Proposed lesson content:",
    "```",
    lessonContent.slice(0, 1000),
    "```",
    "",
    'Return ONLY valid JSON, no prose: {"score": <average score 1-5 as float>, "reason": "<one sentence>"}',
  ].join("\n");
}

async function runLessonQualityJudge(
  config: AkmConfig,
  lessonContent: string,
  sourceContent: string,
  chat: (llmConfig: LlmConnectionConfig, messages: ChatMessage[]) => Promise<string>,
): Promise<{ pass: boolean; score: number; reason: string }> {
  if (!config.llm) {
    return { pass: true, score: -1, reason: "no LLM configured — passing through" };
  }
  const judgeLlmConfig = config.llm.judgeModel ? { ...config.llm, model: config.llm.judgeModel } : config.llm;
  const JUDGE_TIMEOUT_MS = 8_000;
  try {
    const raw = await Promise.race([
      chat(judgeLlmConfig, [
        { role: "system", content: "Return only valid JSON. No prose." },
        { role: "user", content: buildJudgePrompt(lessonContent, sourceContent) },
      ]),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("judge timeout")), JUDGE_TIMEOUT_MS)),
    ]);
    const parsed = parseEmbeddedJsonResponse<{ score: number; reason: string }>(raw);
    if (!parsed || typeof parsed.score !== "number") {
      return { pass: true, score: -1, reason: "judge parse failed — passing through" };
    }
    return { pass: parsed.score >= 3, score: parsed.score, reason: parsed.reason ?? "" };
  } catch {
    return { pass: true, score: -1, reason: "judge failed — passing through" };
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
function writeQualityRejection(
  stash: string,
  inputRef: string,
  lessonRef: string,
  content: string,
  score: number,
  reason: string,
  extraMeta: Record<string, unknown> = {},
): AkmDistillResult {
  const rejectDir = path.join(stash, ".akm", "distill-rejected");
  fs.mkdirSync(rejectDir, { recursive: true });
  const ts = timestampForFilename();
  fs.writeFileSync(
    path.join(rejectDir, `${ts}-${lessonRef}.md`),
    `---\nscore: ${score}\nreason: ${reason}\n---\n\n${content}`,
    "utf8",
  );
  appendEvent({
    eventType: "distill_invoked",
    ref: inputRef,
    metadata: {
      outcome: "quality_rejected",
      lessonRef,
      score,
      reason,
      ...extraMeta,
    },
  });
  return {
    schemaVersion: 1,
    ok: true,
    outcome: "quality_rejected",
    inputRef,
    lessonRef,
    score,
    reason,
    ...extraMeta,
  };
}

// ── Main entry point ────────────────────────────────────────────────────────

/**
 * Run a single bounded distillation pass for `ref`. Always emits exactly one
 * `distill_invoked` event (with `outcome` in the metadata) regardless of the
 * branch taken — so observers can count invocations cheaply.
 */
export async function akmDistill(options: AkmDistillOptions): Promise<AkmDistillResult> {
  const inputRef = options.ref.trim();
  if (!inputRef) {
    throw new UsageError("Asset ref is required. Usage: akm distill <ref>", "MISSING_REQUIRED_ARGUMENT");
  }
  // Validate the ref shape up front so a typo never reaches the LLM.
  parseAssetRef(inputRef);
  const targetKind = options.proposalKind ?? "lesson";

  const config = options.config ?? loadConfig();
  const stash = options.stashDir ?? resolveStashDir();
  const chat = options.chat ?? chatCompletion;
  const lookup = options.lookupFn ?? defaultLookup;
  const readEventsImpl = options.readEventsFn ?? readEvents;

  // Best-effort load: when the asset is not yet indexed we still proceed —
  // the LLM is asked to distil from "available signal" (feedback alone).
  let assetContent: string | null = null;
  try {
    const filePath = await lookup(inputRef);
    if (filePath && fs.existsSync(filePath)) {
      assetContent = fs.readFileSync(filePath, "utf8");
    }
  } catch {
    assetContent = null;
  }

  const { events } = readEventsImpl({
    ref: inputRef,
    type: "feedback",
    excludeTags: options.excludeTags,
    includeTags: options.includeTags,
  });

  // #267 — feedback exclusion. Filter events whose `ref` matches the
  // exclusion list BEFORE the prompt is built. The original event stream
  // is never mutated; only the `feedback` slice that reaches the LLM is
  // affected. The exclusion set is normalised through `parseAssetRef` →
  // re-serialised so callers can pass canonical or origin-prefixed refs
  // and the comparison still works against the event payload's `ref`.
  const exclusionList = options.excludeFeedbackFromRefs ?? [];
  const exclusionSet = new Set(exclusionList.map((ref) => ref.trim()).filter((ref) => ref.length > 0));
  const originalEventCount = events.length;
  const filteredEvents =
    exclusionSet.size > 0 ? events.filter((e) => !(e.ref !== undefined && exclusionSet.has(e.ref))) : events;
  const filteredFeedbackCount = originalEventCount - filteredEvents.length;
  const feedbackFullyFiltered = exclusionSet.size > 0 && originalEventCount > 0 && filteredEvents.length === 0;
  const feedback = filteredEvents.slice(-20).map((e) => ({
    ts: e.ts,
    eventType: e.eventType,
    ...(e.metadata !== undefined ? { metadata: e.metadata } : {}),
  }));

  const promotion =
    targetKind === "lesson"
      ? null
      : assessMemoryKnowledgePromotionCandidate({
          inputRef,
          assetContent,
          feedbackEvents: filteredEvents.map((event) => ({
            ...(event.metadata !== undefined ? { metadata: event.metadata } : {}),
          })),
        });

  if (promotion?.promote && promotion.content && (targetKind === "knowledge" || targetKind === "auto")) {
    // Apply quality gate to fast-path knowledge promotion (Risk 4 fix).
    if (isLlmFeatureEnabled(config, "lesson_quality_gate")) {
      const judgeResult = await runLessonQualityJudge(config, promotion.content, assetContent ?? "", chat);
      if (!judgeResult.pass) {
        return writeQualityRejection(
          stash,
          inputRef,
          promotion.knowledgeRef,
          promotion.content,
          judgeResult.score,
          judgeResult.reason,
        );
      }
    }
    const knowledgeParsed = parseFrontmatter(promotion.content);
    const proposal = createProposal(
      stash,
      {
        ref: promotion.knowledgeRef,
        source: "distill",
        ...(options.sourceRun !== undefined ? { sourceRun: options.sourceRun } : {}),
        payload: {
          content: promotion.content,
          ...(Object.keys(knowledgeParsed.data).length > 0 ? { frontmatter: knowledgeParsed.data } : {}),
        },
      },
      options.ctx,
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
        ...(options.sourceRun !== undefined ? { sourceRun: options.sourceRun } : {}),
        ...(exclusionSet.size > 0 ? { filteredFeedbackCount } : {}),
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
      ...(exclusionSet.size > 0 ? { filteredFeedbackCount, feedbackFullyFiltered } : {}),
    };
  }

  const effectiveProposalKind = targetKind === "knowledge" ? "knowledge" : "lesson";
  const effectiveLessonRef =
    effectiveProposalKind === "knowledge" ? deriveKnowledgeRef(inputRef) : deriveLessonRef(inputRef);

  const userPrompt = buildDistillPrompt({ inputRef, assetContent, feedback, proposalKind: effectiveProposalKind });
  const messages: ChatMessage[] = [
    { role: "system", content: effectiveProposalKind === "knowledge" ? KNOWLEDGE_SYSTEM_PROMPT : LESSON_SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];

  // Single bounded LLM call. The wrapper handles the gate-check, 30 s
  // timeout, and error fallback (returning `null`).
  const raw = await tryLlmFeature(
    "feedback_distillation",
    config,
    async () => {
      if (!config.llm) {
        // No LLM connection configured — treat as gate-disabled. Throwing
        // here lets `tryLlmFeature` route us through the "error" fallback,
        // which is the same graceful skipped path.
        throw new ConfigError(
          "No LLM connection configured. Set `llm.endpoint` and `llm.model` in the akm config.",
          "LLM_NOT_CONFIGURED",
        );
      }
      return chat(config.llm, messages);
    },
    null as string | null,
    {
      onFallback: (evt) => {
        // Log the fallback reason; the caller (raw === null path) handles
        // emitting the distill_invoked event so we don't double-emit here.
        warnVerbose(`[akm] LLM fallback for ${evt.feature}: ${evt.reason}`);
      },
    },
  );

  if (raw === null || raw.trim() === "") {
    appendEvent({
      eventType: "distill_invoked",
      ref: inputRef,
      metadata: {
        outcome: "skipped" as const,
        lessonRef: effectiveLessonRef,
        proposalKind: effectiveProposalKind,
        ...(exclusionSet.size > 0 ? { filteredFeedbackCount } : {}),
      },
    });
    return {
      schemaVersion: 1,
      ok: true,
      outcome: "skipped",
      inputRef,
      lessonRef: effectiveLessonRef,
      proposalRef: effectiveLessonRef,
      proposalKind: effectiveProposalKind,
      message: "feedback distillation is disabled or the LLM call failed; no proposal created.",
      ...(exclusionSet.size > 0 ? { filteredFeedbackCount, feedbackFullyFiltered } : {}),
    };
  }

  // Strip any stray fence the LLM might have added around the markdown.
  const content = stripMarkdownFences(raw);

  // Parse + lint the lesson before creating the proposal. The lint is the
  // canonical gate for required frontmatter (v1 spec §13). On failure we
  // surface a structured error and exit non-zero — but still emit
  // `distill_invoked` so the failure is observable.
  const findings =
    effectiveProposalKind === "knowledge"
      ? validateKnowledgeContent(content, inputRef)
      : lintLessonContent(content, `distill:${inputRef}`).findings;
  if (findings.length > 0) {
    appendEvent({
      eventType: "distill_invoked",
      ref: inputRef,
      metadata: {
        outcome: "validation_failed" as const,
        lessonRef: effectiveLessonRef,
        proposalKind: effectiveProposalKind,
        findingKinds: findings.map((f) => f.kind),
        ...(exclusionSet.size > 0 ? { filteredFeedbackCount } : {}),
      },
    });
    const message = findings.map((f) => f.message).join("\n");
    throw new UsageError(
      `Distilled ${effectiveProposalKind} failed validation:\n${message}`,
      "MISSING_REQUIRED_ARGUMENT",
      effectiveProposalKind === "knowledge"
        ? "Knowledge proposals require a non-empty markdown body."
        : "Lessons require non-empty `description` and `when_to_use` frontmatter fields. See v1 spec §13.",
    );
  }

  // LLM-as-judge quality gate (P2-B). Only active when the feature flag is
  // explicitly enabled. Fail-open: judge failures always pass through.
  if (isLlmFeatureEnabled(config, "lesson_quality_gate")) {
    const judgeResult = await runLessonQualityJudge(config, content, assetContent ?? "", chat);
    if (!judgeResult.pass) {
      return writeQualityRejection(
        stash,
        inputRef,
        effectiveLessonRef,
        content,
        judgeResult.score,
        judgeResult.reason,
        exclusionSet.size > 0 ? { filteredFeedbackCount, feedbackFullyFiltered } : {},
      );
    }
  }

  // Round-trip the parsed frontmatter so the proposal carries it as a
  // structured payload alongside the raw content (matches the shape used by
  // other proposal sources).
  const parsed = parseFrontmatter(content);
  const proposal = createProposal(
    stash,
    {
      ref: effectiveLessonRef,
      source: "distill",
      ...(options.sourceRun !== undefined ? { sourceRun: options.sourceRun } : {}),
      payload: {
        content,
        ...(Object.keys(parsed.data).length > 0 ? { frontmatter: parsed.data } : {}),
      },
    },
    options.ctx,
  );

  appendEvent({
    eventType: "distill_invoked",
    ref: inputRef,
    metadata: {
      outcome: "queued" as const,
      lessonRef: effectiveLessonRef,
      proposalRef: effectiveLessonRef,
      proposalKind: effectiveProposalKind,
      proposalId: proposal.id,
      ...(options.sourceRun !== undefined ? { sourceRun: options.sourceRun } : {}),
      ...(exclusionSet.size > 0 ? { filteredFeedbackCount } : {}),
    },
  });

  return {
    schemaVersion: 1,
    ok: true,
    outcome: "queued",
    inputRef,
    lessonRef: effectiveLessonRef,
    proposalRef: effectiveLessonRef,
    proposalKind: effectiveProposalKind,
    proposalId: proposal.id,
    proposal,
    ...(exclusionSet.size > 0 ? { filteredFeedbackCount, feedbackFullyFiltered } : {}),
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function defaultLookup(ref: string): Promise<string | null> {
  return resolveAssetPath(ref, { mode: "index-only" });
}
