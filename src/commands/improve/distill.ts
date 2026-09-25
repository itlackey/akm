// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

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
 *   - **Single bounded in-tree LLM call.** Routed through `callStructured`
 *     under the `distill` gate (v1 spec §14; 0.8.0 unified the orchestration
 *     and LLM-call gates under `processes.distill.enabled`). The wrapper
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
 * A nested input preserves its first legitimate scope segment
 * (`memories/project-a/deploy` → `lessons/project-a/memory-deploy-lesson`). An
 * unscoped input stays flat; asset types are not project scopes. Origin prefixes
 * remain durable provenance but are not embedded in the output path.
 *
 * # Why we do not call `runAgent`
 *
 * Distillation is in-tree per the v1 spec ("bounded in-tree LLM call"). The
 * agent dispatch path is a heavier shell-out used by the curator/agent
 * surfaces — distill must be cheap, deterministic-ish, and bounded so it can
 * be invoked from CI / automation without spinning up an agent harness.
 */

import fs from "node:fs";
import distillKnowledgeSystemPrompt from "../../assets/prompts/distill-knowledge-system.md" with { type: "text" };
import distillLessonSystemPrompt from "../../assets/prompts/distill-lesson-system.md" with { type: "text" };
import { assembleAsset, assembleAssetFromString, serializeFrontmatterQuoted } from "../../core/asset/asset-serialize";
import { parseFrontmatter, writeSalienceToFrontmatter } from "../../core/asset/frontmatter";
import { stripMarkdownFences } from "../../core/asset/markdown";
import { conceptIdFromTypeName, parseRefInput } from "../../core/asset/resolve-ref";
import { authoringRulesForType } from "../../core/authoring-rules";
import type { AkmConfig, ImproveProfileConfig } from "../../core/config/config";
import { getImproveProcessConfig, loadConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import { appendEvent, type EventsContext, readEvents } from "../../core/events";
import type { AkmDistillResult } from "../../core/improve-types";
import { lintLessonContent } from "../../core/lesson-lint";
import { parseEmbeddedJsonResponse } from "../../core/parse";
import { getDbPath } from "../../core/paths";
import { resolveStandardsContext } from "../../core/standards/resolve-standards-context";
import { withStateDb } from "../../core/state-db";
import { warnVerbose } from "../../core/warn";
import type { LoweringNotice } from "../../execution/resolved-request";
import { resolveAssetPath } from "../../indexer/walk/path-resolver";
import {
  disposeLoweredExecutionDispatchLease,
  type LoweredExecutionDispatchLease,
} from "../../integrations/agent/execution-lowering";
import type { RunnerSpec } from "../../integrations/agent/runner";
import type { ChatMessage, chatCompletion } from "../../llm/client";
import { callStructured, preflightStructuredLlmRunner } from "../../llm/structured-call";
import { closeDatabase, openReadonlyExistingDatabase } from "../../storage/repositories/index-connection";
import { getAllEntries } from "../../storage/repositories/index-entries-repository";
import { type EligibilitySource, isStaleTargetRejection } from "../proposal/proposal-types";
import {
  isProposalSkipped,
  listProposals,
  listProposalsReadOnly,
  type Proposal,
  type ProposalsContext,
} from "../proposal/repository";
import { stripFrontmatterBody as stripBodyForFidelity } from "./content-hash";
import {
  autoRepairLessonFrontmatter,
  autoSwapDescriptionWhenToUse,
  collectLessonQualityFindings,
  type DistillValidationFinding,
  repairLessonDescriptionTruncation,
} from "./distill/content-repair";
import {
  memoryKnowledgePromotionRequiresDispatch,
  type PromoteMemoryContext,
  planMemoryKnowledgePromotion,
  promoteMemoryToKnowledge,
} from "./distill/promote-memory";
import {
  fetchTopSimilarLessons,
  persistOutputEncodingSalience,
  runLessonQualityJudge,
  writeQualityRejection,
} from "./distill/quality-gate";
import { buildClsContext, checkDistillFidelity, DEFAULT_CLS_ADJACENT_COUNT } from "./distill-guards";
import { deriveKnowledgeRef } from "./distill-promotion-policy";
import { buildRefVocabulary, scoreEncodingSalience } from "./encoding-salience";
import { resolveImproveLlmExecution } from "./execution";
import { resolveImproveStrategy, resolveProcessEnabled } from "./improve-strategies";
import { emitProposal } from "./proposal-envelope";
import { createRunContext, type RunContext, resolveRunStashDir } from "./run-context";
import { computeSalience, upsertAssetSalience } from "./salience";
import { MAX_REJECTED_PROPOSALS } from "./shared";
import { durableImproveRef } from "./source-identity";

/**
 * Asset-ref types that `akm distill` structurally refuses as inputs.
 *
 * Distill *produces* lessons from non-lesson sources (memory, skill, knowledge,
 * etc.). Calling distill on an existing `lessons/*` ref would derive
 * `lessons/lesson-<name>-lesson-lesson` (double `-lesson` suffix) — the
 * recursive-ref defect observed across 323 archived rejected proposals.
 *
 * 08-F2: `env` and `secret` are refused as a STRUCTURAL floor — distill reads
 * the input asset's bytes via `readFileSync` and hands them to the LLM, so
 * secret material must never be a distill input. This gate is code, not config:
 * it holds even when `allowedTypes` config is mis-set in unattended cron.
 *
 * The runtime gate inside {@link akmDistill} still refuses these inputs
 * defensively (returning an `outcome: "skipped"` envelope with `skipReason:
 * "recursive_lesson_input"`). This exported set is the planner-side companion:
 * callers that schedule distill attempts (e.g. `akm improve`'s distill queue)
 * import it so refs of these types never enter the queue in the first place.
 *
 * Source of truth: this set drives the gate in `akmDistill` and is consumed
 * directly by the improve planner. Adding a new structurally-refused input
 * type means updating this constant — the planner picks the change up for
 * free.
 */
export const DISTILL_REFUSED_INPUT_TYPES: ReadonlySet<string> = new Set(["lesson", "env", "secret"]);

/**
 * Returns true when `type` is structurally refused as an input by
 * {@link akmDistill}. See {@link DISTILL_REFUSED_INPUT_TYPES}.
 */
export function isDistillRefusedInputType(type: string): boolean {
  return DISTILL_REFUSED_INPUT_TYPES.has(type);
}

export interface AkmDistillOptions {
  /** Asset ref to distil from (`[bundle//]conceptId`). */
  ref: string;
  /**
   * Active improve profile for this run. When set, its per-process `distill`
   * overrides win over the `default` profile; absent falls back to `default`.
   */
  improveProfile?: ImproveProfileConfig;
  /**
   * Proposal target mode. `lesson` always emits a lesson proposal.
   * `auto` lets memory refs graduate into knowledge proposals when a
   * deterministic stability heuristic says they are reinforced enough.
   */
  proposalKind?: "lesson" | "knowledge" | "auto";
  /** Override the resolved stash root (test seam). */
  stashDir?: string;
  /** Override the loaded config (test seam). */
  config?: AkmConfig;
  /** Exact symbolic runner frozen by the improve plan. */
  llmRunner?: Extract<RunnerSpec, { kind: "llm" }> | null;
  /** Shared improve deadline signal for generation and quality judging. */
  signal?: AbortSignal;
  /**
   * Optional chat seam for tests. Production transport stays engine-owned.
   */
  chat?: typeof chatCompletion;
  /** Override the proposals clock / id generator (test seam). */
  ctx?: ProposalsContext;
  /**
   * Events context carrying the improve run's long-lived state.db handle (or
   * the C2 boundary-pinned path) so distill's event emits take appendEvent's
   * fast path instead of a per-event open/migrate/close (R25). Populated by
   * the improve loop; standalone CLI distill leaves it unset.
   */
  eventsCtx?: EventsContext;
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
   * Each entry MUST be a valid `[bundle//]conceptId` ref; the CLI validates
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
  /**
   * Attribution tagging: which eligibility lane (`signal-delta`, `high-salience`,
   * `proactive`, `scope`) selected this asset for the current improve run. Set by
   * `akm improve`'s loop from the partitioned {@link ImproveEligibleRef}. Recorded
   * in `distill_invoked` event metadata and persisted on the created proposal so
   * accept/reject/revert/retrieval outcomes can be sliced by lane. Omitted for
   * direct `akm distill` invocations (no lane → downstream treats as `"unknown"`).
   */
  eligibilitySource?: EligibilitySource;
  /**
   * The input asset's durable `item_ref` (`<bundle>//<conceptId>`), resolved
   * from the index entry at planning time. When present, distill keys its
   * `asset_salience` write by it; direct invocations use the input conceptId.
   */
  itemRef?: string;
}

// ── Lesson-ref derivation ───────────────────────────────────────────────────

/** Derive the proposed lesson ref from the input ref. See module docblock. */
export function deriveLessonRef(inputRef: string): string {
  const parsed = parseRefInput(inputRef);
  // Strip the bundle: a feedback signal recorded against `team//skills/deploy`
  // distils into the same lesson namespace as `skills/deploy`. The proposal
  // id (a UUID) keeps the queue entries distinct, so collisions are not a
  // problem — and reviewers want to see them next to each other anyway.
  const parts = parsed.name.split("/");
  const scope = parts.length > 1 ? parts.shift() : undefined;
  const slug = `${parsed.type}-${parts.join("-")}`.toLowerCase();
  // Replace anything outside the canonical asset-name charset with `-`. Keep
  // it deterministic so re-runs produce the same ref.
  const safe = slug
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const safeScope = scope
    ?.toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `lessons/${safeScope ? `${safeScope}/` : ""}${safe}-lesson`;
}

// ── Content quality validators ──────────────────────────────────────────────
//
// The actual implementations now live in `core/proposal-quality-validators.ts`
// so the same checks run inside `runProposalValidators` on `proposal accept`.
import { detectDoubleFrontmatter, isValidDescription } from "../proposal/validators/proposal-quality-validators";

// ── Prompt assembly ─────────────────────────────────────────────────────────

const LESSON_SYSTEM_PROMPT = distillLessonSystemPrompt;

const KNOWLEDGE_SYSTEM_PROMPT = distillKnowledgeSystemPrompt;

// ── Structured-output schemas (responseSchema lift) ─────────────────────────
//
// PR 1 of the asset-writers decision (see knowledge/projects/akm/
// asset-writers-investigation/00-synthesis): on providers that honour
// `response_format: json_schema`, ask the LLM for a typed JSON object and
// re-assemble the markdown locally. The "emit raw markdown with embedded
// frontmatter" path supports providers that ignore
// the schema (and for the `chat` test seam, which is wired to return strings
// today). Shape-level rejection codes — MALFORMED_FRONTMATTER_BLOCK,
// FRONTMATTER_NOT_OBJECT, INVALID_YAML, UNBALANCED_CODE_FENCE — become
// unreachable on the structured path. Content-quality validators
// (isValidDescription / isValidWhenToUse) keep firing post-assembly because
// the LLM still controls the string contents of typed fields.

/**
 * JSON Schema for structured lesson distillation. Mirrors the LESSON_SYSTEM_PROMPT
 * frontmatter contract. Required: description, when_to_use, body. Optional:
 * tags (string array) so providers that volunteer categorisation hints survive
 * the round-trip without being rejected as additionalProperties.
 */
export const DISTILL_LESSON_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["description", "when_to_use", "body"],
  additionalProperties: false,
  properties: {
    description: {
      type: "string",
      minLength: 10,
      description:
        "Single complete sentence (80-200 chars) summarising what the lesson teaches. No markdown, no leading 'When'/'If'.",
    },
    when_to_use: {
      type: "string",
      minLength: 10,
      description: "Single complete sentence describing the concrete trigger condition for the lesson.",
    },
    body: {
      type: "string",
      minLength: 1,
      description: "Lesson body — plain markdown, 1-3 short paragraphs of practical guidance.",
    },
    tags: {
      type: "array",
      items: { type: "string" },
      description: "Optional tag list. Empty array is allowed; the post-processor drops it if empty.",
    },
  },
};

/**
 * JSON Schema for structured knowledge distillation. Mirrors the
 * KNOWLEDGE_SYSTEM_PROMPT contract. Required: description, body. Optional:
 * tags, sources.
 */
export const DISTILL_KNOWLEDGE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["description", "body"],
  additionalProperties: false,
  properties: {
    description: {
      type: "string",
      minLength: 1,
      description: "One-line summary of the knowledge asset.",
    },
    body: {
      type: "string",
      minLength: 1,
      description: "Knowledge body — structured markdown with a `# Title` heading and durable facts only.",
    },
    tags: {
      type: "array",
      items: { type: "string" },
      description: "Optional tag list. Empty array is allowed; the post-processor drops it if empty.",
    },
    sources: {
      type: "array",
      items: { type: "string" },
      description: "Optional list of source refs the knowledge was distilled from.",
    },
  },
};

/**
 * Shape returned by a structured-output-honouring provider. Loose-typed so the
 * caller can validate before consuming.
 */
interface StructuredDistillPayload {
  description?: unknown;
  when_to_use?: unknown;
  body?: unknown;
  tags?: unknown;
  sources?: unknown;
}

/**
 * Assemble a markdown asset from a structured-output payload. Returns `null`
 * when the payload is missing required fields — the caller then falls through
 * to the prompt-contract markdown path. We deliberately do NOT validate
 * content quality here (isValidDescription / isValidWhenToUse run downstream
 * on the assembled content); this helper only catches shape-level emptiness
 * that the schema may not have rejected (e.g. a provider that ignored
 * `minLength` but still returned the field).
 */
export function assembleStructuredDistillMarkdown(
  payload: StructuredDistillPayload,
  kind: "lesson" | "knowledge",
): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const description = typeof payload.description === "string" ? payload.description.trim() : "";
  const body = typeof payload.body === "string" ? payload.body.trim() : "";
  if (description.length === 0 || body.length === 0) return null;

  const fm: Record<string, string | string[]> = { description };

  if (kind === "lesson") {
    const whenToUse = typeof payload.when_to_use === "string" ? payload.when_to_use.trim() : "";
    if (whenToUse.length === 0) return null;
    fm.when_to_use = whenToUse;
  }

  if (Array.isArray(payload.tags)) {
    const tags = payload.tags.filter((t): t is string => typeof t === "string" && t.trim().length > 0);
    if (tags.length > 0) fm.tags = tags;
  }

  if (kind === "knowledge" && Array.isArray(payload.sources)) {
    const sources = payload.sources.filter((s): s is string => typeof s === "string" && s.trim().length > 0);
    if (sources.length > 0) fm.xrefs = sources;
  }

  return assembleAssetFromString(serializeFrontmatterQuoted(fm), body);
}

function validateKnowledgeContent(content: string, inputRef: string): DistillValidationFinding[] {
  const findings: DistillValidationFinding[] = [];
  const parsed = parseFrontmatter(content);
  if (parsed.content.trim().length === 0) {
    findings.push({
      kind: "missing-body",
      field: "body",
      message: `Distilled knowledge for ${inputRef} must include a non-empty markdown body.`,
    });
  }
  // Knowledge proposals don't strictly require a description, but if one is
  // present it must be a real summary — not a placeholder like `---` or a
  // truncated heading. Without this check, distill can land knowledge assets
  // with `description: ---` (observed in the wild when the LLM has nothing
  // meaningful to say about a session-checkpoint memory).
  const fm = (parsed.data ?? {}) as Record<string, unknown>;
  if (fm.description !== undefined) {
    // Knowledge can legitimately mention the topic name in its description, so
    // suppress the ref-restatement heuristic that's tuned for lesson assets.
    const descCheck = isValidDescription(fm.description, inputRef, { skipRefTailCheck: true });
    if (!descCheck.ok) {
      findings.push({
        kind: "invalid-description",
        field: "description",
        message: `Distilled knowledge for ${inputRef} has an invalid description: ${descCheck.reason}.`,
      });
    }
  }
  // Double-frontmatter pollution shows up in knowledge too — the LLM sometimes
  // re-emits the source asset's frontmatter inside its own response, leaving
  // two `---`-delimited blocks back-to-back.
  const dfm = detectDoubleFrontmatter(content);
  if (dfm) {
    findings.push({
      kind: dfm.kind,
      field: "body",
      message: `Distilled knowledge for ${inputRef}: ${dfm.message}`,
    });
  }
  return findings;
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
  /**
   * Stash authoring standards (convention/meta fact bodies) for non-wiki
   * output. Empty/omitted when none exist; gated on non-empty before injection.
   */
  standardsContext?: string;
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
  if (input.standardsContext?.trim()) {
    lines.push("Standards to follow (the rulebook for this target):");
    lines.push(input.standardsContext.trim());
    lines.push("");
  }
  {
    const authoringRules = authoringRulesForType(input.proposalKind ?? "lesson");
    if (authoringRules) {
      lines.push(authoringRules);
      lines.push("");
    }
  }
  lines.push("Asset content:");
  if (input.assetContent) {
    // The output contract also uses YAML fences. Feeding source frontmatter
    // verbatim caused local models to copy it into the lesson body, producing
    // deterministic double-frontmatter rejection. Distillation needs the
    // source body; its metadata is not evidence to reproduce.
    const body = parseFrontmatter(input.assetContent).content.trim().slice(0, 3000);
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
    lines.push(
      "Produce the knowledge markdown file now. Start your response with `---` on the first line, followed by a `description:` field whose value is a 1-sentence summary (20–400 chars). Never use placeholder values like `---`, `tbd`, `n/a`, or a single dash. If the source has nothing meaningful to summarize, do NOT produce a proposal — return an empty response instead. The frontmatter block ends with a second `---` line; do not emit any additional `---` fences in the body.",
    );
  } else {
    lines.push(
      "Produce the lesson markdown file now. Start your response with `---` on the first line, followed by `description:` and `when_to_use:` fields. Both must be real one-sentence summaries (20–400 chars) — never placeholder values like `---`, `tbd`, or `n/a`. The frontmatter block ends with a second `---` line; do not emit any additional `---` fences in the body.",
    );
  }
  return lines.join("\n");
}

// ── Main entry point ────────────────────────────────────────────────────────

/**
 * Run a single bounded distillation pass for `ref`. Always emits exactly one
 * `distill_invoked` event (with `outcome` in the metadata) regardless of the
 * branch taken — so observers can count invocations cheaply.
 */
/**
 * Best-effort load of the distill INPUT asset plus the #608 encoding-time
 * salience scoring: read the source, build the once-per-invocation bigram ref
 * vocabulary, then score the asset (novelty×0.40 + magnitude×0.35 +
 * predictionError×0.25) and mirror the result to both the asset frontmatter and
 * `state.db :: asset_salience`. Every write is best-effort. Extracted verbatim
 * from `akmDistill`; returns the (possibly salience-stamped) content plus the
 * ref vocabulary the caller reuses when scoring the distilled OUTPUT (G4).
 */
async function loadAndScoreInputSalience(args: {
  inputRef: string;
  durableInputRef: string;
  /**
   * Durable `asset_salience` write key for the input asset: its `item_ref` when
   * resolved, otherwise its conceptId. Matches the preparation-stage writer.
   */
  salienceWriteKey: string;
  stash: string;
  config: AkmConfig;
  outcomeWeightEnabled: boolean;
  lookup: (ref: string) => Promise<string | null>;
  /**
   * WI-9.10: this invocation's fresh asset memo (D6). The salience stamp
   * below reads the source asset then, when the frontmatter delta is
   * non-empty, writes the stamped bytes back to the SAME path and keeps
   * using the in-memory copy — the exact read/rewrite-in-place shape the
   * D6 memo exists for (run-context.ts's docblock cites this site).
   * `ctx.writeAsset` refreshes the memo so a later `ctx.readAsset` of this
   * path (none exists yet in this invocation) would see the stamped bytes.
   */
  ctx: RunContext;
  /** Delay durable salience writes until credential-bearing dispatch returns. */
  persistSalience?: boolean;
}): Promise<{ assetContent: string | null; existingRefVocabulary: Set<string> }> {
  const { inputRef, durableInputRef, salienceWriteKey, stash, outcomeWeightEnabled, lookup, ctx } = args;
  // Best-effort load: when the asset is not yet indexed we still proceed —
  // the LLM is asked to distil from "available signal" (feedback alone).
  let assetContent: string | null = null;
  let assetFilePath: string | null = null;
  try {
    const filePath = await lookup(durableInputRef);
    if (filePath && fs.existsSync(filePath)) {
      assetFilePath = filePath;
      assetContent = ctx.readAsset(filePath);
    }
  } catch {
    assetContent = null;
  }

  // ── #608: Encoding-time salience scoring ────────────────────────────────
  // Score the source asset with the three-signal model (novelty × 0.40 +
  // magnitude × 0.35 + predictionError × 0.25) and persist the result to:
  //   1. The asset's frontmatter (human-readable mirror; idempotent delta gate).
  //   2. state.db :: asset_salience (canonical; feeds improve's high-salience gate).
  // Both writes are best-effort — a DB error never blocks distillation.
  //
  // The bigram ref vocabulary is built ONCE per invocation — the novelty signal
  // reuses it when scoring the distilled OUTPUT at proposal creation (G4).
  let existingRefVocabulary = new Set<string>();
  try {
    const indexDb = openReadonlyExistingDatabase(getDbPath(), { isolatedSnapshot: true });
    if (indexDb) {
      try {
        const allRefs = getAllEntries(indexDb).map((e) => e.itemRef);
        existingRefVocabulary = buildRefVocabulary(allRefs);
      } finally {
        closeDatabase(indexDb);
      }
    }
  } catch {
    // Index not available — novelty defaults to type-floor.
  }

  if (args.persistSalience !== false && assetContent && assetFilePath) {
    try {
      const parsedRef = parseRefInput(inputRef);
      // G4: predictionError decays with revision count — the prior hardcoded
      // `revisionCount: 0` made it a dead constant 1.0. Use the number of
      // proposals ever raised against this ref as the revision proxy.
      let revisionCount = 0;
      try {
        revisionCount = listProposals(stash, { ref: inputRef, includeArchive: true }).length;
      } catch {
        // best-effort: unknown history scores as a first encounter
      }

      const salienceResult = scoreEncodingSalience({
        body: assetContent,
        type: parsedRef.type,
        existingRefVocabulary,
        revisionCount,
      });

      // 1. Write salience to the source asset frontmatter (idempotent).
      const updatedContent = writeSalienceToFrontmatter(assetContent, salienceResult.score, salienceResult);
      if (updatedContent !== assetContent) {
        ctx.writeAsset(assetFilePath, updatedContent);
        assetContent = updatedContent;
      }

      // 2. Persist encoding_salience to state.db.
      try {
        withStateDb((stateDb) => {
          const vector = computeSalience({
            ref: inputRef,
            type: parsedRef.type,
            retrievalFreq: 0,
            encodingSalience: salienceResult.score,
            outcomeWeightEnabled,
          });
          upsertAssetSalience(stateDb, salienceWriteKey, vector);
        });
      } catch {
        // State DB unavailable — frontmatter mirror is the only persistence.
      }
    } catch {
      // Scoring errors never block distillation.
    }
  }

  return { assetContent, existingRefVocabulary };
}

/**
 * Recursive-distillation + secret-material input guard. Distill produces
 * *lessons* from non-lesson sources; a lesson input would derive a recursive
 * `lessons/lesson-<name>` ref (the 323-archived-proposals defect) and
 * env/secret inputs must never be read or sent to the LLM. Emits the
 * `distill_invoked(skipped)` event and returns the terminal skipped result,
 * or `null` when the input type is allowed. Extracted verbatim from
 * `akmDistill` (R25/R31 — the events-ctx threading pushed it over the bar).
 */
function refuseDisallowedDistillInput(args: {
  options: AkmDistillOptions;
  parsedInputRef: ReturnType<typeof parseRefInput>;
  inputRef: string;
  durableInputRef: string;
  eligMeta: { eligibilitySource?: EligibilitySource };
}): AkmDistillResult | null {
  const { options, parsedInputRef, inputRef, durableInputRef, eligMeta } = args;
  if (!isDistillRefusedInputType(parsedInputRef.type)) return null;
  // 08-F2: env/secret are a secret-material refusal (never read the bytes);
  // lesson is the recursive-form refusal. Both skip BEFORE any readFileSync.
  const isSecretInput = parsedInputRef.type === "env" || parsedInputRef.type === "secret";
  const skippedRef = isSecretInput ? inputRef : conceptIdFromTypeName("lesson", parsedInputRef.name);
  const message = isSecretInput
    ? `Distill refuses ${parsedInputRef.type} inputs — secret material must never be sent to the LLM.`
    : "Distill refuses lesson inputs — lessons are the distilled form, not a source.";
  appendEvent(
    {
      eventType: "distill_invoked",
      // Key on item_ref when the planner resolved one, otherwise the conceptId.
      ref: options.itemRef ?? durableInputRef,
      metadata: {
        outcome: "skipped" as const,
        proposalRef: skippedRef,
        message,
        skipReason: isSecretInput ? "refused_secret_input" : "recursive_lesson_input",
        ...eligMeta,
      },
    },
    options.eventsCtx,
  );
  return {
    schemaVersion: 1,
    ok: true,
    outcome: "skipped",
    inputRef,
    proposalRef: skippedRef,
    skipReason: isSecretInput ? "refused_secret_input" : "recursive_lesson_input",
    message,
  };
}

async function prepareDistillExecution(args: {
  options: AkmDistillOptions;
  config: AkmConfig;
  inputRef: string;
  durableInputRef: string;
  salienceWriteKey: string;
}) {
  const { options, config, inputRef, durableInputRef, salienceWriteKey } = args;
  const stash = resolveRunStashDir(options.stashDir);
  const chat = options.chat;
  const executionNotices = new Map<string, Readonly<LoweringNotice>>();
  const collectNotices = (notices: readonly Readonly<LoweringNotice>[]): void => {
    for (const notice of notices) executionNotices.set(JSON.stringify(notice), notice);
  };
  const resolvedExecution = !Object.hasOwn(options, "llmRunner")
    ? resolveImproveLlmExecution({
        config,
        profile: options.improveProfile,
        process: getImproveProcessConfig("distill", options.improveProfile),
        processName: "distill",
      })
    : null;
  if (resolvedExecution) collectNotices(resolvedExecution.notices);
  const distillRunner: Extract<RunnerSpec, { kind: "llm" }> | undefined = Object.hasOwn(options, "llmRunner")
    ? (options.llmRunner ?? undefined)
    : resolvedExecution?.runner;
  const withNotices = (result: AkmDistillResult): AkmDistillResult =>
    executionNotices.size > 0 ? { ...result, notices: Object.freeze([...executionNotices.values()]) } : result;
  const lookup = options.lookupFn ?? ((ref: string) => defaultLookup(ref, stash));
  const readEventsImpl =
    options.readEventsFn ??
    ((readOptions: Parameters<typeof readEvents>[0]) => readEvents(readOptions, { readOnly: true }));
  const outcomeWeightEnabled = config.improve?.salience?.outcomeWeightEnabled !== false;
  const fetchSimilarLessonsFn: NonNullable<AkmDistillOptions["fetchSimilarLessonsFn"]> =
    options.fetchSimilarLessonsFn ?? ((query, n) => fetchTopSimilarLessons(query, n, options.stashDir));
  const assetCtx = createRunContext({
    stashDir: stash,
    config,
    eventsCtx: options.eventsCtx ?? {},
    proposalsCtx: options.ctx ?? {},
    chat,
    getLlmRunner: () => distillRunner ?? null,
    sourceRun: options.sourceRun ?? `distill-${Date.now()}`,
    dryRun: false,
    signal: options.signal,
  }).withFreshAssetMemo();
  const initialSalience = await loadAndScoreInputSalience({
    inputRef,
    durableInputRef,
    salienceWriteKey,
    stash,
    config,
    outcomeWeightEnabled,
    lookup,
    ctx: assetCtx,
    persistSalience: false,
  });
  const assetState = { ...initialSalience };
  const persistInputSalience = async (): Promise<void> => {
    const scored = await loadAndScoreInputSalience({
      inputRef,
      durableInputRef,
      salienceWriteKey,
      stash,
      config,
      outcomeWeightEnabled,
      lookup,
      ctx: assetCtx,
    });
    assetState.assetContent = scored.assetContent ?? assetState.assetContent;
    assetState.existingRefVocabulary = scored.existingRefVocabulary;
  };
  const feedbackState = readDistillFeedback({ readEventsImpl, options, durableInputRef });
  const feedback = feedbackState.filteredEvents.slice(-20).map((event) => ({
    ts: event.ts,
    eventType: event.eventType,
    ...(event.metadata !== undefined ? { metadata: event.metadata } : {}),
  }));
  return {
    stash,
    chat,
    collectNotices,
    distillRunner,
    withNotices,
    lookup,
    outcomeWeightEnabled,
    fetchSimilarLessonsFn,
    assetState,
    persistInputSalience,
    feedback,
    ...feedbackState,
  };
}

export async function akmDistill(options: AkmDistillOptions): Promise<AkmDistillResult> {
  const inputRef = options.ref.trim();
  if (!inputRef) {
    throw new UsageError("Asset ref is required. Usage: akm distill <ref>", "MISSING_REQUIRED_ARGUMENT");
  }
  // Validate the ref shape up front so a typo never reaches the LLM.
  const parsedInputRef = parseRefInput(inputRef);
  const durableInputRef = durableImproveRef(inputRef);
  // The input asset's durable salience write key is item_ref when resolved,
  // otherwise the input conceptId.
  const salienceWriteKey = options.itemRef ?? durableInputRef;
  const targetKind = options.proposalKind ?? "lesson";

  const config = options.config ?? loadConfig();
  const improveProfile = options.improveProfile ?? resolveImproveStrategy(undefined, config).config;
  options = { ...options, improveProfile };
  if (!resolveProcessEnabled("distill", improveProfile)) {
    const proposalKind = targetKind === "knowledge" ? "knowledge" : "lesson";
    return {
      schemaVersion: 1,
      ok: true,
      outcome: "config_disabled",
      inputRef,
      proposalRef: proposalKind === "knowledge" ? deriveKnowledgeRef(inputRef) : deriveLessonRef(inputRef),
      proposalKind,
      message: "distill is disabled in config; enable processes.distill.enabled to activate.",
    };
  }

  // Attribution tagging: spread into every distill_invoked event's metadata so
  // the lane that selected this asset is recorded uniformly across all outcome
  // branches. Empty object when no lane was supplied (direct `akm distill`).
  const eligMeta: { eligibilitySource?: EligibilitySource } = options.eligibilitySource
    ? { eligibilitySource: options.eligibilitySource }
    : {};

  // Recursive-distillation guard (see refuseDisallowedDistillInput). The
  // refused-type set is exported as {@link DISTILL_REFUSED_INPUT_TYPES} so
  // the improve planner can skip these refs before queuing distill attempts;
  // this runtime check stays as a defensive backstop for direct callers.
  const refused = refuseDisallowedDistillInput({ options, parsedInputRef, inputRef, durableInputRef, eligMeta });
  if (refused) return refused;

  const prepared = await prepareDistillExecution({
    options,
    config,
    inputRef,
    durableInputRef,
    salienceWriteKey,
  });
  const {
    stash,
    chat,
    collectNotices,
    distillRunner,
    withNotices,
    lookup,
    outcomeWeightEnabled,
    fetchSimilarLessonsFn,
    assetState,
    persistInputSalience,
    feedback,
    filteredEvents,
    exclusionSet,
    filteredFeedbackCount,
    feedbackFullyFiltered,
  } = prepared;
  const promotionContext = {
    targetKind,
    inputRef,
    durableInputRef,
    ...(options.itemRef ? { itemRef: options.itemRef } : {}),
    assetContent: assetState.assetContent,
    filteredEvents,
    config,
    strategy: options.improveProfile,
    llmRunner: distillRunner,
    signal: options.signal,
    chat,
    stash,
    lookup,
    fetchSimilarLessonsFn,
    existingRefVocabulary: assetState.existingRefVocabulary,
    outcomeWeightEnabled,
    eligMeta,
    eligibilitySource: options.eligibilitySource,
    sourceRun: options.sourceRun,
    proposalsCtx: options.ctx,
    eventsCtx: options.eventsCtx,
    exclusionSetSize: exclusionSet.size,
    filteredFeedbackCount,
    feedbackFullyFiltered,
    onNotices: collectNotices,
  } satisfies PromoteMemoryContext;
  const promotionPlan = await planMemoryKnowledgePromotion(promotionContext);
  let dispatchLease: LoweredExecutionDispatchLease | undefined;

  try {
    // Memory→knowledge promotion branch (D-1/#369). When the target ref is a
    // reinforced memory, distill graduates it into a knowledge proposal instead
    // of a lesson — the whole branch (LLM contradiction-merge, quality gate,
    // proposal creation, event emit) lives in `promoteMemoryToKnowledge` and is
    // terminal when it fires. A `null` return means "not a promotion candidate";
    // fall through to the ordinary lesson/knowledge distillation path.
    if (promotionPlan && distillRunner && memoryKnowledgePromotionRequiresDispatch(promotionContext, promotionPlan)) {
      dispatchLease = await preflightStructuredLlmRunner(distillRunner);
    }
    const promotionResult = await promoteMemoryToKnowledge(
      { ...promotionContext, ...(dispatchLease ? { lease: dispatchLease } : {}) },
      promotionPlan,
    );
    if (promotionResult) {
      await persistInputSalience();
      return withNotices(promotionResult);
    }

    const effectiveProposalKind = targetKind === "knowledge" ? "knowledge" : "lesson";
    const effectiveLessonRef =
      effectiveProposalKind === "knowledge" ? deriveKnowledgeRef(inputRef) : deriveLessonRef(inputRef);

    const messages = await buildDistillMessages({
      options,
      stash,
      inputRef,
      assetContent: assetState.assetContent,
      feedback,
      effectiveProposalKind,
      effectiveLessonRef,
      fetchSimilarLessonsFn,
    });

    if (!dispatchLease && distillRunner) dispatchLease = await preflightStructuredLlmRunner(distillRunner);

    const { raw, fallbackReason } = await runDistillLlmCall({
      config,
      options,
      distillRunner,
      lease: dispatchLease,
      messages,
      effectiveProposalKind,
      onNotices: collectNotices,
    });
    await persistInputSalience();

    if (raw === null || raw.trim() === "") {
      return withNotices(
        distillEmptyResponseResult({
          fallbackReason,
          inputRef,
          durableInputRef,
          ...(options.itemRef ? { itemRef: options.itemRef } : {}),
          effectiveLessonRef,
          effectiveProposalKind,
          exclusionSet,
          filteredFeedbackCount,
          feedbackFullyFiltered,
          eligMeta,
          eventsCtx: options.eventsCtx,
        }),
      );
    }

    const assembled = assembleAndValidateDistillContent({
      raw,
      effectiveProposalKind,
      inputRef,
      durableInputRef,
      ...(options.itemRef ? { itemRef: options.itemRef } : {}),
      effectiveLessonRef,
      exclusionSet,
      filteredFeedbackCount,
      eligMeta,
      eventsCtx: options.eventsCtx,
      stash,
      ...(options.ctx ? { proposalsCtx: options.ctx } : {}),
      ...(options.sourceRun !== undefined ? { sourceRun: options.sourceRun } : {}),
    });
    if ("rejection" in assembled) return withNotices(assembled.rejection);
    const { content, descriptionSwapped } = assembled;

    const gate = await applyDistillQualityGate({
      config,
      options,
      content,
      assetContent: assetState.assetContent,
      chat,
      distillRunner,
      lease: dispatchLease,
      fetchSimilarLessonsFn,
      stash,
      inputRef,
      effectiveLessonRef,
      exclusionSet,
      filteredFeedbackCount,
      feedbackFullyFiltered,
      onNotices: collectNotices,
    });
    if ("rejection" in gate) return withNotices(gate.rejection);
    const lessonJudgeConfidence = gate.confidence;

    return withNotices(
      await emitDistillLessonProposal({
        content,
        options,
        distillRunner,
        assetContent: assetState.assetContent,
        inputRef,
        durableInputRef,
        effectiveLessonRef,
        effectiveProposalKind,
        stash,
        exclusionSet,
        filteredFeedbackCount,
        feedbackFullyFiltered,
        lessonJudgeConfidence,
        existingRefVocabulary: assetState.existingRefVocabulary,
        outcomeWeightEnabled,
        descriptionSwapped,
        eligMeta,
      }),
    );
  } finally {
    if (dispatchLease) disposeLoweredExecutionDispatchLease(dispatchLease);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * The distill-propose pass: the optional WS-3b distill→source fidelity check
 * (routes contradictions to human review), provenance xref round-trip, proposal
 * creation, and the queued/skipped `distill_invoked` emit + output salience
 * scoring (G4). Extracted verbatim from `akmDistill`; every outcome shape and
 * event is byte-identical.
 */
async function emitDistillLessonProposal(args: {
  content: string;
  options: AkmDistillOptions;
  distillRunner: Extract<RunnerSpec, { kind: "llm" }> | undefined;
  assetContent: string | null;
  inputRef: string;
  durableInputRef: string;
  effectiveLessonRef: string;
  effectiveProposalKind: "lesson" | "knowledge";
  stash: string;
  exclusionSet: Set<string>;
  filteredFeedbackCount: number;
  feedbackFullyFiltered: boolean;
  lessonJudgeConfidence: number | undefined;
  existingRefVocabulary: Set<string>;
  outcomeWeightEnabled: boolean;
  descriptionSwapped: number;
  eligMeta: { eligibilitySource?: EligibilitySource };
}): Promise<AkmDistillResult> {
  const {
    options,
    distillRunner,
    assetContent,
    inputRef,
    durableInputRef,
    effectiveLessonRef,
    effectiveProposalKind,
    stash,
    exclusionSet,
    filteredFeedbackCount,
    feedbackFullyFiltered,
    lessonJudgeConfidence,
    existingRefVocabulary,
    outcomeWeightEnabled,
    descriptionSwapped,
    eligMeta,
  } = args;
  let content = args.content;

  // WS-3b: Distill→source fidelity check (step 10).
  // When fidelityCheck.enabled, check the distill proposal against its cited
  // source memories. A contradiction flag routes to human review (not auto-accept).
  // DEFAULT OFF. Fail-open: any error is treated as no-contradiction.
  const fidelityConfig =
    (getImproveProcessConfig("distill", options.improveProfile)?.fidelityCheck as { enabled?: boolean } | undefined) ??
    {};
  if (fidelityConfig.enabled && assetContent) {
    try {
      const proposalBody = stripBodyForFidelity(content);
      const sourceBodies = [stripBodyForFidelity(assetContent)];
      const fidelityResult = checkDistillFidelity(proposalBody, sourceBodies, fidelityConfig);
      if (fidelityResult.contradictionDetected) {
        // Route to human review by writing a quality rejection with reviewNeeded=true.
        return writeQualityRejection(
          stash,
          inputRef,
          effectiveLessonRef,
          content,
          2.0, // below auto-accept threshold, signals review needed
          fidelityResult.reason ?? "Proposal may contradict cited source memories.",
          {
            reviewNeeded: true,
            fidelityContradiction: true,
            ...(exclusionSet.size > 0 ? { filteredFeedbackCount, feedbackFullyFiltered } : {}),
          },
          options.eligibilitySource,
          options.eventsCtx,
          {
            ...(options.ctx ? { proposalsCtx: options.ctx } : {}),
            ...(options.sourceRun !== undefined ? { sourceRun: options.sourceRun } : {}),
            ...(distillRunner?.connection.model ? { modelId: distillRunner.connection.model } : {}),
          },
        );
      }
    } catch {
      // Fail open — fidelity check is supplemental.
    }
  }

  // Round-trip the parsed frontmatter so the proposal carries it as a
  // structured payload alongside the raw content (matches the shape used by
  // other proposal sources).
  //
  // Serialize canonical provenance into the content that promotion writes.
  const parsed = parseFrontmatter(content);
  const existingXrefs = Array.isArray(parsed.data.xrefs) ? parsed.data.xrefs.map(String) : [];
  const frontmatterWithXrefs: Record<string, unknown> = {
    ...parsed.data,
    xrefs: [...new Set([...existingXrefs, durableInputRef])],
  };
  delete frontmatterWithXrefs.sources;
  content = assembleAsset(frontmatterWithXrefs, parsed.content);
  const proposalResult2 = emitProposal(
    { stashDir: stash, proposalsCtx: options.ctx },
    {
      ref: effectiveLessonRef,
      // §23.6 fingerprint model-id term (WI-6.4). Uses the RESOLVED connection
      // (profile/config fallback included), not the raw option — a standalone
      // `akm distill` run must fingerprint under the model that actually
      // generated the content, matching the promote-memory branch.
      ...(distillRunner?.connection.model ? { modelId: distillRunner.connection.model } : {}),
      source: "distill",
      ...(options.sourceRun !== undefined ? { sourceRun: options.sourceRun } : {}),
      payload: {
        content,
        frontmatter: frontmatterWithXrefs,
      },
      ...(lessonJudgeConfidence !== undefined ? { confidence: lessonJudgeConfidence } : {}),
      // Attribution tagging: persist the eligibility lane on the proposal.
      ...(options.eligibilitySource ? { eligibilitySource: options.eligibilitySource } : {}),
    },
  );

  if (isProposalSkipped(proposalResult2)) {
    appendEvent(
      {
        eventType: "distill_invoked",
        // Use item_ref when resolved, otherwise the input conceptId.
        ref: options.itemRef ?? durableInputRef,
        metadata: {
          outcome: "skipped" as const,
          proposalRef: effectiveLessonRef,
          message: proposalResult2.message,
          skipReason: proposalResult2.reason,
          ...eligMeta,
        },
      },
      options.eventsCtx,
    );
    return {
      schemaVersion: 1,
      ok: true,
      outcome: "skipped",
      inputRef,
      proposalRef: effectiveLessonRef,
      skipReason: proposalResult2.reason,
      message: proposalResult2.message,
    };
  }

  const proposal2: Proposal = proposalResult2;
  // G4: content-score the distilled OUTPUT so it carries a real encoding
  // salience (encoding_source='content') from creation — lessons never get
  // another chance (they are refused as distill inputs).
  persistOutputEncodingSalience(
    durableImproveRef(effectiveLessonRef),
    content,
    existingRefVocabulary,
    outcomeWeightEnabled,
  );
  appendEvent(
    {
      eventType: "distill_invoked",
      // Use item_ref when resolved, otherwise the input conceptId.
      ref: options.itemRef ?? durableInputRef,
      metadata: {
        outcome: "queued" as const,
        proposalRef: effectiveLessonRef,
        proposalKind: effectiveProposalKind,
        proposalId: proposal2.id,
        // R3: judge verdicts are longitudinally queryable, not just a one-shot
        // proposal.confidence write (normalized 1–5 score / 5).
        ...(lessonJudgeConfidence !== undefined ? { judgeConfidence: lessonJudgeConfidence } : {}),
        ...(options.sourceRun !== undefined ? { sourceRun: options.sourceRun } : {}),
        ...(exclusionSet.size > 0 ? { filteredFeedbackCount } : {}),
        ...(descriptionSwapped > 0 ? { descriptionSwapped } : {}),
        ...eligMeta,
      },
    },
    options.eventsCtx,
  );

  return {
    schemaVersion: 1,
    ok: true,
    outcome: "queued",
    inputRef,
    proposalRef: effectiveLessonRef,
    proposalKind: effectiveProposalKind,
    proposalId: proposal2.id,
    proposal: proposal2,
    ...(exclusionSet.size > 0 ? { filteredFeedbackCount, feedbackFullyFiltered } : {}),
    ...(descriptionSwapped > 0 ? { descriptionSwapped } : {}),
  };
}

/**
 * Turn the raw LLM response into validated proposal content: prefer the
 * structured-JSON assembly, else strip markdown fences; run the lesson-only
 * auto-repair chain (frontmatter repair, description↔when_to_use swap, truncation
 * repair); then lint/validate, emitting `distill_invoked(validation_failed)` and
 * throwing a `UsageError` on any finding. Extracted verbatim from `akmDistill`.
 */
function assembleAndValidateDistillContent(args: {
  raw: string;
  effectiveProposalKind: "lesson" | "knowledge";
  inputRef: string;
  durableInputRef: string;
  /** Fully-qualified item_ref for the distill_invoked event key. */
  itemRef?: string;
  effectiveLessonRef: string;
  exclusionSet: Set<string>;
  filteredFeedbackCount: number;
  eligMeta: { eligibilitySource?: EligibilitySource };
  eventsCtx?: EventsContext;
  stash: string;
  /** Test seam / attribution passthrough for a minted quality-rejection proposal row. */
  proposalsCtx?: ProposalsContext;
  sourceRun?: string;
}): { content: string; descriptionSwapped: number } | { rejection: AkmDistillResult } {
  const {
    raw,
    effectiveProposalKind,
    inputRef,
    durableInputRef,
    itemRef,
    effectiveLessonRef,
    exclusionSet,
    filteredFeedbackCount,
    eligMeta,
    eventsCtx,
    stash,
    proposalsCtx,
    sourceRun,
  } = args;
  // Structured-output path: when the provider honoured the JSON schema, `raw`
  // is a JSON object string (not a markdown blob). Try to parse it and assemble
  // the canonical `---\nfm\n---\n\nbody` form before using the markdown
  // response path. Failure here (non-JSON response, missing
  // required field, unexpected types) is non-fatal — we drop down to the
  // markdown path which has its own auto-repair + lint pass.
  let content: string;
  const structuredCandidate = parseEmbeddedJsonResponse<StructuredDistillPayload>(raw);
  const structuredAssembled =
    structuredCandidate && !Array.isArray(structuredCandidate)
      ? assembleStructuredDistillMarkdown(structuredCandidate, effectiveProposalKind)
      : null;
  if (structuredAssembled !== null) {
    content = structuredAssembled;
  } else {
    // Strip any stray fence the LLM might have added around the markdown.
    content = stripMarkdownFences(raw);
  }

  // Lesson-path content normalization (see distill/content-repair): auto-repair
  // missing frontmatter, description↔when_to_use auto-swap, and truncation
  // repair. Knowledge output skips all three (no lesson frontmatter contract).
  if (effectiveProposalKind !== "knowledge") {
    content = autoRepairLessonFrontmatter(content, inputRef);
  }

  let descriptionSwapped = 0;
  if (effectiveProposalKind !== "knowledge") {
    const swapResult = autoSwapDescriptionWhenToUse(content, inputRef);
    content = swapResult.content;
    descriptionSwapped = swapResult.swapped;
  }

  if (effectiveProposalKind !== "knowledge") {
    content = repairLessonDescriptionTruncation(content);
  }

  // Parse + lint the lesson before creating the proposal. The lint is the
  // canonical gate for required frontmatter (v1 spec §13): a field that is
  // genuinely missing or empty means there is no valid asset to write, so
  // that failure stays a hard reject — but still emit `distill_invoked` so
  // the failure is observable.
  const structuralFindings: DistillValidationFinding[] =
    effectiveProposalKind === "knowledge"
      ? validateKnowledgeContent(content, inputRef)
      : lintLessonContent(content, `distill:${inputRef}`).findings;

  // Additional lesson-only quality validators — reject the systematic failure
  // modes seen across 323 archived rejected proposals (see distill/content-repair).
  const qualityFindings =
    effectiveProposalKind !== "knowledge" && structuralFindings.length === 0
      ? collectLessonQualityFindings(content, inputRef)
      : [];

  if (structuralFindings.length > 0) {
    appendEvent(
      {
        eventType: "distill_invoked",
        // Use item_ref when resolved, otherwise the input conceptId.
        ref: itemRef ?? durableInputRef,
        metadata: {
          outcome: "validation_failed" as const,
          proposalRef: effectiveLessonRef,
          proposalKind: effectiveProposalKind,
          findingKinds: structuralFindings.map((f) => f.kind),
          ...(exclusionSet.size > 0 ? { filteredFeedbackCount } : {}),
          ...eligMeta,
        },
      },
      eventsCtx,
    );
    const message = structuralFindings.map((f) => f.message).join("\n");
    throw new UsageError(
      `Distilled ${effectiveProposalKind} failed validation:\n${message}`,
      "MISSING_REQUIRED_ARGUMENT",
      effectiveProposalKind === "knowledge"
        ? "Knowledge proposals require a non-empty markdown body."
        : "Lessons require non-empty `description` and `when_to_use` frontmatter fields. See v1 spec §13.",
    );
  }

  if (qualityFindings.length > 0) {
    return {
      rejection: writeQualityRejection(
        stash,
        inputRef,
        effectiveLessonRef,
        content,
        2.0, // below auto-accept threshold, signals review needed — no judge score exists for a structural/heuristic finding
        qualityFindings.map((f) => f.message).join("\n"),
        {
          reviewNeeded: true,
          proposalKind: effectiveProposalKind,
          findingKinds: qualityFindings.map((f) => f.kind),
          ...(exclusionSet.size > 0 ? { filteredFeedbackCount } : {}),
        },
        eligMeta.eligibilitySource,
        eventsCtx,
        {
          ...(proposalsCtx ? { proposalsCtx } : {}),
          ...(sourceRun !== undefined ? { sourceRun } : {}),
        },
      ),
    };
  }

  return { content, descriptionSwapped };
}

/**
 * The single bounded distill LLM call: gate-checked via `callStructured`
 * (R26 migration off the raw `chatCompletion` scaffold), passing the
 * lesson/knowledge JSON schema on the production path and keeping the
 * injected test fake schema-blind. Returns the raw response (or `null`) and
 * the fallback reason.
 */
async function runDistillLlmCall(args: {
  config: AkmConfig;
  options: AkmDistillOptions;
  distillRunner: Extract<RunnerSpec, { kind: "llm" }> | undefined;
  lease: LoweredExecutionDispatchLease | undefined;
  messages: ChatMessage[];
  effectiveProposalKind: "lesson" | "knowledge";
  onNotices: (notices: readonly Readonly<LoweringNotice>[]) => void;
}): Promise<{ raw: string | null; fallbackReason: "disabled" | "timeout" | "error" | undefined }> {
  const { config, options, distillRunner, lease, messages, effectiveProposalKind, onNotices } = args;
  const distillSchema =
    effectiveProposalKind === "knowledge" ? DISTILL_KNOWLEDGE_JSON_SCHEMA : DISTILL_LESSON_JSON_SCHEMA;
  let fallbackReason: "disabled" | "timeout" | "error" | undefined;
  const enabled = resolveProcessEnabled(
    "distill",
    options.improveProfile ?? resolveImproveStrategy(undefined, config).config,
  );
  const recordFallback = (feature: string, reason: "disabled" | "timeout" | "error") => {
    fallbackReason = reason;
    // Log the fallback reason; the caller (raw === null path) handles
    // emitting the distill_invoked event so we don't double-emit here.
    warnVerbose(`[akm] LLM fallback for ${feature}: ${reason}`);
  };
  if (enabled && !distillRunner) {
    // No LLM connection configured. At HEAD this threw a ConfigError inside
    // the gated fn and tryLlmFeature routed it through the "error" fallback;
    // reproduce that terminal state directly (the gate-disabled case above
    // still dominates: when disabled, callStructured takes the "disabled"
    // fallback before any LLM lookup, exactly as before).
    recordFallback("distill", "error");
    return { raw: null, fallbackReason };
  }
  const raw = await callStructured<string | null>({
    feature: "distill",
    akmConfig: config,
    enabled,
    // Safe: when the gate is open, distillRunner is defined (guard above); when
    // it is closed, the transport never runs and the runner is never read.
    runner: distillRunner as Extract<RunnerSpec, { kind: "llm" }>,
    ...(lease ? { lease } : {}),
    messages,
    request:
      options.chat === undefined
        ? // Production path: pass the JSON schema so providers that honour
          // `response_format: json_schema` enforce shape upstream. Providers
          // that ignore the option fall through to the prompt-contract
          // markdown path.
          {
            responseSchema: distillSchema,
            ...(options.signal ? { signal: options.signal } : {}),
          }
        : // Test seam: keep the injected fake as the transport; fakes never
          // see the schema (they return markdown strings).
          { chat: options.chat, ...(options.signal ? { signal: options.signal } : {}) },
    parse: (raw) => raw ?? null,
    onError: (_cls, err) => {
      // At HEAD a transport throw escaped to tryLlmFeature's catch, which
      // fired onFallback("error"); reproduce that observable state.
      void err;
      recordFallback("distill", "error");
      return null;
    },
    fallback: null,
    onFallback: (evt) => recordFallback(evt.feature, evt.reason),
    onNotices,
  });
  return { raw, fallbackReason };
}

/**
 * Build the terminal result for an empty/failed distill LLM response,
 * distinguishing the config-gate-off branch (event suppressed) from a real
 * transport/timeout/empty failure (emits `distill_invoked(llm_failed)`).
 * Extracted verbatim from `akmDistill`.
 */
function distillEmptyResponseResult(args: {
  fallbackReason: "disabled" | "timeout" | "error" | undefined;
  inputRef: string;
  durableInputRef: string;
  /** Fully-qualified item_ref for the distill_invoked event key. */
  itemRef?: string;
  effectiveLessonRef: string;
  effectiveProposalKind: "lesson" | "knowledge";
  exclusionSet: Set<string>;
  filteredFeedbackCount: number;
  feedbackFullyFiltered: boolean;
  eligMeta: { eligibilitySource?: EligibilitySource };
  eventsCtx?: EventsContext;
}): AkmDistillResult {
  const {
    fallbackReason,
    inputRef,
    durableInputRef,
    itemRef,
    effectiveLessonRef,
    effectiveProposalKind,
    exclusionSet,
    filteredFeedbackCount,
    feedbackFullyFiltered,
    eligMeta,
    eventsCtx,
  } = args;
  // Distinguish "config gate disabled" from "LLM call failed". For the
  // config-disabled branch, we ALSO suppress the `distill_invoked` event
  // because no LLM work was actually invoked — emitting the event causes
  // the planner to accumulate phantom invocations that drown out real
  // signal.
  if (fallbackReason === "disabled") {
    return {
      schemaVersion: 1,
      ok: true,
      outcome: "config_disabled",
      inputRef,
      proposalRef: effectiveLessonRef,
      proposalKind: effectiveProposalKind,
      message: "distill is disabled in config; enable processes.distill.enabled to activate.",
      ...(exclusionSet.size > 0 ? { filteredFeedbackCount, feedbackFullyFiltered } : {}),
    };
  }
  // LLM was actually invoked but produced nothing usable (transport error,
  // timeout, or empty/whitespace response). Emit the event so the failure
  // is observable.
  appendEvent(
    {
      eventType: "distill_invoked",
      // Use item_ref when resolved, otherwise the input conceptId.
      ref: itemRef ?? durableInputRef,
      metadata: {
        outcome: "llm_failed" as const,
        proposalRef: effectiveLessonRef,
        proposalKind: effectiveProposalKind,
        ...(exclusionSet.size > 0 ? { filteredFeedbackCount } : {}),
        ...eligMeta,
      },
    },
    eventsCtx,
  );
  return {
    schemaVersion: 1,
    ok: true,
    outcome: "llm_failed",
    inputRef,
    proposalRef: effectiveLessonRef,
    proposalKind: effectiveProposalKind,
    message: "LLM call returned no usable output (timeout, empty, or error).",
    ...(exclusionSet.size > 0 ? { filteredFeedbackCount, feedbackFullyFiltered } : {}),
  };
}

/**
 * The P2-B LLM-as-judge quality gate (fail-CLOSED; D-5/#388 three-band). Returns
 * a terminal rejection result when the judge rejects (or routes to review), or
 * the normalized [0,1] confidence to carry onto the proposal. Extracted verbatim
 * from `akmDistill`.
 */
async function applyDistillQualityGate(args: {
  config: AkmConfig;
  options: AkmDistillOptions;
  content: string;
  assetContent: string | null;
  chat: typeof chatCompletion | undefined;
  distillRunner: Extract<RunnerSpec, { kind: "llm" }> | undefined;
  lease: LoweredExecutionDispatchLease | undefined;
  fetchSimilarLessonsFn: (query: string, n: number) => Promise<Array<{ ref: string; content: string }>>;
  stash: string;
  inputRef: string;
  effectiveLessonRef: string;
  exclusionSet: Set<string>;
  filteredFeedbackCount: number;
  feedbackFullyFiltered: boolean;
  onNotices: (notices: readonly Readonly<LoweringNotice>[]) => void;
}): Promise<{ rejection: AkmDistillResult } | { confidence: number | undefined }> {
  const {
    config,
    options,
    content,
    assetContent,
    chat,
    distillRunner,
    lease,
    fetchSimilarLessonsFn,
    stash,
    inputRef,
    effectiveLessonRef,
    exclusionSet,
    filteredFeedbackCount,
    feedbackFullyFiltered,
    onNotices,
  } = args;
  if (!(options.improveProfile?.processes?.distill?.qualityGate?.enabled ?? true)) {
    return { confidence: undefined };
  }
  // D-4 / #390: retrieve top-3 similar lessons for dedup check in judge.
  const similarLessons = await fetchSimilarLessonsFn(content.slice(0, 500), 3);
  const judgeResult = await runLessonQualityJudge(config, content, assetContent ?? "", chat, {
    ...(similarLessons.length > 0 ? { similarLessons } : {}),
    ...(distillRunner ? { llmRunner: distillRunner } : {}),
    ...(lease ? { lease } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    onNotices,
  });
  if (!judgeResult.pass) {
    const proposalOpts = {
      ...(options.ctx ? { proposalsCtx: options.ctx } : {}),
      ...(options.sourceRun !== undefined ? { sourceRun: options.sourceRun } : {}),
      ...(distillRunner?.connection.model ? { modelId: distillRunner.connection.model } : {}),
    };
    if (judgeResult.reviewNeeded) {
      return {
        rejection: writeQualityRejection(
          stash,
          inputRef,
          effectiveLessonRef,
          content,
          judgeResult.score,
          judgeResult.reason,
          {
            reviewNeeded: true,
            ...(judgeResult.criteria ? { criteria: judgeResult.criteria } : {}),
            ...(exclusionSet.size > 0 ? { filteredFeedbackCount, feedbackFullyFiltered } : {}),
          },
          options.eligibilitySource,
          options.eventsCtx,
          proposalOpts,
        ),
      };
    }
    return {
      rejection: writeQualityRejection(
        stash,
        inputRef,
        effectiveLessonRef,
        content,
        judgeResult.score,
        judgeResult.reason,
        {
          ...(judgeResult.criteria ? { criteria: judgeResult.criteria } : {}),
          ...(exclusionSet.size > 0 ? { filteredFeedbackCount, feedbackFullyFiltered } : {}),
        },
        options.eligibilitySource,
        options.eventsCtx,
        proposalOpts,
      ),
    };
  }
  // Normalize 1-5 judge score to [0, 1]. Only a real passing verdict
  // reaches here (07 P0-2: the judge now fails CLOSED on no-LLM / timeout /
  // parse failure, so those return pass:false and never fall through to
  // this line). A defensive score>0 guard keeps confidence undefined for any
  // non-positive score the auto-accept gate should treat as unscored.
  return { confidence: judgeResult.score > 0 ? judgeResult.score / 5 : undefined };
}

/**
 * Read the target ref's `feedback` events and apply the #267 exclusion filter.
 * Returns the filtered events plus the exclusion tallies the outcome branches
 * carry. Extracted verbatim from `akmDistill`.
 */
function readDistillFeedback(args: {
  readEventsImpl: typeof readEvents;
  options: AkmDistillOptions;
  durableInputRef: string;
}): {
  filteredEvents: ReturnType<typeof readEvents>["events"];
  exclusionSet: Set<string>;
  filteredFeedbackCount: number;
  feedbackFullyFiltered: boolean;
} {
  const { readEventsImpl, options, durableInputRef } = args;
  const { events: unfilteredEvents } = readEventsImpl({
    ref: options.itemRef ?? durableInputRef,
    type: "feedback",
    excludeTags: options.excludeTags,
    includeTags: options.includeTags,
  });
  const events = unfilteredEvents;

  // #267 — feedback exclusion. Filter events whose `ref` matches the
  // exclusion list BEFORE the prompt is built. The original event stream
  // is never mutated; only the `feedback` slice that reaches the LLM is
  // affected. Exclusion refs are compared with event refs exactly.
  const exclusionList = options.excludeFeedbackFromRefs ?? [];
  const exclusionSet = new Set(exclusionList.map((ref) => ref.trim()).filter((ref) => ref.length > 0));
  const originalEventCount = events.length;
  const filteredEvents =
    exclusionSet.size > 0 ? events.filter((e) => !(e.ref !== undefined && exclusionSet.has(e.ref))) : events;
  const filteredFeedbackCount = originalEventCount - filteredEvents.length;
  const feedbackFullyFiltered = exclusionSet.size > 0 && originalEventCount > 0 && filteredEvents.length === 0;
  return { filteredEvents, exclusionSet, filteredFeedbackCount, feedbackFullyFiltered };
}

/**
 * Build the distill chat messages: inject the last 1–3 rejected proposals
 * (Reflexion verbal-RL), the optional WS-3b CLS adjacent-context, and the stash
 * authoring standards, then assemble the system+user prompt. Extracted verbatim
 * from `akmDistill`.
 */
async function buildDistillMessages(args: {
  options: AkmDistillOptions;
  stash: string;
  inputRef: string;
  assetContent: string | null;
  feedback: Parameters<typeof buildDistillPrompt>[0]["feedback"];
  effectiveProposalKind: "lesson" | "knowledge";
  effectiveLessonRef: string;
  fetchSimilarLessonsFn: (query: string, n: number) => Promise<Array<{ ref: string; content: string }>>;
}): Promise<ChatMessage[]> {
  const {
    options,
    stash,
    inputRef,
    assetContent,
    feedback,
    effectiveProposalKind,
    effectiveLessonRef,
    fetchSimilarLessonsFn,
  } = args;
  // Inject last 1–3 rejected proposals for this ref as Reflexion-style
  // verbal-RL context so the LLM avoids regenerating refused proposals.
  // Exclude the drain's stale-target auto-rejects (STALE, R20): those are a
  // procedural refusal (the target changed after mint), not a judgement on
  // the content, and would mislead this Reflexion-style "don't repeat this"
  // context.
  const rejectedForRef = listProposalsReadOnly(
    stash,
    { ref: inputRef, status: "rejected", includeArchive: true },
    options.ctx,
  )
    .filter((p) => !isStaleTargetRejection(p))
    .sort((a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime())
    .slice(0, MAX_REJECTED_PROPOSALS)
    .map((p) => ({
      reason: p.review?.reason ?? "no reason given",
      // #legacy: `changes` is empty for pre-existing rows (storedToChanges),
      // which makes `proposalContent` throw before reflect dispatch even
      // runs. `payload.content` is populated for every row regardless, so
      // read the preview from there instead.
      contentPreview: p.payload.content.slice(0, 500),
    }));

  // WS-3b CLS interleaving (step 9).
  // When cls.enabled, inject embedding-retrieved adjacent lessons/knowledge
  // into the distill prompt so the LLM avoids overwriting prior generalizations
  // (catastrophic interference). DEFAULT OFF.
  const clsConfig =
    (getImproveProcessConfig("distill", options.improveProfile)?.cls as
      | { enabled?: boolean; adjacentCount?: number }
      | undefined) ?? {};
  let clsContext = "";
  if (clsConfig.enabled) {
    try {
      const adjacentCount = clsConfig.adjacentCount ?? DEFAULT_CLS_ADJACENT_COUNT;
      // Use the asset content or input ref as the query for adjacent retrieval.
      const clsQuery = assetContent ? assetContent.slice(0, 500) : inputRef;
      const adjacentItems = await fetchSimilarLessonsFn(clsQuery, adjacentCount);
      clsContext = buildClsContext(adjacentItems, clsConfig);
    } catch {
      // Fail open — CLS is supplemental, never required.
    }
  }

  // Distill output is a lesson/knowledge (non-wiki) → stash authoring
  // standards. Resolved once for this single call.
  const standardsContext = resolveStandardsContext(effectiveLessonRef, stash);
  const baseUserPrompt = buildDistillPrompt({
    inputRef,
    assetContent,
    feedback,
    proposalKind: effectiveProposalKind,
    ...(rejectedForRef.length > 0 ? { rejectedProposals: rejectedForRef } : {}),
    ...(standardsContext.trim() ? { standardsContext } : {}),
  });
  const userPrompt = clsContext ? `${baseUserPrompt}${clsContext}` : baseUserPrompt;
  return [
    { role: "system", content: effectiveProposalKind === "knowledge" ? KNOWLEDGE_SYSTEM_PROMPT : LESSON_SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];
}

/**
 * Exported (PRECHECK) so the improve loop's distill
 * pre-generation guard (`loop-stages.ts`) can resolve the same asset path
 * `akmDistill` would when checking whether a memory promotes to knowledge —
 * without duplicating the resolution logic.
 */
export async function defaultLookup(ref: string, stashDir: string): Promise<string | null> {
  return resolveAssetPath(ref, {
    stashDir,
    mode: "disk-only",
    directoryIndexNames: ["SKILL.md"],
    preserveDirectNameFallback: true,
    honorOrigin: false,
  });
}
