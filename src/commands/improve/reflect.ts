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
 *   4. Dispatch the selected named engine via {@link executeRunner}.
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
import { type AssetRef, parseAssetRef } from "../../core/asset/asset-ref";
import { assembleAssetFromString, serializeFrontmatter } from "../../core/asset/asset-serialize";
import { parseFrontmatter } from "../../core/asset/frontmatter";
import { stripMarkdownFences } from "../../core/asset/markdown";
import { DESCRIPTION_MAX_CHARS, requiresDescription } from "../../core/authoring-rules";
import { resolveStashDir } from "../../core/common";
import type { AkmConfig, ImproveProfileConfig, LlmProfileConfig } from "../../core/config/config";
import { loadConfig } from "../../core/config/config";
import { ConfigError } from "../../core/errors";
import { appendEvent, type EventsContext, readEvents } from "../../core/events";
import type { AkmReflectFailure, AkmReflectResult, EligibilitySource } from "../../core/improve-types";
import { lintLessonContent } from "../../core/lesson-lint";
import { redactSensitiveText } from "../../core/redaction";
import { resolveStandardsContext } from "../../core/standards/resolve-standards-context";
import { lookup } from "../../indexer/indexer";
import type { AgentFailureReason, AgentRunResult, RunAgentOptions } from "../../integrations/agent";
import { resolveEngine } from "../../integrations/agent/engine-resolution";
import {
  buildReflectPrompt,
  extractDraftConfidence,
  parseAgentProposalPayload,
  type RejectedProposalContext,
} from "../../integrations/agent/prompts";
import {
  materializeLlmRunnerConnection,
  type RunnerSpec,
  resolveImproveProcessRunner,
  runnerIsLlm,
  runnerSupportsFileWrite,
} from "../../integrations/agent/runner";
import { collectDispatchSensitiveValues, executeRunner } from "../../integrations/agent/runner-dispatch";
import type { ChatMessage, chatCompletion } from "../../llm/client";
import { callStructured } from "../../llm/structured-call";
import { baseFailureFields, enoentHintMessage, isEnoentFailure } from "../agent/agent-support";
import {
  type CreateProposalInput,
  isProposalSkipped,
  listProposals,
  type Proposal,
  type ProposalsContext,
  proposalContent,
} from "../proposal/repository";
import { checkReflectSize, isValidDescription } from "../proposal/validators/proposal-quality-validators";
import { deriveLessonRef } from "./distill";
import { runReflectQualityJudge } from "./distill/quality-gate";
import { findAssetFilePath } from "./eligibility";
import { emitProposal } from "./proposal-envelope";
import { classifyReflectChange } from "./reflect-noise";
import { createRunContext, type RunContext } from "./run-context";
import { MAX_REJECTED_PROPOSALS } from "./shared";
import { bareImproveRef, durableImproveRef } from "./source-identity";

export interface AkmReflectOptions {
  /**
   * Active improve profile for this run. When set, its per-process `reflect`
   * override wins over the `default` profile (e.g. runner resolution); absent
   * falls back to `default`.
   */
  improveProfile?: ImproveProfileConfig;
  /** Optional asset ref (`type:name`) to focus on. */
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
  /** Test seam: forwarded to runAgent for fake spawn / timers. */
  runAgentOptions?: Pick<RunAgentOptions, "spawn" | "setTimeoutFn" | "clearTimeoutFn">;
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
   * v2 test seam: pre-resolved RunnerSpec injected by tests to exercise the
   * llm/sdk/agent dispatch paths without real config. When set, skips
   * config-based runner resolution entirely.
   */
  runner?: RunnerSpec | null;
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
  /** Source identity used only for durable event keys. */
  sourceName?: string;
  /** Read pre-source-qualification feedback only for the historical local stash. */
  legacyBareState?: boolean;
}

// AkmReflectFailure / AkmReflectSuccess / AkmReflectResult moved DOWN to
// core/improve-types.ts (WI-9.8 KILL 2 — the §10.7 layering inversion:
// core/improve-types.ts imported AkmReflectResult UP from this module).
// Re-exported here verbatim so existing import sites (`from "./reflect"`)
// are unchanged.
export type { AkmReflectFailure, AkmReflectResult, AkmReflectSuccess } from "../../core/improve-types";

const MAX_FEEDBACK_LINES = 10;
const MAX_GLOBAL_FEEDBACK_LINES = 20;

/**
 * Pull recent `feedback` events from events.jsonl. When `ref` is present we
 * scope to that asset; otherwise we surface the most recent feedback across
 * all assets so `akm reflect` can operate in a general "review recent
 * signals" mode. Best-effort — a missing or empty events stream returns `[]`.
 */
function readRecentFeedback(ref?: string, legacyRef?: string): string[] {
  try {
    const result = readEvents({ type: "feedback", ...(ref && !legacyRef ? { ref } : {}) });
    const events =
      ref && legacyRef ? result.events.filter((event) => event.ref === ref || event.ref === legacyRef) : result.events;
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
  "wiki",
  "skill",
  "agent",
  "command",
  "workflow",
]);

/**
 * Identity / structural frontmatter fields the LLM is NEVER allowed to change.
 *
 * Renaming `name` on a skill silently breaks ref resolution because the ref is
 * derived from the on-disk path. Similar reasoning for `ref`, `id`, `slug`,
 * and `type`. The post-processor below restores any of these fields if the
 * LLM tried to rewrite them.
 *
 * Observed regression: proposal `26941510` (May 2026) renamed
 * `skill:openpalm-stack-diagnostics`'s `name` field to `"diagnostic-checklist"`.
 */
const PROTECTED_FRONTMATTER_FIELDS: ReadonlySet<string> = new Set(["name", "ref", "id", "slug", "type"]);

/**
 * Read the last 1–3 archived rejected proposals for a given ref from the
 * proposal store. Best-effort — returns `[]` when the proposals dir is absent
 * or the ref is undefined. Used to inject Reflexion-style verbal-RL context
 * into the reflect prompt so the agent avoids re-proposing already-refused
 * content (arXiv:2303.11366).
 */
function readRejectedProposals(stash: string, ref?: string): RejectedProposalContext[] {
  if (!ref) return [];
  try {
    return listProposals(stash, { ref, status: "rejected", includeArchive: true })
      .sort((a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime())
      .slice(0, MAX_REJECTED_PROPOSALS)
      .map((p) => ({
        ref: p.ref,
        reason: p.review?.reason ?? "no reason given",
        contentPreview: proposalContent(p).slice(0, 500),
      }));
  } catch {
    return [];
  }
}

/**
 * Synthesize a tmp draft-file path for the agent/sdk file-write contract.
 *
 * Mirrors `src/commands/propose.ts:163-178` — when the runner is agent-CLI or
 * the OpenCode SDK, we instruct the agent to write the proposal body directly
 * to this file instead of inlining it in JSON on stdout. This bypasses two
 * known failure modes for long assets: (a) ARG_MAX truncation on prompt
 * round-trips through fenced JSON, and (b) embedded-JSON parser brittleness
 * on multi-KB bodies (e.g. the `knowledge:systems/KOKORO_USAGE_GUIDE` 8.4KB
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
  sourceName?: string,
): Promise<RelatedLesson[]> {
  if (parsedRef.type !== "skill") return [];

  const related = new Map<string, RelatedLesson>();
  const derivedLessonRef = deriveLessonRef(ref);
  const candidateRefs = new Set<string>([derivedLessonRef]);
  const derivedLessonPath = path.join(stash, "lessons", `${derivedLessonRef.slice("lesson:".length)}.md`);
  if (fs.existsSync(derivedLessonPath)) {
    // WI-9.10: genuine content read — routed through the per-invocation asset
    // memo (D6). No write to this same path happens later in this invocation,
    // so memoizing is safe (see run-context.ts's D6 seam docblock).
    related.set(derivedLessonRef, { ref: derivedLessonRef, content: ctx.readAsset(derivedLessonPath) });
  }

  try {
    const feedbackEvents = readEvents({ type: "distill_invoked", ref: durableImproveRef(ref, sourceName) }).events;
    for (const event of feedbackEvents) {
      const lessonRef = typeof event.metadata?.lessonRef === "string" ? event.metadata.lessonRef : undefined;
      if (lessonRef?.startsWith("lesson:")) candidateRefs.add(lessonRef);
    }
  } catch {
    // Best effort only.
  }

  for (const candidateRef of candidateRefs) {
    try {
      const filePath = await findAssetFilePath(durableImproveRef(candidateRef, sourceName), stash);
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
        const lessonRef = `lesson:${lessonName}`;
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
    const feedbackEventsForSkill = readEvents({ type: "feedback", ref }).events;
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
 * Two accepted forms:
 *  1. Structured JSON: `{ skipped: true }` or `{ reason: "<known-skip-reason>" }`
 *  2. Legacy text: any line matching `/proposal skipped/i`
 *
 * The previous regex `/cooldown/i` was intentionally broadened to avoid
 * false-positives on real agent error messages that incidentally contain the
 * word "cooldown" (e.g. "rate limit cooldown exceeded"). Only the tightly
 * scoped forms above are treated as legitimate skip signals.
 */
function isStructuredCooldownSignal(stdout: string): boolean {
  try {
    const parsed = JSON.parse(stdout.trim());
    if (parsed?.skipped === true) return true;
    if (
      typeof parsed?.reason === "string" &&
      // WI-6.4 vocabulary (fingerprint_match / rejection_backoff) plus the
      // legacy tokens — old agent payloads may still carry the retired names.
      [
        "fingerprint_match",
        "rejection_backoff",
        "duplicate_pending",
        "content_hash_match",
        "cooldown",
        "below_threshold",
      ].includes(parsed.reason)
    )
      return true;
  } catch {
    // Non-JSON stdout is never a structured cooldown signal.
  }
  // Legacy text signal emitted by older proposal output lines.
  return /proposal skipped/i.test(stdout);
}

/**
 * Fallback payload parser for reflect agent stdout (R-6 / #375).
 *
 * When the agent does not emit valid JSON (old-style agents, SDK mode without
 * structured output support), this function attempts to recover a proposal
 * payload from the raw markdown output. The parser is deliberately strict —
 * it requires the content to have a complete proposal structure (frontmatter
 * with required fields or a full heading + body).
 *
 * Strictness rationale: The previous implementation accepted any markdown
 * starting with `#` or `---`, which admitted malformed / hallucinated content
 * as valid proposals. Anthropic agent best practices recommend structured
 * output when the SDK supports it; this tighter fallback is the safety net.
 *
 * For SDK runners, structured output (tool-call schema) should be used
 * instead of this fallback. That wiring is tracked separately (full SDK
 * structured-output integration); for now this tighter parser applies to all
 * modes and is the primary R-6 deliverable.
 */
function fallbackPayloadFromRawContent(stdout: string, ref: string | undefined, sdkRunner = false) {
  if (!ref) return undefined;
  const trimmed = stripMarkdownFences(stdout).trim();
  if (!trimmed) return undefined;
  const targetType = ref.split(":")[0];
  if (!looksLikeAssetContent(trimmed, sdkRunner, targetType)) return undefined;
  return { ref, content: trimmed };
}

/**
 * Determine whether raw agent output looks like a valid asset payload (R-6 / #375).
 *
 * Tightened from the previous `startsWith("#") || startsWith("---")`:
 *
 * - YAML frontmatter (`---`): must contain a `description:` field (the only
 *   required frontmatter key in v1 spec). This eliminates empty `---\n---\n`
 *   blocks and pure delimiter sequences as valid payloads.
 * - Heading start (`#`): must have at least 3 non-blank lines after the heading,
 *   to ensure there is actual body content and not just a title stub.
 * - For SDK runners: additionally requires `when_to_use:` for
 *   lesson types (full structured output will replace this in a future PR).
 */
function looksLikeAssetContent(value: string, sdkRunner = false, targetType?: string): boolean {
  if (value.startsWith("---")) {
    // YAML frontmatter must contain at least a description field.
    const fmEnd = value.indexOf("\n---", 4);
    if (fmEnd === -1) return false;
    const fmBlock = value.slice(0, fmEnd + 4);
    const hasDescription = /^description\s*:/m.test(fmBlock);
    if (!hasDescription) return false;
    // In SDK mode, lesson assets additionally require a when_to_use field.
    // Use the target ref type rather than frontmatter type: (which is non-standard).
    if (sdkRunner && targetType === "lesson") {
      return /^when_to_use\s*:/m.test(fmBlock);
    }
    return true;
  }
  if (value.startsWith("#")) {
    // Heading + at least 2 non-blank lines (heading + at least one body line).
    // This rejects pure title stubs (`# Title\n`) but accepts minimal valid content.
    const lines = value.split("\n").filter((l) => l.trim().length > 0);
    return lines.length >= 2;
  }
  return false;
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
}

/**
 * Split a markdown blob into `[frontmatterText, bodyText]`.
 *
 * Returns `[null, raw]` when the blob does not start with a frontmatter block.
 */
function splitFrontmatter(raw: string): { fmText: string | null; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { fmText: null, body: raw };
  return { fmText: m[1], body: m[2] };
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
  if (!/^\w[\w-]*:/m.test(match[1])) return body;
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
  const refType = targetRef.includes(":") ? (targetRef.split(":")[0] ?? "") : "";
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
  if (!sizeOutcome.ok) {
    const pct = (sizeOutcome.ratio * 100).toFixed(0);
    const limit = sizeOutcome.code === "EXCESSIVE_SHRINKAGE" ? "minimum 50%" : "maximum 250%";
    const cause =
      sizeOutcome.code === "EXCESSIVE_SHRINKAGE"
        ? "Concrete content was likely deleted."
        : "Speculative material was likely added.";
    return {
      content: payload.content,
      warnings,
      reject: {
        // Content-policy guard hit (EXCESSIVE_SHRINKAGE / EXCESSIVE_EXPANSION).
        // This is the guard working as designed — the LLM responded fine, we
        // blocked the output. Routed through `content_policy_reject` so the
        // health aggregator can split guard hits out of true LLM faults.
        reason: "content_policy_reject" as AgentFailureReason,
        error: `Reflect rejected: ${sizeOutcome.code} — proposed body is ${pct}% of source (${limit}) for ref ${targetRef}. ${cause}`,
      },
    };
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
  };
}

/**
 * JSON Schema for structured reflect output. Passed to `chatCompletion` when
 * the connection has `supportsJsonSchema: true` so the model returns a strict
 * JSON object matching {@link AgentProposalPayload}.
 */
export const REFLECT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["ref", "content"],
  additionalProperties: false,
  properties: {
    ref: { type: "string", description: "Asset ref in type:name format (e.g. lesson:my-lesson)." },
    content: { type: "string", description: "Full markdown content for the asset." },
    frontmatter: {
      type: "object",
      description: "Optional frontmatter key-value pairs to merge into the asset.",
      additionalProperties: true,
    },
    // Phase 6A (Advantage D6a): self-reported confidence in [0, 1]. When the
    // LLM is well-calibrated, scores at or above the configured threshold
    // (default 0.8) drive auto-accept in `akm improve`. Out-of-range or
    // non-finite values are clamped/dropped by the parser — the schema keeps
    // the field optional so older agents that don't emit a score still work.
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description:
        "Optional self-reported quality confidence in [0, 1]. Persisted on the proposal for reviewers and the triage judge to read during adjudication.",
    },
  },
};

/** Critique prompt injected between prior draft and refinement request (Self-Refine loop). */
const REFLECT_CRITIQUE_PROMPT =
  "Your previous proposal is shown above. Please review it critically and provide an improved version that is more specific, actionable, and avoids any issues with the previous attempt. Return only the improved JSON proposal.";

/** Options for the direct-LLM reflect runner (v2 config path). */
export interface RunReflectViaLlmOptions {
  /** Reflect prompt text (built by {@link buildReflectPrompt}). */
  prompt: string | undefined;
  /** LLM connection config. `supportsJsonSchema` controls structured-output mode. */
  connection: LlmProfileConfig;
  /** Hard timeout for the LLM request in ms. */
  timeoutMs?: number | null;
  /** Optional caller-driven cancellation signal. */
  signal?: AbortSignal;
  /** Prior draft for Self-Refine critique (injected on iterations > 0). */
  priorDraft?: string;
  /** Current refinement iteration (0-based). */
  iteration: number;
  /**
   * JSON Schema for structured output. When provided AND `connection.supportsJsonSchema`
   * is `true`, passed through to `chatCompletion` so the provider enforces it.
   */
  responseSchema?: Record<string, unknown>;
  /** Test seam: override the chat function (avoids real LLM calls in tests). */
  chat?: typeof chatCompletion;
  /**
   * Hard output-token cap forwarded directly to `chatCompletion` as `max_tokens`.
   * Derived from the same blended-bound formula used by {@link checkReflectSize}
   * (via {@link buildReflectPrompt}) so the API layer enforces the same ceiling
   * that the post-processor would reject anyway. Adds a buffer for JSON structure
   * and frontmatter overhead (÷3 chars/token, +500 char overhead).
   * Only set when the source body is ≥ REFLECT_SIZE_GUARD_MIN_BYTES (200 chars).
   */
  maxTokens?: number;
  /**
   * Accepted for type consistency with agent/sdk runners but intentionally NO-OP
   * for the LLM HTTP path: the chat-completion transport has no filesystem access,
   * so it cannot honour a file-write contract. The reflect dispatcher must NEVER
   * synthesize a draft path when the runner kind is `llm` — the prompt builder
   * is also called WITHOUT `draftFilePath` so it emits the JSON contract instead.
   */
  draftFilePath?: string;
}

/**
 * Run a single reflect iteration directly via the LLM API (v2 config path).
 *
 * Returns an {@link AgentRunResult}-shaped object so it can slot into the same
 * dispatch loop as agent-based runners. On success, `stdout` contains the raw
 * LLM response (unparsed JSON or prose). On failure, the error is captured
 * into the result rather than thrown.
 */
export async function runReflectViaLlm(opts: RunReflectViaLlmOptions): Promise<AgentRunResult> {
  const start = Date.now();
  const messages: ChatMessage[] = [{ role: "user", content: opts.prompt ?? "" }];

  if (opts.priorDraft !== undefined && opts.iteration > 0) {
    messages.push({ role: "assistant", content: opts.priorDraft });
    messages.push({ role: "user", content: REFLECT_CRITIQUE_PROMPT });
  }

  try {
    // UNGATED at the seam (no akmConfig): reflect enablement is resolved by
    // the improve strategy before dispatch, and errors propagate into the
    // catch below, folding into the failure-shaped AgentRunResult.
    const stdout = await callStructured<string>({
      feature: "reflect_proposal",
      config: opts.connection,
      messages,
      request: {
        ...(Object.hasOwn(opts, "timeoutMs") ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.responseSchema !== undefined ? { responseSchema: opts.responseSchema } : {}),
        ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
        // Reflect requires a machine-readable payload. Visible chain-of-thought
        // can consume the output cap before the model reaches the JSON object.
        enableThinking: false,
        ...(opts.chat ? { chat: opts.chat } : {}),
      },
      parse: (raw) => raw ?? "",
      // Unreachable on the ungated path (errors propagate to the catch below).
      onError: () => "",
      fallback: "",
    });
    return {
      ok: true,
      stdout,
      stderr: "",
      durationMs: Date.now() - start,
      exitCode: 0,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      stdout: "",
      stderr: msg,
      durationMs: Date.now() - start,
      exitCode: 1,
      reason: "non_zero_exit" as AgentFailureReason,
      error: msg,
    };
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
  activeStrategy: import("../../core/config/config").ImproveProfileConfig | undefined;
  runnerSpec: RunnerSpec;
  feedback: Parameters<typeof runReflectQualityJudge>[3];
  stash: string;
  emitReflectFailed: (
    reason: AgentFailureReason,
    subreason: string,
    ref?: string,
    extra?: Record<string, unknown>,
  ) => void;
}): Promise<AkmReflectResult> {
  const {
    assetContent,
    result,
    options,
    engineName,
    config,
    activeStrategy,
    runnerSpec,
    feedback,
    stash,
    emitReflectFailed,
  } = args;
  let payload = args.payload;

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
      emitReflectFailed("no_change", subreason, options.ref, { changeKind });
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
  const qualityGateEnabled =
    (activeStrategy?.processes?.reflect?.qualityGate?.enabled ?? false) ||
    (activeStrategy?.processes?.distill?.qualityGate?.enabled ?? true);
  if (qualityGateEnabled) {
    const judgeResult = await runReflectQualityJudge(
      config,
      payload.content,
      assetContent ?? "",
      feedback,
      options.chat,
      {
        ...(runnerIsLlm(runnerSpec) ? { llmConfig: materializeLlmRunnerConnection(runnerSpec) } : {}),
        ...(Object.hasOwn(options, "timeoutMs") ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
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
  emitReflectFailed: (
    reason: AgentFailureReason,
    subreason: string,
    ref?: string,
    extra?: Record<string, unknown>,
  ) => void;
}): AkmReflectResult {
  const { payload, options, stash, engineName, durationMs, emitReflectFailed } = args;
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
      return parseAssetRef(payload.ref).type === "lesson";
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

  const proposal: Proposal = proposalResult;

  appendEvent(
    {
      eventType: "reflect_completed",
      ref: proposal.ref,
      metadata: {
        proposalId: proposal.id,
        source: "reflect",
        engine: engineName,
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
 * legacy JSON-stdout path (`parseAgentProposalPayload`, with the raw-content
 * fallback and cooldown-signal reclassification). Returns the payload or a
 * terminal failure envelope. Extracted verbatim from `akmReflect`.
 */
function resolveReflectPayload(args: {
  result: AgentRunResult;
  lastDraftPath: string | undefined;
  sensitiveValues: readonly string[];
  options: AkmReflectOptions;
  runnerSpec: RunnerSpec;
  engineName: string;
  emitReflectFailed: (
    reason: AgentFailureReason,
    subreason: string,
    ref?: string,
    extra?: Record<string, unknown>,
  ) => void;
}): { payload: ReturnType<typeof parseAgentProposalPayload> } | { failure: AkmReflectResult } {
  const { result, lastDraftPath, sensitiveValues, options, runnerSpec, engineName, emitReflectFailed } = args;
  // 6. Resolve the proposal content.
  //
  // Path A (file-write contract — preferred for agent/sdk runners on long
  // assets): the agent wrote the body to `lastDraftPath` and printed
  // `DRAFT_WRITTEN` on stdout. Load the body from disk and synthesize a
  // payload. The `EXCESSIVE_EXPANSION`/schema-shape gates downstream still
  // apply — they validate content, not transport.
  //
  // Path B (legacy JSON stdout): the agent inlined the proposal body in
  // JSON on stdout. Falls through to `parseAgentProposalPayload`. Also the
  // path used by the LLM HTTP runner, which cannot honour file-write.
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
    const fallback = fallbackPayloadFromRawContent(result.stdout ?? "", options.ref, runnerSpec.kind === "sdk");
    if (fallback) {
      return { payload: fallback };
    }
    // Reclassify cooldown/skip messages that arrive as stdout text instead of
    // valid proposal JSON. These are legitimate skip signals, not parse failures,
    // and should not pollute reflectFailedActions or recentErrors injection.
    const stdoutText = result.stdout ?? "";
    const isCooldownSignal = isStructuredCooldownSignal(stdoutText);
    const reason: AgentFailureReason = isCooldownSignal ? "cooldown" : "parse_error";
    emitReflectFailed(reason, isCooldownSignal ? "stdout_cooldown_signal" : "parse_error", options.ref, {
      ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
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
} {
  const config = options.config ?? loadConfig();
  const activeStrategy =
    options.improveProfile ?? config.improve?.strategies?.[config.defaults?.improveStrategy ?? "default"];
  let runnerSpec: RunnerSpec;
  if (options.runner) {
    runnerSpec = options.runner;
  } else if (Object.hasOwn(options, "runner")) {
    throw new ConfigError(
      "Reflect requires an LLM engine for the active improve invocation.",
      "LLM_NOT_CONFIGURED",
      "Set defaults.llmEngine or improve.strategies.<name>.processes.reflect.engine.",
    );
  } else if (options.engine) {
    runnerSpec = resolveEngine(options.engine, config);
  } else if (options.improveProfile) {
    const processRunner = resolveImproveProcessRunner(activeStrategy, "reflect", config);
    if (!processRunner) {
      throw new ConfigError(
        "Reflect requires an LLM engine for the active improve strategy.",
        "LLM_NOT_CONFIGURED",
        "Set defaults.llmEngine or improve.strategies.<name>.processes.reflect.engine.",
      );
    }
    runnerSpec = processRunner;
  } else {
    const defaultEngine = config.defaults?.engine;
    if (!defaultEngine) {
      throw new ConfigError("reflect requires --engine or defaults.engine.", "INVALID_CONFIG_FILE");
    }
    runnerSpec = resolveEngine(defaultEngine, config);
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
  return { config, activeStrategy, runnerSpec, engineName };
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
    parsedRef = parseAssetRef(options.ref);

    // 2a. Type guard — reflect only operates on asset types whose canonical
    // shape is `frontmatter + markdown body`. Refuse non-markdown types
    // (script / env / task) up-front so reflect never prepends YAML to a
    // `.ts` file or rewrites a `.env` blob as prose. See REFLECT_ALLOWED_TYPES.
    if (!REFLECT_ALLOWED_TYPES.has(parsedRef.type)) {
      // Deterministic type-guard rejection — the LLM is never invoked. Emit
      // with reason `unsupported_type` so the improve loop can route this to
      // the `reflect-skipped` action bucket instead of `reflect-failed`. See
      // `/tmp/akm-health-investigations/metrics-taxonomy-review.md` §1a
      // ("Reflect refused asset type" — ~9% of reflect-failed events).
      emitReflectFailed("unsupported_type", "unsupported_type", options.ref, { type: parsedRef.type });
      return {
        failure: {
          schemaVersion: 2,
          ok: false,
          reason: "unsupported_type" as AgentFailureReason,
          error: `Reflect refused: asset type "${parsedRef.type}" is not supported by reflect (only markdown-canonical types are allowed: ${[...REFLECT_ALLOWED_TYPES].sort().join(", ")}). Use \`akm propose\` or edit the file directly.`,
          ref: options.ref,
          exitCode: null,
        },
      };
    }

    if (options.assetContent !== undefined) {
      // Test seam — caller pre-loaded the source content.
      assetContent = options.assetContent;
    } else {
      try {
        const qualifiedRef = durableImproveRef(options.ref, options.sourceName);
        const localFilePath = await findAssetFilePath(qualifiedRef, stash);
        if (localFilePath && fs.existsSync(localFilePath)) {
          assetContent = fs.readFileSync(localFilePath, "utf8");
        } else {
          const entry = await lookup(parseAssetRef(qualifiedRef));
          if (entry?.filePath && fs.existsSync(entry.filePath)) {
            assetContent = fs.readFileSync(entry.filePath, "utf8");
          }
        }
      } catch {
        // Index miss is non-fatal — the agent can still propose a fresh asset.
      }
    }
  }
  return { assetContent, parsedRef };
}

/**
 * Run the agent with the optional Self-Refine loop (R-1 / #372): up to
 * MAX_REFINE_ITERS invocations, each injecting the prior draft as self-critique
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
  agentEnv: Record<string, string>;
  draftPathsToCleanup: string[];
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
    agentEnv,
    draftPathsToCleanup,
  } = args;
  const MAX_REFINE_ITERS = 3;
  const maxRefineIters = Math.min(Math.max(1, options.maxRefineIters ?? 1), MAX_REFINE_ITERS);
  // Determine whether this dispatch can honour the file-write contract.
  // Agent CLI + OpenCode SDK runners both have filesystem access; the direct
  // LLM HTTP runner does NOT.
  const canRunnerWriteFile = runnerSupportsFileWrite(runnerSpec);
  // Initialized to a sentinel; always overwritten in the first loop iteration
  // (maxRefineIters is clamped to >= 1 above).
  let result = {} as AgentRunResult;
  let priorDraft: string | undefined;
  let lastDraftPath: string | undefined;

  for (let iter = 0; iter < maxRefineIters; iter++) {
    // Synthesize a fresh tmp path per iteration so refinement passes never
    // clobber an earlier draft (and so reading back is unambiguous).
    const iterDraftPath = canRunnerWriteFile ? synthesizeReflectDraftPath(options.ref) : undefined;
    if (iterDraftPath) {
      draftPathsToCleanup.push(iterDraftPath);
      lastDraftPath = iterDraftPath;
    }

    const { prompt, maxOutputChars } = buildReflectPrompt({
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
      // on long bodies (e.g. knowledge:systems/KOKORO_USAGE_GUIDE 8.4KB).
      ...(iterDraftPath ? { draftFilePath: iterDraftPath } : {}),
    });
    // Convert char ceiling → token cap for the LLM path: divide by 3 chars/token
    // (conservative — most models are 3.5–4) and add 500-char overhead for the
    // JSON wrapper and frontmatter block that surround the body in the response.
    const maxTokensForLlm = maxOutputChars !== undefined ? Math.ceil((maxOutputChars + 500) / 3) : undefined;

    // Every engine kind crosses the same dispatch seam. Injected spawn/timer
    // functions remain ordinary run options for deterministic tests.
    const runOptions: RunAgentOptions = {
      stdio: "captured",
      parseOutput: "text",
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(Object.keys(agentEnv).length > 0 ? { env: agentEnv } : {}),
      ...(options.runAgentOptions ?? {}),
    };
    const iterResult = await executeRunner(runnerSpec, prompt ?? "", runOptions, {
      llm: async (spec, _prompt, opts) =>
        // LLM HTTP runners cannot honor the file-write contract, so they
        // return structured JSON through stdout.
        runReflectViaLlm({
          prompt,
          connection: spec.connection,
          ...(Object.hasOwn(opts, "timeoutMs") ? { timeoutMs: opts.timeoutMs } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          priorDraft,
          iteration: iter,
          responseSchema: REFLECT_JSON_SCHEMA,
          chat: options.chat,
          ...(maxTokensForLlm !== undefined ? { maxTokens: maxTokensForLlm } : {}),
        }),
    });

    result = iterResult;

    if (!iterResult.ok) break; // surface failure after loop

    // On success, extract the draft content for the next iteration.
    // If the agent returns the same content as the prior draft, stop early
    // (no-op refinement) to avoid wasting tokens on identical iterations.
    if (iter < maxRefineIters - 1) {
      const nextDraft = iterResult.stdout ?? "";
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
    getLlmConfig: () => (runnerIsLlm(runnerSpec) ? materializeLlmRunnerConnection(runnerSpec) : null),
    sourceRun: `reflect-${Date.now()}`,
    dryRun: false,
    signal: options.signal,
  });
}

/**
 * Emit `reflect_invoked` at command entry, then build the `reflect_completed`
 * failure emitter every failure path in `akmReflect` uses (Fix #3 /
 * observability 0.8.0). Extracted verbatim (fn-size decomposition, R31) — see
 * the original inline comments preserved below for the "why".
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
function emitReflectInvokedAndBuildFailureEmitter(
  options: AkmReflectOptions,
): (reason: AgentFailureReason, subreason: string, ref?: string, extra?: Record<string, unknown>) => void {
  // Always emit `reflect_invoked` at command entry — observers see the
  // attempt regardless of downstream success/failure.
  appendEvent(
    {
      eventType: "reflect_invoked",
      ...(options.ref ? { ref: durableImproveRef(options.ref, options.sourceName) } : {}),
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

  return (reason, subreason, ref, extra): void => {
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
}

export async function akmReflect(options: AkmReflectOptions = {}): Promise<AkmReflectResult> {
  const stash = options.stashDir ?? resolveStashDir();

  // 1. Emit reflect_invoked + build the reflect_completed failure emitter
  // every failure path below uses.
  const emitReflectFailed = emitReflectInvokedAndBuildFailureEmitter(options);

  // 2. Resolve target asset content (if a ref is supplied).
  const sourceResolved = await resolveReflectSource(options, stash, emitReflectFailed);
  if ("failure" in sourceResolved) return sourceResolved.failure;
  const { assetContent, parsedRef } = sourceResolved;

  // 3. Resolve exactly one named engine. Standalone reflect uses --engine or
  // defaults.engine; improve resolves its LLM-only strategy/process overlay.
  // An incompatible explicit engine is an error and never falls through.
  const { config, activeStrategy, runnerSpec, engineName } = resolveReflectRunner(options);

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
    options.ref ? durableImproveRef(options.ref, options.sourceName) : undefined,
    options.ref && options.legacyBareState ? bareImproveRef(options.ref) : undefined,
  );
  const schemaHints = buildSchemaHints(parsedRef?.type ?? "", assetContent);
  const relatedLessons =
    options.ref && parsedRef
      ? await readRelatedLessons(assetCtx, stash, options.ref, parsedRef, options.sourceName)
      : [];
  // Reflexion-style verbal-RL: inject rejected proposals so the agent avoids
  // reproducing proposals that have already been reviewed and refused.
  const rejectedProposals = readRejectedProposals(stash, options.ref);
  // Standards "rulebook" for this target — wiki schema (wiki page) or stash
  // convention/meta facts (non-wiki asset); empty when neither fires.
  const standardsContext = resolveStandardsContext(options.ref, stash);

  // 5. Spawn the agent — with the optional Self-Refine loop (R-1 / #372),
  // extracted to {@link runReflectRefineIterations}.
  const agentEnv: Record<string, string> = options.eventSource === "improve" ? { AKM_EVENT_SOURCE: "improve" } : {};
  const sensitiveValues = collectDispatchSensitiveValues(runnerSpec, {
    ...(Object.keys(agentEnv).length > 0 ? { env: agentEnv } : {}),
    ...(options.runAgentOptions ?? {}),
  });

  // Track every draft file path we synthesize so cleanup can remove them on
  // every return path (success and failure). Mirrors propose's unlink pattern
  // in `src/commands/propose.ts:215-226` but generalised to N refinement
  // iterations. Always called via {@link cleanupDrafts} below.
  const draftPathsToCleanup: string[] = [];

  // Best-effort unlink: tolerate already-deleted files (we may have unlinked
  // an intermediate iteration's draft) and unwritable paths. Never throws —
  // the proposal result is the source of truth for the caller.
  const cleanupDrafts = (): void => {
    for (const p of draftPathsToCleanup) {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {
        // Swallow — cleanup is best-effort.
      }
    }
  };

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
      agentEnv,
      draftPathsToCleanup,
    });
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
        };
      }
      const envelope = failureEnvelope(finalResult, options.ref, engineName);
      emitReflectFailed(envelope.reason, "agent_crash", options.ref, {
        ...(envelope.exitCode !== null ? { exitCode: envelope.exitCode } : {}),
      });
      return envelope;
    }

    // Re-alias to `result` for the downstream code that references it.
    result = finalResult;

    const resolved = resolveReflectPayload({
      result,
      lastDraftPath,
      sensitiveValues,
      options,
      runnerSpec,
      engineName,
      emitReflectFailed,
    });
    if ("failure" in resolved) return resolved.failure;
    payload = resolved.payload;
  } finally {
    // Always remove tmp draft files — success, failure, or exception. Returns
    // inside the try above trigger this block before the function exits. Code
    // after this point uses the already-loaded `payload` and never touches the
    // draft paths.
    cleanupDrafts();
  }

  payload = { ...payload, content: redactSensitiveText(payload.content, sensitiveValues) };

  // 6b. Validate payload.ref === options.ref (R-3 / #366).
  // A hallucinating agent can silently retarget proposals to a different ref.
  // This guard normalises both refs through parseAssetRef so origin-prefix
  // differences do not cause false positives, then rejects mismatches.
  // References: CRITIC (arXiv:2305.11738), CoVe (arXiv:2309.11495).
  if (options.ref) {
    try {
      const expectedParsed = parseAssetRef(options.ref);
      const actualParsed = parseAssetRef(payload.ref);
      // Compare type + name (drop origin — agent may omit origin prefix).
      if (expectedParsed.type !== actualParsed.type || expectedParsed.name !== actualParsed.name) {
        emitReflectFailed("parse_error", "ref_mismatch", options.ref, {
          expectedRef: options.ref,
          actualRef: payload.ref,
          ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
        });
        return {
          schemaVersion: 2,
          ok: false,
          reason: "parse_error" as const,
          error: `Agent retargeted proposal: expected ref "${options.ref}" but got "${payload.ref}". Proposal rejected to prevent silent ref hallucination.`,
          ref: options.ref,
          engine: engineName,
          exitCode: result.exitCode,
          stdout: result.stdout,
          ...(result.stderr ? { stderr: result.stderr } : {}),
        };
      }
    } catch {
      // parseAssetRef failure means the agent returned a malformed ref — already
      // caught downstream by createProposal; allow it to surface naturally.
    }
  }

  return finalizeReflectProposal({
    payload,
    assetContent,
    result,
    options,
    engineName,
    config,
    activeStrategy,
    runnerSpec,
    feedback,
    stash,
    emitReflectFailed,
  });
}
