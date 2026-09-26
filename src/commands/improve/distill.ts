// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm distill <ref>` — distil an asset and its feedback into a lesson (or,
 * for a reinforced memory, a knowledge) proposal. One bounded LLM call, then
 * the shared judge → mint path in `./stage`; the proposal queue is the only
 * way to a live asset. Every invocation emits one `distill_invoked` event
 * carrying its `outcome` (config-disabled runs emit none).
 *
 * Lesson refs: a nested input keeps its first scope segment
 * (`memories/project-a/deploy` → `lessons/project-a/memory-deploy-lesson`); an
 * unscoped input stays flat.
 */

import fs from "node:fs";
import distillKnowledgeSystemPrompt from "../../assets/prompts/distill-knowledge-system.md" with { type: "text" };
import distillLessonSystemPrompt from "../../assets/prompts/distill-lesson-system.md" with { type: "text" };
import { assembleAsset, assembleAssetFromString, serializeFrontmatterQuoted } from "../../core/asset/asset-serialize";
import { parseFrontmatter, writeSalienceToFrontmatter } from "../../core/asset/frontmatter";
import { stripMarkdownFences } from "../../core/asset/markdown";
import { conceptIdFromTypeName, parseRefInput } from "../../core/asset/resolve-ref";
import { authoringRulesForType } from "../../core/authoring-rules";
import { resolveStashDir } from "../../core/common";
import type { AkmConfig, ImproveProfileConfig } from "../../core/config/config";
import { getImproveProcessConfig, loadConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import { appendEvent, type EventsContext, readEvents } from "../../core/events";
import type { AkmDistillResult, DistillOutcome } from "../../core/improve-types";
import { lintLessonContent } from "../../core/lesson-lint";
import { parseEmbeddedJsonResponse } from "../../core/parse";
import { getDbPath } from "../../core/paths";
import { resolveStandardsContext } from "../../core/standards/resolve-standards-context";
import { withStateDb } from "../../core/state-db";
import { warn, warnVerbose } from "../../core/warn";
import { recordWrittenPath } from "../../core/write-provenance";
import { resolveAssetPath } from "../../indexer/walk/path-resolver";
import { assertRunnerCredentials } from "../../integrations/agent/runner-dispatch";
import type { chatCompletion } from "../../llm/client";
import { closeDatabase, openReadonlyExistingDatabase } from "../../storage/repositories/index-connection";
import { getAllEntries } from "../../storage/repositories/index-entries-repository";
import type { EligibilitySource } from "../proposal/proposal-types";
import { listProposals, type Proposal, type ProposalsContext } from "../proposal/repository";
import { detectDoubleFrontmatter, isValidDescription } from "../proposal/validators/proposal-quality-validators";
import { akmSearch } from "../read/search";
import { stripFrontmatterBody } from "./content-hash";
import {
  autoRepairLessonFrontmatter,
  autoSwapDescriptionWhenToUse,
  collectLessonQualityFindings,
  type DistillValidationFinding,
  repairLessonDescriptionTruncation,
} from "./distill/content-repair";
import { buildClsContext, checkDistillFidelity, DEFAULT_CLS_ADJACENT_COUNT } from "./distill-guards";
import { assessMemoryKnowledgePromotionCandidate, deriveKnowledgeRef } from "./distill-promotion-policy";
import { buildRefVocabulary, scoreEncodingSalience } from "./encoding-salience";
import { resolveImproveStrategy, resolveProcessEnabled } from "./improve-strategies";
import { recordLedgerAttempt } from "./ledger";
import { computeSalience, upsertAssetSalience } from "./salience";
import {
  callStage,
  type LlmRunner,
  mintProposal,
  type NoticeSet,
  noticeSet,
  rejectedProposalContext,
  runLessonQualityJudge,
  stageRunner,
} from "./stage";

/**
 * Input types distill structurally refuses: a lesson is the distilled form
 * (distilling one would mint `lessons/lesson-…-lesson`), and env/secret bytes
 * must never reach the model. The improve planner skips these before queuing.
 */
export const DISTILL_REFUSED_INPUT_TYPES: ReadonlySet<string> = new Set(["lesson", "env", "secret"]);

export function isDistillRefusedInputType(type: string): boolean {
  return DISTILL_REFUSED_INPUT_TYPES.has(type);
}

export interface AkmDistillOptions {
  /** Asset ref to distil from (`[bundle//]conceptId`). */
  ref: string;
  /** Active improve profile; absent falls back to the default strategy. */
  improveProfile?: ImproveProfileConfig;
  /** `lesson` always; `knowledge` always; `auto` lets a reinforced memory graduate to knowledge. */
  proposalKind?: "lesson" | "knowledge" | "auto";
  stashDir?: string;
  config?: AkmConfig;
  /** Exact runner frozen by the improve plan (an own key, `null` meaning none). */
  llmRunner?: LlmRunner | null;
  /** Shared improve deadline for generation and judging. */
  signal?: AbortSignal;
  /** Test seam: transport override. */
  chat?: typeof chatCompletion;
  /** Test seam: proposals clock / id. */
  ctx?: ProposalsContext;
  /** The improve run's events context (its long-lived state.db handle). */
  eventsCtx?: EventsContext;
  /** Test seam: event reader. */
  readEventsFn?: typeof readEvents;
  /** Test seam: resolve a ref to its file path (`null` when absent). */
  lookupFn?: (ref: string) => Promise<string | null>;
  /** Source-run id stamped on the queued proposal. */
  sourceRun?: string;
  /** Feedback events whose ref is listed never reach the prompt (`bench evolve` gold refs). */
  excludeFeedbackFromRefs?: readonly string[];
  excludeTags?: string[];
  includeTags?: string[];
  /** Test seam: top-N similar lessons for the judge and the CLS context. */
  fetchSimilarLessonsFn?: (query: string, n: number) => Promise<Array<{ ref: string; content: string }>>;
  /** The improve lane that selected the asset, stamped on the event and proposal. */
  eligibilitySource?: EligibilitySource;
  /** The input's durable `item_ref`; direct invocations key by the conceptId. */
  itemRef?: string;
}

/** Derive the proposed lesson ref from the input ref. */
export function deriveLessonRef(inputRef: string): string {
  const parsed = parseRefInput(inputRef);
  const parts = parsed.name.split("/");
  const scope = parts.length > 1 ? parts.shift() : undefined;
  const clean = (value: string): string =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  const safeScope = scope ? clean(scope) : "";
  return `lessons/${safeScope ? `${safeScope}/` : ""}${clean(`${parsed.type}-${parts.join("-")}`)}-lesson`;
}

// ── Output contract ──────────────────────────────────────────────────────────

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

export const DISTILL_KNOWLEDGE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["description", "body"],
  additionalProperties: false,
  properties: {
    description: { type: "string", minLength: 1, description: "One-line summary of the knowledge asset." },
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

interface StructuredDistillPayload {
  description?: unknown;
  when_to_use?: unknown;
  body?: unknown;
  tags?: unknown;
  sources?: unknown;
}

/**
 * Assemble markdown from a structured-output payload, or `null` when a
 * required field is empty (the caller then treats the response as markdown).
 */
export function assembleStructuredDistillMarkdown(
  payload: StructuredDistillPayload,
  kind: "lesson" | "knowledge",
): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
  const list = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0) : [];
  const description = text(payload.description);
  const body = text(payload.body);
  if (!description || !body) return null;
  const fm: Record<string, string | string[]> = { description };
  if (kind === "lesson") {
    const whenToUse = text(payload.when_to_use);
    if (!whenToUse) return null;
    fm.when_to_use = whenToUse;
  }
  const tags = list(payload.tags);
  if (tags.length > 0) fm.tags = tags;
  const sources = kind === "knowledge" ? list(payload.sources) : [];
  if (sources.length > 0) fm.xrefs = sources;
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
  // A present description must be a real summary (not `---` or a heading fragment).
  const description = parsed.data?.description;
  if (description !== undefined) {
    const check = isValidDescription(description, inputRef, { skipRefTailCheck: true });
    if (!check.ok) {
      findings.push({
        kind: "invalid-description",
        field: "description",
        message: `Distilled knowledge for ${inputRef} has an invalid description: ${check.reason}.`,
      });
    }
  }
  const doubled = detectDoubleFrontmatter(content);
  if (doubled) {
    findings.push({
      kind: doubled.kind,
      field: "body",
      message: `Distilled knowledge for ${inputRef}: ${doubled.message}`,
    });
  }
  return findings;
}

interface BuildPromptInput {
  inputRef: string;
  assetContent: string | null;
  feedback: { ts: string; eventType: string; metadata?: Record<string, unknown> }[];
  proposalKind?: "lesson" | "knowledge";
  /** Recent reviewer rejections for this ref ("don't repeat this"). */
  rejectedProposals?: Array<{ reason: string; contentPreview?: string }>;
  /** Stash authoring standards for the output. */
  standardsContext?: string;
}

/**
 * The distill user prompt. Feedback is rendered as "What worked" / "What
 * failed" contrast when it carries signals, else as a flat event list.
 */
export function buildDistillPrompt(input: BuildPromptInput): string {
  const lines: string[] = [`Asset ref: ${input.inputRef}`, ""];
  if (input.standardsContext?.trim()) {
    lines.push("Standards to follow (the rulebook for this target):", input.standardsContext.trim(), "");
  }
  const authoringRules = authoringRulesForType(input.proposalKind ?? "lesson");
  if (authoringRules) lines.push(authoringRules, "");
  lines.push("Asset content:");
  if (input.assetContent) {
    // Source frontmatter is not evidence; fed verbatim, models copied it into the body.
    lines.push("```", parseFrontmatter(input.assetContent).content.trim().slice(0, 3000), "```");
  } else {
    lines.push("(asset is not currently indexed; distil from feedback signal alone)");
  }
  lines.push("");

  const flat = (event: BuildPromptInput["feedback"][number]): string =>
    `- ${event.ts} ${event.eventType}${event.metadata ? ` ${JSON.stringify(event.metadata)}` : ""}`;
  if (input.feedback.length === 0) {
    lines.push("Recent feedback: (no feedback events recorded — distil from the asset itself)");
  } else {
    const worked: string[] = [];
    const failed: string[] = [];
    const other: string[] = [];
    for (const event of input.feedback) {
      const meta = event.metadata ?? {};
      const detail =
        (typeof meta.reason === "string" ? meta.reason : "") || (typeof meta.note === "string" ? meta.note : "");
      const line = `- ${event.ts}: ${detail || "feedback received"}`;
      if (meta.signal === "positive") worked.push(line);
      else if (meta.signal === "negative") failed.push(line);
      else other.push(flat(event));
    }
    if (worked.length > 0 || failed.length > 0) {
      for (const [heading, section] of [
        ["## What worked", worked],
        ["## What failed", failed],
        ["## Other signals", other],
      ] as const) {
        if (section.length > 0) lines.push(heading, ...section, "");
      }
    } else {
      lines.push("Recent feedback events (most recent last):", ...input.feedback.map(flat), "");
    }
  }
  if (input.rejectedProposals && input.rejectedProposals.length > 0) {
    lines.push(
      "",
      "Previously rejected proposals for this ref (Reflexion context):",
      "The following proposals were already reviewed and rejected. " +
        "Your new proposal MUST differ meaningfully in approach, framing, or evidence.",
    );
    for (const rp of input.rejectedProposals) {
      lines.push(`- Rejection reason: ${rp.reason}`);
      if (rp.contentPreview) lines.push(`  Content preview: ${rp.contentPreview.slice(0, 200).replace(/\n/g, " ")}`);
    }
  }
  lines.push(
    input.proposalKind === "knowledge"
      ? "Produce the knowledge markdown file now. Start your response with `---` on the first line, followed by a `description:` field whose value is a 1-sentence summary (20–400 chars). Never use placeholder values like `---`, `tbd`, `n/a`, or a single dash. If the source has nothing meaningful to summarize, do NOT produce a proposal — return an empty response instead. The frontmatter block ends with a second `---` line; do not emit any additional `---` fences in the body."
      : "Produce the lesson markdown file now. Start your response with `---` on the first line, followed by `description:` and `when_to_use:` fields. Both must be real one-sentence summaries (20–400 chars) — never placeholder values like `---`, `tbd`, or `n/a`. The frontmatter block ends with a second `---` line; do not emit any additional `---` fences in the body.",
  );
  return lines.join("\n");
}

// ── Invocation ───────────────────────────────────────────────────────────────

const DISABLED_MESSAGE = "distill is disabled in config; enable processes.distill.enabled to activate.";

type DistillKind = "lesson" | "knowledge";

/** Everything one distill invocation carries between its steps. */
interface DistillRun {
  options: AkmDistillOptions;
  inputRef: string;
  /** Durable key for events, feedback and the ledger: the planner's item_ref, else the conceptId. */
  ledgerRef: string;
  stash: string;
  config: AkmConfig;
  profile: ImproveProfileConfig;
  runner?: LlmRunner;
  notices: NoticeSet;
  eligMeta: { eligibilitySource?: EligibilitySource };
  /** `excludeFeedbackFromRefs` diagnostics, present only when the option was given. */
  exclusion?: { filteredFeedbackCount: number; feedbackFullyFiltered: boolean };
  asset: { path: string | null; content: string | null };
  vocabulary: Set<string>;
  outcomeWeightEnabled: boolean;
  similar: (query: string, n: number) => Promise<Array<{ ref: string; content: string }>>;
  lookup: (ref: string) => Promise<string | null>;
}

function emitDistill(run: Pick<DistillRun, "ledgerRef" | "eligMeta" | "options">, meta: Record<string, unknown>): void {
  appendEvent(
    { eventType: "distill_invoked", ref: run.ledgerRef, metadata: { ...meta, ...run.eligMeta } },
    run.options.eventsCtx,
  );
}

/** The exclusion diagnostics for an event (count only) or a result (count + fully-filtered). */
function exclusionMeta(run: DistillRun, forResult: boolean): Record<string, unknown> {
  if (!run.exclusion) return {};
  return forResult ? { ...run.exclusion } : { filteredFeedbackCount: run.exclusion.filteredFeedbackCount };
}

export async function akmDistill(options: AkmDistillOptions): Promise<AkmDistillResult> {
  const inputRef = options.ref.trim();
  if (!inputRef) {
    throw new UsageError("Asset ref is required. Usage: akm distill <ref>", "MISSING_REQUIRED_ARGUMENT");
  }
  const parsedInputRef = parseRefInput(inputRef);
  const config = options.config ?? loadConfig();
  const profile = options.improveProfile ?? resolveImproveStrategy(undefined, config).config;
  options = { ...options, improveProfile: profile };
  const targetKind = options.proposalKind ?? "lesson";
  const kind: DistillKind = targetKind === "knowledge" ? "knowledge" : "lesson";
  const outputRef = kind === "knowledge" ? deriveKnowledgeRef(inputRef) : deriveLessonRef(inputRef);
  if (!resolveProcessEnabled("distill", profile)) {
    return {
      schemaVersion: 1,
      ok: true,
      outcome: "config_disabled",
      inputRef,
      proposalRef: outputRef,
      proposalKind: kind,
      message: DISABLED_MESSAGE,
    };
  }

  const ledgerRef = options.itemRef ?? inputRef;
  const eligMeta = options.eligibilitySource ? { eligibilitySource: options.eligibilitySource } : {};
  if (isDistillRefusedInputType(parsedInputRef.type)) {
    const secret = parsedInputRef.type === "env" || parsedInputRef.type === "secret";
    const proposalRef = secret ? inputRef : conceptIdFromTypeName("lesson", parsedInputRef.name);
    const skipReason = secret ? "refused_secret_input" : "recursive_lesson_input";
    const message = secret
      ? `Distill refuses ${parsedInputRef.type} inputs — secret material must never be sent to the LLM.`
      : "Distill refuses lesson inputs — lessons are the distilled form, not a source.";
    emitDistill({ ledgerRef, eligMeta, options }, { outcome: "skipped", proposalRef, message, skipReason });
    return { schemaVersion: 1, ok: true, outcome: "skipped", inputRef, proposalRef, skipReason, message };
  }

  const stash = options.stashDir ?? resolveStashDir();
  const notices = noticeSet();
  const lookup = options.lookupFn ?? ((ref: string) => defaultLookup(ref, stash));
  const asset = await loadInput(lookup, inputRef);
  const run: DistillRun = {
    options,
    inputRef,
    ledgerRef,
    stash,
    config,
    profile,
    runner: stageRunner(options, config, profile, "distill", notices.add),
    notices,
    eligMeta,
    asset,
    vocabulary: loadRefVocabulary(),
    outcomeWeightEnabled: config.improve?.salience?.outcomeWeightEnabled !== false,
    similar: options.fetchSimilarLessonsFn ?? fetchTopSimilarLessons,
    lookup,
  };
  const feedbackEvents = readDistillFeedback(run);
  const result = await distill(run, targetKind, kind, outputRef, feedbackEvents);
  return { ...result, ...notices.fields() };
}

async function distill(
  run: DistillRun,
  targetKind: NonNullable<AkmDistillOptions["proposalKind"]>,
  kind: DistillKind,
  outputRef: string,
  feedbackEvents: ReturnType<typeof readEvents>["events"],
): Promise<AkmDistillResult> {
  // A reinforced memory graduates to knowledge without a generation call.
  const promotion = targetKind === "lesson" ? null : await planPromotion(run, feedbackEvents);
  if (promotion) {
    if (run.runner && (promotion.existing || qualityGateEnabled(run))) assertRunnerCredentials(run.runner);
    const promoted = await promoteToKnowledge(run, promotion);
    stampInputSalience(run);
    return promoted;
  }

  const feedback = feedbackEvents.slice(-20).map((event) => ({
    ts: event.ts,
    eventType: event.eventType,
    ...(event.metadata !== undefined ? { metadata: event.metadata } : {}),
  }));
  const { system, prompt } = await buildDistillMessages(run, feedback, kind, outputRef);
  const call = run.runner
    ? await callStage({
        feature: "distill",
        runner: run.runner,
        system,
        prompt,
        gate: { config: run.config, enabled: true },
        // The injected test transport never sees the schema.
        request: {
          ...(run.options.chat === undefined
            ? { responseSchema: kind === "knowledge" ? DISTILL_KNOWLEDGE_JSON_SCHEMA : DISTILL_LESSON_JSON_SCHEMA }
            : { chat: run.options.chat }),
          ...(run.options.signal ? { signal: run.options.signal } : {}),
        },
        onNotices: run.notices.add,
      })
    : ({ ok: false, reason: "error" } as const);
  // Durable input salience waits until the credential-bearing dispatch returned.
  stampInputSalience(run);
  if (!call.ok || call.raw.trim() === "") {
    if (!call.ok) warnVerbose(`[akm] LLM fallback for distill: ${call.reason}`);
    emitDistill(run, {
      outcome: "llm_failed",
      proposalRef: outputRef,
      proposalKind: kind,
      ...exclusionMeta(run, false),
    });
    return {
      schemaVersion: 1,
      ok: true,
      outcome: "llm_failed",
      inputRef: run.inputRef,
      proposalRef: outputRef,
      proposalKind: kind,
      message: "LLM call returned no usable output (timeout, empty, or error).",
      ...exclusionMeta(run, true),
    };
  }

  const assembled = assembleDistilledContent(run, call.raw, kind, outputRef);
  if ("rejection" in assembled) return assembled.rejection;
  return judgeAndQueue(run, {
    ref: outputRef,
    kind,
    content: assembled.content,
    source: run.asset.content,
    descriptionSwapped: assembled.descriptionSwapped,
  });
}

/** Turn the response into validated content: structured JSON or markdown, then lesson repairs and lint. */
function assembleDistilledContent(
  run: DistillRun,
  raw: string,
  kind: DistillKind,
  outputRef: string,
): { content: string; descriptionSwapped: number } | { rejection: AkmDistillResult } {
  const structured = parseEmbeddedJsonResponse<StructuredDistillPayload>(raw);
  let content =
    (structured && !Array.isArray(structured) ? assembleStructuredDistillMarkdown(structured, kind) : null) ??
    stripMarkdownFences(raw);
  let descriptionSwapped = 0;
  if (kind === "lesson") {
    content = autoRepairLessonFrontmatter(content, run.inputRef);
    ({ content, swapped: descriptionSwapped } = autoSwapDescriptionWhenToUse(content, run.inputRef));
    content = repairLessonDescriptionTruncation(content);
  }
  // Required structure missing means there is no asset to write: a hard reject.
  const structural =
    kind === "knowledge"
      ? validateKnowledgeContent(content, run.inputRef)
      : lintLessonContent(content, `distill:${run.inputRef}`).findings;
  if (structural.length > 0) {
    emitDistill(run, {
      outcome: "validation_failed",
      proposalRef: outputRef,
      proposalKind: kind,
      findingKinds: structural.map((f) => f.kind),
      ...exclusionMeta(run, false),
    });
    throw new UsageError(
      `Distilled ${kind} failed validation:\n${structural.map((f) => f.message).join("\n")}`,
      "MISSING_REQUIRED_ARGUMENT",
      kind === "knowledge"
        ? "Knowledge proposals require a non-empty markdown body."
        : "Lessons require non-empty `description` and `when_to_use` frontmatter fields. See v1 spec §13.",
    );
  }
  // Heuristic quality findings go to a human, not the bin.
  const quality = kind === "lesson" ? collectLessonQualityFindings(content, run.inputRef) : [];
  if (quality.length > 0) {
    return {
      rejection: rejectDistilled(run, outputRef, content, 2.0, quality.map((f) => f.message).join("\n"), {
        reviewNeeded: true,
        proposalKind: kind,
        findingKinds: quality.map((f) => f.kind),
      }),
    };
  }
  return { content, descriptionSwapped };
}

function qualityGateEnabled(run: DistillRun): boolean {
  return run.profile.processes?.distill?.qualityGate?.enabled ?? true;
}

/**
 * Judge the distilled content, then queue it. A rejected, uncertain or
 * source-contradicting result is recorded instead (see {@link writeQualityRejection}).
 */
async function judgeAndQueue(
  run: DistillRun,
  out: {
    ref: string;
    kind: DistillKind;
    content: string;
    source: string | null;
    descriptionSwapped?: number;
    /** Knowledge promotions keep their own frontmatter and skip the fidelity check. */
    promotion?: boolean;
  },
): Promise<AkmDistillResult> {
  let content = out.content;
  let confidence: number | undefined;
  if (qualityGateEnabled(run)) {
    const similarLessons = await run.similar(content.slice(0, 500), 3);
    const verdict = await runLessonQualityJudge(run.config, content, out.source ?? "", run.options.chat, {
      ...(similarLessons.length > 0 ? { similarLessons } : {}),
      ...(run.runner ? { llmRunner: run.runner } : {}),
      ...(run.options.signal ? { signal: run.options.signal } : {}),
      onNotices: run.notices.add,
    });
    if (!verdict.pass) {
      return rejectDistilled(run, out.ref, content, verdict.score, verdict.reason, {
        ...(verdict.reviewNeeded ? { reviewNeeded: true } : {}),
        ...(verdict.criteria ? { criteria: verdict.criteria } : {}),
      });
    }
    if (verdict.score > 0) confidence = verdict.score / 5;
  }

  let frontmatter: Record<string, unknown> | undefined;
  if (out.promotion) {
    const data = parseFrontmatter(content).data;
    if (Object.keys(data).length > 0) frontmatter = data;
  } else {
    // Optional check against the cited source; a contradiction goes to a human.
    const fidelity = (getImproveProcessConfig("distill", run.profile)?.fidelityCheck as { enabled?: boolean }) ?? {};
    if (fidelity.enabled && out.source) {
      try {
        const verdict = checkDistillFidelity(
          stripFrontmatterBody(content),
          [stripFrontmatterBody(out.source)],
          fidelity,
        );
        if (verdict.contradictionDetected) {
          return rejectDistilled(
            run,
            out.ref,
            content,
            2.0,
            verdict.reason ?? "Proposal may contradict cited source memories.",
            { reviewNeeded: true, fidelityContradiction: true },
          );
        }
      } catch {
        // The fidelity check is supplemental.
      }
    }
    // Canonical provenance goes into the content promotion writes.
    const parsed = parseFrontmatter(content);
    const xrefs = Array.isArray(parsed.data.xrefs) ? parsed.data.xrefs.map(String) : [];
    frontmatter = { ...parsed.data, xrefs: [...new Set([...xrefs, run.inputRef])] };
    delete frontmatter.sources;
    content = assembleAsset(frontmatter, parsed.content);
  }

  const proposal = mintProposal(
    run.stash,
    run.options.ctx,
    {
      ref: out.ref,
      source: "distill",
      ...(run.options.sourceRun !== undefined ? { sourceRun: run.options.sourceRun } : {}),
      payload: { content, ...(frontmatter ? { frontmatter } : {}) },
      ...(confidence !== undefined ? { confidence } : {}),
      ...(run.options.eligibilitySource ? { eligibilitySource: run.options.eligibilitySource } : {}),
      // The ledger keys the attempt by the input, not the output.
      attemptedRefs: [run.ledgerRef],
    },
    { judged: confidence !== undefined },
  );
  persistOutputEncodingSalience(run, out.ref, content);
  const swapped = out.descriptionSwapped ? { descriptionSwapped: out.descriptionSwapped } : {};
  emitDistill(run, {
    outcome: "queued",
    proposalRef: out.ref,
    proposalKind: out.kind,
    proposalId: proposal.id,
    ...(confidence !== undefined ? { judgeConfidence: confidence } : {}),
    ...(run.options.sourceRun !== undefined ? { sourceRun: run.options.sourceRun } : {}),
    ...exclusionMeta(run, false),
    ...swapped,
  });
  return {
    schemaVersion: 1,
    ok: true,
    outcome: "queued",
    inputRef: run.inputRef,
    proposalRef: out.ref,
    proposalKind: out.kind,
    proposalId: proposal.id,
    proposal,
    ...exclusionMeta(run, true),
    ...swapped,
  };
}

function rejectDistilled(
  run: DistillRun,
  proposalRef: string,
  content: string,
  score: number,
  reason: string,
  meta: Record<string, unknown>,
): AkmDistillResult {
  return writeQualityRejection({
    stash: run.stash,
    inputRef: run.inputRef,
    proposalRef,
    content,
    score,
    reason,
    meta: { ...meta, ...exclusionMeta(run, true) },
    eligibilitySource: run.options.eligibilitySource,
    eventsCtx: run.options.eventsCtx,
    proposalsCtx: run.options.ctx,
    sourceRun: run.options.sourceRun,
    ledgerRef: run.ledgerRef,
  });
}

/**
 * Record a distill quality-gate outcome and return its envelope.
 * `quality_rejected` lands in the improve ledger under the input's key (its
 * rejection window keeps selection from regenerating it); `review_needed`
 * mints a pending proposal for a human, stamped `deferred`/`quality-gate` so
 * the triage drain leaves it alone. Content the mint refuses still records
 * the attempt.
 */
export function writeQualityRejection(args: {
  stash: string;
  inputRef: string;
  proposalRef: string;
  content: string;
  score: number;
  reason: string;
  /** Spread into the event and the envelope; `reviewNeeded: true` selects `review_needed`. */
  meta?: Record<string, unknown>;
  eligibilitySource?: EligibilitySource;
  eventsCtx?: EventsContext;
  proposalsCtx?: ProposalsContext;
  sourceRun?: string;
  /** The input's ledger key (default `inputRef`). */
  ledgerRef?: string;
}): AkmDistillResult {
  const meta = args.meta ?? {};
  const outcome: DistillOutcome = meta.reviewNeeded ? "review_needed" : "quality_rejected";
  const ledgerRef = args.ledgerRef ?? args.inputRef;
  const access = { proposalsCtx: args.proposalsCtx, eventsCtx: args.eventsCtx };
  const attempt = { stashDir: args.stash, ref: ledgerRef, source: "distill", detail: args.reason };
  let proposal: Proposal | undefined;
  if (outcome === "quality_rejected") {
    recordLedgerAttempt(access, { ...attempt, outcome: "quality_rejected" });
  } else {
    try {
      proposal = mintProposal(
        args.stash,
        args.proposalsCtx,
        {
          ref: args.proposalRef,
          source: "distill",
          ...(args.sourceRun !== undefined ? { sourceRun: args.sourceRun } : {}),
          payload: { content: args.content },
          attemptedRefs: [ledgerRef],
          ...(args.eligibilitySource ? { eligibilitySource: args.eligibilitySource } : {}),
        },
        { review: { reason: "quality-review", gate: "quality-gate" } },
      );
    } catch (error) {
      warn(
        `[akm] writeQualityRejection: failed to queue ${args.proposalRef} for review: ${error instanceof Error ? error.message : String(error)}`,
      );
      recordLedgerAttempt(access, { ...attempt, outcome: "review_needed" });
    }
  }
  const eligMeta = args.eligibilitySource ? { eligibilitySource: args.eligibilitySource } : {};
  appendEvent(
    {
      eventType: "distill_invoked",
      ref: ledgerRef,
      metadata: {
        outcome,
        proposalRef: args.proposalRef,
        score: args.score,
        reason: args.reason,
        ...meta,
        ...eligMeta,
      },
    },
    args.eventsCtx,
  );
  return {
    schemaVersion: 1,
    ok: true,
    outcome,
    inputRef: args.inputRef,
    proposalRef: args.proposalRef,
    score: args.score,
    reason: args.reason,
    ...(proposal ? { proposalId: proposal.id, proposal } : {}),
    ...meta,
  } as AkmDistillResult;
}

// ── Memory → knowledge promotion ─────────────────────────────────────────────

interface PromotionPlan {
  knowledgeRef: string;
  content: string;
  /** Content already at the destination, when it exists. */
  existing: string | null;
}

async function planPromotion(
  run: DistillRun,
  feedbackEvents: ReturnType<typeof readEvents>["events"],
): Promise<PromotionPlan | null> {
  const assessment = assessMemoryKnowledgePromotionCandidate({
    inputRef: run.inputRef,
    assetContent: run.asset.content,
    feedbackEvents,
  });
  if (!assessment.promote || !assessment.content) return null;
  const existingPath = await run.lookup(assessment.knowledgeRef);
  let existing: string | null = null;
  try {
    if (existingPath && fs.existsSync(existingPath)) existing = fs.readFileSync(existingPath, "utf8");
  } catch {
    existing = null;
  }
  return { knowledgeRef: assessment.knowledgeRef, content: assessment.content, existing };
}

/**
 * Promote a reinforced memory to knowledge. An existing destination is
 * reconciled by the model (ADD/UPDATE swap content in, NOOP keeps what is
 * there); without a model the existing content is appended for the reviewer.
 */
async function promoteToKnowledge(run: DistillRun, plan: PromotionPlan): Promise<AkmDistillResult> {
  let content = plan.content;
  if (plan.existing && run.runner) {
    const merged = await callStage({
      feature: "distill",
      runner: run.runner,
      system: "Return only valid JSON. No prose.",
      prompt: [
        "You are merging two versions of a knowledge document.",
        "Existing content is already committed; new content comes from a memory distillation run.",
        "Choose one of: ADD (combine both), UPDATE (replace existing with new), NOOP (keep existing unchanged).",
        'Return ONLY valid JSON: {"action": "ADD"|"UPDATE"|"NOOP", "content": "<merged markdown if ADD/UPDATE, empty string if NOOP>"}',
        "",
        "## Existing knowledge content",
        "```",
        plan.existing.slice(0, 3000),
        "```",
        "",
        "## New content from distillation",
        "```",
        plan.content.slice(0, 3000),
        "```",
      ].join("\n"),
      request: {
        ...(run.options.signal ? { signal: run.options.signal } : {}),
        ...(run.options.chat ? { chat: run.options.chat } : {}),
      },
      onNotices: run.notices.add,
    });
    const decision = merged.ok
      ? parseEmbeddedJsonResponse<{ action: "ADD" | "UPDATE" | "NOOP"; content?: string }>(merged.raw)
      : undefined;
    if (decision?.action === "NOOP") {
      emitDistill(run, {
        outcome: "skipped",
        proposalRef: plan.knowledgeRef,
        message: "D-1: LLM resolved destination conflict as NOOP — existing content kept",
      });
      return {
        schemaVersion: 1,
        ok: true,
        outcome: "skipped",
        inputRef: run.inputRef,
        proposalRef: plan.knowledgeRef,
        skipReason: "conflict_noop",
        message: "Existing knowledge content unchanged (contradiction resolution: NOOP)",
      };
    }
    if ((decision?.action === "ADD" || decision?.action === "UPDATE") && decision.content?.trim()) {
      content = decision.content;
    }
  } else if (plan.existing) {
    content = [
      plan.content,
      "",
      "---",
      "<!-- D-1 / #369: Existing knowledge content is shown below for reviewer reference. -->",
      "<!-- Review: decide whether to ADD (merge), UPDATE (replace), or NOOP (keep existing). -->",
      "",
      "## Existing content (for reviewer reference)",
      "",
      plan.existing,
    ].join("\n");
  }
  return judgeAndQueue(run, {
    ref: plan.knowledgeRef,
    kind: "knowledge",
    content,
    source: run.asset.content,
    promotion: true,
  });
}

// ── Inputs ───────────────────────────────────────────────────────────────────

/** Read the input asset (best-effort: an unindexed asset distils from feedback alone). */
async function loadInput(
  lookup: (ref: string) => Promise<string | null>,
  inputRef: string,
): Promise<DistillRun["asset"]> {
  try {
    const filePath = await lookup(inputRef);
    if (filePath && fs.existsSync(filePath)) return { path: filePath, content: fs.readFileSync(filePath, "utf8") };
  } catch {
    // An index miss is not fatal.
  }
  return { path: null, content: null };
}

/** The index's ref bigram vocabulary, for the novelty term of encoding salience. */
function loadRefVocabulary(): Set<string> {
  try {
    const db = openReadonlyExistingDatabase(getDbPath(), { isolatedSnapshot: true });
    if (!db) return new Set();
    try {
      return buildRefVocabulary(getAllEntries(db).map((e) => e.itemRef));
    } finally {
      closeDatabase(db);
    }
  } catch {
    return new Set();
  }
}

/**
 * Score the input's encoding salience and mirror it to the asset frontmatter
 * and `asset_salience` (keyed by the ledger ref). Best-effort throughout.
 */
function stampInputSalience(run: DistillRun): void {
  const { content, path: filePath } = run.asset;
  if (!content || !filePath) return;
  try {
    const type = parseRefInput(run.inputRef).type;
    let revisionCount = 0;
    try {
      // Revisions so far: every proposal raised against this ref.
      revisionCount = listProposals(run.stash, { ref: run.inputRef, includeArchive: true }).length;
    } catch {
      // Unknown history scores as a first encounter.
    }
    const scored = scoreEncodingSalience({ body: content, type, existingRefVocabulary: run.vocabulary, revisionCount });
    const updated = writeSalienceToFrontmatter(content, scored.score, scored);
    if (updated !== content) {
      fs.writeFileSync(filePath, updated, "utf8");
      recordWrittenPath(filePath);
      run.asset.content = updated;
    }
    try {
      withStateDb((stateDb) =>
        upsertAssetSalience(
          stateDb,
          run.ledgerRef,
          computeSalience({
            ref: run.inputRef,
            type,
            retrievalFreq: 0,
            encodingSalience: scored.score,
            outcomeWeightEnabled: run.outcomeWeightEnabled,
          }),
        ),
      );
    } catch {
      // The frontmatter mirror is the only persistence then.
    }
  } catch {
    // Scoring never blocks distillation.
  }
}

/**
 * Content-score a distilled output so it carries a real encoding salience from
 * creation — lessons are refused as inputs, so this is their only chance.
 */
function persistOutputEncodingSalience(run: DistillRun, ref: string, body: string): void {
  try {
    const type = parseRefInput(ref).type;
    const scored = scoreEncodingSalience({ body, type, existingRefVocabulary: run.vocabulary, revisionCount: 0 });
    withStateDb((stateDb) =>
      upsertAssetSalience(
        stateDb,
        ref,
        computeSalience({
          ref,
          type,
          retrievalFreq: 0,
          encodingSalience: scored.score,
          outcomeWeightEnabled: run.outcomeWeightEnabled,
        }),
      ),
    );
  } catch {
    // Scoring never blocks proposal creation.
  }
}

/** The ref's feedback events, minus any `excludeFeedbackFromRefs` matches. */
function readDistillFeedback(run: DistillRun): ReturnType<typeof readEvents>["events"] {
  const read =
    run.options.readEventsFn ??
    ((readOptions: Parameters<typeof readEvents>[0]) => readEvents(readOptions, { readOnly: true }));
  const { events } = read({
    ref: run.ledgerRef,
    type: "feedback",
    excludeTags: run.options.excludeTags,
    includeTags: run.options.includeTags,
  });
  const excluded = new Set(
    (run.options.excludeFeedbackFromRefs ?? []).map((ref) => ref.trim()).filter((ref) => ref.length > 0),
  );
  if (excluded.size === 0) return events;
  const kept = events.filter((e) => !(e.ref !== undefined && excluded.has(e.ref)));
  run.exclusion = {
    filteredFeedbackCount: events.length - kept.length,
    feedbackFullyFiltered: events.length > 0 && kept.length === 0,
  };
  return kept;
}

/** System + user prompt: rejected-proposal context, optional CLS neighbours, stash standards. */
async function buildDistillMessages(
  run: DistillRun,
  feedback: BuildPromptInput["feedback"],
  kind: DistillKind,
  outputRef: string,
): Promise<{ system: string; prompt: string }> {
  const rejectedProposals = rejectedProposalContext(run.stash, run.inputRef, run.options.ctx);
  // CLS interleaving (default off): show related lessons so the model does not overwrite them.
  const cls =
    (getImproveProcessConfig("distill", run.profile)?.cls as { enabled?: boolean; adjacentCount?: number }) ?? {};
  let clsContext = "";
  if (cls.enabled) {
    try {
      const query = run.asset.content ? run.asset.content.slice(0, 500) : run.inputRef;
      clsContext = buildClsContext(await run.similar(query, cls.adjacentCount ?? DEFAULT_CLS_ADJACENT_COUNT), cls);
    } catch {
      // CLS context is supplemental.
    }
  }
  const standardsContext = resolveStandardsContext(outputRef, run.stash);
  const prompt = buildDistillPrompt({
    inputRef: run.inputRef,
    assetContent: run.asset.content,
    feedback,
    proposalKind: kind,
    ...(rejectedProposals.length > 0 ? { rejectedProposals } : {}),
    ...(standardsContext.trim() ? { standardsContext } : {}),
  });
  return {
    system: kind === "knowledge" ? distillKnowledgeSystemPrompt : distillLessonSystemPrompt,
    prompt: `${prompt}${clsContext}`,
  };
}

async function defaultLookup(ref: string, stashDir: string): Promise<string | null> {
  return resolveAssetPath(ref, {
    stashDir,
    mode: "disk-only",
    directoryIndexNames: ["SKILL.md"],
    preserveDirectNameFallback: true,
    honorOrigin: false,
  });
}

/** Top-N existing lessons similar to `query` (empty when search is unavailable). */
async function fetchTopSimilarLessons(query: string, n: number): Promise<Array<{ ref: string; content: string }>> {
  try {
    const result = await akmSearch({ query, type: "lesson", limit: n, skipLogging: true, eventSource: "improve" });
    return (result?.hits ?? [])
      .filter((h): h is import("../../sources/types").SourceSearchHit => "path" in h && typeof h.path === "string")
      .slice(0, n)
      .map((h) => {
        let content = "";
        try {
          if (h.path && fs.existsSync(h.path)) content = fs.readFileSync(h.path, "utf8");
        } catch {
          // best-effort
        }
        return { ref: h.ref, content };
      });
  } catch {
    return [];
  }
}
