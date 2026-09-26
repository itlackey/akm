// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm reflect [ref]` — ask an engine for a revised asset and queue it as a
 * proposal (`source: "reflect"`). Reflect never writes an asset: the proposal
 * queue is the only path, `akm proposal accept` the bridge.
 *
 * Every invocation closes with one `reflect_completed` event; `reflect_invoked`
 * is emitted once the dispatch has validated its credentials (deterministic
 * pre-dispatch refusals still emit both).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assembleAssetFromString, serializeFrontmatter } from "../../core/asset/asset-serialize";
import { parseFrontmatter } from "../../core/asset/frontmatter";
import { type AssetRef, conceptIdFromTypeName, parseRefInput } from "../../core/asset/resolve-ref";
import { DESCRIPTION_MAX_CHARS, requiresDescription } from "../../core/authoring-rules";
import { resolveStashDir } from "../../core/common";
import type { AkmConfig, ImproveProfileConfig } from "../../core/config/config";
import { loadConfig } from "../../core/config/config";
import { generatedContentRejection, stripReflectPromptScaffolding } from "../../core/content-safety";
import { ConfigError, UsageError } from "../../core/errors";
import { appendEvent, type EventsContext, readEvents } from "../../core/events";
import type { AkmReflectFailure, AkmReflectResult } from "../../core/improve-types";
import { lintLessonContent } from "../../core/lesson-lint";
import { parseEmbeddedJsonResponse } from "../../core/parse";
import { redactSensitiveText } from "../../core/redaction";
import { resolveStandardsContext } from "../../core/standards/resolve-standards-context";
import { warn, warnOnce } from "../../core/warn";
import { lookup } from "../../indexer/indexer";
import type { AgentFailureReason, AgentRunResult, RunAgentOptions } from "../../integrations/agent";
import { DEFAULT_LLM_TIMEOUT_MS } from "../../integrations/agent/config";
import {
  fallbackAnnouncement,
  NO_ENGINE_MESSAGE_SUFFIX,
  NO_ENGINE_REMEDY,
  withEngineFallback,
} from "../../integrations/agent/engine-fallback";
import { buildExecution, resolveExecution } from "../../integrations/agent/execution";
import {
  buildReflectOutputRepairPrompt,
  buildReflectPrompt,
  extractDraftConfidence,
  parseAgentProposalPayload,
  REFLECT_CONTENT_CAP,
  REFLECT_TRUNCATION_MARKER,
  type ReflectLlmOutputMode,
  type ReflectPromptInput,
} from "../../integrations/agent/prompts";
import { type RunnerSpec, runnerIsLlm, runnerSupportsFileWrite } from "../../integrations/agent/runner";
import {
  assertRunnerCredentials,
  collectDispatchSensitiveValues,
  type RunExecutionOptions,
  runExecution,
} from "../../integrations/agent/runner-dispatch";
import { type ChatMessage, type chatCompletion, isJsonSchemaKnownUnsupported, LlmCallError } from "../../llm/client";
import { baseFailureFields, enoentHintMessage, isEnoentFailure } from "../agent/agent-support";
import type { EligibilitySource } from "../proposal/proposal-types";
import type { CreateProposalInput, ProposalsContext } from "../proposal/repository";
import { checkReflectSize, isValidDescription } from "../proposal/validators/proposal-quality-validators";
import { CHARS_PER_TOKEN, DEFAULT_CONTEXT_LENGTH_TOKENS } from "./consolidate/chunking";
import { deriveLessonRef } from "./distill";
import { findAssetFilePath } from "./eligibility";
import { resolveImproveLlmExecution } from "./execution";
import { recordLedgerAttempt } from "./ledger";
import { classifyReflectChange, splitFrontmatter } from "./reflect-noise";
import {
  callStage,
  type LlmRunner,
  mintProposal,
  type Notice,
  noticeSet,
  rejectedProposalContext,
  runReflectQualityJudge,
} from "./stage";

export interface AkmReflectOptions {
  /** Active improve profile; its per-process `reflect` override wins over the default strategy. */
  improveProfile?: ImproveProfileConfig;
  /** Asset ref (`[bundle//]conceptId`) to focus on. */
  ref?: string;
  /** Task hint passed through to the prompt. */
  task?: string;
  /** Named engine override (defaults to `defaults.engine`). */
  engine?: string;
  timeoutMs?: number;
  /** Shared improve deadline for dispatch and judging. */
  signal?: AbortSignal;
  stashDir?: string;
  /** Bundle destination for the proposal. */
  target?: NonNullable<CreateProposalInput["target"]>;
  /** Test seam: forwarded to the agent spawn. */
  runAgentOptions?: Pick<RunAgentOptions, "spawn" | "setTimeoutFn" | "clearTimeoutFn">;
  /** Test seam: SDK generation without a real SDK server. */
  runSdk?: RunExecutionOptions["runSdk"];
  /** Test seam: proposal clock / id. */
  ctx?: ProposalsContext;
  /** The improve run's events context (its long-lived state.db handle). */
  eventsCtx?: EventsContext;
  /** Recent reflect errors in this improve run, shown to the model as patterns to avoid. */
  avoidPatterns?: string[];
  /** Test seam: transport override for generation and the judge. */
  chat?: typeof chatCompletion;
  config?: AkmConfig;
  /** `"improve"` tags agent subprocess events so they stay out of user history. */
  eventSource?: "user" | "improve";
  /** Defer "low-value" micro-rewrites like no-op/cosmetic ones (`processes.reflect.lowValueFilter`). */
  lowValueFilter?: boolean;
  /** Self-refine passes (default 1; each later pass critiques the prior draft). */
  maxRefineIters?: number;
  /** Test seam: pre-loaded source content instead of the index lookup. */
  assetContent?: string;
  /** The improve lane that selected the asset, stamped on events and the proposal. */
  eligibilitySource?: EligibilitySource;
  /** The asset's durable `item_ref`; direct invocations key by the conceptId. */
  itemRef?: string;
}

const MAX_FEEDBACK_LINES = 10;
const MAX_GLOBAL_FEEDBACK_LINES = 20;

function readOnlyEventsContext(ctx?: EventsContext): EventsContext {
  return ctx?.db ? ctx : { ...(ctx ?? {}), readOnly: true };
}

/** Recent `feedback` lines for `ref` (or across all assets without one). Best-effort. */
function readRecentFeedback(ref?: string, eventsCtx?: EventsContext): string[] {
  try {
    const events = readEvents({ type: "feedback", ...(ref ? { ref } : {}) }, readOnlyEventsContext(eventsCtx)).events;
    return events.slice(-(ref ? MAX_FEEDBACK_LINES : MAX_GLOBAL_FEEDBACK_LINES)).map((event) => {
      const md = event.metadata ?? {};
      const signal = typeof md.signal === "string" ? md.signal : "?";
      const note = typeof md.reason === "string" ? md.reason : typeof md.note === "string" ? md.note : "";
      const details = note ? `[${signal}] ${note}` : `[${signal}]`;
      return !ref && event.ref ? `${event.ref} ${details}` : details;
    });
  } catch {
    return [];
  }
}

/**
 * Types reflect may rewrite: its output is frontmatter + markdown, which would
 * break a script or env file. Another type is allowed only when its current
 * content already has that shape; secrets are never read.
 */
export const REFLECT_ALLOWED_TYPES: ReadonlySet<string> = new Set([
  "knowledge",
  "memory",
  "lesson",
  "skill",
  "agent",
  "command",
  "workflow",
]);

const REFLECT_REFUSED_TYPES: ReadonlySet<string> = new Set(["secret"]);

/** Identity fields the model may never change (a renamed `name` breaks ref resolution). */
const PROTECTED_FRONTMATTER_FIELDS: ReadonlySet<string> = new Set(["name", "ref", "id", "slug", "type"]);

/**
 * A fresh tmp path per iteration for the agent/SDK file-write contract (long
 * bodies are written to a file instead of fenced JSON on stdout). The direct
 * LLM runner has no filesystem and never gets one.
 */
function synthesizeReflectDraftPath(ref: string | undefined): string {
  const safeRef = (ref ?? "no-ref").replace(/[^a-z0-9_-]/gi, "_");
  const rand = Math.random().toString(36).slice(2, 8);
  return path.join(os.tmpdir(), `akm-reflect-${safeRef}-${Date.now()}-${rand}.md`);
}

/** Lesson lint findings for the prompt: a concrete starting point for the revision. */
function buildSchemaHints(type: string, content: string | undefined): string[] {
  if (!content || type !== "lesson") return [];
  return lintLessonContent(content, "reflect").findings.map((f) => `[${f.kind}] ${f.message}`);
}

interface RelatedLesson {
  ref: string;
  content: string;
}

/**
 * Lessons related to a skill: its derived lesson, lessons distilled from it,
 * and lessons citing it in `sources`. Without independent feedback on the skill,
 * lessons reflect itself produced are dropped so its own output is not fed
 * back as evidence.
 */
async function readRelatedLessons(
  stash: string,
  ref: string,
  parsedRef: { type: string; name: string },
  itemRef: string | undefined,
  eventsCtx: EventsContext | undefined,
): Promise<RelatedLesson[]> {
  if (parsedRef.type !== "skill") return [];
  const cache = new Map<string, string>();
  const read = (filePath: string): string => {
    const key = path.resolve(filePath);
    const cached = cache.get(key) ?? fs.readFileSync(filePath, "utf8");
    cache.set(key, cached);
    return cached;
  };
  const related = new Map<string, RelatedLesson>();
  const derivedLessonRef = deriveLessonRef(ref);
  const candidateRefs = new Set<string>([derivedLessonRef]);
  const derivedLessonPath = path.join(stash, "lessons", `${parseRefInput(derivedLessonRef).name}.md`);
  if (fs.existsSync(derivedLessonPath)) {
    related.set(derivedLessonRef, { ref: derivedLessonRef, content: read(derivedLessonPath) });
  }
  try {
    const keys = new Set([itemRef ?? ref]);
    for (const event of readEvents({ type: "distill_invoked" }, readOnlyEventsContext(eventsCtx)).events) {
      if (event.ref === undefined || !keys.has(event.ref)) continue;
      const proposalRef = typeof event.metadata?.proposalRef === "string" ? event.metadata.proposalRef : undefined;
      if (proposalRef && lenientRefType(proposalRef) === "lesson") candidateRefs.add(proposalRef);
    }
  } catch {
    // best-effort
  }
  for (const candidateRef of candidateRefs) {
    try {
      const filePath = await findAssetFilePath(candidateRef, stash);
      if (filePath && fs.existsSync(filePath))
        related.set(candidateRef, { ref: candidateRef, content: read(filePath) });
    } catch {
      // An index miss is not fatal.
    }
  }
  try {
    const lessonsDir = path.join(stash, "lessons");
    if (fs.existsSync(lessonsDir)) {
      for (const fileName of fs.readdirSync(lessonsDir)) {
        if (!fileName.endsWith(".md")) continue;
        const content = read(path.join(lessonsDir, fileName));
        const sources = parseFrontmatter(content).data.sources;
        if (!Array.isArray(sources) || !sources.some((s) => typeof s === "string" && s.trim() === ref)) continue;
        const lessonRef = conceptIdFromTypeName("lesson", fileName.slice(0, -3));
        if (!related.has(lessonRef)) related.set(lessonRef, { ref: lessonRef, content });
      }
    }
  } catch {
    // best-effort
  }
  let hasIndependentFeedback = true;
  try {
    hasIndependentFeedback = readEvents({ type: "feedback", ref }, readOnlyEventsContext(eventsCtx)).events.length > 0;
  } catch {
    // Unknown: keep every lesson.
  }
  if (!hasIndependentFeedback) {
    for (const [lessonRef, lesson] of related) {
      try {
        if (parseFrontmatter(lesson.content).data.derived_from_reflect === true) related.delete(lessonRef);
      } catch {
        // Unparseable frontmatter: keep it.
      }
    }
  }
  return [...related.values()];
}

/** The asset type of a maybe-ref, or `""` when it does not parse. */
function lenientRefType(ref: string | undefined): string {
  if (!ref) return "";
  try {
    return parseRefInput(ref).type;
  } catch {
    return "";
  }
}

export interface ReflectSanitizeResult {
  /** Sanitized content (source frontmatter restored + merged). */
  content: string;
  frontmatter?: Record<string, unknown>;
  /** Non-fatal notes for the event. */
  warnings: string[];
  sizeGuardRatio?: { code: "EXCESSIVE_SHRINKAGE" | "EXCESSIVE_EXPANSION"; ratio: number };
  /** The model echoed REFLECT_TRUNCATION_MARKER into its rewrite. */
  truncationMarkerLeaked?: boolean;
}

/**
 * Cut a duplicate frontmatter block the model appended after its rewrite.
 * Requires a balanced fence AND `key:` lines so thematic breaks survive.
 */
function stripAppendedFrontmatter(body: string): string {
  const match = body.match(/\n---\r?\n([\s\S]*?)\n---\r?\n/);
  if (!match || !/^\w[\w-]*:/m.test(match[1]!)) return body;
  return body.slice(0, body.indexOf(match[0])).replace(/\s+$/, "");
}

/**
 * A description derived from existing metadata (title, first heading, first
 * prose sentence) that passes `isValidDescription`, or `undefined`. Never
 * free-form invention.
 */
function deriveDescriptionFromAsset(
  title: unknown,
  proposedBody: string,
  sourceBody: string,
  targetRef: string,
): string | undefined {
  const candidates: Array<{ text: string; kind: "fragment" | "prose" }> = [];
  if (typeof title === "string" && title.trim()) candidates.push({ text: title.trim(), kind: "fragment" });
  for (const body of [proposedBody, sourceBody]) {
    const heading = body.match(/^#{1,6}\s+(.+?)\s*$/m)?.[1];
    if (heading) candidates.push({ text: heading.trim(), kind: "fragment" });
  }
  for (const body of [proposedBody, sourceBody]) {
    const sentence = firstProseSentence(body);
    if (sentence) candidates.push({ text: sentence, kind: "prose" });
  }
  for (const { text, kind } of candidates) {
    const normalized = text
      .replace(/`/g, "")
      .replace(/^[#>*\-\s]+/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized) continue;
    // A bare title/heading reads poorly as a description: prefer the sentence form.
    const variants = kind === "fragment" ? [`Reference notes on ${normalized}.`, normalized] : [normalized];
    for (const v of variants) {
      const clamped = v.length > DESCRIPTION_MAX_CHARS ? v.slice(0, DESCRIPTION_MAX_CHARS).trimEnd() : v;
      if (isValidDescription(clamped, targetRef, { skipRefTailCheck: true }).ok) return clamped;
    }
  }
  return undefined;
}

function firstProseSentence(body: string): string {
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^(#{1,6}\s|```|~~~|[-*+]\s|\d+\.\s|>|\||<!--)/.test(line)) continue;
    return (line.match(/^(.+?[.!?])(\s|$)/)?.[1] ?? line).trim();
  }
  return "";
}

/**
 * Reflect's content rails: the source frontmatter is restored and the model's
 * frontmatter merged on top except identity fields; a stray or appended
 * frontmatter block and echoed run-only guidance are stripped; a missing
 * required description is derived deterministically; a body outside the size
 * ratios or echoing the truncation notice is flagged for review.
 */
export function sanitizeReflectPayload(
  payload: { content: string; frontmatter?: Record<string, unknown> },
  sourceContent: string | undefined,
  targetRef: string,
): ReflectSanitizeResult {
  const warnings: string[] = [];
  const { fmText: sourceFmText, body: sourceBody } = sourceContent
    ? splitFrontmatter(sourceContent)
    : { fmText: null, body: "" };
  const sourceFm = sourceFmText !== null ? parseFrontmatter(sourceContent ?? "").data : {};
  const { fmText: llmFmText, body: rawLlmBody } = splitFrontmatter(payload.content);
  let llmFm: Record<string, unknown> = {};
  if (llmFmText !== null) {
    warnings.push("LLM emitted frontmatter in content; stripped and merged through identity guard.");
    try {
      llmFm = parseFrontmatter(payload.content).data;
    } catch {
      llmFm = {};
    }
  }
  if (payload.frontmatter && typeof payload.frontmatter === "object") llmFm = { ...llmFm, ...payload.frontmatter };
  for (const field of PROTECTED_FRONTMATTER_FIELDS) {
    if (field in llmFm && llmFm[field] !== sourceFm[field]) {
      warnings.push(`LLM attempted to change protected frontmatter field "${field}"; restored from source.`);
      delete llmFm[field];
    }
  }
  const mergedFm: Record<string, unknown> = { ...sourceFm, ...llmFm };
  for (const field of PROTECTED_FRONTMATTER_FIELDS) if (field in sourceFm) mergedFm[field] = sourceFm[field];

  const scaffolding = stripReflectPromptScaffolding(stripAppendedFrontmatter(rawLlmBody.replace(/^\s+/, "")));
  const cleanedBody = scaffolding.content;
  if (scaffolding.stripped) {
    warnings.push('Removed echoed run-only "Avoid These Patterns" guidance from the proposed asset body (#963).');
  }

  // Only a source that already has frontmatter but no description gets one:
  // injecting a whole block, or overwriting an authored one, is out of scope.
  const refType = lenientRefType(targetRef);
  const desc = mergedFm.description;
  const sourceHadFrontmatter = sourceFmText !== null && Object.keys(sourceFm).length > 0;
  if (
    refType &&
    requiresDescription(refType) &&
    (typeof desc !== "string" || desc.trim().length === 0) &&
    sourceHadFrontmatter
  ) {
    const derived = deriveDescriptionFromAsset(mergedFm.title, cleanedBody, sourceBody, targetRef);
    if (derived) {
      mergedFm.description = derived;
      warnings.push(
        "Synthesized a deterministic `description` from title/heading (#636) — source and proposal lacked one.",
      );
    }
  }

  const size = checkReflectSize(sourceBody, cleanedBody);
  let sizeGuardRatio: ReflectSanitizeResult["sizeGuardRatio"];
  if (!size.ok) {
    const shrink = size.code === "EXCESSIVE_SHRINKAGE";
    warnings.push(
      `${size.code} — proposed body is ${(size.ratio * 100).toFixed(0)}% of source (${shrink ? "minimum 50%" : "maximum 250%"}) for ref ${targetRef}. ${shrink ? "Concrete content was likely deleted." : "Speculative material was likely added."} Flagged for review.`,
    );
    sizeGuardRatio = { code: size.code, ratio: size.ratio };
  }
  const truncationMarkerLeaked = cleanedBody.includes(REFLECT_TRUNCATION_MARKER);
  if (truncationMarkerLeaked) {
    warnings.push(
      `Proposed body for ref ${targetRef} contains the truncation-notice text the model was shown for a capped source asset ("${REFLECT_TRUNCATION_MARKER}"). The model likely echoed the notice instead of writing real content. Flagged for review.`,
    );
  }
  // No frontmatter at all stays body-only, never gaining a stray `---`.
  const hasFrontmatter = Object.keys(mergedFm).length > 0;
  return {
    content: hasFrontmatter ? assembleAssetFromString(serializeFrontmatter(mergedFm), cleanedBody) : cleanedBody,
    ...(hasFrontmatter ? { frontmatter: mergedFm } : {}),
    warnings,
    ...(sizeGuardRatio ? { sizeGuardRatio } : {}),
    ...(truncationMarkerLeaked ? { truncationMarkerLeaked } : {}),
  };
}

// ── Direct-LLM output contract ───────────────────────────────────────────────

const REFLECT_FRONTMATTER_PATCH_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["description", "when_to_use"],
  additionalProperties: false,
  properties: {
    description: { type: ["string", "null"] },
    when_to_use: { type: ["string", "null"] },
  },
};

const REFLECT_CONFIDENCE_SCHEMA = {
  type: "number",
  minimum: 0,
  maximum: 1,
  description:
    "Self-reported quality confidence in [0, 1]. Persisted on the proposal for reviewers and the triage judge to read during adjudication.",
};

export const REFLECT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["content", "confidence", "frontmatterPatch"],
  additionalProperties: false,
  properties: {
    content: { type: "string", description: "Complete improved markdown body without YAML frontmatter." },
    confidence: REFLECT_CONFIDENCE_SCHEMA,
    frontmatterPatch: REFLECT_FRONTMATTER_PATCH_JSON_SCHEMA,
  },
};

const REFLECT_UNSCOPED_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["ref", "content", "confidence", "frontmatterPatch"],
  additionalProperties: false,
  properties: {
    ref: { type: "string", description: "Selected asset ref as a subdir-qualified conceptId." },
    content: { type: "string", description: "Complete improved markdown body without YAML frontmatter." },
    confidence: { type: "number", minimum: 0, maximum: 1, description: "Self-reported quality confidence in [0, 1]." },
    frontmatterPatch: REFLECT_FRONTMATTER_PATCH_JSON_SCHEMA,
  },
};

/**
 * Frame for JSON Schema unless the connection disabled it or already proved
 * this process that it rejects it (the transport retries plain text on a 4xx).
 */
function wantsJsonSchemaOutput(connection: { endpoint: string; model: string; supportsJsonSchema?: boolean }): boolean {
  return connection.supportsJsonSchema !== false && !isJsonSchemaKnownUnsupported(connection);
}

/** Injected between the prior draft and the refinement request (self-refine). */
const REFLECT_CRITIQUE_PROMPT =
  "Your previous proposal is shown above. Review it critically and provide an improved version that is more specific, actionable, and avoids any issues with the previous attempt. Return only the improved response using the output contract from the original prompt.";

export interface RunReflectViaLlmOptions {
  prompt: string | undefined;
  runner: LlmRunner;
  timeoutMs?: number | null;
  signal?: AbortSignal;
  /** Prior draft for self-refine critique (iterations > 0). */
  priorDraft?: string;
  iteration: number;
  /** JSON Schema for structured output (the transport falls back once on a 4xx). */
  responseSchema?: Record<string, unknown>;
  chat?: typeof chatCompletion;
  maxTokens?: number;
  /** Ignored: the HTTP transport has no filesystem for the file-write contract. */
  draftFilePath?: string;
  outputMode: ReflectLlmOutputMode;
  /** Known target identity; target-scoped output never echoes it. */
  targetRef?: string;
  /** Invocation-wide repair budget gate (default true). */
  allowRepair?: boolean;
  onNotices?: (notices: readonly Notice[]) => void;
}

interface ReflectLlmTelemetry {
  outputMode: ReflectLlmOutputMode;
  repairAttempts: number;
}

function parsedRecord(result: AgentRunResult): Record<string, unknown> | undefined {
  return result.parsed && typeof result.parsed === "object" && !Array.isArray(result.parsed)
    ? (result.parsed as Record<string, unknown>)
    : undefined;
}

function reflectLlmTelemetry(result: AgentRunResult): ReflectLlmTelemetry | undefined {
  const parsed = parsedRecord(result);
  if (!parsed || (parsed.outputMode !== "json_schema" && parsed.outputMode !== "framed_markdown")) return undefined;
  if (typeof parsed.repairAttempts !== "number") return undefined;
  return { outputMode: parsed.outputMode, repairAttempts: parsed.repairAttempts };
}

function parseReflectConfidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('direct reflect response missing required number field "confidence" in [0, 1]');
  }
  return value;
}

function parseReflectFrontmatterPatch(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error('direct reflect response missing required object field "frontmatterPatch"');
  }
  const patch = value as Record<string, unknown>;
  const keys = Object.keys(patch).sort();
  if (keys.length !== 2 || keys[0] !== "description" || keys[1] !== "when_to_use") {
    throw new Error("direct reflect frontmatterPatch fields must be exactly: description, when_to_use");
  }
  const frontmatter: Record<string, unknown> = {};
  for (const field of ["description", "when_to_use"] as const) {
    const fieldValue = patch[field];
    if (fieldValue === null) continue;
    if (typeof fieldValue !== "string" || !fieldValue.trim() || /[\r\n]/.test(fieldValue)) {
      throw new Error(`direct reflect frontmatterPatch.${field} must be a non-empty single-line string or null`);
    }
    frontmatter[field] = fieldValue.trim();
  }
  return Object.keys(frontmatter).length > 0 ? frontmatter : undefined;
}

function parseSchemaReflectOutput(raw: string, targetRef: string | undefined) {
  const parsed = parseEmbeddedJsonResponse<Record<string, unknown>>(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("direct reflect response was not valid JSON");
  }
  const expectedKeys = targetRef
    ? ["confidence", "content", "frontmatterPatch"]
    : ["confidence", "content", "frontmatterPatch", "ref"];
  const actualKeys = Object.keys(parsed).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error(`direct reflect response fields must be exactly: ${expectedKeys.join(", ")}`);
  }
  if (typeof parsed.content !== "string" || !parsed.content.trim()) {
    throw new Error('direct reflect response missing required string field "content"');
  }
  const ref = targetRef ?? (typeof parsed.ref === "string" ? parsed.ref.trim() : "");
  if (!ref) throw new Error('direct reflect response missing required string field "ref"');
  const frontmatter = parseReflectFrontmatterPatch(parsed.frontmatterPatch);
  return {
    ref,
    content: parsed.content,
    confidence: parseReflectConfidence(parsed.confidence),
    ...(frontmatter ? { frontmatter } : {}),
  };
}

function parseFramedReflectOutput(raw: string, targetRef: string | undefined) {
  const normalized = raw.replaceAll("\r\n", "\n").trim();
  const beginMarker = "AKM_REFLECT_CONTENT_BEGIN\n";
  const endMarker = "\nAKM_REFLECT_CONTENT_END";
  const beginIndex = normalized.indexOf(beginMarker);
  if (beginIndex < 0 || (beginIndex > 0 && normalized[beginIndex - 1] !== "\n")) {
    throw new Error("direct reflect response missing AKM_REFLECT_CONTENT_BEGIN marker");
  }
  const contentStart = beginIndex + beginMarker.length;
  const endIndex = normalized.lastIndexOf(endMarker);
  if (endIndex < contentStart || normalized.slice(endIndex + endMarker.length).trim()) {
    throw new Error("direct reflect response missing terminal AKM_REFLECT_CONTENT_END marker");
  }
  const headerLines = normalized.slice(0, beginIndex).trim().split("\n").filter(Boolean);
  const header = (prefix: string) => headerLines.find((line) => line.startsWith(prefix));
  const confidenceLine = header("AKM_REFLECT_CONFIDENCE:");
  const refLine = header("AKM_REFLECT_REF:");
  const patchLine = header("AKM_REFLECT_FRONTMATTER_PATCH:");
  const invalidRefLine = targetRef ? refLine !== undefined : refLine === undefined;
  if (headerLines.length !== (targetRef ? 2 : 3) || !confidenceLine || !patchLine || invalidRefLine) {
    throw new Error("direct reflect response contained invalid frame metadata");
  }
  const confidenceText = confidenceLine.slice("AKM_REFLECT_CONFIDENCE:".length).trim();
  if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(confidenceText)) {
    throw new Error("direct reflect frame confidence must be a decimal number in [0, 1]");
  }
  const ref = targetRef ?? refLine?.slice("AKM_REFLECT_REF:".length).trim() ?? "";
  if (!ref) throw new Error("direct reflect response contained an empty AKM_REFLECT_REF value");
  const content = normalized.slice(contentStart, endIndex);
  if (!content.trim()) throw new Error("direct reflect response contained empty framed content");
  let parsedPatch: unknown;
  try {
    parsedPatch = JSON.parse(patchLine.slice("AKM_REFLECT_FRONTMATTER_PATCH:".length).trim());
  } catch {
    throw new Error("direct reflect response contained invalid frontmatter patch JSON");
  }
  const frontmatter = parseReflectFrontmatterPatch(parsedPatch);
  const confidence = parseReflectConfidence(Number(confidenceText));
  return { ref, content, confidence, ...(frontmatter ? { frontmatter } : {}) };
}

/**
 * One reflect iteration through the direct LLM runner, as an agent-shaped
 * result (errors captured, never thrown except configuration). An unparseable
 * response gets one repair turn within the original deadline.
 */
export async function runReflectViaLlm(opts: RunReflectViaLlmOptions): Promise<AgentRunResult> {
  const start = Date.now();
  let repairAttempts = 0;
  const configuredTimeout = Object.hasOwn(opts, "timeoutMs")
    ? (opts.timeoutMs ?? null)
    : Object.hasOwn(opts.runner, "timeoutMs")
      ? (opts.runner.timeoutMs ?? null)
      : DEFAULT_LLM_TIMEOUT_MS;
  const deadline = typeof configuredTimeout === "number" ? start + configuredTimeout : undefined;
  const messages: ChatMessage[] = [{ role: "user", content: opts.prompt ?? "" }];
  if (opts.priorDraft !== undefined && opts.iteration > 0) {
    messages.push({ role: "assistant", content: opts.priorDraft }, { role: "user", content: REFLECT_CRITIQUE_PROMPT });
  }
  const parse = (raw: string) =>
    opts.outputMode === "json_schema"
      ? parseSchemaReflectOutput(raw, opts.targetRef)
      : parseFramedReflectOutput(raw, opts.targetRef);
  const failure = (err: unknown, reason: AgentFailureReason, stdout = "", exitCode = 1): AgentRunResult => {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      stdout,
      stderr: msg,
      durationMs: Date.now() - start,
      exitCode,
      reason,
      error: msg,
      parsed: { outputMode: opts.outputMode, repairAttempts },
    };
  };
  const call = async (callMessages: ChatMessage[], repairTimeoutMs?: number): Promise<string> => {
    const outcome = await callStage({
      feature: "reflect_proposal",
      runner: opts.runner,
      prompt: callMessages.at(-1)?.content ?? "",
      history: callMessages.slice(0, -1),
      request: {
        ...(repairTimeoutMs !== undefined
          ? { timeoutMs: repairTimeoutMs }
          : Object.hasOwn(opts, "timeoutMs")
            ? { timeoutMs: opts.timeoutMs }
            : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.responseSchema !== undefined ? { responseSchema: opts.responseSchema } : {}),
        ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
        // Visible chain-of-thought can exhaust the output before the envelope.
        enableThinking: false,
        ...(opts.chat ? { chat: opts.chat } : {}),
      },
      ...(opts.onNotices ? { onNotices: opts.onNotices } : {}),
    });
    if (!outcome.ok) {
      throw outcome.reason === "timeout"
        ? new LlmCallError(outcome.error ?? "timeout", "timeout")
        : new Error(outcome.error ?? "LLM call failed");
    }
    return outcome.raw;
  };

  try {
    if (opts.signal?.aborted) throw new Error("Reflect request aborted");
    const stdout = await call(messages);
    let payload: ReturnType<typeof parse>;
    let acceptedOutput = stdout;
    try {
      payload = parse(stdout);
    } catch (err) {
      if (opts.allowRepair === false) return failure(err, "parse_error", stdout, 0);
      if (opts.signal?.aborted) return failure(new Error("Reflect request aborted"), "aborted", stdout);
      const remaining = deadline === undefined ? undefined : deadline - Date.now();
      if (remaining !== undefined && remaining <= 0) {
        return failure(
          new LlmCallError("Reflect request timed out before output repair", "timeout"),
          "timeout",
          stdout,
        );
      }
      repairAttempts = 1;
      const repairPrompt = buildReflectOutputRepairPrompt(opts.outputMode, opts.targetRef !== undefined);
      acceptedOutput = await call(
        [...messages, { role: "assistant", content: stdout }, { role: "user", content: repairPrompt }],
        remaining,
      );
      try {
        payload = parse(acceptedOutput);
      } catch (repairErr) {
        return failure(repairErr, "parse_error", acceptedOutput, 0);
      }
    }
    return {
      ok: true,
      stdout: JSON.stringify(payload),
      stderr: "",
      durationMs: Date.now() - start,
      exitCode: 0,
      parsed: { outputMode: opts.outputMode, repairAttempts, priorDraft: acceptedOutput },
    };
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    const reason: AgentFailureReason = opts.signal?.aborted
      ? "aborted"
      : err instanceof LlmCallError && err.code === "timeout"
        ? "timeout"
        : "non_zero_exit";
    return failure(err, reason);
  }
}

// ── Invocation ───────────────────────────────────────────────────────────────

type ReflectPayload = ReturnType<typeof parseAgentProposalPayload>;

/** One reflect invocation: its runner, notices, and the closing-event helpers. */
interface ReflectRun {
  options: AkmReflectOptions;
  stash: string;
  config: AkmConfig;
  runnerSpec: RunnerSpec;
  engineName: string;
  notices: ReturnType<typeof noticeSet>;
  emitInvoked: () => void;
  emitFailed: (reason: AgentFailureReason, subreason: string, ref?: string, extra?: Record<string, unknown>) => void;
}

/** The lazy `reflect_invoked` + failure-side `reflect_completed` emitters. */
function reflectEmitters(options: AkmReflectOptions): Pick<ReflectRun, "emitInvoked" | "emitFailed"> {
  let invoked = false;
  const emitInvoked = (): void => {
    if (invoked) return;
    appendEvent(
      {
        eventType: "reflect_invoked",
        ...(options.ref ? { ref: options.itemRef ?? options.ref } : {}),
        metadata: {
          ...(options.task ? { task: options.task } : {}),
          ...(options.engine ? { engine: options.engine } : {}),
          ...(options.eligibilitySource ? { eligibilitySource: options.eligibilitySource } : {}),
        },
      },
      options.eventsCtx,
    );
    invoked = true;
  };
  const emitFailed: ReflectRun["emitFailed"] = (reason, subreason, ref, extra) => {
    emitInvoked();
    appendEvent(
      {
        eventType: "reflect_completed",
        ...(ref ? { ref } : {}),
        metadata: { source: "reflect", ok: false, reason, subreason, ...(extra ?? {}) },
      },
      options.eventsCtx,
    );
  };
  return { emitInvoked, emitFailed };
}

/** A post-dispatch failure envelope (with the run's notices). */
function reflectFailure(
  run: ReflectRun,
  result: AgentRunResult,
  reason: AgentFailureReason,
  error: string,
  withOutput: boolean,
): AkmReflectFailure {
  return {
    schemaVersion: 2,
    ok: false,
    reason,
    error,
    ...(run.options.ref ? { ref: run.options.ref } : {}),
    engine: run.engineName,
    exitCode: result.exitCode,
    ...(withOutput ? { stdout: result.stdout, ...(result.stderr ? { stderr: result.stderr } : {}) } : {}),
    ...run.notices.fields(),
  };
}

function exitCodeMeta(result: AgentRunResult): Record<string, unknown> {
  return result.exitCode !== null ? { exitCode: result.exitCode } : {};
}

function unsupportedTypeFailure(
  ref: string,
  type: string,
  detail: string,
  emitFailed: ReflectRun["emitFailed"],
): { failure: AkmReflectResult } {
  emitFailed("unsupported_type", "unsupported_type", ref, { type });
  return {
    failure: {
      schemaVersion: 2,
      ok: false,
      reason: "unsupported_type" as AgentFailureReason,
      error: `Reflect refused: asset type "${type}" is not supported by reflect (${detail}). Use \`akm proposal new\` or edit the file directly.`,
      ref,
      exitCode: null,
    },
  };
}

/** The target's parsed ref and current content, or a refusal for a type reflect cannot rewrite. */
async function resolveReflectSource(
  options: AkmReflectOptions,
  stash: string,
  emitFailed: ReflectRun["emitFailed"],
): Promise<{ assetContent: string | undefined; parsedRef: AssetRef | undefined } | { failure: AkmReflectResult }> {
  if (!options.ref) return { assetContent: undefined, parsedRef: undefined };
  const parsedRef = parseRefInput(options.ref);
  // A secret's content is never read, whatever it looks like.
  if (REFLECT_REFUSED_TYPES.has(parsedRef.type)) {
    return unsupportedTypeFailure(
      options.ref,
      parsedRef.type,
      "secret material is never read or sent to an LLM",
      emitFailed,
    );
  }
  let assetContent = options.assetContent;
  if (assetContent === undefined) {
    try {
      const qualifiedRef = options.itemRef ?? options.ref;
      const localFilePath = await findAssetFilePath(qualifiedRef, stash);
      if (localFilePath && fs.existsSync(localFilePath)) {
        assetContent = fs.readFileSync(localFilePath, "utf8");
      } else {
        const entry = await lookup(parseRefInput(qualifiedRef));
        if (entry?.filePath && fs.existsSync(entry.filePath)) assetContent = fs.readFileSync(entry.filePath, "utf8");
      }
    } catch {
      // An index miss is not fatal: the agent can still propose a fresh asset.
    }
  }
  if (
    !REFLECT_ALLOWED_TYPES.has(parsedRef.type) &&
    (assetContent === undefined || parseFrontmatter(assetContent).frontmatter === null)
  ) {
    return unsupportedTypeFailure(options.ref, parsedRef.type, "its content is not frontmatter + markdown", emitFailed);
  }
  return { assetContent, parsedRef };
}

/**
 * The single engine for this invocation: `--engine`, the improve strategy's
 * LLM-only reflect process, or `defaults.engine` (announced when it falls back
 * to the SDK binary). Unattended improve refuses a tool-capable engine.
 */
function resolveReflectRunner(options: AkmReflectOptions): {
  config: AkmConfig;
  activeStrategy: ImproveProfileConfig | undefined;
  runnerSpec: RunnerSpec;
  engineName: string;
  notices: readonly Notice[];
} {
  const config = options.config ?? loadConfig();
  const activeStrategy =
    options.improveProfile ?? config.improve?.strategies?.[config.defaults?.improveStrategy ?? "default"];
  const lower = (selection: Parameters<typeof resolveExecution>[0]) => {
    const prepared = resolveExecution(selection);
    return buildExecution(prepared.request, prepared.runner);
  };
  let lowered: { runner: RunnerSpec; notices: readonly Notice[] };
  if (options.engine) {
    lowered = lower({ content: "reflect engine selection", config, current: { engine: options.engine } });
  } else if (options.improveProfile) {
    const resolved = resolveImproveLlmExecution({
      config,
      profile: activeStrategy,
      process: activeStrategy?.processes?.reflect,
      processName: "reflect",
    });
    if (!resolved) {
      throw new ConfigError(
        "Reflect requires an LLM engine for the active improve strategy.",
        "LLM_NOT_CONFIGURED",
        "Set defaults.llmEngine or improve.strategies.<name>.processes.reflect.engine.",
      );
    }
    lowered = resolved;
  } else {
    const { config: engineConfig, fallbackEngineName } = withEngineFallback(config);
    const defaultEngine = engineConfig.defaults?.engine;
    const announcement = fallbackAnnouncement(fallbackEngineName, defaultEngine);
    if (announcement) warn(announcement);
    if (!defaultEngine) {
      throw new ConfigError(`reflect ${NO_ENGINE_MESSAGE_SUFFIX} ${NO_ENGINE_REMEDY}`, "INVALID_CONFIG_FILE");
    }
    lowered = lower({ content: "reflect engine selection", config });
  }
  const runnerSpec = lowered.runner;
  if (options.eventSource === "improve" && !runnerIsLlm(runnerSpec)) {
    throw new ConfigError(
      `Unattended improve requires an LLM engine for reflect; engine "${runnerSpec.engine ?? options.engine ?? "unknown"}" is tool-capable.`,
      "INVALID_CONFIG_FILE",
      "Set defaults.llmEngine or improve.strategies.<name>.processes.reflect.engine to an LLM engine.",
    );
  }
  const engineName = runnerSpec.engine ?? options.engine;
  if (!engineName) throw new ConfigError("Reflect requires a named engine.", "INVALID_CONFIG_FILE");
  return { config, activeStrategy, runnerSpec, engineName, notices: lowered.notices };
}

/** Lower a runner and check its credentials, so a bad transport fails before any work. */
function preflightReflectDispatch(runnerSpec: RunnerSpec, onNotices: (notices: readonly Notice[]) => void): void {
  const prepared = resolveExecution({
    content: "Validate reflect operation transport before dispatch.",
    runner: runnerSpec,
  });
  const lowered = buildExecution(prepared.request, prepared.runner);
  onNotices(lowered.notices);
  assertRunnerCredentials(lowered.runner);
}

/**
 * The flat 12k content cap exists for CLI argv; the HTTP runner can spend half
 * its context window (after the rest of the prompt) on the asset, reserving
 * the other half for the rewrite. Never below the flat floor.
 */
function computeReflectContentBudgetChars(promptInput: ReflectPromptInput, runnerSpec: RunnerSpec): number | undefined {
  if (!runnerIsLlm(runnerSpec) || !promptInput.assetContent?.trim()) return undefined;
  const window = (runnerSpec.connection.contextLength ?? DEFAULT_CONTEXT_LENGTH_TOKENS) * CHARS_PER_TOKEN;
  const overhead = buildReflectPrompt({ ...promptInput, contentBudgetChars: 0 }).prompt.length;
  return Math.max(REFLECT_CONTENT_CAP, Math.floor((window - overhead) / 2));
}

interface ReflectPromptSources {
  feedback: string[];
  schemaHints: string[];
  relatedLessons: RelatedLesson[];
  rejectedProposals: ReturnType<typeof rejectedProposalContext>;
  standardsContext: string;
}

/** Every read-only prompt input, shared by dispatch and `--show-prompt`. */
async function gatherReflectPromptSources(
  options: AkmReflectOptions,
  stash: string,
  parsedRef: AssetRef | undefined,
  assetContent: string | undefined,
): Promise<ReflectPromptSources> {
  return {
    feedback: readRecentFeedback(options.ref ? (options.itemRef ?? options.ref) : undefined, options.eventsCtx),
    schemaHints: buildSchemaHints(parsedRef?.type ?? "", assetContent),
    relatedLessons:
      options.ref && parsedRef
        ? await readRelatedLessons(stash, options.ref, parsedRef, options.itemRef, options.eventsCtx)
        : [],
    rejectedProposals: rejectedProposalContext(stash, options.ref, options.ctx),
    standardsContext: resolveStandardsContext(options.ref, stash),
  };
}

/** The exact prompt reflect sends, shared by dispatch and `--show-prompt`. */
function buildReflectPromptText(args: {
  options: AkmReflectOptions;
  parsedRef: AssetRef | undefined;
  assetContent: string | undefined;
  sources: ReflectPromptSources;
  runnerSpec: RunnerSpec;
  draftFilePath: string | undefined;
  priorDraft: string | undefined;
}): { prompt: string; outputMode?: ReflectLlmOutputMode } {
  const { options, parsedRef, assetContent, sources, runnerSpec, draftFilePath, priorDraft } = args;
  const { feedback, schemaHints, relatedLessons, rejectedProposals, standardsContext } = sources;
  const outputMode: ReflectLlmOutputMode | undefined = runnerIsLlm(runnerSpec)
    ? wantsJsonSchemaOutput(runnerSpec.connection)
      ? "json_schema"
      : "framed_markdown"
    : undefined;
  const input: ReflectPromptInput = {
    ...(options.ref ? { ref: options.ref } : {}),
    ...(parsedRef?.type ? { type: parsedRef.type } : {}),
    ...(parsedRef?.name ? { name: parsedRef.name } : {}),
    ...(assetContent !== undefined ? { assetContent } : {}),
    ...(feedback.length > 0 ? { feedback } : {}),
    ...(schemaHints.length > 0 ? { schemaHints } : {}),
    ...(relatedLessons.length > 0 ? { relatedLessons } : {}),
    ...(options.task ? { task: options.task } : {}),
    ...(standardsContext.trim() ? { standardsContext } : {}),
    ...(options.avoidPatterns && options.avoidPatterns.length > 0 ? { avoidPatterns: options.avoidPatterns } : {}),
    ...(rejectedProposals.length > 0 ? { rejectedProposals } : {}),
    ...(priorDraft !== undefined ? { priorDraft } : {}),
    ...(draftFilePath ? { draftFilePath } : {}),
    ...(outputMode ? { outputMode } : {}),
  };
  const contentBudgetChars = computeReflectContentBudgetChars(input, runnerSpec);
  const { prompt } = buildReflectPrompt({
    ...input,
    ...(contentBudgetChars !== undefined ? { contentBudgetChars } : {}),
  });
  return { prompt, ...(outputMode ? { outputMode } : {}) };
}

/**
 * Dispatch with the optional self-refine loop: up to `maxRefineIters` passes,
 * each critiquing the prior draft, stopping early on an unchanged draft. The
 * direct-LLM repair budget is shared across passes.
 */
async function runReflectRefineIterations(args: {
  run: ReflectRun;
  parsedRef: AssetRef | undefined;
  assetContent: string | undefined;
  sources: ReflectPromptSources;
  agentEnv: Record<string, string>;
  draftPaths: string[];
}): Promise<{ result: AgentRunResult; lastDraftPath: string | undefined }> {
  const { run, parsedRef, assetContent, sources, agentEnv, draftPaths } = args;
  const { options, runnerSpec } = run;
  const maxRefineIters = Math.max(1, options.maxRefineIters ?? 1);
  const canWriteFile = runnerSupportsFileWrite(runnerSpec);
  let result = {} as AgentRunResult;
  let priorDraft: string | undefined;
  let lastDraftPath: string | undefined;
  let repairAttempts = 0;
  for (let iter = 0; iter < maxRefineIters; iter++) {
    const draftFilePath = canWriteFile ? synthesizeReflectDraftPath(options.ref) : undefined;
    if (draftFilePath) {
      draftPaths.push(draftFilePath);
      lastDraftPath = draftFilePath;
    }
    const { prompt, outputMode } = buildReflectPromptText({
      options,
      parsedRef,
      assetContent,
      sources,
      runnerSpec,
      draftFilePath,
      priorDraft,
    });
    let iterResult: AgentRunResult;
    if (runnerIsLlm(runnerSpec)) {
      iterResult = await runReflectViaLlm({
        prompt,
        runner: runnerSpec,
        ...(Object.hasOwn(options, "timeoutMs") ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        priorDraft,
        iteration: iter,
        ...(outputMode === "json_schema"
          ? { responseSchema: options.ref ? REFLECT_JSON_SCHEMA : REFLECT_UNSCOPED_JSON_SCHEMA }
          : {}),
        outputMode: outputMode ?? "framed_markdown",
        ...(options.ref ? { targetRef: options.ref } : {}),
        allowRepair: repairAttempts === 0,
        ...(options.chat ? { chat: options.chat } : {}),
        onNotices: run.notices.add,
      });
    } else {
      const conversation =
        priorDraft !== undefined && iter > 0
          ? [
              { role: "user" as const, content: prompt },
              { role: "assistant" as const, content: priorDraft },
            ]
          : undefined;
      const current = {
        ...(Object.hasOwn(options, "timeoutMs") ? { timeout: options.timeoutMs } : {}),
        ...(Object.keys(agentEnv).length > 0 ? { environment: agentEnv } : {}),
      };
      const prepared = resolveExecution({
        content: conversation ? REFLECT_CRITIQUE_PROMPT : prompt,
        ...(conversation ? { conversation } : {}),
        runner: runnerSpec,
        ...(Object.keys(current).length > 0 ? { current } : {}),
      });
      const lowered = buildExecution(prepared.request, prepared.runner);
      run.notices.add(lowered.notices);
      iterResult = await runExecution(lowered, {
        ...(options.runSdk ? { runSdk: options.runSdk } : {}),
        runOptions: { ...(options.signal ? { signal: options.signal } : {}), ...(options.runAgentOptions ?? {}) },
      });
    }
    const telemetry = reflectLlmTelemetry(iterResult);
    if (telemetry) repairAttempts += telemetry.repairAttempts;
    result = telemetry
      ? { ...iterResult, parsed: { ...(iterResult.parsed as Record<string, unknown>), ...telemetry, repairAttempts } }
      : iterResult;
    if (!result.ok) break;
    if (iter < maxRefineIters - 1) {
      const priorFromLlm = parsedRecord(result)?.priorDraft;
      const nextDraft = typeof priorFromLlm === "string" ? priorFromLlm : (result.stdout ?? "");
      if (priorDraft !== undefined && nextDraft === priorDraft) break;
      priorDraft = nextDraft;
    }
  }
  return { result, lastDraftPath };
}

/**
 * The proposal payload from a successful run: the agent's draft file
 * (file-write contract, `DRAFT_WRITTEN confidence=<n>` on stdout) or the JSON
 * payload on stdout.
 */
function resolveReflectPayload(
  run: ReflectRun,
  result: AgentRunResult,
  lastDraftPath: string | undefined,
  sensitiveValues: readonly string[],
): { payload: ReflectPayload } | { failure: AkmReflectResult } {
  const { options } = run;
  const draftFileExists =
    lastDraftPath !== undefined && fs.existsSync(lastDraftPath) && fs.statSync(lastDraftPath).size > 0;
  const draftSignaled = /\bDRAFT_WRITTEN\b/.test(result.stdout ?? "");
  if (draftSignaled && lastDraftPath && !draftFileExists) {
    run.emitFailed("parse_error", "draft_missing", options.ref, exitCodeMeta(result));
    return {
      failure: reflectFailure(
        run,
        result,
        "parse_error",
        `Agent emitted DRAFT_WRITTEN but draft file is missing or empty (${lastDraftPath}). The file-write contract failed; either the agent's file tools are broken or the path was unwritable.`,
        true,
      ),
    };
  }
  if (draftFileExists && lastDraftPath) {
    const draftConfidence = extractDraftConfidence(result.stdout);
    return {
      payload: {
        ref: options.ref ?? "",
        content: redactSensitiveText(fs.readFileSync(lastDraftPath, "utf8"), sensitiveValues),
        ...(draftConfidence !== undefined ? { confidence: draftConfidence } : {}),
      },
    };
  }
  try {
    return { payload: parseAgentProposalPayload(result.stdout ?? "") };
  } catch (err) {
    run.emitFailed("parse_error", "parse_error", options.ref, {
      ...exitCodeMeta(result),
      ...(reflectLlmTelemetry(result) ?? {}),
    });
    return {
      failure: reflectFailure(run, result, "parse_error", err instanceof Error ? err.message : String(err), true),
    };
  }
}

const NOISE_SUBREASONS = {
  noop: "reflect_skipped_noop",
  cosmetic: "reflect_skipped_cosmetic",
  "low-value": "reflect_skipped_low_value",
} as const;

/**
 * Sanitize, drop a no-op/cosmetic (and optionally low-value) change, judge the
 * exact content that would be persisted, then mint. Size-flagged or
 * truncation-leaking content skips the judge and waits for review.
 */
async function finalizeReflectProposal(args: {
  run: ReflectRun;
  payload: ReflectPayload;
  assetContent: string | undefined;
  result: AgentRunResult;
  judge: { enabled: boolean; skippedNoJudge: boolean; runner: LlmRunner | undefined };
  feedback: string[];
}): Promise<AkmReflectResult> {
  const { run, assetContent, result, judge, feedback } = args;
  const { options } = run;
  const telemetry = reflectLlmTelemetry(result) ?? {};
  const sanitized = sanitizeReflectPayload(
    { content: args.payload.content, ...(args.payload.frontmatter ? { frontmatter: args.payload.frontmatter } : {}) },
    assetContent,
    args.payload.ref,
  );
  const payload: ReflectPayload = {
    ...args.payload,
    content: sanitized.content,
    ...(sanitized.frontmatter ? { frontmatter: sanitized.frontmatter } : {}),
  };

  if (assetContent !== undefined) {
    const changeKind = classifyReflectChange(assetContent, payload.content);
    if (
      changeKind === "noop" ||
      changeKind === "cosmetic" ||
      (changeKind === "low-value" && options.lowValueFilter === true)
    ) {
      run.emitFailed("no_change", NOISE_SUBREASONS[changeKind], options.ref, { changeKind, ...telemetry });
      const what =
        changeKind === "noop"
          ? "identical to the current asset (empty diff)"
          : changeKind === "low-value"
            ? "a low-value prose micro-rewrite (few changed tokens, no structural changes)"
            : "a cosmetic-only reformat of the current asset (whitespace/fence/YAML-folding changes)";
      return reflectFailure(
        run,
        result,
        "no_change",
        `Reflect skipped: proposed content for ${payload.ref} is ${what}; no proposal created.`,
        false,
      );
    }
  }

  const flagged = Boolean(sanitized.sizeGuardRatio || sanitized.truncationMarkerLeaked);
  const judged = judge.enabled && !flagged;
  if (judged) {
    const verdict = await runReflectQualityJudge(
      run.config,
      payload.content,
      assetContent ?? "",
      feedback,
      options.chat,
      {
        runnerSelectionFrozen: true,
        ...(judge.runner ? { llmRunner: judge.runner } : {}),
        ...(Object.hasOwn(options, "timeoutMs") ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        onNotices: run.notices.add,
      },
    );
    if (!verdict.pass) {
      if (options.ref) {
        recordLedgerAttempt(
          { proposalsCtx: options.ctx, eventsCtx: options.eventsCtx },
          {
            stashDir: run.stash,
            ref: options.itemRef ?? options.ref,
            source: "reflect",
            outcome: "quality_rejected",
            detail: verdict.reason,
          },
        );
      }
      appendEvent(
        {
          eventType: "reflect_completed",
          ref: payload.ref,
          metadata: {
            source: "reflect",
            qualityRejected: true,
            qualityScore: verdict.score,
            qualityReason: verdict.reason,
            ...(verdict.criteria ? { qualityCriteria: verdict.criteria } : {}),
            ...telemetry,
          },
        },
        options.eventsCtx,
      );
      return reflectFailure(
        run,
        result,
        "quality_rejected",
        `Reflect proposal quality gate rejected: score=${verdict.score}, reason="${verdict.reason}"`,
        false,
      );
    }
  }

  // A lesson reflect wrote is marked so a later reflect on the same skill does
  // not read it back as independent evidence.
  const frontmatter: Record<string, unknown> = {
    ...(payload.frontmatter ?? {}),
    ...(lenientRefType(payload.ref) === "lesson" ? { derived_from_reflect: true } : {}),
  };
  const reviewReasons = [
    ...(judge.skippedNoJudge ? ["no-judge-configured"] : []),
    ...(sanitized.sizeGuardRatio ? ["reflect-size-ratio"] : []),
    ...(sanitized.truncationMarkerLeaked ? ["reflect-truncation-leak"] : []),
  ];
  const proposal = mintProposal(
    run.stash,
    options.ctx,
    {
      ref: payload.ref,
      ...(options.target ? { target: options.target } : {}),
      source: "reflect",
      sourceRun: `reflect-${Date.now()}`,
      payload: { content: payload.content, ...(Object.keys(frontmatter).length > 0 ? { frontmatter } : {}) },
      ...(typeof payload.confidence === "number" ? { confidence: payload.confidence } : {}),
      ...(options.eligibilitySource ? { eligibilitySource: options.eligibilitySource } : {}),
      ...(options.itemRef ? { attemptedRefs: [options.itemRef] } : {}),
    },
    reviewReasons.length > 0
      ? {
          review: {
            reason: reviewReasons.join("+"),
            gate: "reflect",
            ...(sanitized.sizeGuardRatio ? { measured: Math.round(sanitized.sizeGuardRatio.ratio * 100) } : {}),
          },
        }
      : { judged },
  );
  appendEvent(
    {
      eventType: "reflect_completed",
      ref: proposal.ref,
      metadata: {
        proposalId: proposal.id,
        source: "reflect",
        engine: run.engineName,
        ...(judge.skippedNoJudge ? { qualityGateSkippedNoJudge: true } : {}),
        ...(sanitized.sizeGuardRatio
          ? { sizeGuardRatio: sanitized.sizeGuardRatio.code, sizeGuardRatioValue: sanitized.sizeGuardRatio.ratio }
          : {}),
        ...(sanitized.truncationMarkerLeaked ? { truncationMarkerLeaked: true } : {}),
        ...telemetry,
      },
    },
    options.eventsCtx,
  );
  return {
    schemaVersion: 2,
    ok: true,
    proposal,
    ref: proposal.ref,
    engine: run.engineName,
    durationMs: result.durationMs,
    ...run.notices.fields(),
  };
}

/**
 * `akm improve <ref> --show-prompt`: the exact prompt reflect would send for
 * one asset. Read-only: no credential, no dispatch, no event.
 */
export async function renderReflectPromptPreview(
  options: AkmReflectOptions,
): Promise<{ ref: string; prompt: string; engine: string; engineKind: RunnerSpec["kind"] }> {
  if (!options.ref) {
    throw new UsageError("renderReflectPromptPreview requires options.ref.", "INVALID_FLAG_VALUE");
  }
  const ref = options.ref;
  const stash = options.stashDir ?? resolveStashDir();
  const source = await resolveReflectSource(options, stash, () => {});
  if ("failure" in source) {
    const { failure } = source;
    throw new UsageError(
      (!failure.ok && failure.error) || `Reflect cannot preview ref "${ref}".`,
      "INVALID_FLAG_VALUE",
    );
  }
  const { runnerSpec, engineName } = resolveReflectRunner(options);
  const sources = await gatherReflectPromptSources(options, stash, source.parsedRef, source.assetContent);
  const { prompt } = buildReflectPromptText({
    options,
    parsedRef: source.parsedRef,
    assetContent: source.assetContent,
    sources,
    runnerSpec,
    // The same tmp-path shape a dispatch would use; never written.
    draftFilePath: runnerSupportsFileWrite(runnerSpec) ? synthesizeReflectDraftPath(ref) : undefined,
    priorDraft: undefined,
  });
  return { ref, prompt, engine: engineName, engineKind: runnerSpec.kind };
}

export async function akmReflect(options: AkmReflectOptions = {}): Promise<AkmReflectResult> {
  const stash = options.stashDir ?? resolveStashDir();
  const { emitInvoked, emitFailed } = reflectEmitters(options);
  const source = await resolveReflectSource(options, stash, emitFailed);
  if ("failure" in source) return source.failure;
  const { assetContent, parsedRef } = source;

  const { config, activeStrategy, runnerSpec, engineName, notices: resolutionNotices } = resolveReflectRunner(options);
  const notices = noticeSet();
  notices.add(resolutionNotices);
  const run: ReflectRun = { options, stash, config, runnerSpec, engineName, notices, emitInvoked, emitFailed };

  // Judge selection is frozen before dispatch so a missing judge credential fails first.
  const judgeWanted =
    (activeStrategy?.processes?.reflect?.qualityGate?.enabled ?? false) ||
    (activeStrategy?.processes?.distill?.qualityGate?.enabled ?? true);
  let judgeRunner: LlmRunner | undefined;
  if (judgeWanted) {
    if (runnerIsLlm(runnerSpec)) {
      judgeRunner = runnerSpec;
    } else {
      const resolved = resolveImproveLlmExecution({ config, processName: "reflect_proposal_quality-judge" });
      if (resolved) notices.add(resolved.notices);
      judgeRunner = resolved?.runner;
    }
  }
  const skippedNoJudge = judgeWanted && !judgeRunner;
  if (skippedNoJudge) {
    warnOnce(
      "reflect-quality-gate-no-judge",
      "Reflect proposal quality gate has no LLM configured to judge proposals (set defaults.llmEngine). Skipping the gate for this run; the proposal is queued for human review instead.",
    );
  }
  preflightReflectDispatch(runnerSpec, notices.add);
  if (judgeRunner && judgeRunner !== runnerSpec) preflightReflectDispatch(judgeRunner, notices.add);

  const sources = await gatherReflectPromptSources(options, stash, parsedRef, assetContent);
  const agentEnv: Record<string, string> = options.eventSource === "improve" ? { AKM_EVENT_SOURCE: "improve" } : {};
  const sensitiveValues = collectDispatchSensitiveValues(runnerSpec, {
    ...(Object.keys(agentEnv).length > 0 ? { env: agentEnv } : {}),
    ...(options.runAgentOptions ?? {}),
  });
  const draftPaths: string[] = [];
  let result: AgentRunResult;
  let payload: ReflectPayload;
  try {
    const iterated = await runReflectRefineIterations({ run, parsedRef, assetContent, sources, agentEnv, draftPaths });
    emitInvoked();
    result = iterated.result;
    if (!result.ok) {
      if (isEnoentFailure(result)) {
        emitFailed("spawn_failed", "enoent", options.ref, {
          ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
        });
        return {
          ...baseFailureFields(result),
          schemaVersion: 2,
          ...(options.ref ? { ref: options.ref } : {}),
          engine: engineName,
          error: enoentHintMessage(runnerIsLlm(runnerSpec) ? engineName : runnerSpec.profile.bin),
          ...notices.fields(),
        };
      }
      const envelope: AkmReflectFailure = {
        ...baseFailureFields(result),
        schemaVersion: 2,
        ...(options.ref ? { ref: options.ref } : {}),
        engine: engineName,
      };
      emitFailed(envelope.reason, envelope.reason === "parse_error" ? "parse_error" : "agent_crash", options.ref, {
        ...(envelope.exitCode !== null ? { exitCode: envelope.exitCode } : {}),
        ...(reflectLlmTelemetry(result) ?? {}),
      });
      return { ...envelope, ...notices.fields() };
    }
    const resolved = resolveReflectPayload(run, result, iterated.lastDraftPath, sensitiveValues);
    if ("failure" in resolved) return resolved.failure;
    payload = resolved.payload;
  } catch (error) {
    if (!(error instanceof ConfigError)) emitInvoked();
    throw error;
  } finally {
    for (const draftPath of draftPaths) {
      try {
        if (fs.existsSync(draftPath)) fs.unlinkSync(draftPath);
      } catch {
        // best-effort
      }
    }
  }

  const unsafeContent = generatedContentRejection(
    payload.content,
    redactSensitiveText(payload.content, sensitiveValues),
  );
  if (unsafeContent) {
    emitFailed("parse_error", "parse_error", options.ref, exitCodeMeta(result));
    return reflectFailure(run, result, "parse_error", unsafeContent, false);
  }
  // A retargeted proposal is refused (malformed refs are left to proposal validation).
  if (options.ref) {
    let retargeted = false;
    try {
      const expected = parseRefInput(options.ref);
      const actual = parseRefInput(payload.ref);
      retargeted = expected.type !== actual.type || expected.name !== actual.name;
    } catch {
      retargeted = false;
    }
    if (retargeted) {
      emitFailed("parse_error", "ref_mismatch", options.ref, {
        expectedRef: options.ref,
        actualRef: payload.ref,
        ...exitCodeMeta(result),
        ...(reflectLlmTelemetry(result) ?? {}),
      });
      return reflectFailure(
        run,
        result,
        "parse_error",
        `Agent retargeted proposal: expected ref "${options.ref}" but got "${payload.ref}". Proposal rejected to prevent silent ref hallucination.`,
        true,
      );
    }
  }
  return finalizeReflectProposal({
    run,
    payload,
    assetContent,
    result,
    judge: { enabled: judgeWanted && !skippedNoJudge, skippedNoJudge, runner: judgeRunner },
    feedback: sources.feedback,
  });
}
