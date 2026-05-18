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
 *     enforces a hard timeout (default 600s / 10 min — overridable via
 *     `opts.timeoutMs`) and converts disable / throw / timeout
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
import {
  createProposal,
  isProposalSkipped,
  listProposals,
  type Proposal,
  type ProposalsContext,
} from "../core/proposals";
import { warnVerbose } from "../core/warn";
import { resolveAssetPath } from "../indexer/path-resolver";
import { type ChatMessage, chatCompletion, parseEmbeddedJsonResponse } from "../llm/client";
import { isLlmFeatureEnabled, tryLlmFeature } from "../llm/feature-gate";
import { assessMemoryKnowledgePromotionCandidate, deriveKnowledgeRef } from "./distill-promotion-policy";
import { akmSearch } from "./search";

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
/**
 * D-5 / #388: "review_needed" outcome replaces the binary quality-gate cutoff
 * for the uncertainty band (score 2.5–3.5). MT-Bench arXiv:2306.05685 reports
 * ~±0.5 judge variance — 15-25% of borderline proposals flip between runs.
 * The review-needed band converts uncertain cases into explicit human review
 * requests rather than opaque auto-decisions.
 */
export type DistillOutcome = "queued" | "skipped" | "validation_failed" | "quality_rejected" | "review_needed";

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
  /**
   * D-4 / #390: Optional seam to retrieve top-3 similar existing lessons for
   * the judge prompt. When absent in production, `fetchTopSimilarLessons` is
   * used (requires a configured embedding). Voyager arXiv:2305.16291 — skill
   * library admission checks against the existing library.
   */
  fetchSimilarLessonsFn?: (query: string, n: number) => Promise<Array<{ ref: string; content: string }>>;
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
  "YOUR RESPONSE MUST START EXACTLY WITH `---` ON THE VERY FIRST LINE.",
  "DO NOT output any prose, explanation, or code fences before or after.",
  "",
  "Required output format — copy this structure exactly:",
  "---",
  "description: <one-line summary of what the lesson teaches>",
  "when_to_use: <one-line trigger sentence — when should an agent reach for this lesson?>",
  "---",
  "",
  "<lesson body — plain markdown, 1–3 short paragraphs of practical guidance>",
  "",
  "RULES:",
  "- `description` MUST be a non-empty single-line string (no newlines).",
  "- `when_to_use` MUST be a non-empty single-line string (no newlines).",
  "- The lesson body MUST be non-empty.",
  "- Do NOT reproduce the source asset verbatim — distil what a caller needs to know.",
  "- Output ONLY the lesson file. No preamble, no code fences, no trailing prose.",
].join("\n");

const KNOWLEDGE_SYSTEM_PROMPT = [
  "You are the akm `distill` distiller.",
  "Given an asset and recent feedback events about it, produce a concise",
  "*knowledge* markdown document capturing the durable, reusable facts.",
  "Prefer stable guidance over narrative recap.",
  "",
  "YOUR RESPONSE MUST START EXACTLY WITH `---` ON THE VERY FIRST LINE.",
  "DO NOT output any prose, explanation, or code fences before or after.",
  "",
  "Required output format:",
  "---",
  "description: <one-line summary of the knowledge asset>",
  "tags: [<tag1>, <tag2>]",
  "---",
  "",
  "# <Title>",
  "",
  "<body — structured markdown, durable facts only>",
  "",
  "RULES:",
  "- `description` MUST be a non-empty single-line string.",
  "- Include a meaningful markdown body with a `# Title` heading.",
  "- Output ONLY the knowledge file. No preamble, no code fences, no trailing prose.",
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
  /**
   * Last 1–3 archived rejected proposals for this ref. Injected as
   * Reflexion-style verbal-RL context so the LLM does not regenerate
   * proposals that have already been reviewed and refused.
   */
  rejectedProposals?: Array<{ reason: string; contentPreview?: string }>;
}

/**
 * Pure: build the user-prompt body. Exported for tests.
 *
 * D-3 (#371): restructures the feedback section from raw JSON event lines into
 * a Reflexion-style verbal contrast (`## What worked` / `## What failed`).
 * The verbal format allows LLMs to use feedback as gradient signal rather than
 * just metadata — capturing the +8% AlfWorld lift from arXiv:2303.11366 and
 * the contrast-based rule-learning gain from ExpeL arXiv:2308.10144.
 */
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

  if (input.feedback.length === 0) {
    lines.push("Recent feedback: (no feedback events recorded — distil from the asset itself)");
  } else {
    // D-3 (#371): verbal contrast format for Reflexion verbal-gradient lift.
    // Partition events into positive ("what worked") and negative ("what failed").
    const positive: string[] = [];
    const negative: string[] = [];
    const neutral: string[] = [];

    for (const event of input.feedback) {
      const meta = (event.metadata ?? {}) as Record<string, unknown>;
      const signal = typeof meta.signal === "string" ? meta.signal : undefined;
      const reason = typeof meta.reason === "string" ? meta.reason : "";
      const note = typeof meta.note === "string" ? meta.note : "";
      const detail = reason || note;
      const line = detail ? `- ${event.ts}: ${detail}` : `- ${event.ts}: feedback received`;

      if (signal === "positive") positive.push(line);
      else if (signal === "negative") negative.push(line);
      else
        neutral.push(`- ${event.ts} ${event.eventType}${event.metadata ? ` ${JSON.stringify(event.metadata)}` : ""}`);
    }

    if (positive.length > 0 || negative.length > 0) {
      if (positive.length > 0) {
        lines.push("## What worked");
        for (const l of positive) lines.push(l);
        lines.push("");
      }
      if (negative.length > 0) {
        lines.push("## What failed");
        for (const l of negative) lines.push(l);
        lines.push("");
      }
      if (neutral.length > 0) {
        lines.push("## Other signals");
        for (const l of neutral) lines.push(l);
        lines.push("");
      }
    } else {
      // No positive/negative signals — fall back to the pre-D3 flat format for
      // non-feedback event types (e.g. reflect_invoked, distill_invoked).
      lines.push("Recent feedback events (most recent last):");
      for (const event of input.feedback) {
        const meta = event.metadata ? ` ${JSON.stringify(event.metadata)}` : "";
        lines.push(`- ${event.ts} ${event.eventType}${meta}`);
      }
      lines.push("");
    }
  }
  if (input.rejectedProposals && input.rejectedProposals.length > 0) {
    lines.push("");
    lines.push("Previously rejected proposals for this ref (Reflexion context):");
    lines.push(
      "The following proposals were already reviewed and rejected. " +
        "Your new proposal MUST differ meaningfully in approach, framing, or evidence.",
    );
    for (const rp of input.rejectedProposals) {
      lines.push(`- Rejection reason: ${rp.reason}`);
      if (rp.contentPreview) {
        lines.push(`  Content preview: ${rp.contentPreview.slice(0, 200).replace(/\n/g, " ")}`);
      }
    }
  }
  if (input.proposalKind === "knowledge") {
    lines.push("Produce the knowledge markdown file now. Start your response with `---` on the first line.");
  } else {
    lines.push(
      "Produce the lesson markdown file now. Start your response with `---` on the first line, followed by `description:` and `when_to_use:` fields.",
    );
  }
  return lines.join("\n");
}

// ── D-4 / #390: Top-3 similar lessons retrieval ──────────────────────────────

/**
 * Default implementation: use akmSearch to find top-N similar lesson assets.
 * Returns empty array when search fails or returns no results.
 * Requires embedding configured for semantic similarity; degrades gracefully.
 */
async function fetchTopSimilarLessons(
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
      .filter((h): h is import("../sources/types").SourceSearchHit => "path" in h && typeof h.path === "string")
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
function buildJudgePrompt(
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
 * Gated behind `lesson_quality_gate` (or its alias `proposal_quality_gate`) at
 * the call site via {@link isLlmFeatureEnabled}.
 *
 * Fail-open: returns `pass: true` on timeout, parse failure, or missing LLM.
 */
export async function runLessonQualityJudge(
  config: AkmConfig,
  lessonContent: string,
  sourceContent: string,
  chat: (llmConfig: LlmConnectionConfig, messages: ChatMessage[]) => Promise<string>,
  /** D-4 / #390: top-3 similar existing lessons for dedup check. */
  similarLessons?: Array<{ ref: string; content: string }>,
): Promise<{ pass: boolean; score: number; reason: string; reviewNeeded?: boolean }> {
  if (!config.llm) {
    return { pass: true, score: -1, reason: "no LLM configured — passing through" };
  }
  const judgeLlmConfig = config.llm.judgeModel ? { ...config.llm, model: config.llm.judgeModel } : config.llm;
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
      return { pass: true, score: -1, reason: "judge parse failed — passing through" };
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
  // D-4 / #390: similar-lessons retrieval seam (test-injectable).
  const fetchSimilarLessonsFn =
    options.fetchSimilarLessonsFn ?? ((query, n) => fetchTopSimilarLessons(query, n, options.stashDir));

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

    if (existingKnowledgeContent && config?.llm) {
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
        const mergeResponse = await chat(config.llm, [
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
    } else if (existingKnowledgeContent && !config?.llm) {
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
    if (isLlmFeatureEnabled(config, "lesson_quality_gate")) {
      // D-4 / #390: retrieve top-3 similar lessons for dedup check in judge.
      const similarLessons = await fetchSimilarLessonsFn(resolvedPromotionContent.slice(0, 500), 3);
      const judgeResult = await runLessonQualityJudge(
        config,
        resolvedPromotionContent,
        assetContent ?? "",
        chat,
        similarLessons.length > 0 ? similarLessons : undefined,
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
          );
        }
        return writeQualityRejection(
          stash,
          inputRef,
          promotion.knowledgeRef,
          resolvedPromotionContent,
          judgeResult.score,
          judgeResult.reason,
        );
      }
    }
    const knowledgeParsed = parseFrontmatter(resolvedPromotionContent);
    const proposalResult = createProposal(
      stash,
      {
        ref: promotion.knowledgeRef,
        source: "distill",
        ...(options.sourceRun !== undefined ? { sourceRun: options.sourceRun } : {}),
        payload: {
          content: resolvedPromotionContent,
          ...(Object.keys(knowledgeParsed.data).length > 0 ? { frontmatter: knowledgeParsed.data } : {}),
        },
      },
      options.ctx,
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

  // Inject last 1–3 rejected proposals for this ref as Reflexion-style
  // verbal-RL context so the LLM avoids regenerating refused proposals.
  const MAX_REJECTED_PROPOSALS = 3;
  const rejectedForRef = listProposals(stash, { ref: inputRef, status: "rejected", includeArchive: true })
    .sort((a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime())
    .slice(0, MAX_REJECTED_PROPOSALS)
    .map((p) => ({
      reason: p.review?.reason ?? "no reason given",
      contentPreview: p.payload.content.slice(0, 500),
    }));

  const userPrompt = buildDistillPrompt({
    inputRef,
    assetContent,
    feedback,
    proposalKind: effectiveProposalKind,
    ...(rejectedForRef.length > 0 ? { rejectedProposals: rejectedForRef } : {}),
  });
  const messages: ChatMessage[] = [
    { role: "system", content: effectiveProposalKind === "knowledge" ? KNOWLEDGE_SYSTEM_PROMPT : LESSON_SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];

  // Single bounded LLM call. The wrapper handles the gate-check, 600s
  // (10 min) default timeout, and error fallback (returning `null`).
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
  let content = stripMarkdownFences(raw);

  // Auto-repair missing frontmatter fields before hard-failing. Small models
  // frequently produce a good lesson body but omit the YAML header entirely.
  // Rather than discarding valid content, we extract description/when_to_use
  // from the body and prepend the required frontmatter block.
  if (effectiveProposalKind !== "knowledge") {
    const parsed = parseFrontmatter(content);
    const fm = (parsed.data ?? {}) as Record<string, unknown>;
    const missingDesc = typeof fm.description !== "string" || !(fm.description as string).trim();
    const missingWtu = typeof fm.when_to_use !== "string" || !(fm.when_to_use as string).trim();
    if (missingDesc || missingWtu) {
      const body = parsed.content.trim();
      // Strip markdown formatting tokens from a line so extracted text is clean.
      const stripMd = (l: string) =>
        l
          .replace(/\*\*([^*]+)\*\*/g, "$1")
          .replace(/\*([^*]+)\*/g, "$1")
          .replace(/`([^`]+)`/g, "$1")
          .replace(/^[#*\->_]+\s*/, "")
          .replace(/:\s*$/, "")
          .trim();
      // Skip lines that look like YAML field assignments (key: value) or frontmatter delimiters.
      // These appear when the LLM leaks frontmatter content into the body, causing
      // auto-repair to produce description: "description: Key Takeaways".
      const isYamlLike = (l: string) => /^---/.test(l) || /^[a-z_]+:\s/i.test(l);
      // Extract description: first non-trivial prose line after stripping markdown
      const descLine =
        body
          .split("\n")
          .map(stripMd)
          .find((l) => !isYamlLike(l) && l.length > 10 && l.length < 200) ?? `Lesson distilled from ${inputRef}`;
      // Extract when_to_use: look for a line starting with "When" or "Use when"
      const wtuLine =
        body
          .split("\n")
          .map(stripMd)
          .find((l) => /^(when |use when|apply when)/i.test(l) && l.length < 200) ??
        `When working with ${inputRef.split(":").pop() ?? "this asset"}.`;
      const repairedFm = {
        ...fm,
        ...(missingDesc ? { description: descLine } : {}),
        ...(missingWtu ? { when_to_use: wtuLine } : {}),
      };
      const fmLines = Object.entries(repairedFm)
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join("\n");
      content = `---\n${fmLines}\n---\n\n${body}`;
    }
  }

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
  // D-5 / #388: Three-band system — review_needed band queues a proposal
  // with review_needed outcome rather than auto-rejecting.
  if (isLlmFeatureEnabled(config, "lesson_quality_gate")) {
    // D-4 / #390: retrieve top-3 similar lessons for dedup check in judge.
    const similarLessons = await fetchSimilarLessonsFn(content.slice(0, 500), 3);
    const judgeResult = await runLessonQualityJudge(
      config,
      content,
      assetContent ?? "",
      chat,
      similarLessons.length > 0 ? similarLessons : undefined,
    );
    if (!judgeResult.pass) {
      if (judgeResult.reviewNeeded) {
        return writeQualityRejection(
          stash,
          inputRef,
          effectiveLessonRef,
          content,
          judgeResult.score,
          judgeResult.reason,
          {
            reviewNeeded: true,
            ...(exclusionSet.size > 0 ? { filteredFeedbackCount, feedbackFullyFiltered } : {}),
          },
        );
      }
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
  //
  // D-7 / #398: Inject `sources: [inputRef]` into the LLM-path proposal
  // frontmatter when the field is absent, providing reviewers with provenance
  // without requiring them to open event history. A-MEM arXiv:2502.12110 —
  // all notes carry explicit provenance links.
  const parsed = parseFrontmatter(content);
  const frontmatterWithSources: Record<string, unknown> = { ...parsed.data };
  if (!Array.isArray(frontmatterWithSources.sources) || (frontmatterWithSources.sources as unknown[]).length === 0) {
    frontmatterWithSources.sources = [inputRef];
  }
  const proposalResult2 = createProposal(
    stash,
    {
      ref: effectiveLessonRef,
      source: "distill",
      ...(options.sourceRun !== undefined ? { sourceRun: options.sourceRun } : {}),
      payload: {
        content,
        frontmatter: frontmatterWithSources,
      },
    },
    options.ctx,
  );

  if (isProposalSkipped(proposalResult2)) {
    appendEvent({
      eventType: "distill_invoked",
      ref: inputRef,
      metadata: {
        outcome: "skipped" as const,
        lessonRef: effectiveLessonRef,
        message: proposalResult2.message,
        skipReason: proposalResult2.reason,
      },
    });
    return {
      schemaVersion: 1,
      ok: true,
      outcome: "skipped",
      inputRef,
      lessonRef: effectiveLessonRef,
      message: proposalResult2.message,
    };
  }

  const proposal2: Proposal = proposalResult2;
  appendEvent({
    eventType: "distill_invoked",
    ref: inputRef,
    metadata: {
      outcome: "queued" as const,
      lessonRef: effectiveLessonRef,
      proposalRef: effectiveLessonRef,
      proposalKind: effectiveProposalKind,
      proposalId: proposal2.id,
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
    proposalId: proposal2.id,
    proposal: proposal2,
    ...(exclusionSet.size > 0 ? { filteredFeedbackCount, feedbackFullyFiltered } : {}),
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function defaultLookup(ref: string): Promise<string | null> {
  return resolveAssetPath(ref, { mode: "index-only" });
}
