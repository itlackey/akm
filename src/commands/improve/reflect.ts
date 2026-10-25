// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm reflect [ref]` — ask an engine whether an asset's `description`,
 * `when_to_use` and title need a fix, and queue the asset with that fix as a
 * proposal (`source: "reflect"`). The engine never writes the body: akm keeps
 * it byte for byte. Reflect never writes an asset: the proposal queue is the
 * only path, `akm proposal accept` the bridge.
 *
 * Every invocation closes with one `reflect_completed` event; `reflect_invoked`
 * is emitted once the dispatch has validated its credentials (deterministic
 * pre-dispatch refusals still emit both).
 */

import fs from "node:fs";
import path from "node:path";
import { assetPathForName, stashDirFor } from "../../core/asset/asset-placement";
import { serializeFrontmatter } from "../../core/asset/asset-serialize";
import { parseFrontmatter } from "../../core/asset/frontmatter";
import { type AssetRef, parseRefInput } from "../../core/asset/resolve-ref";
import { DESCRIPTION_MAX_CHARS, requiresDescription } from "../../core/authoring-rules";
import { isWithin, resolveStashDir, safeRealpath } from "../../core/common";
import type { AkmConfig, ImproveProfileConfig } from "../../core/config/config";
import { loadConfig } from "../../core/config/config";
import { SHIPPED_ALIAS } from "../../core/config/model-aliases";
import { generatedContentRejection } from "../../core/content-safety";
import { ConfigError, UsageError } from "../../core/errors";
import { appendEvent, type EventsContext, readEvents } from "../../core/events";
import type { AkmReflectFailure, AkmReflectResult } from "../../core/improve-types";
import { lintLessonContent } from "../../core/lesson-lint";
import { parseEmbeddedJsonResponse } from "../../core/parse";
import { redactSensitiveText } from "../../core/redaction";
import { resolveStandardsContext } from "../../core/standards/resolve-standards-context";
import type { Parsed } from "../../core/structured";
import { warnOnce } from "../../core/warn";
import { lookup } from "../../indexer/indexer";
import type { AgentFailureReason, AgentRunResult } from "../../integrations/agent";
import { buildExecution, currentLayer, resolveExecution, shippedAlias } from "../../integrations/agent/execution";
import {
  buildReflectOutputRepairPrompt,
  buildReflectPrompt,
  REFLECT_CONTENT_CAP,
  type ReflectOutputMode,
  type ReflectPromptInput,
} from "../../integrations/agent/prompts";
import type { RunnerSpec } from "../../integrations/agent/runner";
import { collectDispatchSensitiveValues } from "../../integrations/agent/runner-dispatch";
import { type ChatMessage, type chatCompletion, isJsonSchemaKnownUnsupported, LlmCallError } from "../../llm/client";
import { structuredLoop } from "../../llm/structured";
import { baseFailureFields, enoentHintMessage, isEnoentFailure } from "../agent/agent-support";
import type { EligibilitySource } from "../proposal/proposal-types";
import type { CreateProposalInput, ProposalsContext } from "../proposal/repository";
import { isValidDescription } from "../proposal/validators/proposal-quality-validators";
import { CHARS_PER_TOKEN, DEFAULT_CONTEXT_LENGTH_TOKENS } from "./consolidate/chunking";
import { contentHash } from "./content-hash";
import { findAssetFilePath } from "./eligibility";
import { resolveImproveExecution } from "./execution";
import { recordLedgerAttempt } from "./ledger";
import {
  bodyHasH1,
  classifyReflectChange,
  findReflectDefect,
  type ReflectDefectFilter,
  splitFrontmatter,
} from "./reflect-noise";
import {
  callStageOnce,
  errMessage,
  mintProposal,
  type Notice,
  noticeSet,
  type QualityJudgeResult,
  rejectedProposalContext,
  resolveQualityGateJudge,
  runReflectQualityJudge,
} from "./stage";

export interface AkmReflectOptions {
  /** Active improve profile; its per-process `reflect` override wins over the default strategy. */
  improveProfile?: ImproveProfileConfig;
  /** Asset ref (`[bundle//]conceptId`) to focus on. */
  ref?: string;
  /** Task hint passed through to the prompt. */
  task?: string;
  /** Connection (or harness) override, by name. */
  engine?: string;
  timeoutMs?: number;
  /** Shared improve deadline for dispatch and judging. */
  signal?: AbortSignal;
  stashDir?: string;
  /** Bundle destination for the proposal. */
  target?: NonNullable<CreateProposalInput["target"]>;
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
  /** The wording lists of the pre-judge defect rules (`processes.reflect.defectFilter`); a list left out takes its default. */
  defectFilter?: ReflectDefectFilter;
  /** Test seam: pre-loaded source content instead of the index lookup. */
  assetContent?: string;
  /** The improve lane that selected the asset, stamped on events and the proposal. */
  eligibilitySource?: EligibilitySource;
  /** The asset's durable `item_ref`; direct invocations key by the conceptId. */
  itemRef?: string;
}

const MAX_FEEDBACK_LINES = 10;
const MAX_GLOBAL_FEEDBACK_LINES = 20;

/** Ends a feedback line whose event judged text the asset no longer has. */
const EARLIER_TEXT_MARK = " (given on an earlier version of the text)";

function readOnlyEventsContext(ctx?: EventsContext): EventsContext {
  return ctx?.db ? ctx : { ...(ctx ?? {}), readOnly: true };
}

/**
 * Recent `feedback` lines for `ref` (or across all assets without one). Given the
 * asset's current content, a line whose event recorded the hash of a different
 * body is marked. Best-effort.
 */
function readRecentFeedback(ref?: string, eventsCtx?: EventsContext, assetContent?: string): string[] {
  try {
    const events = readEvents({ type: "feedback", ...(ref ? { ref } : {}) }, readOnlyEventsContext(eventsCtx)).events;
    const bodyHash = assetContent === undefined ? undefined : contentHash(assetContent, "body");
    return events.slice(-(ref ? MAX_FEEDBACK_LINES : MAX_GLOBAL_FEEDBACK_LINES)).map((event) => {
      const md = event.metadata ?? {};
      const signal = typeof md.signal === "string" ? md.signal : "?";
      const note = typeof md.reason === "string" ? md.reason : typeof md.note === "string" ? md.note : "";
      const details = note ? `[${signal}] ${note}` : `[${signal}]`;
      const line = !ref && event.ref ? `${event.ref} ${details}` : details;
      return bodyHash !== undefined && typeof md.contentHash === "string" && md.contentHash !== bodyHash
        ? `${line}${EARLIER_TEXT_MARK}`
        : line;
    });
  } catch {
    return [];
  }
}

/**
 * Types reflect may patch: its output is frontmatter + markdown, which would
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

/** Lesson lint findings for the prompt: a concrete starting point for the revision. */
function buildSchemaHints(type: string, content: string | undefined): string[] {
  if (!content || type !== "lesson") return [];
  return lintLessonContent(content, "reflect").findings.map((f) => `[${f.kind}] ${f.message}`);
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

/**
 * A description derived from existing metadata (title, first heading, first
 * prose sentence) that passes `isValidDescription`, or `undefined`. Never
 * free-form invention.
 */
function deriveDescriptionFromAsset(title: unknown, body: string, targetRef: string): string | undefined {
  const candidates: Array<{ text: string; kind: "fragment" | "prose" }> = [];
  if (typeof title === "string" && title.trim()) candidates.push({ text: title.trim(), kind: "fragment" });
  const heading = body.match(/^#{1,6}\s+(.+?)\s*$/m)?.[1];
  if (heading) candidates.push({ text: heading.trim(), kind: "fragment" });
  const sentence = firstProseSentence(body);
  if (sentence) candidates.push({ text: sentence, kind: "prose" });
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

/** What a reflect reply changes; a field it leaves out stays as the source has it. */
interface ReflectPatch {
  description?: string;
  when_to_use?: string;
  /** The text of a level-1 heading, added only to a body that has none. */
  title?: string;
}

/** The body with `# title` and one blank line inserted at its first non-blank line; the rest is untouched. */
function withH1(body: string, title: string): string {
  const eol = body.match(/\r?\n/)?.[0] ?? "\n";
  const leading = body.match(/^(?:\r?\n)*/)?.[0] ?? "";
  return `${leading}# ${title}${eol}${eol}${body.slice(leading.length)}`;
}

/**
 * The asset with the patch applied, or `undefined` when the patch changes
 * nothing (or there is no asset to patch). The body is the source's own, byte
 * for byte; the one thing akm adds to it is a `# title` heading it lacks, with
 * one blank line after it (#1183). A
 * required description that neither the source nor the patch has is derived
 * from the asset's own text (#636). Only the changed keys' frontmatter lines are
 * rewritten: every other line is kept as it is, so a source whose YAML the
 * parser reads only in part (a broken description beside a list) loses nothing.
 */
export function applyReflectPatch(
  patch: ReflectPatch,
  sourceContent: string,
  targetRef: string,
): { content: string; frontmatter?: Record<string, unknown> } | undefined {
  if (!sourceContent.trim()) return undefined;
  const { fmText, body: sourceBody } = splitFrontmatter(sourceContent);
  // A fence that is opened and never closed (`---` fused onto the last value)
  // would leave the old block in the body under a new one: a person fixes it.
  if (fmText === null && /^---\r?\n/.test(sourceContent)) return undefined;
  const sourceFm = fmText !== null ? parseFrontmatter(sourceContent).data : {};
  const { title, ...changes } = patch as Record<string, unknown> & { title?: string };
  const addTitle = title !== undefined && !bodyHasH1(sourceBody);
  // The heading and one blank line go in at the body's first non-blank line, in
  // the body's own line ending; every other byte of the body stays where it was.
  const body = addTitle ? withH1(sourceBody, title) : sourceBody;

  // Only a source that already has frontmatter but no description gets one:
  // injecting a whole block, or overwriting an authored one, is out of scope.
  const refType = lenientRefType(targetRef);
  const desc = changes.description ?? sourceFm.description;
  if (
    refType &&
    requiresDescription(refType) &&
    (typeof desc !== "string" || desc.trim().length === 0) &&
    Object.keys(sourceFm).length > 0
  ) {
    const derived = deriveDescriptionFromAsset(sourceFm.title, body, targetRef);
    if (derived) changes.description = derived;
  }
  for (const key of Object.keys(changes)) if (changes[key] === sourceFm[key]) delete changes[key];
  if (!addTitle && Object.keys(changes).length === 0) return undefined;

  // No frontmatter at all stays body-only unless the patch adds a field. The
  // blank line after a closing fence is part of the source body, so only a
  // block or heading akm adds brings its own.
  if (fmText === null) {
    if (Object.keys(changes).length === 0) return { content: body };
    const content = `---\n${serializeFrontmatter(changes)}\n---\n\n${body}`;
    return { content, frontmatter: parseFrontmatter(content).data };
  }
  const content = `---\n${patchFrontmatterLines(fmText, changes)}\n---\n${body}`;
  return { content, frontmatter: parseFrontmatter(content).data };
}

/** The frontmatter text with each changed key's lines (the key line and its indented continuation) replaced, or appended. */
function patchFrontmatterLines(fmText: string, changes: Record<string, unknown>): string {
  const lines = fmText.split(/\r?\n/);
  for (const [key, value] of Object.entries(changes)) {
    const replacement = serializeFrontmatter({ [key]: value }).split("\n");
    const start = lines.findIndex((line) => line.startsWith(`${key}:`));
    if (start === -1) {
      lines.push(...replacement);
      continue;
    }
    let end = start + 1;
    while (end < lines.length && /^[ \t]/.test(lines[end] ?? "")) end++;
    lines.splice(start, end - start, ...replacement);
  }
  return lines.join("\n");
}

// ── Output contract ──────────────────────────────────────────────────────────
//
// Every engine kind is asked for the same reply: the JSON object of
// REFLECT_JSON_SCHEMA, or the framed-markdown frame for an LLM engine that
// rejects JSON Schema. The reply is validated by the parse functions below and
// repaired once, whatever engine produced it.

const REFLECT_FRONTMATTER_PATCH_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["description", "when_to_use", "title"],
  additionalProperties: false,
  properties: {
    description: { type: ["string", "null"] },
    when_to_use: { type: ["string", "null"] },
    title: { type: ["string", "null"] },
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
  required: ["confidence", "frontmatterPatch"],
  additionalProperties: false,
  properties: {
    confidence: REFLECT_CONFIDENCE_SCHEMA,
    frontmatterPatch: REFLECT_FRONTMATTER_PATCH_JSON_SCHEMA,
  },
};

export const REFLECT_UNSCOPED_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["ref", "confidence", "frontmatterPatch"],
  additionalProperties: false,
  properties: {
    ref: { type: "string", description: "Selected asset ref as a subdir-qualified conceptId." },
    confidence: { type: "number", minimum: 0, maximum: 1, description: "Self-reported quality confidence in [0, 1]." },
    frontmatterPatch: REFLECT_FRONTMATTER_PATCH_JSON_SCHEMA,
  },
};

/**
 * Frame for JSON Schema unless the connection already proved
 * this process that it rejects it (the transport retries plain text on a 4xx).
 */
function wantsJsonSchemaOutput(connection: { endpoint: string; model: string }): boolean {
  return !isJsonSchemaKnownUnsupported(connection);
}

export interface RunReflectIterationOptions {
  prompt: string | undefined;
  runner: RunnerSpec;
  timeoutMs?: number | null;
  signal?: AbortSignal;
  /**
   * JSON Schema the reply must match, sent as the request's output schema: as
   * `response_format` to an LLM engine (the transport falls back once on a
   * 4xx), as an instruction at the end of the prompt to an agent engine.
   */
  responseSchema?: Record<string, unknown>;
  chat?: typeof chatCompletion;
  maxTokens?: number;
  outputMode: ReflectOutputMode;
  /** Known target identity; target-scoped output never echoes it. */
  targetRef?: string;
  onNotices?: (notices: readonly Notice[]) => void;
  /** The child process's environment: an agent or SDK engine has one, an LLM does not. */
  environment?: Record<string, string>;
}

interface ReflectTelemetry {
  outputMode: ReflectOutputMode;
  repairAttempts: number;
}

function parsedRecord(result: AgentRunResult): Record<string, unknown> | undefined {
  return result.parsed && typeof result.parsed === "object" && !Array.isArray(result.parsed)
    ? (result.parsed as Record<string, unknown>)
    : undefined;
}

function reflectTelemetry(result: AgentRunResult): ReflectTelemetry | undefined {
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

const REFLECT_PATCH_FIELDS = ["description", "when_to_use", "title"] as const;

/** A parsed reflect reply: the asset it names, its confidence, and the fields it changes. */
interface ReflectPayload {
  ref: string;
  confidence: number;
  patch: ReflectPatch;
}

function parseReflectFrontmatterPatch(value: unknown): ReflectPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error('direct reflect response missing required object field "frontmatterPatch"');
  }
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).length !== REFLECT_PATCH_FIELDS.length || REFLECT_PATCH_FIELDS.some((f) => !(f in fields))) {
    throw new Error(`direct reflect frontmatterPatch fields must be exactly: ${REFLECT_PATCH_FIELDS.join(", ")}`);
  }
  const patch: ReflectPatch = {};
  for (const field of REFLECT_PATCH_FIELDS) {
    const fieldValue = fields[field];
    if (fieldValue === null) continue;
    if (typeof fieldValue !== "string" || !fieldValue.trim() || /[\r\n]/.test(fieldValue)) {
      throw new Error(`direct reflect frontmatterPatch.${field} must be a non-empty single-line string or null`);
    }
    patch[field] = fieldValue.trim();
  }
  return patch;
}

function parseSchemaReflectOutput(raw: string, targetRef: string | undefined): ReflectPayload {
  const parsed = parseEmbeddedJsonResponse<Record<string, unknown>>(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("direct reflect response was not valid JSON");
  }
  const expectedKeys = targetRef ? ["confidence", "frontmatterPatch"] : ["confidence", "frontmatterPatch", "ref"];
  const actualKeys = Object.keys(parsed).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error(`direct reflect response fields must be exactly: ${expectedKeys.join(", ")}`);
  }
  const ref = targetRef ?? (typeof parsed.ref === "string" ? parsed.ref.trim() : "");
  if (!ref) throw new Error('direct reflect response missing required string field "ref"');
  return {
    ref,
    confidence: parseReflectConfidence(parsed.confidence),
    patch: parseReflectFrontmatterPatch(parsed.frontmatterPatch),
  };
}

function parseFramedReflectOutput(raw: string, targetRef: string | undefined): ReflectPayload {
  const headerLines = raw.replaceAll("\r\n", "\n").trim().split("\n").filter(Boolean);
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
  let parsedPatch: unknown;
  try {
    parsedPatch = JSON.parse(patchLine.slice("AKM_REFLECT_FRONTMATTER_PATCH:".length).trim());
  } catch {
    throw new Error("direct reflect response contained invalid frontmatter patch JSON");
  }
  return {
    ref,
    confidence: parseReflectConfidence(Number(confidenceText)),
    patch: parseReflectFrontmatterPatch(parsedPatch),
  };
}

/**
 * One reflect call on any engine, as an agent-shaped result (errors captured,
 * never thrown except configuration). Every engine kind is sent the same request,
 * with the reply's schema as the output schema, and its reply is held to the same
 * contract: an unparseable reply gets one repair turn within the original
 * deadline, then fails. A failed agent or SDK dispatch is reported as it ran,
 * with its exit code and stderr; an LLM call has only its message.
 */
export async function runReflectIteration(opts: RunReflectIterationOptions): Promise<AgentRunResult> {
  const start = Date.now();
  let repairAttempts = 0;
  const configuredTimeout = Object.hasOwn(opts, "timeoutMs") ? (opts.timeoutMs ?? null) : opts.runner.timeoutMs;
  const deadline = typeof configuredTimeout === "number" ? start + configuredTimeout : undefined;
  const messages: ChatMessage[] = [{ role: "user", content: opts.prompt ?? "" }];
  const parse = (raw: string): Parsed<ReflectPayload> => {
    try {
      return {
        ok: true,
        value:
          opts.outputMode === "json_schema"
            ? parseSchemaReflectOutput(raw, opts.targetRef)
            : parseFramedReflectOutput(raw, opts.targetRef),
      };
    } catch (err) {
      return { ok: false, errors: [errMessage(err)] };
    }
  };
  const failure = (err: unknown, reason: AgentFailureReason, stdout = "", exitCode = 1): AgentRunResult => {
    const msg = errMessage(err);
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
  // The result of the dispatch that failed, kept for an agent or SDK engine.
  let dispatched: AgentRunResult | undefined;
  // Reflect parses and repairs its own reply (the repair turn below), so one dispatch, unvalidated.
  const call = async (callMessages: ChatMessage[], repairTimeoutMs?: number): Promise<string> => {
    const outcome = await callStageOnce({
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
      ...(opts.environment ? { current: { environment: opts.environment } } : {}),
      ...(opts.onNotices ? { onNotices: opts.onNotices } : {}),
    });
    if (!outcome.ok) {
      if (opts.runner.kind !== "connection") dispatched = outcome.result;
      throw outcome.reason === "timeout"
        ? new LlmCallError(outcome.error ?? "timeout", "timeout")
        : new Error(outcome.error ?? "dispatch failed");
    }
    return outcome.raw;
  };

  try {
    if (opts.signal?.aborted) throw new Error("Reflect request aborted");
    const loop = await structuredLoop<ReflectPayload>({
      dispatch: (correction) => {
        if (!correction) return call(messages);
        // The repair turn spends what is left of the original deadline, and does not start once the caller has aborted.
        if (opts.signal?.aborted) throw new Error("Reflect request aborted");
        const remaining = deadline === undefined ? undefined : deadline - Date.now();
        if (remaining !== undefined && remaining <= 0) {
          throw new LlmCallError("Reflect request timed out before output repair", "timeout");
        }
        repairAttempts = 1;
        const repair = `${buildReflectOutputRepairPrompt(opts.outputMode, opts.targetRef !== undefined)}\n\nWhat was wrong with it: ${correction.text}`;
        return call(
          [...messages, { role: "assistant", content: correction.reply }, { role: "user", content: repair }],
          remaining,
        );
      },
      parse,
      correct: (refusal) => refusal.errors.join("; "),
    });
    // A reply that broke the contract; its message is the parser's, on every engine kind.
    if (!loop.ok) return failure(new Error(loop.errors.join("; ")), "parse_error", loop.raw, 0);
    return {
      ok: true,
      stdout: JSON.stringify(loop.value),
      stderr: "",
      durationMs: Date.now() - start,
      exitCode: 0,
      parsed: { outputMode: opts.outputMode, repairAttempts },
    };
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    if (dispatched) return { ...dispatched, parsed: { outputMode: opts.outputMode, repairAttempts } };
    const reason: AgentFailureReason = opts.signal?.aborted
      ? "aborted"
      : err instanceof LlmCallError && err.code === "timeout"
        ? "timeout"
        : "non_zero_exit";
    return failure(err, reason);
  }
}

// ── Invocation ───────────────────────────────────────────────────────────────

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

/**
 * A proposal writes the file derived from the ref's type and name under the bundle's root. An asset indexed
 * anywhere else (a skill's `references/a.md` is `knowledge/skills/<name>/references/a`) has nothing there, so the
 * proposal would be a `create` and accepting it would add a second file for the ref (#1052).
 */
function fileOutsideLayoutFailure(
  ref: string,
  file: string,
  writes: string,
  emitFailed: ReflectRun["emitFailed"],
): { failure: AkmReflectResult } {
  emitFailed("unsupported_type", "file_outside_layout", ref);
  return {
    failure: {
      schemaVersion: 2,
      ok: false,
      reason: "unsupported_type" as AgentFailureReason,
      error: `Reflect refused: the file for ${ref} is ${file}, but a proposal would write ${writes}. Edit the file directly.`,
      ref,
      exitCode: null,
    },
  };
}

/** The target's parsed ref and current content, or a refusal for a type reflect cannot patch. */
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
  let assetFile: string | undefined;
  if (assetContent === undefined) {
    try {
      const qualifiedRef = options.itemRef ?? options.ref;
      const localFilePath = await findAssetFilePath(qualifiedRef, stash);
      if (localFilePath && fs.existsSync(localFilePath)) {
        assetFile = localFilePath;
      } else {
        const entry = await lookup(parseRefInput(qualifiedRef));
        if (entry?.filePath && fs.existsSync(entry.filePath)) assetFile = entry.filePath;
      }
      if (assetFile !== undefined) assetContent = fs.readFileSync(assetFile, "utf8");
    } catch {
      // An index miss is not fatal: reflect then has no content to patch.
    }
  }
  if (
    !REFLECT_ALLOWED_TYPES.has(parsedRef.type) &&
    (assetContent === undefined || parseFrontmatter(assetContent).frontmatter === null)
  ) {
    return unsupportedTypeFailure(options.ref, parsedRef.type, "its content is not frontmatter + markdown", emitFailed);
  }
  // A file in another bundle is `createProposal`'s to refuse (#1000); this one is in the proposal's own bundle.
  const root = path.resolve(options.target?.root ?? stash);
  const typeDir = stashDirFor(parsedRef.type);
  if (assetFile !== undefined && typeDir !== undefined && isWithin(assetFile, root)) {
    const writes = assetPathForName(parsedRef.type, path.join(root, typeDir), parsedRef.name);
    if (safeRealpath(writes) !== safeRealpath(assetFile)) {
      return fileOutsideLayoutFailure(options.ref, assetFile, writes, emitFailed);
    }
  }
  return { assetContent, parsedRef };
}

/**
 * The single connection or harness for this invocation: `--engine`, the improve
 * strategy's reflect process, or the default. Whatever its kind, reflect runs it
 * under the model-work tool policy.
 */
function resolveReflectRunner(options: AkmReflectOptions): {
  config: AkmConfig;
  activeStrategy: ImproveProfileConfig | undefined;
  runnerSpec: RunnerSpec;
  engineName: string;
  notices: readonly Notice[];
} {
  const config = options.config ?? loadConfig();
  const activeStrategy = options.improveProfile ?? config.improve?.strategies?.[config.improve?.strategy ?? "default"];
  const lower = (selection: Parameters<typeof resolveExecution>[0]) => {
    const prepared = resolveExecution(selection);
    return buildExecution(prepared.request, prepared.runner);
  };
  let lowered: { runner: RunnerSpec; notices: readonly Notice[] };
  if (options.engine) {
    lowered = lower({
      content: "reflect engine selection",
      config,
      layers: [shippedAlias(SHIPPED_ALIAS.improve), currentLayer({ engine: options.engine })],
      modelWork: true,
    });
  } else if (options.improveProfile) {
    const resolved = resolveImproveExecution({ config, processName: "reflect", alias: SHIPPED_ALIAS.improve });
    if (!resolved) {
      throw new ConfigError(
        "Reflect requires a connection or harness for the active improve strategy.",
        "LLM_NOT_CONFIGURED",
        "Run `akm setup`, or set improve.connection or improve.processes.reflect.connection.",
      );
    }
    lowered = resolved;
  } else {
    lowered = lower({
      content: "reflect engine selection",
      config,
      layers: [shippedAlias(SHIPPED_ALIAS.improve)],
      modelWork: true,
    });
  }
  const runnerSpec = lowered.runner;
  return { config, activeStrategy, runnerSpec, engineName: runnerSpec.name, notices: lowered.notices };
}

/**
 * The flat 12k content cap exists for CLI argv; the HTTP runner can spend half
 * its context window (after the rest of the prompt) on the asset, reserving
 * the other half for the reply. Never below the flat floor.
 */
function computeReflectContentBudgetChars(promptInput: ReflectPromptInput, runnerSpec: RunnerSpec): number | undefined {
  if (runnerSpec.kind !== "connection" || !promptInput.assetContent?.trim()) return undefined;
  const window = (runnerSpec.contextLength ?? DEFAULT_CONTEXT_LENGTH_TOKENS) * CHARS_PER_TOKEN;
  const overhead = buildReflectPrompt({ ...promptInput, contentBudgetChars: 0 }).prompt.length;
  return Math.max(REFLECT_CONTENT_CAP, Math.floor((window - overhead) / 2));
}

interface ReflectPromptSources {
  feedback: string[];
  schemaHints: string[];
  rejectedProposals: ReturnType<typeof rejectedProposalContext>;
  standardsContext: string;
}

/** Every read-only prompt input, shared by dispatch and `--show-prompt`. */
function gatherReflectPromptSources(
  options: AkmReflectOptions,
  stash: string,
  parsedRef: AssetRef | undefined,
  assetContent: string | undefined,
): ReflectPromptSources {
  return {
    feedback: readRecentFeedback(
      options.ref ? (options.itemRef ?? options.ref) : undefined,
      options.eventsCtx,
      assetContent,
    ),
    schemaHints: buildSchemaHints(parsedRef?.type ?? "", assetContent),
    rejectedProposals: rejectedProposalContext(stash, options.ref, options.ctx, options.eventsCtx),
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
}): { prompt: string; outputMode: ReflectOutputMode } {
  const { options, parsedRef, assetContent, sources, runnerSpec } = args;
  const { feedback, schemaHints, rejectedProposals, standardsContext } = sources;
  // A connection that rejects JSON Schema gets the framed contract; a harness gets the JSON object.
  const outputMode: ReflectOutputMode =
    runnerSpec.kind === "connection" && !wantsJsonSchemaOutput(runnerSpec) ? "framed_markdown" : "json_schema";
  const input: ReflectPromptInput = {
    ...(options.ref ? { ref: options.ref } : {}),
    ...(parsedRef?.type ? { type: parsedRef.type } : {}),
    ...(parsedRef?.name ? { name: parsedRef.name } : {}),
    ...(assetContent !== undefined ? { assetContent } : {}),
    ...(feedback.length > 0 ? { feedback } : {}),
    ...(schemaHints.length > 0 ? { schemaHints } : {}),
    ...(options.task ? { task: options.task } : {}),
    ...(standardsContext.trim() ? { standardsContext } : {}),
    ...(options.avoidPatterns && options.avoidPatterns.length > 0 ? { avoidPatterns: options.avoidPatterns } : {}),
    ...(rejectedProposals.length > 0 ? { rejectedProposals } : {}),
    outputMode,
  };
  const contentBudgetChars = computeReflectContentBudgetChars(input, runnerSpec);
  const { prompt } = buildReflectPrompt({
    ...input,
    ...(contentBudgetChars !== undefined ? { contentBudgetChars } : {}),
  });
  return { prompt, outputMode };
}

/**
 * Dispatch the reflect request once. Under the model-work tool policy an agent can edit only its own scratch
 * directory, which is gone once it returns, so it returns the proposal as its reply, as an LLM does.
 */
async function dispatchReflect(args: {
  run: ReflectRun;
  parsedRef: AssetRef | undefined;
  assetContent: string | undefined;
  sources: ReflectPromptSources;
  agentEnv: Record<string, string>;
}): Promise<AgentRunResult> {
  const { run, parsedRef, assetContent, sources, agentEnv } = args;
  const { options, runnerSpec } = run;
  const { prompt, outputMode } = buildReflectPromptText({ options, parsedRef, assetContent, sources, runnerSpec });
  return runReflectIteration({
    prompt,
    runner: runnerSpec,
    ...(Object.hasOwn(options, "timeoutMs") ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(outputMode === "json_schema"
      ? { responseSchema: options.ref ? REFLECT_JSON_SCHEMA : REFLECT_UNSCOPED_JSON_SCHEMA }
      : {}),
    outputMode,
    ...(options.ref ? { targetRef: options.ref } : {}),
    ...(options.chat ? { chat: options.chat } : {}),
    // Only a harness (or the internal runtime) runs a child process, which has an environment.
    ...(runnerSpec.kind !== "connection" && Object.keys(agentEnv).length > 0 ? { environment: agentEnv } : {}),
    onNotices: run.notices.add,
  });
}

/**
 * The judge's review band for a reflect revision: a non-pass whose mean is at or above this goes to a
 * person (`judge-uncertain`); a lower one is refused. The judge's own review label starts at 2.5, but
 * nothing labelled below 3.5 is worth a person's time. Labelled runs of the judge (akm-eval judge-gate,
 * lab 27B Q2; ~/akm/eval/judge-gate/tuning), good / bad among non-passing verdicts:
 *   mean >= 3.5, frontmatter-only proposals Opus reviewed: 17 / 9 (shipped judge, 113 proposals),
 *     15 / 0, 18 / 9 and 15 / 5 (earlier rubric, three runs);
 *   mean >= 3.5, public corpus of body rewrites: 12 / 35;
 *   mean < 3.5, 396 labelled body rewrites: 6 / 285 (Q4 judge 5 / 177, Q2 judge 1 / 108);
 *     public corpus 3 / 37; frontmatter-only proposals: 1 / 2 (shipped judge), 5 / 1 (earlier runs).
 * Mean 4.0 with one criterion at 2 was good 14 / 0; mean 3.67 was 3 / 8. A rule on the lowest
 * criterion did not help: a criterion at 3 or more is rare in a non-pass, and a 2 is the usual
 * shape of a good one.
 */
const REFLECT_REVIEW_MIN_SCORE = 3.5;

const NOISE_SUBREASONS = {
  noop: "reflect_skipped_noop",
  cosmetic: "reflect_skipped_cosmetic",
} as const;

/**
 * Apply the patch, drop a no-op/cosmetic change,
 * judge the exact content that would be persisted, then mint. A revision with a
 * deterministic defect is refused before the judge runs, whether or not the
 * gate is on.
 */
async function finalizeReflectProposal(args: {
  run: ReflectRun;
  payload: ReflectPayload;
  assetContent: string;
  result: AgentRunResult;
  judge: { enabled: boolean; skippedNoJudge: boolean; runner: RunnerSpec | undefined };
  feedback: string[];
}): Promise<AkmReflectResult> {
  const { run, payload, assetContent, result, judge, feedback } = args;
  const { options } = run;
  const telemetry = reflectTelemetry(result) ?? {};
  const patched = applyReflectPatch(payload.patch, assetContent, payload.ref);
  // A patch that changes nothing leaves the asset as it is: an empty diff.
  const content = patched?.content ?? assetContent;

  const changeKind = classifyReflectChange(assetContent, content);
  if (changeKind === "noop" || changeKind === "cosmetic") {
    run.emitFailed("no_change", NOISE_SUBREASONS[changeKind], options.ref, { changeKind, ...telemetry });
    const what =
      changeKind === "noop"
        ? "identical to the current asset (empty diff)"
        : "a cosmetic-only reformat of the current asset (whitespace/fence/YAML-folding changes)";
    return reflectFailure(
      run,
      result,
      "no_change",
      `Reflect skipped: proposed content for ${payload.ref} is ${what}; no proposal created.`,
      false,
    );
  }

  /** A judge refused the revision: record it for the ledger's rejection window and stop. */
  const refuse = (detail: string, metadata: Record<string, unknown>, message: string): AkmReflectResult => {
    if (options.ref) {
      recordLedgerAttempt(
        { proposalsCtx: options.ctx, eventsCtx: options.eventsCtx },
        {
          stashDir: run.stash,
          ref: options.itemRef ?? options.ref,
          source: "reflect",
          outcome: "quality_rejected",
          detail,
        },
      );
    }
    appendEvent(
      {
        eventType: "reflect_completed",
        ref: payload.ref,
        metadata: { source: "reflect", qualityRejected: true, ...metadata, ...telemetry },
      },
      options.eventsCtx,
    );
    return reflectFailure(run, result, "quality_rejected", message, false);
  };
  // A defect no judge needs to weigh is refused before any judge call, whether or not the gate is on.
  const defect = findReflectDefect(assetContent, content, options.defectFilter);
  if (defect) return refuse(defect, { reflectDefect: defect }, `Reflect proposal refused before the judge: ${defect}`);
  let verdict: QualityJudgeResult | undefined;
  let judgeFailed = false;
  let judgeUncertain = false;
  if (judge.enabled) {
    verdict = await runReflectQualityJudge(run.config, content, assetContent, feedback, options.chat, {
      runnerSelectionFrozen: true,
      ref: payload.ref,
      ...(judge.runner ? { llmRunner: judge.runner } : {}),
      ...(Object.hasOwn(options, "timeoutMs") ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      onNotices: run.notices.add,
    });
    // A judge that timed out, errored or replied unparseably gave no verdict: a person reviews the revision.
    judgeFailed = verdict.reviewNeeded === true && verdict.score === -1;
    // A real score in the band is uncertain, not bad: a person decides, and no window is recorded.
    judgeUncertain = verdict.reviewNeeded === true && verdict.score >= REFLECT_REVIEW_MIN_SCORE;
    if (!verdict.pass && !judgeFailed && !judgeUncertain) {
      return refuse(
        verdict.reason,
        {
          qualityScore: verdict.score,
          qualityReason: verdict.reason,
          ...(verdict.criteria ? { qualityCriteria: verdict.criteria } : {}),
        },
        `Reflect proposal quality gate rejected: score=${verdict.score}, reason="${verdict.reason}"`,
      );
    }
  }

  const reviewReasons = [
    ...(judge.skippedNoJudge ? ["no-judge-configured"] : []),
    ...(judgeFailed ? ["judge-error"] : []),
    ...(judgeUncertain ? ["judge-uncertain"] : []),
  ];
  const gateReview = judgeFailed || judgeUncertain;
  const proposal = mintProposal(
    run.stash,
    options.ctx,
    {
      ref: payload.ref,
      ...(options.target ? { target: options.target } : {}),
      source: "reflect",
      sourceRun: `reflect-${Date.now()}`,
      payload: { content, ...(patched?.frontmatter ? { frontmatter: patched.frontmatter } : {}) },
      confidence: payload.confidence,
      ...(options.eligibilitySource ? { eligibilitySource: options.eligibilitySource } : {}),
      ...(options.itemRef ? { itemRef: options.itemRef, attemptedRefs: [options.itemRef] } : {}),
    },
    reviewReasons.length > 0
      ? {
          review: {
            reason: reviewReasons.join("+"),
            // The quality gate's hand-off to a person, as distill's: the triage drain leaves it alone.
            gate: gateReview ? "quality-gate" : "reflect",
            ...(gateReview && verdict?.criteria ? { scores: verdict.criteria } : {}),
            ...(gateReview && verdict?.reason ? { judgeReason: verdict.reason } : {}),
          },
        }
      : { judged: verdict },
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
        ...(judgeFailed || judgeUncertain ? { qualityReason: verdict?.reason } : {}),
        ...(judgeUncertain ? { qualityScore: verdict?.score } : {}),
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
  const sources = gatherReflectPromptSources(options, stash, source.parsedRef, source.assetContent);
  const { prompt } = buildReflectPromptText({
    options,
    parsedRef: source.parsedRef,
    assetContent: source.assetContent,
    sources,
    runnerSpec,
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
  const judgeWanted = activeStrategy?.processes?.reflect?.qualityGate?.enabled ?? true;
  let judgeRunner: RunnerSpec | undefined;
  if (judgeWanted) judgeRunner = resolveQualityGateJudge(config, activeStrategy, "reflect", notices.add);
  const skippedNoJudge = judgeWanted && !judgeRunner;
  if (skippedNoJudge) {
    warnOnce(
      "reflect-quality-gate-no-judge",
      "Reflect proposal quality gate has no connection or harness to judge proposals (run `akm setup`). Skipping the gate for this run; the proposal is queued for human review instead.",
    );
  }

  const sources = gatherReflectPromptSources(options, stash, parsedRef, assetContent);
  const agentEnv: Record<string, string> = options.eventSource === "improve" ? { AKM_EVENT_SOURCE: "improve" } : {};
  const sensitiveValues = collectDispatchSensitiveValues(runnerSpec);
  let result: AgentRunResult;
  let payload: ReflectPayload;
  try {
    result = await dispatchReflect({ run, parsedRef, assetContent, sources, agentEnv });
    emitInvoked();
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
          error: enoentHintMessage(runnerSpec.kind === "connection" ? engineName : runnerSpec.bin),
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
        ...(reflectTelemetry(result) ?? {}),
      });
      return { ...envelope, ...notices.fields() };
    }
    // The iteration parsed the reply and put its payload on stdout.
    payload = JSON.parse(result.stdout) as ReflectPayload;
  } catch (error) {
    if (!(error instanceof ConfigError)) emitInvoked();
    throw error;
  }

  const generated = Object.values(payload.patch).join("\n");
  const unsafeContent = generatedContentRejection(generated, redactSensitiveText(generated, sensitiveValues));
  if (unsafeContent) {
    emitFailed("parse_error", "parse_error", options.ref, exitCodeMeta(result));
    return reflectFailure(run, result, "parse_error", unsafeContent, false);
  }
  // An unscoped reply names its asset only now: read it as a targeted run read its own before dispatch.
  const target = options.ref
    ? { assetContent }
    : await resolveReflectSource({ ...options, ref: payload.ref }, stash, emitFailed);
  if ("failure" in target) return target.failure;
  return finalizeReflectProposal({
    run,
    payload,
    assetContent: target.assetContent ?? "",
    result,
    judge: { enabled: judgeWanted && !skippedNoJudge, skippedNoJudge, runner: judgeRunner },
    feedback: sources.feedback,
  });
}
