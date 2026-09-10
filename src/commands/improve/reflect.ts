// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm reflect [ref]` — proposal-producing agent command (#226).
 *
 * Pipeline:
 *
 *   1. Emit `reflect_invoked` event at command entry (always, even on failure).
 *   2. If `ref` is provided, look the asset up via the FTS index and read its
 *      content. Pull recent feedback (`feedback` events for that ref) and
 *      lesson-lint findings to surface as schema hints.
 *   3. Build the prompt via {@link buildReflectPrompt}.
 *   4. Prepare, authorize, lower, and dispatch the frozen engine selection.
 *   5. Parse the agent's stdout into a {@link AgentProposalPayload}.
 *   6. Insert into the proposal queue via {@link createProposal} with
 *      `source: "reflect"`.
 *
 * Failures are surfaced as structured envelopes carrying an
 * {@link AgentFailureReason} discriminant. Reflect NEVER calls
 * `writeAssetToSource` directly — the proposal queue is the only path to
 * a committed asset, and the `accept` flow is the bridge.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assembleAssetFromString, serializeFrontmatter } from "../../core/asset/asset-serialize";
import { parseFrontmatter } from "../../core/asset/frontmatter";
import { type AssetRef, conceptIdFromTypeName, parseRefInput } from "../../core/asset/resolve-ref";
import { DESCRIPTION_MAX_CHARS, requiresDescription } from "../../core/authoring-rules";
import type { AkmConfig, ImproveProfileConfig } from "../../core/config/config";
import { loadConfig } from "../../core/config/config";
import { ConfigError, UsageError } from "../../core/errors";
import { appendEvent, type EventsContext, readEvents } from "../../core/events";
import type { AkmReflectFailure, AkmReflectResult } from "../../core/improve-types";
import { lintLessonContent } from "../../core/lesson-lint";
import { parseEmbeddedJsonResponse } from "../../core/parse";
import { redactSensitiveText } from "../../core/redaction";
import { resolveStandardsContext } from "../../core/standards/resolve-standards-context";
import { warn, warnOnce } from "../../core/warn";
import type { LoweringNotice } from "../../execution/resolved-request";
import { lookup } from "../../indexer/indexer";
import type { AgentFailureReason, AgentRunResult, RunAgentOptions } from "../../integrations/agent";
import { DEFAULT_LLM_TIMEOUT_MS } from "../../integrations/agent/config";
import {
  fallbackAnnouncement,
  NO_ENGINE_MESSAGE_SUFFIX,
  NO_ENGINE_REMEDY,
  withEngineFallback,
} from "../../integrations/agent/engine-fallback";
import {
  acquireLoweredExecutionDispatchLease,
  dispatchLoweredExecutionRequest,
  disposeLoweredExecutionDispatchLease,
  type LoweredExecutionDispatchLease,
  lowerResolvedExecutionRequest,
  lowerResolvedExecutionRequestWithRunner,
} from "../../integrations/agent/execution-lowering";
import { prepareInlineExecution, prepareInlineExecutionWithRunner } from "../../integrations/agent/inline-execution";
import {
  buildReflectOutputRepairPrompt,
  buildReflectPrompt,
  extractDraftConfidence,
  parseAgentProposalPayload,
  REFLECT_CONTENT_CAP,
  REFLECT_TRUNCATION_MARKER,
  type ReflectLlmOutputMode,
  type ReflectPromptInput,
  type RejectedProposalContext,
} from "../../integrations/agent/prompts";
import { type RunnerSpec, runnerIsLlm, runnerSupportsFileWrite } from "../../integrations/agent/runner";
import { collectDispatchSensitiveValues, type RunnerSeams } from "../../integrations/agent/runner-dispatch";
import { type ChatMessage, type chatCompletion, isJsonSchemaKnownUnsupported, LlmCallError } from "../../llm/client";
import { callStructured } from "../../llm/structured-call";
import { baseFailureFields, enoentHintMessage, isEnoentFailure } from "../agent/agent-support";
import type { EligibilitySource } from "../proposal/proposal-types";
import {
  type CreateProposalInput,
  isProposalSkipped,
  listProposalsReadOnly,
  type Proposal,
  type ProposalsContext,
  proposalContent,
  recordGateDecision,
} from "../proposal/repository";
import { checkReflectSize, isValidDescription } from "../proposal/validators/proposal-quality-validators";
import { CHARS_PER_TOKEN, DEFAULT_CONTEXT_LENGTH_TOKENS } from "./consolidate/chunking";
import { deriveLessonRef } from "./distill";
import { runReflectQualityJudge } from "./distill/quality-gate";
import { findAssetFilePath } from "./eligibility";
import { resolveImproveLlmExecution } from "./execution";
import { emitProposal } from "./proposal-envelope";
import { classifyReflectChange } from "./reflect-noise";
import { createRunContext, type RunContext, resolveRunStashDir } from "./run-context";
import { MAX_REJECTED_PROPOSALS } from "./shared";
import { durableImproveRef, improveStateReadRefs } from "./source-identity";

function collectLoweringNotices(
  target: Map<string, Readonly<LoweringNotice>>,
  notices: readonly Readonly<LoweringNotice>[],
): void {
  for (const notice of notices) target.set(JSON.stringify(notice), notice);
}

function reflectNoticeFields(notices: Map<string, Readonly<LoweringNotice>>): {
  notices?: readonly Readonly<LoweringNotice>[];
} {
  return notices.size > 0 ? { notices: Object.freeze([...notices.values()]) } : {};
}

export interface AkmReflectOptions {
  /**
   * Active improve profile for this run. When set, its per-process `reflect`
   * override wins over the `default` profile (e.g. runner resolution); absent
   * falls back to `default`.
   */
  improveProfile?: ImproveProfileConfig;
  /** Optional asset ref (`[bundle//]conceptId`, e.g. `lessons/my-lesson`) to focus on. */
  ref?: string;
  /** Optional task hint passed through to the reflection prompt. */
  task?: string;
  /** Override the named engine (defaults to `defaults.engine`). */
  engine?: string;
  /** Override the spawn timeout. */
  timeoutMs?: number;
  /** Shared improve deadline signal for direct LLM dispatch and judging. */
  signal?: AbortSignal;
  /** Test seam: override the stash dir. */
  stashDir?: string;
  /** Resolved current bundle destination for proposals emitted by reflect. */
  target?: NonNullable<CreateProposalInput["target"]>;
  /** Test seam: forwarded to runAgent for fake spawn / timers. */
  runAgentOptions?: Pick<RunAgentOptions, "spawn" | "setTimeoutFn" | "clearTimeoutFn">;
  /** Test seam for SDK generation without starting a real SDK server. */
  runSdk?: RunnerSeams["runSdk"];
  /** Test seam: stable id / clock for proposal creation. */
  ctx?: ProposalsContext;
  /**
   * Events context carrying the improve run's long-lived state.db handle (or
   * the C2 boundary-pinned path) so reflect's event emits take appendEvent's
   * fast path instead of a per-event open/migrate/close (R25). Populated by
   * the improve loop; standalone CLI reflect leaves it unset.
   */
  eventsCtx?: EventsContext;
  /**
   * Error patterns from earlier assets in the same improve run. When non-empty,
   * injected into the reflect prompt so the agent avoids repeating the same
   * mistakes across assets.
   */
  avoidPatterns?: string[];
  /**
   * Optional chat seam for the proposal quality gate (R-5 / #374).
   * Defaults to {@link chatCompletion}. Injected in tests to avoid real LLM calls.
   */
  chat?: typeof chatCompletion;
  /**
   * Override the loaded AkmConfig (test seam + for the quality gate).
   * Needed by R-5 to access the selected strategy's proposal quality gate
   * without a real config file in tests.
   */
  config?: import("../../core/config/config").AkmConfig;
  /**
   * Event source for usage logging. Set to `"improve"` when called from
   * `akm improve` so agent subprocess events are tagged and can be
   * filtered out of user-facing history.
   */
  eventSource?: "user" | "improve";
  /**
   * #639 low-value filter (DEFAULT OFF). When true, "low-value" changes — a
   * 2-3 changed-token prose micro-rewrite with no code/frontmatter/structural/
   * negation/decision signal (see classifyReflectChange) — are deferred like
   * noop/cosmetic instead of becoming proposals. The improve loop resolves this
   * from the active strategy's `processes.reflect.lowValueFilter.enabled`; the
   * standalone `akm reflect` command leaves it off.
   */
  lowValueFilter?: boolean;
  /**
   * Maximum number of iterative self-refinement passes (R-1 / #372).
   * Default: 1 (single-shot, no refinement — preserves existing behaviour).
   * Capped at 3 to prevent runaway loops.
   *
   * On each pass beyond the first the prior draft is injected back into the
   * prompt as Self-Refine critique context (arXiv:2303.17651). The loop stops
   * early if the agent returns the same content as the previous iteration.
   */
  maxRefineIters?: number;
  /**
   * Test seam: pre-loaded source asset content. When set, bypasses the
   * indexer `lookup()` step so the safety-rail / sanitizer tests can pin
   * down what reflect sees as the source — without needing a fully built
   * FTS index in the test fixture.
   *
   * In production this is always `undefined`; the indexer drives lookup.
   */
  assetContent?: string;
  /**
   * Attribution tagging: which eligibility lane (`signal-delta`, `high-salience`,
   * `proactive`, `scope`) selected this asset for the current improve run. Set by
   * `akm improve`'s loop from the partitioned {@link ImproveEligibleRef}. Recorded
   * in `reflect_invoked` event metadata and persisted on the created proposal so
   * accept/reject/revert/retrieval outcomes can be sliced by lane. Omitted for
   * direct `akm reflect` invocations (no lane → downstream treats as `"unknown"`).
   */
  eligibilitySource?: EligibilitySource;
  /**
   * The resolved index entry's fully-qualified durable key
   * (`<bundle>//<conceptId>`, from {@link ImproveEligibleRef.itemRef}).
   * When absent, reflect uses the input conceptId as its durable key.
   */
  itemRef?: string;
}

const MAX_FEEDBACK_LINES = 10;
const MAX_GLOBAL_FEEDBACK_LINES = 20;

/**
 * Pull recent `feedback` events from events.jsonl. When `ref` is present we
 * scope to that asset; otherwise we surface the most recent feedback across
 * all assets so `akm reflect` can operate in a general "review recent
 * signals" mode. Best-effort — a missing or empty events stream returns `[]`.
 */
function readOnlyEventsContext(ctx?: EventsContext): EventsContext {
  return ctx?.db ? ctx : { ...(ctx ?? {}), readOnly: true };
}

function readRecentFeedback(ref?: string, eventsCtx?: EventsContext): string[] {
  try {
    const events = readEvents({ type: "feedback", ...(ref ? { ref } : {}) }, readOnlyEventsContext(eventsCtx)).events;
    const lines: string[] = [];
    const limit = ref ? MAX_FEEDBACK_LINES : MAX_GLOBAL_FEEDBACK_LINES;
    for (const event of events.slice(-limit)) {
      const md = (event.metadata ?? {}) as Record<string, unknown>;
      const signal = typeof md.signal === "string" ? md.signal : "?";
      const note = typeof md.reason === "string" ? md.reason : typeof md.note === "string" ? md.note : "";
      const details = note ? `[${signal}] ${note}` : `[${signal}]`;
      lines.push(!ref && event.ref ? `${event.ref} ${details}` : details);
    }
    return lines;
  } catch {
    return [];
  }
}

/**
 * Asset types that reflect is allowed to operate on.
 *
 * Reflect's canonical output shape is `frontmatter + markdown body`. Running it
 * against types whose on-disk form is NOT markdown (executable scripts, env files
 * env files, YAML tasks) blindly prepends `---\n…\n---\n` to the asset and
 * breaks the runtime contract — for example a `.ts` script with a YAML preamble
 * is a TypeScript syntax error.
 *
 * Whitelisting (rather than blacklisting) keeps the door closed by default as
 * new asset types are registered. To allow a custom registered type, extend
 * this set explicitly.
 *
 * Observed regression: proposal `8737ab63` (May 2026) prepended frontmatter to
 * a `.ts` script file via reflect. This whitelist prevents that.
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

function isReflectableSourceShape(content: string): boolean {
  return parseFrontmatter(content).frontmatter !== null;
}

/**
 * Identity / structural frontmatter fields the LLM is NEVER allowed to change.
 *
 * Renaming `name` on a skill silently breaks ref resolution because the ref is
 * derived from the on-disk path. Similar reasoning for `ref`, `id`, `slug`,
 * and `type`. The post-processor below restores any of these fields if the
 * LLM tried to rewrite them.
 *
 * Observed regression: proposal `26941510` (May 2026) renamed
 * `skills/openpalm-stack-diagnostics`'s `name` field to `"diagnostic-checklist"`.
 */
const PROTECTED_FRONTMATTER_FIELDS: ReadonlySet<string> = new Set(["name", "ref", "id", "slug", "type"]);

/**
 * Read the last 1–3 archived rejected proposals for a given ref from the
 * proposal store. Returns `[]` when the proposals store is absent (not yet
 * created) or the ref is undefined — `listProposalsReadOnly` already handles
 * that case; a genuine read failure propagates instead of being swallowed,
 * since silently dropping this Reflexion-style context risks re-proposing
 * content that was already rejected (arXiv:2303.11366).
 */
function readRejectedProposals(
  stash: string,
  ref?: string,
  proposalsCtx?: ProposalsContext,
): RejectedProposalContext[] {
  if (!ref) return [];
  return listProposalsReadOnly(stash, { ref, status: "rejected", includeArchive: true }, proposalsCtx)
    .sort((a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime())
    .slice(0, MAX_REJECTED_PROPOSALS)
    .map((p) => ({
      ref: p.ref,
      reason: p.review?.reason ?? "no reason given",
      contentPreview: proposalContent(p).slice(0, 500),
    }));
}

/**
 * Synthesize a tmp draft-file path for the agent/sdk file-write contract.
 *
 * Mirrors the draft-path synthesis in `src/commands/proposal/propose.ts` —
 * when the runner is agent-CLI or the OpenCode SDK, we instruct the agent to
 * write the proposal body directly to this file instead of inlining it in
 * JSON on stdout. This bypasses two
 * known failure modes for long assets: (a) ARG_MAX truncation on prompt
 * round-trips through fenced JSON, and (b) embedded-JSON parser brittleness
 * on multi-KB bodies (e.g. the `knowledge/systems/KOKORO_USAGE_GUIDE` 8.4KB
 * payload that produced 4/5 `parse_error` in May 2026 reflect validation).
 *
 * The path lives under {@link os.tmpdir} and embeds the (sanitized) ref +
 * timestamp + random suffix so concurrent reflect calls cannot collide.
 *
 * The LLM HTTP runner cannot use this path because chat-completion transport
 * has no filesystem access.
 */
function synthesizeReflectDraftPath(ref: string | undefined): string {
  const safeRef = (ref ?? "no-ref").replace(/[^a-z0-9_-]/gi, "_");
  const rand = Math.random().toString(36).slice(2, 8);
  return path.join(os.tmpdir(), `akm-reflect-${safeRef}-${Date.now()}-${rand}.md`);
}

/**
 * Heuristic check that the agent honoured the file-write contract.
 * The contract instructs the agent to emit a single `DRAFT_WRITTEN` line on
 * stdout when it has finished writing the draft file. Some agents print
 * additional log lines; we match anywhere in the captured stdout.
 */
function stdoutSignalsDraftWritten(stdout: string | undefined): boolean {
  if (!stdout) return false;
  return /\bDRAFT_WRITTEN\b/.test(stdout);
}

/**
 * Build schema/lint hints for the prompt. For lesson refs, run the lesson
 * lint over the current content and surface any findings — they are a
 * concrete starting point for the agent's revision.
 */
function buildSchemaHints(type: string, content: string | undefined): string[] {
  if (!content) return [];
  if (type !== "lesson") return [];
  const report = lintLessonContent(content, "reflect");
  return report.findings.map((f) => `[${f.kind}] ${f.message}`);
}

interface RelatedLesson {
  ref: string;
  content: string;
}

function hasRelatedSkillSource(content: string, skillRef: string): boolean {
  const parsed = parseFrontmatter(content);
  const sources = parsed.data.sources;
  return Array.isArray(sources) && sources.some((source) => typeof source === "string" && source.trim() === skillRef);
}

async function readRelatedLessons(
  ctx: RunContext,
  stash: string,
  ref: string,
  parsedRef: { type: string; name: string },
  itemRef?: string,
): Promise<RelatedLesson[]> {
  if (parsedRef.type !== "skill") return [];

  const related = new Map<string, RelatedLesson>();
  const derivedLessonRef = deriveLessonRef(ref);
  const candidateRefs = new Set<string>([derivedLessonRef]);
  const derivedLessonPath = path.join(stash, "lessons", `${parseRefInput(derivedLessonRef).name}.md`);
  if (fs.existsSync(derivedLessonPath)) {
    // WI-9.10: genuine content read — routed through the per-invocation asset
    // memo (D6). No write to this same path happens later in this invocation,
    // so memoizing is safe (see run-context.ts's D6 seam docblock).
    related.set(derivedLessonRef, { ref: derivedLessonRef, content: ctx.readAsset(derivedLessonPath) });
  }

  try {
    // Match events using the candidate's single durable state key.
    const distillInvokedKeys = new Set(improveStateReadRefs(ref, itemRef));
    const feedbackEvents = readEvents({ type: "distill_invoked" }, readOnlyEventsContext(ctx.eventsCtx)).events.filter(
      (event) => event.ref !== undefined && distillInvokedKeys.has(event.ref),
    );
    for (const event of feedbackEvents) {
      const proposalRef = typeof event.metadata?.proposalRef === "string" ? event.metadata.proposalRef : undefined;
      if (proposalRef && lenientRefType(proposalRef) === "lesson") candidateRefs.add(proposalRef);
    }
  } catch {
    // Best effort only.
  }

  for (const candidateRef of candidateRefs) {
    try {
      const filePath = await findAssetFilePath(durableImproveRef(candidateRef), stash);
      if (!filePath || !fs.existsSync(filePath)) continue;
      const content = ctx.readAsset(filePath);
      related.set(candidateRef, { ref: candidateRef, content });
    } catch {
      // Index miss is non-fatal.
    }
  }

  try {
    const lessonsDir = path.join(stash, "lessons");
    if (fs.existsSync(lessonsDir)) {
      for (const fileName of fs.readdirSync(lessonsDir)) {
        if (!fileName.endsWith(".md")) continue;
        const content = ctx.readAsset(path.join(lessonsDir, fileName));
        if (!hasRelatedSkillSource(content, ref)) continue;
        const lessonName = fileName.slice(0, -3);
        const lessonRef = conceptIdFromTypeName("lesson", lessonName);
        if (!related.has(lessonRef)) {
          related.set(lessonRef, { ref: lessonRef, content });
        }
      }
    }
  } catch {
    // Best effort only.
  }

  // R-4 / #373: Filter out lessons with `derived_from_reflect: true` unless
  // independent feedback exists for the skill. This prevents the echo-chamber
  // risk where reflect-output lessons feed back into the next reflect pass as
  // "independent" evidence, amplifying their own prior outputs over time.
  //
  // ExpeL arXiv:2308.10144: rules need differential evidence from independent
  // sources (success vs failure traces). A lesson that only ever appeared from
  // reflect-internal signals has no such differential signal.
  //
  // "Independent feedback" = any usage_events "feedback" events for the skill
  // ref itself, indicating a human or external system rated the skill.
  let hasIndependentFeedback = false;
  try {
    const feedbackEventsForSkill = readEvents({ type: "feedback", ref }, readOnlyEventsContext(ctx.eventsCtx)).events;
    hasIndependentFeedback = feedbackEventsForSkill.length > 0;
  } catch {
    // Best effort — if we can't check, allow all lessons through.
    hasIndependentFeedback = true;
  }

  if (!hasIndependentFeedback) {
    // No independent feedback: exclude all reflect-derived lessons to prevent
    // echo-chamber amplification.
    for (const [lessonRef, lesson] of related.entries()) {
      try {
        const lessonFm = parseFrontmatter(lesson.content);
        if (lessonFm.data.derived_from_reflect === true) {
          related.delete(lessonRef);
        }
      } catch {
        // If we can't parse the frontmatter, keep the lesson (safe default).
      }
    }
  }

  return [...related.values()];
}

/**
 * Returns true only when `stdout` is a recognised AKM proposal-skip signal.
 *
 * Accepted forms are structured JSON: `{ skipped: true }` or
 * `{ reason: "<known-skip-reason>" }`.
 */
function isStructuredCooldownSignal(stdout: string): boolean {
  try {
    const parsed = JSON.parse(stdout.trim());
    if (parsed?.skipped === true) return true;
    if (typeof parsed?.reason === "string" && ["fingerprint_match", "rejection_backoff"].includes(parsed.reason))
      return true;
  } catch {
    // Non-JSON stdout is never a structured cooldown signal.
  }
  return false;
}

/**
 * Best-effort asset type for a maybe-ref string, in the 0.9.0 `[bundle//]conceptId`
 * grammar (`""` when it does not parse). Replaces the pre-0.9.0 `ref.split(":")[0]`
 * type-extraction, which yielded the whole conceptId (`lessons/my-lesson`) instead
 * of the type once refs stopped carrying a `type:` prefix (ref-grammar decision
 * D-R3). Lenient by design — the callers degrade gracefully on an empty type.
 */
function lenientRefType(ref: string | undefined): string {
  if (!ref) return "";
  try {
    return parseRefInput(ref).type;
  } catch {
    return "";
  }
}

/** Outcome of {@link sanitizeReflectPayload}. */
export interface ReflectSanitizeResult {
  /** Sanitized content (frontmatter preserved + identity fields restored). */
  content: string;
  /** Sanitized frontmatter object suitable for {@link CreateProposalInput.payload.frontmatter}. */
  frontmatter?: Record<string, unknown>;
  /** Non-fatal warnings recorded in the event metadata. */
  warnings: string[];
  /** When set, the proposal must be rejected with this reason / error. */
  reject?: { reason: AgentFailureReason; error: string };
  sizeGuardRatio?: { code: "EXCESSIVE_SHRINKAGE" | "EXCESSIVE_EXPANSION"; ratio: number };
  /** #952 — the model echoed REFLECT_TRUNCATION_MARKER into its rewrite. */
  truncationMarkerLeaked?: boolean;
}

/**
 * Split a markdown blob into `[frontmatterText, bodyText]`.
 *
 * Returns `[null, raw]` when the blob does not start with a frontmatter block.
 */
function splitFrontmatter(raw: string): { fmText: string | null; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { fmText: null, body: raw };
  return { fmText: m[1]!, body: m[2]! };
}

/**
 * Strip an LLM-appended duplicate frontmatter block from a body string.
 *
 * When the LLM echoes the original source file verbatim after its rewrite,
 * the resulting body contains a second `---...---` YAML block. We detect it
 * by requiring BOTH a balanced fence (opening + closing `---`) AND YAML-like
 * `key: value` content inside, so legitimate Markdown thematic breaks and
 * code-fence examples are never truncated.
 */
function stripAppendedFrontmatter(body: string): string {
  const fencePattern = /\n---\r?\n([\s\S]*?)\n---\r?\n/;
  const match = body.match(fencePattern);
  if (!match) return body;
  // Only strip when the captured block looks like YAML frontmatter.
  if (!/^\w[\w-]*:/m.test(match[1]!)) return body;
  return body.slice(0, body.indexOf(match[0])).replace(/\s+$/, "");
}

/**
 * #636 — deterministically derive a valid `description` from an asset's existing
 * metadata when one is missing. Sources, in priority order: the `title:`
 * frontmatter field, the first `# Heading` in the (proposed or source) body, and
 * the first sentence of the opening body paragraph. The candidate is normalized
 * (whitespace collapsed, trailing punctuation/markdown stripped, clamped to the
 * description max) and only returned if it PASSES `isValidDescription` — so this
 * never produces a heading-fragment, truncated, or otherwise gate-failing value.
 * Returns `undefined` when nothing usable can be derived (caller leaves the
 * proposal as-is rather than fabricating prose).
 *
 * This is intentionally deterministic and lives in the reflect proposal-build
 * path — it does NOT touch the validators or the promote-time repair.
 */
function deriveDescriptionFromAsset(
  title: unknown,
  proposedBody: string,
  sourceBody: string,
  targetRef: string,
): string | undefined {
  // Each candidate is tagged with its kind. A title or `# Heading` is a bare
  // fragment ("Paged.js — Named Page") that reads poorly as a description even
  // when it is long enough to pass the length gate, so for those we prefer the
  // padded sentence form. A prose sentence is already a sentence, so it is used
  // as-is (padding it would double-wrap an already-complete sentence).
  const candidates: Array<{ text: string; kind: "fragment" | "prose" }> = [];

  // 1. title: frontmatter
  if (typeof title === "string" && title.trim()) candidates.push({ text: title.trim(), kind: "fragment" });

  // 2. first `# Heading` (proposed body first, then source body)
  for (const body of [proposedBody, sourceBody]) {
    const headingMatch = body.match(/^#{1,6}\s+(.+?)\s*$/m);
    if (headingMatch?.[1]) candidates.push({ text: headingMatch[1].trim(), kind: "fragment" });
  }

  // 3. first sentence of the opening prose paragraph (skip headings, fences,
  //    list markers, blockquotes — those are not prose).
  for (const body of [proposedBody, sourceBody]) {
    const firstSentence = firstProseSentence(body);
    if (firstSentence) candidates.push({ text: firstSentence, kind: "prose" });
  }

  for (const { text, kind } of candidates) {
    const normalized = normalizeDescriptionCandidate(text);
    if (!normalized) continue;
    // For a title/heading fragment, try the padded sentence form FIRST so the
    // result reads as a sentence rather than a bare fragment — a short but valid
    // title like "Paged.js — Named Page" (21 chars) would otherwise be returned
    // verbatim. Fall back to the bare form only if the padded form fails the
    // gate. A prose candidate is already a sentence, so it is used as-is.
    const variants = kind === "fragment" ? [`Reference notes on ${normalized}.`, normalized] : [normalized];
    for (const v of variants) {
      const clamped = v.length > DESCRIPTION_MAX_CHARS ? v.slice(0, DESCRIPTION_MAX_CHARS).trimEnd() : v;
      if (isValidDescription(clamped, targetRef, { skipRefTailCheck: true }).ok) return clamped;
    }
  }
  return undefined;
}

/** Extract the first prose sentence from a markdown body, or `""` if none. */
function firstProseSentence(body: string): string {
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^(#{1,6}\s|```|~~~|[-*+]\s|\d+\.\s|>|\||<!--)/.test(line)) continue;
    const sentenceMatch = line.match(/^(.+?[.!?])(\s|$)/);
    return (sentenceMatch?.[1] ?? line).trim();
  }
  return "";
}

/** Normalize a description candidate: strip markdown markers, collapse space. */
function normalizeDescriptionCandidate(raw: string): string {
  return raw
    .replace(/`/g, "")
    .replace(/^[#>*\-\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Reflect post-processor — enforces the safety rails described at the top of
 * this file:
 *
 *   1. Restore the source frontmatter so reflect never strips load-bearing
 *      `description`, `when_to_use`, `tags`, etc. The LLM is only allowed to
 *      change the markdown body. Frontmatter fields proposed by the LLM are
 *      treated as a *merge on top* of the source — concrete field renames /
 *      identity changes (`name`, `ref`, `id`, `slug`, `type`) are reverted.
 *   2. Reject responses that shrink or expand the body past the configured
 *      ratio thresholds, when the source body is large enough to be reliable.
 *   3. Drop any leading `---` frontmatter block the LLM produced inside the
 *      body — the prompt asks it to emit body only, and a stray YAML preamble
 *      on top of an executable-typed asset is dangerous.
 *
 * Caller branches:
 *   - On `reject`: surface as a failure with the reported reason.
 *   - Otherwise: substitute `content` (and optional `frontmatter`) into the
 *     proposal payload.
 *
 * Source-less / new-asset case (`sourceContent === undefined`): we still strip
 * the LLM's frontmatter block from `content` and re-emit a clean block built
 * from `payload.frontmatter` so identity fields can be enforced. Size guard
 * is skipped because there is no source to compare against.
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
  if (llmFmText !== null) {
    warnings.push("LLM emitted frontmatter in content; stripped and merged through identity guard.");
  }

  // Parse the LLM-emitted frontmatter (if any) so we can merge its non-identity
  // keys into the source frontmatter.
  let llmFm: Record<string, unknown> = {};
  if (llmFmText !== null) {
    try {
      llmFm = parseFrontmatter(payload.content).data;
    } catch {
      llmFm = {};
    }
  }
  // Also accept the explicit `frontmatter` field on the payload.
  if (payload.frontmatter && typeof payload.frontmatter === "object") {
    llmFm = { ...llmFm, ...payload.frontmatter };
  }

  // Strip protected identity fields from any LLM-supplied frontmatter — they
  // must come from the source asset, never from the LLM.
  for (const field of PROTECTED_FRONTMATTER_FIELDS) {
    if (field in llmFm && llmFm[field] !== sourceFm[field]) {
      warnings.push(`LLM attempted to change protected frontmatter field "${field}"; restored from source.`);
      delete llmFm[field];
    }
  }

  // Build the effective frontmatter: source overlaid with sanitized LLM fields.
  // Source fields always win on identity keys.
  const mergedFm: Record<string, unknown> = { ...sourceFm, ...llmFm };
  for (const field of PROTECTED_FRONTMATTER_FIELDS) {
    if (field in sourceFm) {
      mergedFm[field] = sourceFm[field];
    }
  }

  const cleanedBody = stripAppendedFrontmatter(rawLlmBody.replace(/^\s+/, ""));

  // #636 — deterministic description fallback (reflect-side belt-and-suspenders).
  // If the type requires a `description` and the merged frontmatter is still
  // MISSING one (source had none AND the model didn't author one), derive a
  // description DETERMINISTICALLY from the existing `title:` frontmatter or the
  // first `# Heading` / opening body sentence — never free-form invention. This
  // runs in the reflect proposal-build path, BEFORE the proposal is created, so
  // the validator/promote path is left untouched (no gate fabricates content).
  //
  // Scope is the issue's target: a source asset that ALREADY carries frontmatter
  // (e.g. scraped docs: `source`/`title`/`scraped`) but has a MISSING/empty
  // `description`. We deliberately do NOT fire when:
  //   - the source has no frontmatter block at all (injecting one would be a
  //     structural change and would defeat the #580 no-op/cosmetic noise gate
  //     for a pure body echo), or
  //   - a present-but-otherwise-invalid description exists (too short, a heading
  //     fragment) — overwriting authored content is out of scope; the prompt
  //     instruction handles improving it instead.
  const refType = lenientRefType(targetRef);
  const mergedDesc = mergedFm.description;
  const descIsMissing = typeof mergedDesc !== "string" || mergedDesc.trim().length === 0;
  const sourceHadFrontmatter = sourceFmText !== null && Object.keys(sourceFm).length > 0;
  if (refType && requiresDescription(refType) && descIsMissing && sourceHadFrontmatter) {
    const derived = deriveDescriptionFromAsset(mergedFm.title, cleanedBody, sourceBody, targetRef);
    if (derived) {
      mergedFm.description = derived;
      warnings.push(
        "Synthesized a deterministic `description` from title/heading (#636) — source and proposal lacked one.",
      );
    }
  }

  // Size guard — only when source body is meaningfully large. The pure
  // predicate lives in `core/proposal-quality-validators` so the same check
  // also runs inside `runProposalValidators` on `proposal accept`.
  const sizeOutcome = checkReflectSize(sourceBody, cleanedBody);
  let sizeGuardRatio: ReflectSanitizeResult["sizeGuardRatio"];
  if (!sizeOutcome.ok) {
    const pct = (sizeOutcome.ratio * 100).toFixed(0);
    const limit = sizeOutcome.code === "EXCESSIVE_SHRINKAGE" ? "minimum 50%" : "maximum 250%";
    const cause =
      sizeOutcome.code === "EXCESSIVE_SHRINKAGE"
        ? "Concrete content was likely deleted."
        : "Speculative material was likely added.";
    warnings.push(
      `${sizeOutcome.code} — proposed body is ${pct}% of source (${limit}) for ref ${targetRef}. ${cause} Flagged for review.`,
    );
    sizeGuardRatio = { code: sizeOutcome.code, ratio: sizeOutcome.ratio };
  }

  // Truncation-marker leak (#952) — a model that saw a capped/truncated
  // asset sometimes echoes the "[truncated ...]" notice verbatim into its
  // rewrite instead of proposing real content for the missing tail. The
  // body-length ratio check above does not reliably catch this (a leaked
  // marker can still fall inside the 50%-250% band). Flag and defer to
  // human review — same "degrade with a warning" rung as the size guard,
  // not a new hard reject.
  const truncationMarkerLeaked = cleanedBody.includes(REFLECT_TRUNCATION_MARKER);
  if (truncationMarkerLeaked) {
    warnings.push(
      `Proposed body for ref ${targetRef} contains the truncation-notice text the model was shown for a capped source asset ("${REFLECT_TRUNCATION_MARKER}"). The model likely echoed the notice instead of writing real content. Flagged for review.`,
    );
  }

  // Reassemble final content: merged frontmatter + cleaned body.
  // When there is no frontmatter at all (no source fm and no LLM fm), emit body
  // only so we don't add a stray `---` to e.g. a script asset that bypassed the
  // type guard via a custom registration.
  const hasFrontmatter = Object.keys(mergedFm).length > 0;
  const reassembled = hasFrontmatter
    ? assembleAssetFromString(serializeFrontmatter(mergedFm), cleanedBody)
    : cleanedBody;

  return {
    content: reassembled,
    ...(hasFrontmatter ? { frontmatter: mergedFm } : {}),
    warnings,
    ...(sizeGuardRatio ? { sizeGuardRatio } : {}),
    ...(truncationMarkerLeaked ? { truncationMarkerLeaked } : {}),
  };
}

/**
 * JSON Schema for structured reflect output. Passed to `chatCompletion` when
 * {@link wantsJsonSchemaOutput} selects `outputMode: "json_schema"`, so the
 * model returns a strict JSON object containing only the target-scoped
 * fields AKM cannot derive.
 */
const REFLECT_FRONTMATTER_PATCH_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["description", "when_to_use"],
  additionalProperties: false,
  properties: {
    description: { type: ["string", "null"] },
    when_to_use: { type: ["string", "null"] },
  },
};

export const REFLECT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["content", "confidence", "frontmatterPatch"],
  additionalProperties: false,
  properties: {
    content: { type: "string", description: "Complete improved markdown body without YAML frontmatter." },
    // Phase 6A (Advantage D6a): self-reported confidence in [0, 1]. When the
    // LLM is well-calibrated, scores at or above the configured threshold
    // (default 0.8) drive auto-accept in `akm improve`. Out-of-range or
    // non-finite values are rejected by direct-output extraction. Agent and SDK
    // confidence remains optional on their separate existing contracts.
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description:
        "Self-reported quality confidence in [0, 1]. Persisted on the proposal for reviewers and the triage judge to read during adjudication.",
    },
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
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description: "Self-reported quality confidence in [0, 1].",
    },
    frontmatterPatch: REFLECT_FRONTMATTER_PATCH_JSON_SCHEMA,
  },
};

/**
 * Whether to frame the reflect prompt for structured JSON output on this
 * connection. Optimistic by default — `chatCompletion` attempts
 * `response_format: json_schema` fresh on every call and falls back once on
 * a 4xx, so there is no persisted verdict to consult here. `false` only when
 * a human/workflow explicitly disabled it, or a real call already proved
 * this connection rejects it earlier in the same process.
 */
function wantsJsonSchemaOutput(connection: { endpoint: string; model: string; supportsJsonSchema?: boolean }): boolean {
  return connection.supportsJsonSchema !== false && !isJsonSchemaKnownUnsupported(connection);
}

/** Critique prompt injected between prior draft and refinement request (Self-Refine loop). */
const REFLECT_CRITIQUE_PROMPT =
  "Your previous proposal is shown above. Review it critically and provide an improved version that is more specific, actionable, and avoids any issues with the previous attempt. Return only the improved response using the output contract from the original prompt.";

// Reflect no longer
// derives a `max_tokens` cap from the prompt's character-based size policy.
// llm/client.ts does not send `max_tokens` by default for exactly this
// reason — the model/API already knows its own limits, and a character-to-
// token conversion is inherently approximate (the very history this
// function's old doc comment recorded: it had already cut a real response
// off mid-envelope once and needed a 2,048-token fudge factor bolted on to
// compensate). The content-size policy is still enforced twice over — the
// prompt rules the model reads, and the post-processor's own size check —
// so nothing is lost by not adding a third, byte-derived cap whose only
// possible effect is truncating a response early.

/** Options for the direct-LLM reflect runner selected by the current execution path. */
export interface RunReflectViaLlmOptions {
  /** Reflect prompt text (built by {@link buildReflectPrompt}). */
  prompt: string | undefined;
  /** Exact symbolic runner selected before dispatch. */
  runner: Extract<RunnerSpec, { kind: "llm" }>;
  /** Operation-scoped credential snapshot shared across generation/refinement/repair. */
  lease?: LoweredExecutionDispatchLease;
  /** Hard timeout for the LLM request in ms. */
  timeoutMs?: number | null;
  /** Optional caller-driven cancellation signal. */
  signal?: AbortSignal;
  /** Prior draft for Self-Refine critique (injected on iterations > 0). */
  priorDraft?: string;
  /** Current refinement iteration (0-based). */
  iteration: number;
  /**
   * JSON Schema for structured output. When provided, passed through to
   * `chatCompletion`, which attempts `response_format: json_schema` fresh on
   * every call and falls back once to plain-text framing on a 4xx.
   */
  responseSchema?: Record<string, unknown>;
  /** Test seam: override the chat function (avoids real LLM calls in tests). */
  chat?: typeof chatCompletion;
  /**
   * Hard output-token cap forwarded directly to `chatCompletion` as `max_tokens`.
   * Derived from the same blended-bound formula used by {@link checkReflectSize}
   * (via {@link buildReflectPrompt}) so the API layer enforces the same ceiling
   * that the post-processor would reject anyway. Adds a buffer for JSON structure
   * and response-envelope overhead (÷3 chars/token, +500 char overhead).
   * Only set when the source body is ≥ REFLECT_SIZE_GUARD_MIN_BYTES (200 chars).
   */
  maxTokens?: number;
  /**
   * Accepted for type consistency with agent/sdk runners but intentionally NO-OP
   * for the LLM HTTP path: the chat-completion transport has no filesystem access,
   * so it cannot honour a file-write contract. The reflect dispatcher must NEVER
   * synthesize a draft path when the runner kind is `llm` — the prompt builder
   * is also called WITHOUT `draftFilePath` so it emits the direct-LLM contract instead.
   */
  draftFilePath?: string;
  /** Direct-LLM extraction contract. */
  outputMode: ReflectLlmOutputMode;
  /** Known target identity; direct target-scoped output never echoes this. */
  targetRef?: string;
  /** Invocation-wide repair budget gate. Defaults to true for direct callers. */
  allowRepair?: boolean;
  /** Stable lowering diagnostics sink shared across refine/repair attempts. */
  onNotices?: (notices: readonly Readonly<LoweringNotice>[]) => void;
}

interface ReflectLlmTelemetry {
  outputMode: ReflectLlmOutputMode;
  repairAttempts: number;
}

function reflectLlmTelemetry(result: AgentRunResult): ReflectLlmTelemetry | undefined {
  if (!result.parsed || typeof result.parsed !== "object" || Array.isArray(result.parsed)) return undefined;
  const parsed = result.parsed as Record<string, unknown>;
  if (parsed.outputMode !== "json_schema" && parsed.outputMode !== "framed_markdown") return undefined;
  if (typeof parsed.repairAttempts !== "number") return undefined;
  return { outputMode: parsed.outputMode, repairAttempts: parsed.repairAttempts };
}

function reflectLlmPriorDraft(result: AgentRunResult): string | undefined {
  if (!result.parsed || typeof result.parsed !== "object" || Array.isArray(result.parsed)) return undefined;
  const priorDraft = (result.parsed as Record<string, unknown>).priorDraft;
  return typeof priorDraft === "string" ? priorDraft : undefined;
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
  const confidenceLine = headerLines.find((line) => line.startsWith("AKM_REFLECT_CONFIDENCE:"));
  const refLine = headerLines.find((line) => line.startsWith("AKM_REFLECT_REF:"));
  const patchLine = headerLines.find((line) => line.startsWith("AKM_REFLECT_FRONTMATTER_PATCH:"));
  const expectedHeaderLines = targetRef ? 2 : 3;
  const invalidRefLine = targetRef ? refLine !== undefined : refLine === undefined;
  if (headerLines.length !== expectedHeaderLines || !confidenceLine || !patchLine || invalidRefLine) {
    throw new Error("direct reflect response contained invalid frame metadata");
  }
  const confidenceText = confidenceLine.slice("AKM_REFLECT_CONFIDENCE:".length).trim();
  if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(confidenceText)) {
    throw new Error("direct reflect frame confidence must be a decimal number in [0, 1]");
  }
  const confidence = parseReflectConfidence(Number(confidenceText));
  const ref = targetRef ?? refLine?.slice("AKM_REFLECT_REF:".length).trim() ?? "";
  if (!ref) throw new Error("direct reflect response contained an empty AKM_REFLECT_REF value");
  const content = normalized.slice(contentStart, endIndex);
  if (!content.trim()) throw new Error("direct reflect response contained empty framed content");
  const patchText = patchLine.slice("AKM_REFLECT_FRONTMATTER_PATCH:".length).trim();
  let parsedPatch: unknown;
  try {
    parsedPatch = JSON.parse(patchText);
  } catch {
    throw new Error("direct reflect response contained invalid frontmatter patch JSON");
  }
  const frontmatter = parseReflectFrontmatterPatch(parsedPatch);
  return { ref, content, confidence, ...(frontmatter ? { frontmatter } : {}) };
}

function parseDirectReflectOutput(raw: string, mode: ReflectLlmOutputMode, targetRef: string | undefined) {
  return mode === "json_schema" ? parseSchemaReflectOutput(raw, targetRef) : parseFramedReflectOutput(raw, targetRef);
}

/**
 * Run a single reflect iteration directly via the LLM API (v2 config path).
 *
 * Returns an {@link AgentRunResult}-shaped object so it can slot into the same
 * dispatch loop as agent-based runners. Production calls extract the selected
 * direct-LLM contract and normalize it to proposal JSON in `stdout`. Errors
 * are captured into the result rather than thrown.
 */
export async function runReflectViaLlm(opts: RunReflectViaLlmOptions): Promise<AgentRunResult> {
  const start = Date.now();
  let repairAttempts = 0;
  const _connection = opts.runner.connection;
  const messages: ChatMessage[] = [{ role: "user", content: opts.prompt ?? "" }];
  const configuredTimeout = Object.hasOwn(opts, "timeoutMs")
    ? (opts.timeoutMs ?? null)
    : Object.hasOwn(opts.runner, "timeoutMs")
      ? (opts.runner.timeoutMs ?? null)
      : DEFAULT_LLM_TIMEOUT_MS;
  const deadline = typeof configuredTimeout === "number" ? start + configuredTimeout : undefined;

  if (opts.priorDraft !== undefined && opts.iteration > 0) {
    messages.push({ role: "assistant", content: opts.priorDraft });
    messages.push({ role: "user", content: REFLECT_CRITIQUE_PROMPT });
  }

  const call = async (callMessages: ChatMessage[], repairTimeoutMs?: number): Promise<string> =>
    callStructured<string>({
      feature: "reflect_proposal",
      runner: opts.runner,
      ...(opts.lease ? { lease: opts.lease } : {}),
      messages: callMessages,
      request: {
        ...(repairTimeoutMs !== undefined
          ? { timeoutMs: repairTimeoutMs }
          : Object.hasOwn(opts, "timeoutMs")
            ? { timeoutMs: opts.timeoutMs }
            : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.responseSchema !== undefined ? { responseSchema: opts.responseSchema } : {}),
        ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
        // Reflect requires a machine-readable payload. Visible chain-of-thought
        // can consume the output cap before the model reaches the envelope.
        enableThinking: false,
        ...(opts.chat ? { chat: opts.chat } : {}),
      },
      ...(opts.onNotices ? { onNotices: opts.onNotices } : {}),
      parse: (raw) => raw ?? "",
      // Unreachable on the ungated path (errors propagate to the catch below).
      onError: () => "",
      fallback: "",
    });

  const failure = (
    err: unknown,
    reason: AgentFailureReason,
    repairAttempts: number,
    stdout = "",
    exitCode = 1,
  ): AgentRunResult => {
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

  try {
    if (opts.signal?.aborted) throw new Error("Reflect request aborted");
    const stdout = await call(messages);

    let payload: ReturnType<typeof parseDirectReflectOutput>;
    let acceptedOutput = stdout;
    try {
      payload = parseDirectReflectOutput(stdout, opts.outputMode, opts.targetRef);
    } catch (err) {
      if (opts.allowRepair === false) return failure(err, "parse_error", 0, stdout, 0);
      if (opts.signal?.aborted) return failure(new Error("Reflect request aborted"), "aborted", 0, stdout);
      const remaining = deadline === undefined ? undefined : deadline - Date.now();
      if (remaining !== undefined && remaining <= 0) {
        return failure(
          new LlmCallError("Reflect request timed out before output repair", "timeout"),
          "timeout",
          0,
          stdout,
        );
      }
      repairAttempts = 1;
      const repairMessages: ChatMessage[] = [
        ...messages,
        { role: "assistant", content: stdout },
        {
          role: "user",
          content: buildReflectOutputRepairPrompt(opts.outputMode, opts.targetRef !== undefined),
        },
      ];
      const repaired = await call(repairMessages, remaining);
      acceptedOutput = repaired;
      try {
        payload = parseDirectReflectOutput(repaired, opts.outputMode, opts.targetRef);
      } catch (err) {
        return failure(err, "parse_error", repairAttempts, repaired, 0);
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
    return failure(err, reason, repairAttempts);
  }
}

function failureEnvelope(
  result: AgentRunResult,
  ref: string | undefined,
  engine?: string,
  fallbackReason: AgentFailureReason = "non_zero_exit",
): AkmReflectFailure {
  return {
    ...baseFailureFields(result, fallbackReason),
    schemaVersion: 2,
    ...(ref ? { ref } : {}),
    ...(engine ? { engine } : {}),
  };
}

/**
 * Reflect content-preservation + proposal creation: restore/reset protected
 * frontmatter and reject unsafe body-size ratios (sanitizeReflectPayload), the
 * #580 noise gate, the optional quality judge, then create the proposal (with
 * the R-4/#373 lesson provenance stamp) and emit `reflect_completed`. Extracted
 * verbatim from `akmReflect`; every reject/skip envelope and event is
 * byte-identical.
 */
async function finalizeReflectProposal(args: {
  payload: ReturnType<typeof parseAgentProposalPayload>;
  assetContent: string | undefined;
  result: AgentRunResult;
  options: AkmReflectOptions;
  engineName: string;
  config: import("../../core/config/config").AkmConfig;
  qualityGateEnabled: boolean;
  qualityGateSkippedNoJudge: boolean;
  qualityJudgeRunner: Extract<RunnerSpec, { kind: "llm" }> | undefined;
  qualityJudgeLease: LoweredExecutionDispatchLease | undefined;
  feedback: Parameters<typeof runReflectQualityJudge>[3];
  stash: string;
  emitReflectFailed: (
    reason: AgentFailureReason,
    subreason: string,
    ref?: string,
    extra?: Record<string, unknown>,
  ) => void;
  onNotices: (notices: readonly Readonly<LoweringNotice>[]) => void;
}): Promise<AkmReflectResult> {
  const {
    assetContent,
    result,
    options,
    engineName,
    config,
    qualityGateEnabled,
    qualityGateSkippedNoJudge,
    qualityJudgeRunner,
    qualityJudgeLease,
    feedback,
    stash,
    emitReflectFailed,
    onNotices,
  } = args;
  let payload = args.payload;
  const outputTelemetry = reflectLlmTelemetry(result);

  // 7. Reflect content-preservation rails:
  //     - Restore source frontmatter so reflect can never strip indexable
  //       fields (`description`, `when_to_use`, `tags`, ...).
  //     - Reset protected identity fields (`name`, `ref`, `id`, `slug`,
  //       `type`) the LLM tried to change.
  //     - Reject proposals that shrink/expand the body past safe ratios.
  //
  // See REFLECT_ALLOWED_TYPES / sanitizeReflectPayload for the underlying
  // hypotheses + observed regressions (`8737ab63`, `26941510`, and the
  // catastrophic-shrinkage cases from the May 2026 review).
  const sanitizeOutcome = sanitizeReflectPayload(
    { content: payload.content, ...(payload.frontmatter ? { frontmatter: payload.frontmatter } : {}) },
    assetContent,
    payload.ref,
  );
  if (sanitizeOutcome.reject) {
    appendEvent(
      {
        eventType: "reflect_completed",
        ref: payload.ref,
        metadata: {
          source: "reflect",
          sanitized: true,
          rejected: true,
          rejectReason: sanitizeOutcome.reject.error,
          ...(sanitizeOutcome.warnings.length > 0 ? { sanitizerWarnings: sanitizeOutcome.warnings } : {}),
          ...(outputTelemetry ?? {}),
        },
      },
      options.eventsCtx,
    );
    return {
      schemaVersion: 2,
      ok: false,
      reason: sanitizeOutcome.reject.reason,
      error: sanitizeOutcome.reject.error,
      ...(options.ref ? { ref: options.ref } : {}),
      engine: engineName,
      exitCode: result.exitCode,
    };
  }
  payload = {
    ...payload,
    content: sanitizeOutcome.content,
    ...(sanitizeOutcome.frontmatter ? { frontmatter: sanitizeOutcome.frontmatter } : {}),
  };

  // 7c. Noise gate (#580): never queue a proposal whose sanitized content is
  // identical to the current asset (empty diff) or differs only cosmetically
  // (whitespace reflow, code-fence language hints, YAML scalar re-folding).
  // Pure deterministic text comparison — see `reflect-noise.ts`. Skipped when
  // there is no source asset (new-asset proposals have nothing to diff against).
  if (assetContent !== undefined) {
    const changeKind = classifyReflectChange(assetContent, payload.content);
    // 'low-value' is config-gated (#639). DEFAULT OFF — absent = byte-identical
    // pre-#639 behaviour (low-value treated the same as substantive). Resolved
    // by the caller from the active improve strategy's
    // `processes.reflect.lowValueFilter.enabled` and passed via options, so the
    // running strategy decides.
    const lowValueFilterEnabled = options.lowValueFilter === true;
    const isDeferred =
      changeKind === "noop" || changeKind === "cosmetic" || (changeKind === "low-value" && lowValueFilterEnabled);
    if (isDeferred) {
      const subreason =
        changeKind === "noop"
          ? "reflect_skipped_noop"
          : changeKind === "low-value"
            ? "reflect_skipped_low_value"
            : "reflect_skipped_cosmetic";
      emitReflectFailed("no_change", subreason, options.ref, { changeKind, ...(outputTelemetry ?? {}) });
      return {
        schemaVersion: 2,
        ok: false,
        reason: "no_change" as const,
        error:
          changeKind === "noop"
            ? `Reflect skipped: proposed content for ${payload.ref} is identical to the current asset (empty diff); no proposal created.`
            : changeKind === "low-value"
              ? `Reflect skipped: proposed content for ${payload.ref} is a low-value prose micro-rewrite (few changed tokens, no structural changes); no proposal created.`
              : `Reflect skipped: proposed content for ${payload.ref} is a cosmetic-only reformat of the current asset (whitespace/fence/YAML-folding changes); no proposal created.`,
        ...(options.ref ? { ref: options.ref } : {}),
        engine: engineName,
        exitCode: result.exitCode,
      };
    }
  }

  // 7c. Judge the exact sanitized content that can be persisted. Fail closed
  // on cancellation, transport failure, malformed output, or an invalid score.
  // Skipped when the size guard or the truncation-marker leak already fired —
  // that content is deferred to human review regardless of what the judge says.
  if (qualityGateEnabled && !sanitizeOutcome.sizeGuardRatio && !sanitizeOutcome.truncationMarkerLeaked) {
    const judgeResult = await runReflectQualityJudge(
      config,
      payload.content,
      assetContent ?? "",
      feedback,
      options.chat,
      {
        runnerSelectionFrozen: true,
        ...(qualityJudgeRunner ? { llmRunner: qualityJudgeRunner } : {}),
        ...(qualityJudgeLease ? { lease: qualityJudgeLease } : {}),
        ...(Object.hasOwn(options, "timeoutMs") ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        onNotices,
      },
    );
    if (!judgeResult.pass) {
      appendEvent(
        {
          eventType: "reflect_completed",
          ref: payload.ref,
          metadata: {
            source: "reflect",
            qualityRejected: true,
            qualityScore: judgeResult.score,
            qualityReason: judgeResult.reason,
            ...(outputTelemetry ?? {}),
          },
        },
        options.eventsCtx,
      );
      return {
        schemaVersion: 2,
        ok: false,
        reason: "parse_error" as const,
        error: `Reflect proposal quality gate rejected: score=${judgeResult.score}, reason="${judgeResult.reason}"`,
        ...(options.ref ? { ref: options.ref } : {}),
        engine: engineName,
        exitCode: result.exitCode,
      };
    }
  }

  return createReflectProposal({
    payload,
    options,
    stash,
    engineName,
    durationMs: result.durationMs,
    emitReflectFailed,
    outputTelemetry,
    qualityGateSkippedNoJudge,
    sizeGuardRatio: sanitizeOutcome.sizeGuardRatio,
    truncationMarkerLeaked: sanitizeOutcome.truncationMarkerLeaked,
  });
}

/**
 * Create the reflect proposal from sanitized+judged payload: stamp the R-4/#373
 * lesson provenance marker, call `createProposal`, and emit the terminal
 * `reflect_completed` (or a cooldown skip envelope). Extracted verbatim from
 * `akmReflect`'s finalize tail.
 */
function createReflectProposal(args: {
  payload: ReturnType<typeof parseAgentProposalPayload>;
  options: AkmReflectOptions;
  stash: string;
  engineName: string;
  durationMs: number;
  outputTelemetry?: ReflectLlmTelemetry;
  qualityGateSkippedNoJudge: boolean;
  sizeGuardRatio?: { code: "EXCESSIVE_SHRINKAGE" | "EXCESSIVE_EXPANSION"; ratio: number };
  truncationMarkerLeaked?: boolean;
  emitReflectFailed: (
    reason: AgentFailureReason,
    subreason: string,
    ref?: string,
    extra?: Record<string, unknown>,
  ) => void;
}): AkmReflectResult {
  const {
    payload,
    options,
    stash,
    engineName,
    durationMs,
    emitReflectFailed,
    outputTelemetry,
    qualityGateSkippedNoJudge,
    sizeGuardRatio,
    truncationMarkerLeaked,
  } = args;
  // 8. Create the proposal. The proposal queue is the ONLY thing reflect
  // writes — promotion to a real asset is gated by `akm proposal accept`.
  //
  // R-4 / #373: Stamp `derived_from_reflect: true` in the frontmatter of any
  // lesson proposal generated by reflect. This provenance marker lets
  // `readRelatedLessons` exclude echo-chamber lessons (lessons that originate
  // from prior reflect runs on the same skill) unless independent feedback
  // evidence exists. ExpeL arXiv:2308.10144 — reject rules without success/
  // failure differential from independent evidence.
  const isLessonProposal = (() => {
    try {
      return parseRefInput(payload.ref).type === "lesson";
    } catch {
      return false;
    }
  })();
  const basePayloadFrontmatter = payload.frontmatter ?? {};
  const payloadFrontmatterWithProvenance: Record<string, unknown> = isLessonProposal
    ? { ...basePayloadFrontmatter, derived_from_reflect: true }
    : basePayloadFrontmatter;

  const createInput: CreateProposalInput = {
    ref: payload.ref,
    ...(options.target ? { target: options.target } : {}),
    source: "reflect",
    sourceRun: `reflect-${Date.now()}`,
    payload: {
      content: payload.content,
      ...(Object.keys(payloadFrontmatterWithProvenance).length > 0
        ? { frontmatter: payloadFrontmatterWithProvenance }
        : {}),
    },
    // Phase 6A: forward LLM-reported confidence into the proposal record.
    // `parseAgentProposalPayload` already clamps to [0, 1] and drops non-
    // finite values; `createProposal` runs its own sanitizer as a safety net.
    ...(typeof payload.confidence === "number" ? { confidence: payload.confidence } : {}),
    // Attribution tagging: persist the eligibility lane on the proposal so it
    // survives to accept/reject/revert time even across runs. See EligibilitySource.
    ...(options.eligibilitySource ? { eligibilitySource: options.eligibilitySource } : {}),
    // §23.6 fingerprint model-id term (WI-6.4): the engine that generated
    // this draft (reflect resolves engines, not bare model ids).
    modelId: engineName,
  };
  const proposalResult = emitProposal({ stashDir: stash, proposalsCtx: options.ctx }, createInput);

  if (isProposalSkipped(proposalResult)) {
    // Dedup/cooldown guard fired — surface as a "cooldown" reason (not "parse_error")
    // so the improve orchestrator can distinguish legitimate skips from real failures
    // and exclude them from recentErrors/avoidPatterns injection.
    emitReflectFailed("cooldown", "proposal_skipped", options.ref, {
      proposalSkipReason: proposalResult.reason,
      ...(outputTelemetry ?? {}),
    });
    return {
      schemaVersion: 2,
      ok: false,
      reason: "cooldown" as const,
      error: `Proposal skipped (${proposalResult.reason}): ${proposalResult.message}`,
      ...(options.ref ? { ref: options.ref } : {}),
      engine: engineName,
      exitCode: null,
    };
  }

  let proposal: Proposal = proposalResult;

  const reviewReasons: string[] = [];
  if (qualityGateSkippedNoJudge) reviewReasons.push("no-judge-configured");
  if (sizeGuardRatio) reviewReasons.push("reflect-size-ratio");
  if (truncationMarkerLeaked) reviewReasons.push("reflect-truncation-leak");
  if (reviewReasons.length > 0) {
    proposal =
      recordGateDecision(
        stash,
        proposal.id,
        {
          outcome: "deferred",
          reason: reviewReasons.join("+"),
          gate: "reflect",
          ...(sizeGuardRatio ? { measured: Math.round(sizeGuardRatio.ratio * 100) } : {}),
        },
        options.ctx,
      ) ?? proposal;
  }

  appendEvent(
    {
      eventType: "reflect_completed",
      ref: proposal.ref,
      metadata: {
        proposalId: proposal.id,
        source: "reflect",
        engine: engineName,
        ...(qualityGateSkippedNoJudge ? { qualityGateSkippedNoJudge: true } : {}),
        ...(sizeGuardRatio ? { sizeGuardRatio: sizeGuardRatio.code, sizeGuardRatioValue: sizeGuardRatio.ratio } : {}),
        ...(truncationMarkerLeaked ? { truncationMarkerLeaked: true } : {}),
        ...(outputTelemetry ?? {}),
      },
    },
    options.eventsCtx,
  );

  return {
    schemaVersion: 2,
    ok: true,
    proposal,
    ref: proposal.ref,
    engine: engineName,
    durationMs,
  };
}

/**
 * Resolve the agent's proposal payload from a successful run: the file-write
 * contract path (read `lastDraftPath`, extract self-rated confidence) or the
 * JSON-stdout path used by direct LLM runners. Returns the payload or a terminal
 * failure envelope.
 */
function resolveReflectPayload(args: {
  result: AgentRunResult;
  lastDraftPath: string | undefined;
  sensitiveValues: readonly string[];
  options: AkmReflectOptions;
  engineName: string;
  emitReflectFailed: (
    reason: AgentFailureReason,
    subreason: string,
    ref?: string,
    extra?: Record<string, unknown>,
  ) => void;
}): { payload: ReturnType<typeof parseAgentProposalPayload> } | { failure: AkmReflectResult } {
  const { result, lastDraftPath, sensitiveValues, options, engineName, emitReflectFailed } = args;
  // 6. Resolve the proposal content.
  //
  // Path A (file-write contract — preferred for agent/sdk runners on long
  // assets): the agent wrote the body to `lastDraftPath` and printed
  // `DRAFT_WRITTEN` on stdout. Load the body from disk and synthesize a
  // payload. The `EXCESSIVE_EXPANSION`/schema-shape gates downstream still
  // apply — they validate content, not transport.
  //
  // Path B (JSON stdout): the direct LLM runner cannot honour file-write.
  const draftFileExists =
    lastDraftPath !== undefined && fs.existsSync(lastDraftPath) && fs.statSync(lastDraftPath).size > 0;
  const draftSignaled = stdoutSignalsDraftWritten(result.stdout);

  if (draftSignaled && lastDraftPath && !draftFileExists) {
    // Agent claimed to write the draft but the file is missing or empty.
    // Surface as a parse_error rather than silently falling through — the
    // alternative would be parsing the `DRAFT_WRITTEN` sentinel as JSON,
    // which is guaranteed to fail with a confusing message.
    emitReflectFailed("parse_error", "draft_missing", options.ref, {
      ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
    });
    return {
      failure: {
        schemaVersion: 2,
        ok: false,
        reason: "parse_error",
        error: `Agent emitted DRAFT_WRITTEN but draft file is missing or empty (${lastDraftPath}). The file-write contract failed; either the agent's file tools are broken or the path was unwritable.`,
        ...(options.ref ? { ref: options.ref } : {}),
        engine: engineName,
        exitCode: result.exitCode,
        stdout: result.stdout,
        ...(result.stderr ? { stderr: result.stderr } : {}),
      },
    };
  }

  if (draftFileExists && lastDraftPath) {
    // Happy path: agent wrote the body to disk. Use the ref the caller
    // supplied (or a placeholder when omitted — the R-3 ref-mismatch guard
    // below has no effect when there is no expected ref).
    const fileContent = redactSensitiveText(fs.readFileSync(lastDraftPath, "utf8"), sensitiveValues);
    // Phase 6A: file-write contract carries self-rated confidence on the
    // `DRAFT_WRITTEN confidence=<n>` sentinel line. Extract it so the
    // file-write path is on equal footing with the JSON-stdout path for
    // auto-accept gating in `akm improve`.
    const draftConfidence = extractDraftConfidence(result.stdout);
    return {
      payload: {
        ref: options.ref ?? "",
        content: fileContent,
        ...(draftConfidence !== undefined ? { confidence: draftConfidence } : {}),
      },
    };
  }

  try {
    return { payload: parseAgentProposalPayload(result.stdout ?? "") };
  } catch (err) {
    // Reclassify cooldown/skip messages that arrive as stdout text instead of
    // valid proposal JSON. These are legitimate skip signals, not parse failures,
    // and should not pollute reflectFailedActions or recentErrors injection.
    const stdoutText = result.stdout ?? "";
    const isCooldownSignal = isStructuredCooldownSignal(stdoutText);
    const reason: AgentFailureReason = isCooldownSignal ? "cooldown" : "parse_error";
    emitReflectFailed(reason, isCooldownSignal ? "stdout_cooldown_signal" : "parse_error", options.ref, {
      ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
      ...(reflectLlmTelemetry(result) ?? {}),
    });
    return {
      failure: {
        schemaVersion: 2,
        ok: false,
        reason,
        error: err instanceof Error ? err.message : String(err),
        ...(options.ref ? { ref: options.ref } : {}),
        engine: engineName,
        exitCode: result.exitCode,
        stdout: result.stdout,
        ...(result.stderr ? { stderr: result.stderr } : {}),
      },
    };
  }
}

function isReflectQualityGateEnabled(activeStrategy: ImproveProfileConfig | undefined): boolean {
  return (
    (activeStrategy?.processes?.reflect?.qualityGate?.enabled ?? false) ||
    (activeStrategy?.processes?.distill?.qualityGate?.enabled ?? true)
  );
}

type ReflectQualityJudgeSelection = Readonly<{
  enabled: boolean;
  runner: Extract<RunnerSpec, { kind: "llm" }> | undefined;
}>;

/** Resolve the exact judge transport before generation so its credential can join the operation snapshot. */
function resolveReflectQualityJudgeRunner(
  config: AkmConfig,
  runnerSpec: RunnerSpec,
  enabled: boolean,
  onNotices: (notices: readonly Readonly<LoweringNotice>[]) => void,
): ReflectQualityJudgeSelection {
  if (!enabled) return Object.freeze({ enabled: false, runner: undefined });
  if (runnerIsLlm(runnerSpec)) return Object.freeze({ enabled: true, runner: runnerSpec });
  const resolved = resolveImproveLlmExecution({ config, processName: "reflect_proposal_quality-judge" });
  if (resolved) onNotices(resolved.notices);
  return Object.freeze({ enabled: true, runner: resolved?.runner });
}

/** Acquire through genuine preparation/lowering for all runner kinds, including SDK fallback credentials. */
function acquireReflectDispatchLease(
  runnerSpec: RunnerSpec,
  onNotices: (notices: readonly Readonly<LoweringNotice>[]) => void,
): LoweredExecutionDispatchLease {
  const prepared = prepareInlineExecutionWithRunner({
    content: "Validate reflect operation transport before dispatch.",
    runner: runnerSpec,
    invocationKind: "direct",
  });
  const lowered = lowerResolvedExecutionRequestWithRunner(prepared.request, prepared.runner);
  onNotices(lowered.notices);
  return acquireLoweredExecutionDispatchLease(lowered);
}

/**
 * Resolve the single named engine for a reflect invocation (standalone --engine
 * / defaults.engine, or the improve strategy's LLM-only process overlay),
 * throwing on any incompatible or missing engine, and validating the unattended
 * LLM requirement. Extracted verbatim from `akmReflect`.
 */
function resolveReflectRunner(options: AkmReflectOptions): {
  config: import("../../core/config/config").AkmConfig;
  activeStrategy: import("../../core/config/config").ImproveProfileConfig | undefined;
  runnerSpec: RunnerSpec;
  engineName: string;
  notices: readonly Readonly<LoweringNotice>[];
} {
  const config = options.config ?? loadConfig();
  const activeStrategy =
    options.improveProfile ?? config.improve?.strategies?.[config.defaults?.improveStrategy ?? "default"];
  let runnerSpec: RunnerSpec;
  let notices: readonly Readonly<LoweringNotice>[] = [];
  if (options.engine) {
    const prepared = prepareInlineExecution({
      content: "reflect engine selection",
      config,
      invocationKind: "direct",
      current: { engine: options.engine },
    });
    const lowered = lowerResolvedExecutionRequest(prepared.request, prepared.config);
    runnerSpec = lowered.runner;
    notices = lowered.notices;
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
    runnerSpec = resolved.runner;
    notices = resolved.notices;
  } else {
    const { config: engineConfig, fallbackEngineName } = withEngineFallback(config);
    const defaultEngine = engineConfig.defaults?.engine;
    // Announced, never silent — same contract as the workflow freeze boundary
    // and the task runner. Only this arm can select the synthesized engine.
    const engineAnnouncement = fallbackAnnouncement(fallbackEngineName, defaultEngine);
    if (engineAnnouncement) warn(engineAnnouncement);
    if (!defaultEngine) {
      throw new ConfigError(`reflect ${NO_ENGINE_MESSAGE_SUFFIX} ${NO_ENGINE_REMEDY}`, "INVALID_CONFIG_FILE");
    }
    const prepared = prepareInlineExecution({
      content: "reflect engine selection",
      config,
      invocationKind: "direct",
    });
    const lowered = lowerResolvedExecutionRequest(prepared.request, prepared.config);
    runnerSpec = lowered.runner;
    notices = lowered.notices;
  }
  if (options.eventSource === "improve" && !runnerIsLlm(runnerSpec)) {
    throw new ConfigError(
      `Unattended improve requires an LLM engine for reflect; engine "${runnerSpec.engine ?? options.engine ?? "unknown"}" is tool-capable.`,
      "INVALID_CONFIG_FILE",
      "Set defaults.llmEngine or improve.strategies.<name>.processes.reflect.engine to an LLM engine.",
    );
  }
  const engineName = runnerSpec.engine ?? options.engine;
  if (!engineName) {
    throw new ConfigError("Reflect requires a named engine.", "INVALID_CONFIG_FILE");
  }
  return { config, activeStrategy, runnerSpec, engineName, notices };
}

function unsupportedTypeFailure(
  ref: string,
  type: string,
  detail: string,
  emitReflectFailed: (
    reason: AgentFailureReason,
    subreason: string,
    ref?: string,
    extra?: Record<string, unknown>,
  ) => void,
): { failure: AkmReflectResult } {
  emitReflectFailed("unsupported_type", "unsupported_type", ref, { type });
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
 * Resolve the reflect target's parsed ref + current on-disk content: enforce the
 * REFLECT_ALLOWED_TYPES markdown-canonical type guard (returning a terminal
 * `unsupported_type` failure), honour the `options.assetContent` test seam, else
 * best-effort load via the local file path / index lookup. Extracted verbatim
 * from `akmReflect`.
 */
async function resolveReflectSource(
  options: AkmReflectOptions,
  stash: string,
  emitReflectFailed: (
    reason: AgentFailureReason,
    subreason: string,
    ref?: string,
    extra?: Record<string, unknown>,
  ) => void,
): Promise<{ assetContent: string | undefined; parsedRef: AssetRef | undefined } | { failure: AkmReflectResult }> {
  let assetContent: string | undefined;
  let parsedRef: AssetRef | undefined;
  if (options.ref) {
    parsedRef = parseRefInput(options.ref);

    // 2a. Refuse `secret` before any content is read — a secret's content is
    // never touched by reflect, regardless of what it happens to look like.
    if (REFLECT_REFUSED_TYPES.has(parsedRef.type)) {
      return unsupportedTypeFailure(
        options.ref,
        parsedRef.type,
        "secret material is never read or sent to an LLM",
        emitReflectFailed,
      );
    }

    if (options.assetContent !== undefined) {
      // Test seam — caller pre-loaded the source content.
      assetContent = options.assetContent;
    } else {
      try {
        // Resolve the source by item_ref when planning supplied one, otherwise
        // use the input conceptId.
        const qualifiedRef = options.itemRef ?? durableImproveRef(options.ref);
        const localFilePath = await findAssetFilePath(qualifiedRef, stash);
        if (localFilePath && fs.existsSync(localFilePath)) {
          assetContent = fs.readFileSync(localFilePath, "utf8");
        } else {
          const entry = await lookup(parseRefInput(qualifiedRef));
          if (entry?.filePath && fs.existsSync(entry.filePath)) {
            assetContent = fs.readFileSync(entry.filePath, "utf8");
          }
        }
      } catch {
        // Index miss is non-fatal — the agent can still propose a fresh asset.
      }
    }

    if (!REFLECT_ALLOWED_TYPES.has(parsedRef.type)) {
      if (assetContent === undefined || !isReflectableSourceShape(assetContent)) {
        return unsupportedTypeFailure(
          options.ref,
          parsedRef.type,
          "its content is not frontmatter + markdown",
          emitReflectFailed,
        );
      }
    }
  }
  return { assetContent, parsedRef };
}

/**
 * #952 — the flat REFLECT_CONTENT_CAP (12 000 chars) exists only to avoid
 * E2BIG when the prompt travels through CLI argv (agent/SDK runners). The
 * direct-LLM HTTP path never touches argv, so it can use the resolved
 * engine's own context window instead. The reserve for "the rest of the
 * prompt" is measured directly (not guessed): build the same prompt with
 * the content cap forced to zero and use its length as the overhead, so
 * feedback/standards/schema-hints/prior-draft size is accounted for
 * exactly, per this call. A reflect rewrite returns a body roughly the
 * size of the input, so the budget only spends HALF of the usable window
 * on input content and reserves the other half for the model's own
 * output — otherwise a full-context request leaves no room for a
 * response. Never drops below the flat floor.
 *
 * Shared by the real dispatch path ({@link runReflectRefineIterations}) and
 * `renderReflectPromptPreview`'s `--show-prompt` preview, so the preview
 * renders the exact prompt reflect would actually send for LLM runners
 * instead of always the flat-cap prompt.
 */
function computeReflectContentBudgetChars(promptInput: ReflectPromptInput, runnerSpec: RunnerSpec): number | undefined {
  return runnerIsLlm(runnerSpec) && promptInput.assetContent?.trim()
    ? Math.max(
        REFLECT_CONTENT_CAP,
        Math.floor(
          ((runnerSpec.connection.contextLength ?? DEFAULT_CONTEXT_LENGTH_TOKENS) * CHARS_PER_TOKEN -
            buildReflectPrompt({ ...promptInput, contentBudgetChars: 0 }).prompt.length) /
            2,
        ),
      )
    : undefined;
}

/**
 * Run the agent with the optional Self-Refine loop (R-1 / #372): up to
 * `maxRefineIters` invocations, each injecting the prior draft as self-critique
 * context and exiting early on a no-op refinement. Synthesizes per-iteration
 * draft paths into `draftPathsToCleanup` (mutated) and returns the final agent
 * result + last draft path. Extracted verbatim from `akmReflect`.
 */
async function runReflectRefineIterations(args: {
  options: AkmReflectOptions;
  parsedRef: AssetRef | undefined;
  assetContent: string | undefined;
  feedback: ReturnType<typeof readRecentFeedback>;
  schemaHints: ReturnType<typeof buildSchemaHints>;
  relatedLessons: Awaited<ReturnType<typeof readRelatedLessons>>;
  rejectedProposals: ReturnType<typeof readRejectedProposals>;
  standardsContext: string;
  runnerSpec: RunnerSpec;
  lease: LoweredExecutionDispatchLease;
  agentEnv: Record<string, string>;
  draftPathsToCleanup: string[];
  onNotices: (notices: readonly Readonly<LoweringNotice>[]) => void;
}): Promise<{ result: AgentRunResult; lastDraftPath: string | undefined }> {
  const {
    options,
    parsedRef,
    assetContent,
    feedback,
    schemaHints,
    relatedLessons,
    rejectedProposals,
    standardsContext,
    runnerSpec,
    lease,
    agentEnv,
    draftPathsToCleanup,
    onNotices,
  } = args;
  const maxRefineIters = Math.max(1, options.maxRefineIters ?? 1);
  // Determine whether this dispatch can honour the file-write contract.
  // Agent CLI + OpenCode SDK runners both have filesystem access; the direct
  // LLM HTTP runner does NOT.
  const canRunnerWriteFile = runnerSupportsFileWrite(runnerSpec);
  const outputMode: ReflectLlmOutputMode | undefined = runnerIsLlm(runnerSpec)
    ? wantsJsonSchemaOutput(runnerSpec.connection)
      ? "json_schema"
      : "framed_markdown"
    : undefined;
  // Initialized to a sentinel; always overwritten in the first loop iteration
  // (maxRefineIters is clamped to >= 1 above).
  let result = {} as AgentRunResult;
  let priorDraft: string | undefined;
  let lastDraftPath: string | undefined;
  let repairAttempts = 0;

  for (let iter = 0; iter < maxRefineIters; iter++) {
    // Synthesize a fresh tmp path per iteration so refinement passes never
    // clobber an earlier draft (and so reading back is unambiguous).
    const iterDraftPath = canRunnerWriteFile ? synthesizeReflectDraftPath(options.ref) : undefined;
    if (iterDraftPath) {
      draftPathsToCleanup.push(iterDraftPath);
      lastDraftPath = iterDraftPath;
    }

    const promptInput: ReflectPromptInput = {
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
      // R-1: inject prior draft as self-critique target on iterations > 0
      ...(priorDraft !== undefined ? { priorDraft } : {}),
      // Issue A (#reflect-pipeline file-write contract): when the runner can
      // touch the filesystem, instruct the agent to write the proposal body
      // to a tmp file instead of inlining it in JSON. Avoids parse failures
      // on long bodies (e.g. knowledge/systems/KOKORO_USAGE_GUIDE 8.4KB).
      ...(iterDraftPath ? { draftFilePath: iterDraftPath } : {}),
      ...(outputMode ? { outputMode } : {}),
    };
    const contentBudgetChars = computeReflectContentBudgetChars(promptInput, runnerSpec);
    const { prompt } = buildReflectPrompt({
      ...promptInput,
      ...(contentBudgetChars !== undefined ? { contentBudgetChars } : {}),
    });
    let iterResult: AgentRunResult;
    if (runnerIsLlm(runnerSpec)) {
      // LLM HTTP runners cannot honor the file-write contract, so they return
      // structured output through stdout. callStructured owns preparation,
      // lowering, credential materialization, and direct transport dispatch.
      iterResult = await runReflectViaLlm({
        prompt,
        runner: runnerSpec,
        lease,
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
        onNotices,
      });
    } else {
      const conversationPriorDraft = priorDraft;
      const hasConversation = conversationPriorDraft !== undefined && iter > 0;
      const current = {
        ...(Object.hasOwn(options, "timeoutMs") ? { timeout: options.timeoutMs } : {}),
        ...(Object.keys(agentEnv).length > 0 ? { environment: agentEnv } : {}),
      };
      const prepared = prepareInlineExecutionWithRunner({
        content: hasConversation ? REFLECT_CRITIQUE_PROMPT : (prompt ?? ""),
        ...(hasConversation
          ? {
              conversation: [
                { role: "user" as const, content: prompt ?? "" },
                { role: "assistant" as const, content: conversationPriorDraft as string },
              ],
            }
          : {}),
        runner: runnerSpec,
        invocationKind: "direct",
        ...(Object.keys(current).length > 0 ? { current } : {}),
      });
      const lowered = lowerResolvedExecutionRequestWithRunner(prepared.request, prepared.runner);
      onNotices(lowered.notices);
      iterResult = await dispatchLoweredExecutionRequest(lowered, {
        lease,
        ...(options.runSdk ? { runSdk: options.runSdk } : {}),
        runOptions: {
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.runAgentOptions ?? {}),
        },
      });
    }

    const iterTelemetry = reflectLlmTelemetry(iterResult);
    if (iterTelemetry) repairAttempts += iterTelemetry.repairAttempts;
    result = iterTelemetry
      ? {
          ...iterResult,
          parsed: {
            ...(iterResult.parsed as Record<string, unknown>),
            ...iterTelemetry,
            repairAttempts,
          },
        }
      : iterResult;

    if (!result.ok) break; // surface failure after loop

    // On success, extract the draft content for the next iteration.
    // If the agent returns the same content as the prior draft, stop early
    // (no-op refinement) to avoid wasting tokens on identical iterations.
    if (iter < maxRefineIters - 1) {
      const nextDraft = reflectLlmPriorDraft(result) ?? result.stdout ?? "";
      if (priorDraft !== undefined && nextDraft === priorDraft) break;
      priorDraft = nextDraft;
    }
  }

  return { result, lastDraftPath };
}

/**
 * WI-9.10: build one `akm reflect` invocation's {@link RunContext} purely
 * from values `akmReflect` has already resolved by the time it calls this
 * (stash, config, runnerSpec) plus the caller-supplied seams on `options` —
 * no second config load, no new db handle. reflect has no `dryRun` option
 * (it never writes source assets directly, only the proposal queue — see the
 * module docblock) so `dryRun` is always `false` here. reflect also has no
 * `sourceRun` option; the value below mirrors the same `reflect-${Date.now()}`
 * convention already used inline at proposal creation time (see
 * `createInput` further down this file), as a fresh, independent token —
 * nothing yet reads `ctx.sourceRun`.
 */
function buildReflectRunContext(args: {
  options: AkmReflectOptions;
  stash: string;
  config: AkmConfig;
  runnerSpec: RunnerSpec;
}): RunContext {
  const { options, stash, config, runnerSpec } = args;
  return createRunContext({
    stashDir: stash,
    config,
    eventsCtx: options.eventsCtx ?? {},
    // Not yet wired into any proposal call site this stage (mirrors
    // buildImproveRunContext's proposalsCtx comment in improve.ts).
    proposalsCtx: options.ctx ?? {},
    chat: options.chat,
    getLlmRunner: () => (runnerIsLlm(runnerSpec) ? runnerSpec : null),
    sourceRun: `reflect-${Date.now()}`,
    dryRun: false,
    signal: options.signal,
  });
}

/**
 * Build idempotent `reflect_invoked` / `reflect_completed` emitters. Invocation
 * is delayed until canonical dispatch validates symbolic credentials, while
 * deterministic pre-dispatch failures still close an invoke/complete pair.
 *
 * Fix #3 (observability 0.8.0): every failure path below MUST emit
 * `reflect_completed` so observers can close the invoke/complete loop. The
 * three success-side `reflect_completed` emit sites carry rich metadata
 * (qualityRejected, sanitized, proposalId, etc.); the failure-side emits
 * carry `{ok: false, reason}` plus the ref when known. Stable failure
 * reasons line up with `AgentFailureReason`: "parse_error", "non_zero_exit",
 * "cooldown", "timeout", "spawn_failed", "llm_*", plus the synthetic
 * "ref_mismatch" / "enoent" / "draft_missing" subtypes for cases the agent
 * surface conflates as "parse_error". Sub-reasons land in `subreason`.
 */
function buildReflectEventEmitters(options: AkmReflectOptions): {
  emitInvoked: () => void;
  emitFailed: (reason: AgentFailureReason, subreason: string, ref?: string, extra?: Record<string, unknown>) => void;
} {
  let invoked = false;
  const emitInvoked = (): void => {
    if (invoked) return;
    appendEvent(
      {
        eventType: "reflect_invoked",
        // Key on item_ref when planning supplied one, otherwise the conceptId.
        ...(options.ref ? { ref: options.itemRef ?? durableImproveRef(options.ref) } : {}),
        metadata: {
          ...(options.task ? { task: options.task } : {}),
          ...(options.engine ? { engine: options.engine } : {}),
          // Attribution tagging: stamp the eligibility lane so reflect_invoked can be
          // sliced by lane downstream. See EligibilitySource.
          ...(options.eligibilitySource ? { eligibilitySource: options.eligibilitySource } : {}),
        },
      },
      options.eventsCtx,
    );
    invoked = true;
  };

  const emitFailed = (reason: AgentFailureReason, subreason: string, ref?: string, extra?: Record<string, unknown>) => {
    emitInvoked();
    appendEvent(
      {
        eventType: "reflect_completed",
        ...(ref ? { ref } : {}),
        metadata: {
          source: "reflect",
          ok: false,
          reason,
          subreason,
          ...(extra ?? {}),
        },
      },
      options.eventsCtx,
    );
  };

  return { emitInvoked, emitFailed };
}

function cleanupReflectDrafts(paths: readonly string[]): void {
  for (const draftPath of paths) {
    try {
      if (fs.existsSync(draftPath)) fs.unlinkSync(draftPath);
    } catch {
      // Draft cleanup is best-effort; the proposal result remains authoritative.
    }
  }
}

function validateReflectPayloadRef(args: {
  payload: ReturnType<typeof parseAgentProposalPayload>;
  result: AgentRunResult;
  options: AkmReflectOptions;
  engineName: string;
  emitReflectFailed: ReturnType<typeof buildReflectEventEmitters>["emitFailed"];
  executionNotices: Map<string, Readonly<LoweringNotice>>;
}): AkmReflectResult | undefined {
  const { payload, result, options, engineName, emitReflectFailed, executionNotices } = args;
  if (!options.ref) return undefined;
  try {
    const expectedParsed = parseRefInput(options.ref);
    const actualParsed = parseRefInput(payload.ref);
    if (expectedParsed.type === actualParsed.type && expectedParsed.name === actualParsed.name) return undefined;
    emitReflectFailed("parse_error", "ref_mismatch", options.ref, {
      expectedRef: options.ref,
      actualRef: payload.ref,
      ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
      ...(reflectLlmTelemetry(result) ?? {}),
    });
    return {
      schemaVersion: 2,
      ok: false,
      reason: "parse_error",
      error: `Agent retargeted proposal: expected ref "${options.ref}" but got "${payload.ref}". Proposal rejected to prevent silent ref hallucination.`,
      ref: options.ref,
      engine: engineName,
      exitCode: result.exitCode,
      stdout: result.stdout,
      ...(result.stderr ? { stderr: result.stderr } : {}),
      ...reflectNoticeFields(executionNotices),
    };
  } catch {
    // Malformed refs are rejected downstream by proposal validation.
    return undefined;
  }
}

/**
 * #952 — render the composed reflect prompt for exactly one asset with no
 * engine dispatch. Reuses every read-only step `akmReflect` performs before
 * {@link buildReflectPrompt} (source resolution, runner resolution, feedback /
 * schema-hint / related-lesson / rejected-proposal gathering) and stops right
 * there: no dispatch lease is acquired, no request is sent, and — because the
 * `emitReflectFailed` callback passed to {@link resolveReflectSource} here is
 * a no-op — no `reflect_invoked`/`reflect_completed` event is appended either.
 *
 * `akm improve <ref> --show-prompt` (`improve-cli.ts`) is the CLI surface: a
 * field operator uses it to see the exact prompt reflect would send, in
 * seconds, without running a full improve cycle or needing a reachable
 * engine.
 */
export async function renderReflectPromptPreview(
  options: AkmReflectOptions,
): Promise<{ ref: string; prompt: string; engine: string; engineKind: RunnerSpec["kind"] }> {
  if (!options.ref) {
    throw new UsageError("renderReflectPromptPreview requires options.ref.", "INVALID_FLAG_VALUE");
  }
  const ref = options.ref;
  const stash = resolveRunStashDir(options.stashDir);

  const sourceResolved = await resolveReflectSource(options, stash, () => {
    // No event emitted: this is a read-only preview, not a real invocation.
  });
  if ("failure" in sourceResolved) {
    const { failure } = sourceResolved;
    throw new UsageError(
      (!failure.ok && failure.error) || `Reflect cannot preview ref "${ref}".`,
      "INVALID_FLAG_VALUE",
    );
  }
  const { assetContent, parsedRef } = sourceResolved;

  const { runnerSpec, engineName } = resolveReflectRunner(options);
  const ctx = buildReflectRunContext({ options, stash, config: options.config ?? loadConfig(), runnerSpec });
  const assetCtx = ctx.withFreshAssetMemo();

  const feedback = readRecentFeedback(options.itemRef ?? durableImproveRef(ref), options.eventsCtx);
  const schemaHints = buildSchemaHints(parsedRef?.type ?? "", assetContent);
  const relatedLessons = parsedRef ? await readRelatedLessons(assetCtx, stash, ref, parsedRef, options.itemRef) : [];
  const rejectedProposals = readRejectedProposals(stash, ref, options.ctx);
  const standardsContext = resolveStandardsContext(ref, stash);

  const canRunnerWriteFile = runnerSupportsFileWrite(runnerSpec);
  const outputMode: ReflectLlmOutputMode | undefined = runnerIsLlm(runnerSpec)
    ? wantsJsonSchemaOutput(runnerSpec.connection)
      ? "json_schema"
      : "framed_markdown"
    : undefined;
  // Same tmp-path synthesis a real dispatch would use (Issue A) — never
  // written to, since this preview never runs the agent.
  const draftFilePath = canRunnerWriteFile ? synthesizeReflectDraftPath(ref) : undefined;

  const previewPromptInput: ReflectPromptInput = {
    ref,
    ...(parsedRef?.type ? { type: parsedRef.type } : {}),
    ...(parsedRef?.name ? { name: parsedRef.name } : {}),
    ...(assetContent !== undefined ? { assetContent } : {}),
    ...(feedback.length > 0 ? { feedback } : {}),
    ...(schemaHints.length > 0 ? { schemaHints } : {}),
    ...(relatedLessons.length > 0 ? { relatedLessons } : {}),
    ...(options.task ? { task: options.task } : {}),
    ...(standardsContext.trim() ? { standardsContext } : {}),
    ...(rejectedProposals.length > 0 ? { rejectedProposals } : {}),
    ...(draftFilePath ? { draftFilePath } : {}),
    ...(outputMode ? { outputMode } : {}),
  };
  // #952 — mirror the real dispatch path's context-aware content budget (see
  // computeReflectContentBudgetChars) so the preview shows the exact prompt
  // reflect would send: an LLM engine with a large context window gets the
  // full asset with no truncation marker, not the flat 12 000-char cap.
  const contentBudgetChars = computeReflectContentBudgetChars(previewPromptInput, runnerSpec);
  const { prompt } = buildReflectPrompt({
    ...previewPromptInput,
    ...(contentBudgetChars !== undefined ? { contentBudgetChars } : {}),
  });

  return { ref, prompt, engine: engineName, engineKind: runnerSpec.kind };
}

export async function akmReflect(options: AkmReflectOptions = {}): Promise<AkmReflectResult> {
  const stash = resolveRunStashDir(options.stashDir);

  // Build lazy event emitters. The invocation row is committed only after the
  // canonical dispatch has validated symbolic credentials; deterministic
  // pre-dispatch skips still emit it through emitReflectFailed.
  const { emitInvoked: emitReflectInvoked, emitFailed: emitReflectFailed } = buildReflectEventEmitters(options);

  // 2. Resolve target asset content (if a ref is supplied).
  const sourceResolved = await resolveReflectSource(options, stash, emitReflectFailed);
  if ("failure" in sourceResolved) return sourceResolved.failure;
  const { assetContent, parsedRef } = sourceResolved;

  // 3. Resolve exactly one named engine. Standalone reflect uses --engine or
  // defaults.engine; improve resolves its LLM-only strategy/process overlay.
  // An incompatible explicit engine is an error and never falls through.
  const { config, activeStrategy, runnerSpec, engineName, notices: resolutionNotices } = resolveReflectRunner(options);
  const executionNotices = new Map<string, Readonly<LoweringNotice>>();
  collectLoweringNotices(executionNotices, resolutionNotices);
  const collectExecutionNotices = (notices: readonly Readonly<LoweringNotice>[]): void =>
    collectLoweringNotices(executionNotices, notices);
  let qualityJudgeSelection = resolveReflectQualityJudgeRunner(
    config,
    runnerSpec,
    isReflectQualityGateEnabled(activeStrategy),
    collectExecutionNotices,
  );
  const qualityGateSkippedNoJudge = qualityJudgeSelection.enabled && !qualityJudgeSelection.runner;
  if (qualityGateSkippedNoJudge) {
    warnOnce(
      "reflect-quality-gate-no-judge",
      "Reflect proposal quality gate has no LLM configured to judge proposals (set defaults.llmEngine, or improve.strategies.<name>.processes.reflect.qualityGate.engine). Skipping the gate for this run; the proposal is queued for human review instead.",
    );
    qualityJudgeSelection = Object.freeze({ enabled: false, runner: undefined });
  }
  const qualityJudgeRunner = qualityJudgeSelection.runner;
  let generationLease: LoweredExecutionDispatchLease | undefined;
  let qualityJudgeLease: LoweredExecutionDispatchLease | undefined;

  try {
    generationLease = acquireReflectDispatchLease(runnerSpec, collectExecutionNotices);
    qualityJudgeLease =
      qualityJudgeRunner === runnerSpec
        ? generationLease
        : qualityJudgeRunner
          ? acquireReflectDispatchLease(qualityJudgeRunner, collectExecutionNotices)
          : undefined;

    // WI-9.10: RunContext, built only once config/runnerSpec exist so engine
    // resolution's existing error-priority ordering is undisturbed (see
    // buildReflectRunContext's docblock). D6: assetCtx is a fresh,
    // per-invocation memo — readRelatedLessons below is its genuine
    // content-read consumer.
    const ctx = buildReflectRunContext({ options, stash, config, runnerSpec });
    const assetCtx = ctx.withFreshAssetMemo();

    // 4. Build the shared prompt inputs — feedback, hints, lessons, rejected
    // proposals. These are stable across refinement iterations; only the
    // `priorDraft` field changes per-iteration (R-1 / #372).
    const feedback = readRecentFeedback(
      options.ref ? (options.itemRef ?? durableImproveRef(options.ref)) : undefined,
      options.eventsCtx,
    );
    const schemaHints = buildSchemaHints(parsedRef?.type ?? "", assetContent);
    const relatedLessons =
      options.ref && parsedRef
        ? await readRelatedLessons(assetCtx, stash, options.ref, parsedRef, options.itemRef)
        : [];
    // Reflexion-style verbal-RL: inject rejected proposals so the agent avoids
    // reproducing proposals that have already been reviewed and refused.
    const rejectedProposals = readRejectedProposals(stash, options.ref, options.ctx);
    // Standards "rulebook" for this target — stash convention/meta facts; empty
    // when none fire.
    const standardsContext = resolveStandardsContext(options.ref, stash);

    // 5. Spawn the agent — with the optional Self-Refine loop (R-1 / #372),
    // extracted to {@link runReflectRefineIterations}.
    const agentEnv: Record<string, string> = options.eventSource === "improve" ? { AKM_EVENT_SOURCE: "improve" } : {};
    const sensitiveValues = collectDispatchSensitiveValues(runnerSpec, {
      ...(Object.keys(agentEnv).length > 0 ? { env: agentEnv } : {}),
      ...(options.runAgentOptions ?? {}),
    });

    const draftPathsToCleanup: string[] = [];

    // `result` / `lastDraftPath` / `payload` are populated inside the try. Hoisted
    // here so the post-try sections (R-3 ref guard, sanitizer, quality gate,
    // createProposal) can use them after the drafts have been cleaned up.
    let result = {} as AgentRunResult;
    let lastDraftPath: string | undefined;
    let payload: ReturnType<typeof parseAgentProposalPayload>;
    try {
      const iterated = await runReflectRefineIterations({
        options,
        parsedRef,
        assetContent,
        feedback,
        schemaHints,
        relatedLessons,
        rejectedProposals,
        standardsContext,
        runnerSpec,
        lease: generationLease,
        agentEnv,
        draftPathsToCleanup,
        onNotices: collectExecutionNotices,
      });
      emitReflectInvoked();
      result = iterated.result;
      lastDraftPath = iterated.lastDraftPath;

      const finalResult: AgentRunResult = result;

      if (!finalResult.ok) {
        // B3: ENOENT / not-found gives an actionable hint.
        if (isEnoentFailure(finalResult)) {
          emitReflectFailed("spawn_failed", "enoent", options.ref, {
            ...(finalResult.exitCode !== undefined ? { exitCode: finalResult.exitCode } : {}),
          });
          return {
            ...failureEnvelope(finalResult, options.ref, engineName),
            error: enoentHintMessage(runnerIsLlm(runnerSpec) ? engineName : runnerSpec.profile.bin),
            ...reflectNoticeFields(executionNotices),
          };
        }
        const envelope = failureEnvelope(finalResult, options.ref, engineName);
        emitReflectFailed(
          envelope.reason,
          envelope.reason === "parse_error" ? "parse_error" : "agent_crash",
          options.ref,
          {
            ...(envelope.exitCode !== null ? { exitCode: envelope.exitCode } : {}),
            ...(reflectLlmTelemetry(finalResult) ?? {}),
          },
        );
        return { ...envelope, ...reflectNoticeFields(executionNotices) };
      }

      // Re-alias to `result` for the downstream code that references it.
      result = finalResult;

      const resolved = resolveReflectPayload({
        result,
        lastDraftPath,
        sensitiveValues,
        options,
        engineName,
        emitReflectFailed,
      });
      if ("failure" in resolved) {
        return { ...resolved.failure, ...reflectNoticeFields(executionNotices) };
      }
      payload = resolved.payload;
    } catch (error) {
      if (!(error instanceof ConfigError)) emitReflectInvoked();
      throw error;
    } finally {
      // Always remove tmp draft files — success, failure, or exception. Returns
      // inside the try above trigger this block before the function exits. Code
      // after this point uses the already-loaded `payload` and never touches the
      // draft paths.
      cleanupReflectDrafts(draftPathsToCleanup);
    }

    payload = { ...payload, content: redactSensitiveText(payload.content, sensitiveValues) };

    const refFailure = validateReflectPayloadRef({
      payload,
      result,
      options,
      engineName,
      emitReflectFailed,
      executionNotices,
    });
    if (refFailure) return refFailure;

    const finalized = await finalizeReflectProposal({
      payload,
      assetContent,
      result,
      options,
      engineName,
      config,
      qualityGateEnabled: qualityJudgeSelection.enabled,
      qualityGateSkippedNoJudge,
      qualityJudgeRunner,
      qualityJudgeLease,
      feedback,
      stash,
      emitReflectFailed,
      onNotices: collectExecutionNotices,
    });
    return { ...finalized, ...reflectNoticeFields(executionNotices) };
  } finally {
    if (qualityJudgeLease && qualityJudgeLease !== generationLease) {
      disposeLoweredExecutionDispatchLease(qualityJudgeLease);
    }
    if (generationLease) disposeLoweredExecutionDispatchLease(generationLease);
  }
}
