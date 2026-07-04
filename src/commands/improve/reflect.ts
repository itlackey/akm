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
 *   4. Spawn the configured agent profile via {@link runAgent}.
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
import type { AkmConfig, LlmConnectionConfig, LlmProfileConfig } from "../../core/config/config";
import { getImproveProcessConfig, loadConfig } from "../../core/config/config";
import { ConfigError, UsageError } from "../../core/errors";
import { appendEvent, readEvents } from "../../core/events";
import type { EligibilitySource } from "../../core/improve-types";
import { lintLessonContent } from "../../core/lesson-lint";
import { resolveStandardsContext } from "../../core/standards/resolve-standards-context";
import { lookup } from "../../indexer/indexer";
import {
  type AgentFailureReason,
  type AgentProfile,
  type AgentRunResult,
  type RunAgentOptions,
  runAgent,
} from "../../integrations/agent";
import { resolveProcessAgentProfile } from "../../integrations/agent/config";
import {
  buildReflectPrompt,
  extractDraftConfidence,
  parseAgentProposalPayload,
  type RejectedProposalContext,
} from "../../integrations/agent/prompts";
import {
  type RunnerSpec,
  resolveImproveProcessRunnerFromProfile,
  runnerIsLlm,
  runnerSupportsFileWrite,
} from "../../integrations/agent/runner";
import { executeRunner } from "../../integrations/agent/runner-dispatch";
import { runOpencodeSdk } from "../../integrations/harnesses/opencode-sdk";
import { type ChatMessage, chatCompletion } from "../../llm/client";
import { isLlmFeatureEnabled } from "../../llm/feature-gate";
import {
  baseFailureFields,
  enoentHintMessage,
  isEnoentFailure,
  loadAgentConfigFromDisk,
  resolveAgentProfile,
} from "../agent/agent-support";
import {
  type CreateProposalInput,
  createProposal,
  isProposalSkipped,
  listProposals,
  type Proposal,
  type ProposalsContext,
} from "../proposal/repository";
import { checkReflectSize, isValidDescription } from "../proposal/validators/proposal-quality-validators";
import { deriveLessonRef, runLessonQualityJudge } from "./distill";
import { classifyReflectChange } from "./reflect-noise";

export interface AkmReflectOptions {
  /** Optional asset ref (`type:name`) to focus on. */
  ref?: string;
  /** Optional task hint passed through to the reflection prompt. */
  task?: string;
  /** Override the agent profile name (defaults to `agent.default`). */
  profile?: string;
  /** Override the spawn timeout. */
  timeoutMs?: number;
  /** Test seam: override the stash dir. */
  stashDir?: string;
  /** Test seam: override the resolved agent profile (skips config lookup). */
  agentProfile?: AgentProfile;
  /** Test seam: forwarded to runAgent for fake spawn / timers. */
  runAgentOptions?: Pick<RunAgentOptions, "spawn" | "setTimeoutFn" | "clearTimeoutFn">;
  /** Test seam: pre-resolved AkmConfig (skips config load). */
  agentConfig?: AkmConfig;
  /** Test seam: stable id / clock for proposal creation. */
  ctx?: ProposalsContext;
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
  chat?: (
    config: import("../../core/config/config").LlmConnectionConfig,
    messages: import("../../llm/client").ChatMessage[],
  ) => Promise<string>;
  /**
   * Override the loaded AkmConfig (test seam + for the quality gate).
   * Needed by R-5 to access the proposal quality gate (now stored at
   * `profiles.improve.default.processes.reflect.qualityGate.enabled`) without
   * a real config file in tests.
   */
  config?: import("../../core/config/config").AkmConfig;
  /**
   * Named process to use for per-process agent config lookup. Defaults to
   * `"reflect"`. When an explicit `--profile` flag is given, the process
   * lookup is skipped and the flag value wins.
   */
  agentProcess?: string;
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
   * from the ACTIVE profile's `processes.reflect.lowValueFilter.enabled`; the
   * standalone `akm reflect` command leaves it off. (Previously read from a
   * hardcoded `profiles.improve.default` path that ignored the active profile.)
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
   * When true, run the full LLM pipeline but skip persisting the proposal.
   * Used by the self-consistency sampling loop in `akm improve` to collect
   * N candidate proposals before voting — only the winner is persisted by
   * the caller (R-2 / #389, arXiv:2203.11171).
   */
  draftMode?: boolean;
  /**
   * v2 test seam: pre-resolved RunnerSpec injected by tests to exercise the
   * llm/sdk/agent dispatch paths without real config. When set, skips
   * config-based runner resolution entirely.
   */
  runner?: RunnerSpec;
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
   * Attribution tagging: which eligibility lane (`signal-delta`, `high-retrieval`,
   * `proactive`, `scope`) selected this asset for the current improve run. Set by
   * `akm improve`'s loop from the partitioned {@link ImproveEligibleRef}. Recorded
   * in `reflect_invoked` event metadata and persisted on the created proposal so
   * accept/reject/revert/retrieval outcomes can be sliced by lane. Omitted for
   * direct `akm reflect` invocations (no lane → downstream treats as `"unknown"`).
   */
  eligibilitySource?: EligibilitySource;
}

export interface AkmReflectFailure {
  schemaVersion: 1;
  ok: false;
  reason: AgentFailureReason;
  error: string;
  ref?: string;
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
}

export interface AkmReflectSuccess {
  schemaVersion: 1;
  ok: true;
  proposal: Proposal;
  ref: string;
  agentProfile: string;
  durationMs: number;
}

export type AkmReflectResult = AkmReflectSuccess | AkmReflectFailure;

const MAX_FEEDBACK_LINES = 10;
const MAX_GLOBAL_FEEDBACK_LINES = 20;

/**
 * Pull recent `feedback` events from events.jsonl. When `ref` is present we
 * scope to that asset; otherwise we surface the most recent feedback across
 * all assets so `akm reflect` can operate in a general "review recent
 * signals" mode. Best-effort — a missing or empty events stream returns `[]`.
 */
function readRecentFeedback(ref?: string): string[] {
  try {
    const result = readEvents({ type: "feedback", ...(ref ? { ref } : {}) });
    const lines: string[] = [];
    const limit = ref ? MAX_FEEDBACK_LINES : MAX_GLOBAL_FEEDBACK_LINES;
    for (const event of result.events.slice(-limit)) {
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

const MAX_REJECTED_PROPOSALS = 3;

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
        contentPreview: p.payload.content.slice(0, 500),
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
 * Returns `undefined` for the LLM HTTP runner — the chat-completion transport
 * has no filesystem access (see warning at `src/llm/call-ai.ts:64-71`).
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
  stash: string,
  ref: string,
  parsedRef: { type: string; name: string },
): Promise<RelatedLesson[]> {
  if (parsedRef.type !== "skill") return [];

  const related = new Map<string, RelatedLesson>();
  const derivedLessonRef = deriveLessonRef(ref);
  const candidateRefs = new Set<string>([derivedLessonRef]);
  const derivedLessonPath = path.join(stash, "lessons", `${derivedLessonRef.slice("lesson:".length)}.md`);
  if (fs.existsSync(derivedLessonPath)) {
    related.set(derivedLessonRef, { ref: derivedLessonRef, content: fs.readFileSync(derivedLessonPath, "utf8") });
  }

  try {
    const feedbackEvents = readEvents({ type: "distill_invoked", ref }).events;
    for (const event of feedbackEvents) {
      const lessonRef = typeof event.metadata?.lessonRef === "string" ? event.metadata.lessonRef : undefined;
      if (lessonRef?.startsWith("lesson:")) candidateRefs.add(lessonRef);
    }
  } catch {
    // Best effort only.
  }

  for (const candidateRef of candidateRefs) {
    try {
      const entry = await lookup(parseAssetRef(candidateRef));
      if (!entry?.filePath || !fs.existsSync(entry.filePath)) continue;
      const content = fs.readFileSync(entry.filePath, "utf8");
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
        const content = fs.readFileSync(path.join(lessonsDir, fileName), "utf8");
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
      ["duplicate_pending", "content_hash_match", "cooldown", "below_threshold"].includes(parsed.reason)
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
 * When `sdkMode === true`, structured output (tool-call schema) should be used
 * instead of this fallback. That wiring is tracked separately (full SDK
 * structured-output integration); for now this tighter parser applies to all
 * modes and is the primary R-6 deliverable.
 */
function fallbackPayloadFromRawContent(stdout: string, ref: string | undefined, sdkMode = false) {
  if (!ref) return undefined;
  const trimmed = stripMarkdownFences(stdout).trim();
  if (!trimmed) return undefined;
  const targetType = ref.split(":")[0];
  if (!looksLikeAssetContent(trimmed, sdkMode, targetType)) return undefined;
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
 * - In SDK mode (`sdkMode === true`): additionally requires `when_to_use:` for
 *   lesson types (full structured output will replace this in a future PR).
 */
function looksLikeAssetContent(value: string, sdkMode = false, targetType?: string): boolean {
  if (value.startsWith("---")) {
    // YAML frontmatter must contain at least a description field.
    const fmEnd = value.indexOf("\n---", 4);
    if (fmEnd === -1) return false;
    const fmBlock = value.slice(0, fmEnd + 4);
    const hasDescription = /^description\s*:/m.test(fmBlock);
    if (!hasDescription) return false;
    // In SDK mode, lesson assets additionally require a when_to_use field.
    // Use the target ref type rather than frontmatter type: (which is non-standard).
    if (sdkMode && targetType === "lesson") {
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
        "Optional self-reported quality confidence in [0, 1]. Proposals with confidence >= the active threshold (default 0.8) may be auto-accepted by `akm improve`.",
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
  timeoutMs?: number;
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
  chat?: (config: LlmConnectionConfig, messages: ChatMessage[]) => Promise<string>;
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
   * Mirrors the warning at `src/llm/call-ai.ts:64-71`.
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
    let stdout: string;
    if (opts.chat) {
      // Test seam: injected chat function (two-arg signature, no responseSchema).
      stdout = await opts.chat(opts.connection, messages);
    } else {
      // Production path: full chatCompletion with optional structured-output schema
      // and optional hard max_tokens cap (derived from source body size).
      stdout = await chatCompletion(opts.connection, messages, {
        ...(opts.responseSchema !== undefined ? { responseSchema: opts.responseSchema } : {}),
        ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      });
    }
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
  fallbackReason: AgentFailureReason = "non_zero_exit",
): AkmReflectFailure {
  return {
    ...baseFailureFields(result, fallbackReason),
    ...(ref ? { ref } : {}),
  };
}

export async function akmReflect(options: AkmReflectOptions = {}): Promise<AkmReflectResult> {
  const stash = options.stashDir ?? resolveStashDir();

  // 1. Always emit `reflect_invoked` at command entry — observers see the
  // attempt regardless of downstream success/failure.
  appendEvent({
    eventType: "reflect_invoked",
    ...(options.ref ? { ref: options.ref } : {}),
    metadata: {
      ...(options.task ? { task: options.task } : {}),
      ...(options.profile ? { profile: options.profile } : {}),
      // Attribution tagging: stamp the eligibility lane so reflect_invoked can be
      // sliced by lane downstream. See EligibilitySource.
      ...(options.eligibilitySource ? { eligibilitySource: options.eligibilitySource } : {}),
    },
  });

  // Fix #3 (observability 0.8.0): every failure path below MUST emit
  // `reflect_completed` so observers can close the invoke/complete loop. The
  // three success-side `reflect_completed` emit sites carry rich metadata
  // (qualityRejected, sanitized, proposalId, etc.); the failure-side emits
  // carry `{ok: false, reason}` plus the ref when known. Stable failure
  // reasons line up with `AgentFailureReason`: "parse_error", "non_zero_exit",
  // "cooldown", "timeout", "spawn_failed", "llm_*", plus the synthetic
  // "ref_mismatch" / "enoent" / "draft_missing" subtypes for cases the agent
  // surface conflates as "parse_error". Sub-reasons land in `subreason`.
  const emitReflectFailed = (
    reason: AgentFailureReason,
    subreason: string,
    ref?: string,
    extra?: Record<string, unknown>,
  ): void => {
    appendEvent({
      eventType: "reflect_completed",
      ...(ref ? { ref } : {}),
      metadata: {
        source: "reflect",
        ok: false,
        reason,
        subreason,
        ...(extra ?? {}),
      },
    });
  };

  // 2. Resolve target asset content (if a ref is supplied).
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
        schemaVersion: 1,
        ok: false,
        reason: "unsupported_type" as AgentFailureReason,
        error: `Reflect refused: asset type "${parsedRef.type}" is not supported by reflect (only markdown-canonical types are allowed: ${[...REFLECT_ALLOWED_TYPES].sort().join(", ")}). Use \`akm propose\` or edit the file directly.`,
        ref: options.ref,
        exitCode: null,
      };
    }

    if (options.assetContent !== undefined) {
      // Test seam — caller pre-loaded the source content.
      assetContent = options.assetContent;
    } else {
      try {
        const entry = await lookup(parsedRef);
        if (entry?.filePath && fs.existsSync(entry.filePath)) {
          assetContent = fs.readFileSync(entry.filePath, "utf8");
        }
      } catch {
        // Index miss is non-fatal — the agent can still propose a fresh asset.
      }
    }
  }

  // 3. Resolve agent profile. ConfigError surfaces as a thrown error so the
  // CLI dispatcher renders the standard envelope.
  //
  // When an explicit --profile flag is given, honour it directly (existing
  // behaviour). Otherwise use resolveProcessAgentProfile so that per-process
  // agent config (agent.processes["reflect"]) is picked up automatically.
  let profile: AgentProfile | undefined;
  let resolvedTimeoutMs: number | null | undefined = options.timeoutMs;
  let runnerSpec: RunnerSpec | undefined;
  try {
    if (options.agentProfile) {
      // Test seam: injected profile bypasses all config.
      profile = options.agentProfile;
    } else if (options.runner) {
      // Caller-provided RunnerSpec (used in tests and --dry-run-resolve).
      runnerSpec = options.runner;
    } else {
      const cfg = options.config ?? loadConfig();
      const reflectProcess = getImproveProcessConfig(cfg, "reflect");
      // Resolve the runner from the improve profile's reflect entry when present.
      runnerSpec = resolveImproveProcessRunnerFromProfile(reflectProcess, cfg) ?? undefined;
      if (runnerSpec) {
        if (resolvedTimeoutMs === undefined && runnerSpec.timeoutMs !== undefined) {
          resolvedTimeoutMs = runnerSpec.timeoutMs;
        }
      } else {
        if (options.profile) {
          // Explicit --profile flag wins over process config.
          profile = resolveAgentProfile(options);
        } else {
          // Use per-process config resolution (falls back to defaults.agent).
          const agent = options.agentConfig ?? loadAgentConfigFromDisk();
          const processName = options.agentProcess ?? "reflect";
          const resolved = resolveProcessAgentProfile(processName, agent);
          profile = resolved.profile;
          // Only apply process-resolved timeoutMs when caller didn't supply one.
          if (resolvedTimeoutMs === undefined) {
            resolvedTimeoutMs = resolved.timeoutMs;
          }
        }
      }
    }
  } catch (err) {
    if (err instanceof ConfigError || err instanceof UsageError) throw err;
    throw err;
  }
  // Ensure profile is set for agent/sdk runners that don't use runnerSpec
  if (!runnerSpec && !profile) {
    const agent = options.agentConfig ?? loadAgentConfigFromDisk();
    profile = resolveAgentProfile({ ...options, agentConfig: agent });
  }

  // Derive a display name for logging — either from the resolved profile or the runnerSpec.
  const resolvedProfileName: string =
    profile?.name ??
    (runnerSpec && runnerIsLlm(runnerSpec)
      ? `llm:${runnerSpec.connection.model}`
      : runnerSpec
        ? `${runnerSpec.kind}:${runnerSpec.profile.name ?? "unknown"}`
        : "unknown");

  // 4. Build the shared prompt inputs — feedback, hints, lessons, rejected
  // proposals. These are stable across refinement iterations; only the
  // `priorDraft` field changes per-iteration (R-1 / #372).
  const feedback = readRecentFeedback(options.ref);
  const schemaHints = buildSchemaHints(parsedRef?.type ?? "", assetContent);
  const relatedLessons = options.ref && parsedRef ? await readRelatedLessons(stash, options.ref, parsedRef) : [];
  // Reflexion-style verbal-RL: inject rejected proposals so the agent avoids
  // reproducing proposals that have already been reviewed and refused.
  const rejectedProposals = readRejectedProposals(stash, options.ref);
  // Standards "rulebook" for this target — wiki schema (wiki page) or stash
  // convention/meta facts (non-wiki asset); empty when neither fires.
  const standardsContext = resolveStandardsContext(options.ref, stash);

  // 5. Spawn the agent — with optional Self-Refine loop (R-1 / #372).
  //
  // maxRefineIters controls how many agent invocations are made:
  //   - 1 (default): single-shot, same as pre-R-1 behaviour
  //   - 2–3: on each subsequent pass, the prior draft is injected back into
  //     the prompt as Self-Refine critique context (arXiv:2303.17651)
  //
  // The loop exits early when the agent returns the same content as before
  // (no-op refinement) to avoid wasting tokens on identical iterations.
  const MAX_REFINE_ITERS = 3;
  const maxRefineIters = Math.min(Math.max(1, options.maxRefineIters ?? 1), MAX_REFINE_ITERS);
  const agentEnv: Record<string, string> = options.eventSource === "improve" ? { AKM_EVENT_SOURCE: "improve" } : {};

  // Determine whether this dispatch can honour the file-write contract.
  // Agent CLI + OpenCode SDK runners both have filesystem access; the direct
  // LLM HTTP runner does NOT (see `src/llm/call-ai.ts:64-71`). The v1
  // `profile.sdkMode` fallback also runs the SDK so it counts as file-writable.
  // Test seams (`options.runAgentOptions.spawn`) emulate agent CLI behaviour so
  // they participate as well — tests opt out by simply not writing the file.
  const canRunnerWriteFile = runnerSpec ? runnerSupportsFileWrite(runnerSpec) : true;

  // Initialized to a sentinel; always overwritten in the first loop iteration
  // (maxRefineIters is clamped to >= 1 above). TypeScript cannot prove a
  // for-loop always runs at least once, so we use a type assertion here.
  let result = {} as AgentRunResult;
  let priorDraft: string | undefined;
  // Track every draft file path we synthesize so cleanup can remove them on
  // every return path (success and failure). Mirrors propose's unlink pattern
  // in `src/commands/propose.ts:215-226` but generalised to N refinement
  // iterations. Always called via {@link cleanupDrafts} below.
  const draftPathsToCleanup: string[] = [];
  // Last iteration's draft path — read back if the agent wrote it.
  let lastDraftPath: string | undefined;

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

  // `payload` is populated inside the try (either by reading the draft file
  // or parsing stdout JSON). Hoisted here so the post-try sections (R-3 ref
  // guard, quality gate, sanitizer, createProposal) can use it after the
  // drafts have been cleaned up.
  let payload: ReturnType<typeof parseAgentProposalPayload>;
  try {
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

      let iterResult: AgentRunResult;
      if (options.runAgentOptions?.spawn) {
        // Test seam: use raw runAgent with injected spawn so tests remain deterministic.
        const resolvedProfile = profile;
        if (!resolvedProfile) {
          throw new Error("internal: reflect test-seam path requires a resolved agent profile");
        }
        const runOptions: RunAgentOptions = {
          stdio: "captured",
          parseOutput: "text",
          ...(resolvedTimeoutMs !== undefined ? { timeoutMs: resolvedTimeoutMs } : {}),
          ...(Object.keys(agentEnv).length > 0 ? { env: agentEnv } : {}),
          ...(options.runAgentOptions ?? {}),
        };
        iterResult = await runAgent(resolvedProfile, prompt, runOptions);
      } else if (runnerSpec) {
        // v2: dispatch through the unified RunnerSpec seam (X3). The `agent` /
        // `sdk` arms route to the default profile runners; the `llm` arm is
        // reflect-specific (wraps `runReflectViaLlm` — its bespoke iteration
        // shape) so it is supplied as the `llm` handler.
        const runOptions: RunAgentOptions = {
          stdio: "captured",
          parseOutput: "text",
          ...(Object.keys(agentEnv).length > 0 ? { env: agentEnv } : {}),
        };
        iterResult = await executeRunner(runnerSpec, prompt ?? "", runOptions, {
          llm: async (spec) =>
            // LLM HTTP path — `draftFilePath` is accepted for type symmetry
            // (see `RunReflectViaLlmOptions.draftFilePath` docstring) but is
            // intentionally a no-op. The prompt builder above also did not
            // include the file-write contract for this kind, so the LLM is
            // still asked for JSON via stdout.
            runReflectViaLlm({
              prompt,
              connection: spec.connection,
              timeoutMs: spec.timeoutMs ?? (typeof resolvedTimeoutMs === "number" ? resolvedTimeoutMs : undefined),
              priorDraft,
              iteration: iter,
              responseSchema: REFLECT_JSON_SCHEMA,
              chat: options.chat,
              ...(maxTokensForLlm !== undefined ? { maxTokens: maxTokensForLlm } : {}),
            }),
          // The `agent` arm (and only the agent arm — preserving prior behavior)
          // overlays `spec.timeoutMs` onto the base run options.
          runAgent: (profile, p, opts) =>
            runAgent(profile, p, {
              ...opts,
              ...(runnerSpec.timeoutMs !== undefined ? { timeoutMs: runnerSpec.timeoutMs } : {}),
            }),
        });
      } else {
        // Production path (v1): dispatch directly to the appropriate runner.
        // The fallback at the end of step 3 guarantees `profile` is set whenever
        // `runnerSpec` is undefined, but TS can't prove that across the loop +
        // await boundary — narrow into a const.
        const resolvedProfile = profile;
        if (!resolvedProfile) {
          throw new Error("internal: reflect v1 dispatch reached without a resolved agent profile or runnerSpec");
        }
        const runOptions: RunAgentOptions = {
          stdio: "captured",
          parseOutput: "text",
          ...(resolvedTimeoutMs !== undefined ? { timeoutMs: resolvedTimeoutMs } : {}),
          ...(Object.keys(agentEnv).length > 0 ? { env: agentEnv } : {}),
        };
        iterResult = resolvedProfile.sdkMode
          ? await runOpencodeSdk(resolvedProfile, prompt ?? "", runOptions)
          : await runAgent(resolvedProfile, prompt, runOptions);
      }

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

    const finalResult: AgentRunResult = result;

    if (!finalResult.ok) {
      // B3: ENOENT / not-found gives an actionable hint.
      if (isEnoentFailure(finalResult)) {
        emitReflectFailed("spawn_failed", "enoent", options.ref, {
          ...(finalResult.exitCode !== undefined ? { exitCode: finalResult.exitCode } : {}),
        });
        return {
          ...failureEnvelope(finalResult, options.ref),
          error: enoentHintMessage(profile?.bin ?? resolvedProfileName),
        };
      }
      const envelope = failureEnvelope(finalResult, options.ref);
      emitReflectFailed(envelope.reason, "agent_crash", options.ref, {
        ...(envelope.exitCode !== null ? { exitCode: envelope.exitCode } : {}),
      });
      return envelope;
    }

    // Re-alias to `result` for the downstream code that references it.
    result = finalResult;

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
        schemaVersion: 1,
        ok: false,
        reason: "parse_error",
        error: `Agent emitted DRAFT_WRITTEN but draft file is missing or empty (${lastDraftPath}). The file-write contract failed; either the agent's file tools are broken or the path was unwritable.`,
        ...(options.ref ? { ref: options.ref } : {}),
        exitCode: result.exitCode,
        stdout: result.stdout,
        ...(result.stderr ? { stderr: result.stderr } : {}),
      };
    }

    if (draftFileExists && lastDraftPath) {
      // Happy path: agent wrote the body to disk. Use the ref the caller
      // supplied (or a placeholder when omitted — the R-3 ref-mismatch guard
      // below has no effect when there is no expected ref).
      const fileContent = fs.readFileSync(lastDraftPath, "utf8");
      // Phase 6A: file-write contract carries self-rated confidence on the
      // `DRAFT_WRITTEN confidence=<n>` sentinel line. Extract it so the
      // file-write path is on equal footing with the JSON-stdout path for
      // auto-accept gating in `akm improve`.
      const draftConfidence = extractDraftConfidence(result.stdout);
      payload = {
        ref: options.ref ?? "",
        content: fileContent,
        ...(draftConfidence !== undefined ? { confidence: draftConfidence } : {}),
      };
      // The agent followed the file-write contract — `payload.ref` mirrors the
      // caller's expected ref, so the R-3 guard below cannot fire. The agent
      // had no opportunity to retarget the proposal. If the ref was omitted
      // entirely, downstream `createProposal` will reject the empty ref.
    } else {
      try {
        payload = parseAgentProposalPayload(result.stdout ?? "");
      } catch (err) {
        const fallback = fallbackPayloadFromRawContent(result.stdout ?? "", options.ref, profile?.sdkMode ?? false);
        if (fallback) {
          payload = fallback;
        } else {
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
            schemaVersion: 1,
            ok: false,
            reason,
            error: err instanceof Error ? err.message : String(err),
            ...(options.ref ? { ref: options.ref } : {}),
            exitCode: result.exitCode,
            stdout: result.stdout,
            ...(result.stderr ? { stderr: result.stderr } : {}),
          };
        }
      }
    }
  } finally {
    // Always remove tmp draft files — success, failure, or exception. Returns
    // inside the try above trigger this block before the function exits. Code
    // after this point uses the already-loaded `payload` and never touches the
    // draft paths.
    cleanupDrafts();
  }

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
          schemaVersion: 1,
          ok: false,
          reason: "parse_error" as const,
          error: `Agent retargeted proposal: expected ref "${options.ref}" but got "${payload.ref}". Proposal rejected to prevent silent ref hallucination.`,
          ref: options.ref,
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

  // 7. R-5 / #374: Apply the proposal quality gate when enabled.
  // Mirrors the lesson quality gate on distill proposals. The gate uses
  // `runLessonQualityJudge` from distill.ts and is gated behind either
  // `profiles.improve.default.processes.reflect.qualityGate.enabled` or
  // `profiles.improve.default.processes.distill.qualityGate.enabled` (the
  // `lesson_quality_gate` flag name is the legacy alias still accepted by
  // `isLlmFeatureEnabled`). Fail-open: any judge error passes through.
  // G-Eval (arXiv:2303.16634) — quality judgment before admission.
  const runtimeConfig =
    options.config ??
    (() => {
      try {
        return loadConfig();
      } catch {
        return undefined;
      }
    })();
  const chatFn = options.chat ?? chatCompletion;
  const qualityGateEnabled =
    isLlmFeatureEnabled(runtimeConfig, "proposal_quality_gate") ||
    isLlmFeatureEnabled(runtimeConfig, "lesson_quality_gate");

  if (qualityGateEnabled && runtimeConfig) {
    const assetContent: string | null = (() => {
      if (!options.ref) return null;
      try {
        const refParsed = parseAssetRef(options.ref);
        const candidates = [
          path.join(stash, `${refParsed.type}s`, `${refParsed.name}.md`),
          path.join(stash, `${refParsed.type}s`, refParsed.name, "index.md"),
        ];
        for (const p of candidates) {
          if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
        }
        return null;
      } catch {
        return null;
      }
    })();

    const judgeResult = await runLessonQualityJudge(runtimeConfig, payload.content, assetContent ?? "", chatFn);
    if (!judgeResult.pass) {
      // Quality gate rejected the proposal — surface as parse_error so the
      // improve orchestrator can log it and move on without crashing.
      appendEvent({
        eventType: "reflect_completed",
        ref: payload.ref,
        metadata: {
          source: "reflect",
          qualityRejected: true,
          qualityScore: judgeResult.score,
          qualityReason: judgeResult.reason,
        },
      });
      return {
        schemaVersion: 1,
        ok: false,
        reason: "parse_error" as const,
        error: `Reflect proposal quality gate rejected: score=${judgeResult.score}, reason="${judgeResult.reason}"`,
        ...(options.ref ? { ref: options.ref } : {}),
        exitCode: result.exitCode,
      };
    }
  }

  // 7b. Reflect content-preservation rails:
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
    appendEvent({
      eventType: "reflect_completed",
      ref: payload.ref,
      metadata: {
        source: "reflect",
        sanitized: true,
        rejected: true,
        rejectReason: sanitizeOutcome.reject.error,
        ...(sanitizeOutcome.warnings.length > 0 ? { sanitizerWarnings: sanitizeOutcome.warnings } : {}),
      },
    });
    return {
      schemaVersion: 1,
      ok: false,
      reason: sanitizeOutcome.reject.reason,
      error: sanitizeOutcome.reject.error,
      ...(options.ref ? { ref: options.ref } : {}),
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
  // Pure deterministic text comparison — see `reflect-noise.ts`. Runs before
  // the draftMode branch so self-consistency sampling never votes a no-op
  // candidate into the queue either. Skipped when there is no source asset
  // (new-asset proposals have nothing to diff against).
  if (assetContent !== undefined) {
    const changeKind = classifyReflectChange(assetContent, payload.content);
    // 'low-value' is config-gated (#639). DEFAULT OFF — absent = byte-identical
    // pre-#639 behaviour (low-value treated the same as substantive). Resolved
    // by the caller from the ACTIVE improve profile's
    // `processes.reflect.lowValueFilter.enabled` and passed via options, so the
    // running profile (not a hardcoded `profiles.improve.default`) decides.
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
        schemaVersion: 1,
        ok: false,
        reason: "no_change" as const,
        error:
          changeKind === "noop"
            ? `Reflect skipped: proposed content for ${payload.ref} is identical to the current asset (empty diff); no proposal created.`
            : changeKind === "low-value"
              ? `Reflect skipped: proposed content for ${payload.ref} is a low-value prose micro-rewrite (few changed tokens, no structural changes); no proposal created.`
              : `Reflect skipped: proposed content for ${payload.ref} is a cosmetic-only reformat of the current asset (whitespace/fence/YAML-folding changes); no proposal created.`,
        ...(options.ref ? { ref: options.ref } : {}),
        exitCode: result.exitCode,
      };
    }
  }

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

  // Draft mode: skip DB persistence — the SC sampling loop in improve.ts persists
  // only the majority-vote winner (R-2 / #389). Return a synthetic proposal so
  // pickMajorityVote can compare content via Jaccard similarity.
  if (options.draftMode) {
    const draftProposal: Proposal = {
      id: `sc-draft-${Date.now()}`,
      ref: payload.ref,
      source: "reflect",
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      payload: {
        content: payload.content,
        ...(Object.keys(payloadFrontmatterWithProvenance).length > 0
          ? { frontmatter: payloadFrontmatterWithProvenance }
          : {}),
      },
      // Phase 6A: preserve confidence on the synthetic draft so the SC majority
      // winner carries the score through to the persisted proposal.
      ...(typeof payload.confidence === "number" ? { confidence: payload.confidence } : {}),
    };
    return {
      schemaVersion: 1,
      ok: true,
      proposal: draftProposal,
      ref: draftProposal.ref,
      agentProfile: resolvedProfileName,
      durationMs: result.durationMs,
    };
  }

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
  };
  const proposalResult = createProposal(stash, createInput, options.ctx);

  if (isProposalSkipped(proposalResult)) {
    // Dedup/cooldown guard fired — surface as a "cooldown" reason (not "parse_error")
    // so the improve orchestrator can distinguish legitimate skips from real failures
    // and exclude them from recentErrors/avoidPatterns injection.
    emitReflectFailed("cooldown", "proposal_skipped", options.ref, {
      proposalSkipReason: proposalResult.reason,
    });
    return {
      schemaVersion: 1,
      ok: false,
      reason: "cooldown" as const,
      error: `Proposal skipped (${proposalResult.reason}): ${proposalResult.message}`,
      ...(options.ref ? { ref: options.ref } : {}),
      exitCode: null,
    };
  }

  const proposal: Proposal = proposalResult;

  appendEvent({
    eventType: "reflect_completed",
    ref: proposal.ref,
    metadata: {
      proposalId: proposal.id,
      source: "reflect",
      agentProfile: resolvedProfileName,
    },
  });

  return {
    schemaVersion: 1,
    ok: true,
    proposal,
    ref: proposal.ref,
    agentProfile: resolvedProfileName,
    durationMs: result.durationMs,
  };
}
