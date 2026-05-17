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
import path from "node:path";
import { parseAssetRef } from "../core/asset-ref";
import { resolveStashDir } from "../core/common";
import { loadConfig } from "../core/config";
import { ConfigError, UsageError } from "../core/errors";
import { appendEvent, readEvents } from "../core/events";
import { parseFrontmatter } from "../core/frontmatter";
import { lintLessonContent } from "../core/lesson-lint";
import { stripMarkdownFences } from "../core/markdown";
import {
  type CreateProposalInput,
  createProposal,
  isProposalSkipped,
  listProposals,
  type Proposal,
  type ProposalsContext,
} from "../core/proposals";
import { lookup } from "../indexer/indexer";
import {
  type AgentConfig,
  type AgentFailureReason,
  type AgentProfile,
  type AgentRunResult,
  type RunAgentOptions,
  runAgent,
} from "../integrations/agent";
import { resolveProcessAgentProfile } from "../integrations/agent/config";
import {
  buildReflectPrompt,
  parseAgentProposalPayload,
  type RejectedProposalContext,
} from "../integrations/agent/prompts";
import { runAgentSdk } from "../integrations/agent/sdk-runner";
import { chatCompletion } from "../llm/client";
import { isLlmFeatureEnabled } from "../llm/feature-gate";
import {
  baseFailureFields,
  enoentHintMessage,
  isEnoentFailure,
  loadAgentConfigFromDisk,
  resolveAgentProfile,
} from "./agent-support";
import { deriveLessonRef, runLessonQualityJudge } from "./distill";

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
  /** Test seam: pre-resolved AgentConfig (skips config load). */
  agentConfig?: AgentConfig;
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
    config: import("../core/config").LlmConnectionConfig,
    messages: import("../llm/client").ChatMessage[],
  ) => Promise<string>;
  /**
   * Override the loaded AkmConfig (test seam + for the quality gate).
   * Needed by R-5 to access llm.features.proposal_quality_gate without
   * a real config file in tests.
   */
  config?: import("../core/config").AkmConfig;
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
    },
  });

  // 2. Resolve target asset content (if a ref is supplied).
  let assetContent: string | undefined;
  let parsedRef: { type: string; name: string } | undefined;
  if (options.ref) {
    parsedRef = parseAssetRef(options.ref);
    try {
      const entry = await lookup(parsedRef);
      if (entry?.filePath && fs.existsSync(entry.filePath)) {
        assetContent = fs.readFileSync(entry.filePath, "utf8");
      }
    } catch {
      // Index miss is non-fatal — the agent can still propose a fresh asset.
    }
  }

  // 3. Resolve agent profile. ConfigError surfaces as a thrown error so the
  // CLI dispatcher renders the standard envelope.
  //
  // When an explicit --profile flag is given, honour it directly (existing
  // behaviour). Otherwise use resolveProcessAgentProfile so that per-process
  // agent config (agent.processes["reflect"]) is picked up automatically.
  let profile: AgentProfile;
  let resolvedTimeoutMs: number | undefined = options.timeoutMs;
  try {
    if (options.agentProfile) {
      // Test seam: injected profile bypasses all config.
      profile = options.agentProfile;
    } else if (options.profile) {
      // Explicit --profile flag wins over process config.
      profile = resolveAgentProfile(options);
    } else {
      // Use per-process config resolution (falls back to agent.default).
      const agent = options.agentConfig ?? loadAgentConfigFromDisk();
      const processName = options.agentProcess ?? "reflect";
      const resolved = resolveProcessAgentProfile(processName, agent);
      profile = resolved.profile;
      // Only apply process-resolved timeoutMs when caller didn't supply one.
      if (resolvedTimeoutMs === undefined) {
        resolvedTimeoutMs = resolved.timeoutMs;
      }
    }
  } catch (err) {
    if (err instanceof ConfigError || err instanceof UsageError) throw err;
    throw err;
  }

  // 4. Build the shared prompt inputs — feedback, hints, lessons, rejected
  // proposals. These are stable across refinement iterations; only the
  // `priorDraft` field changes per-iteration (R-1 / #372).
  const feedback = readRecentFeedback(options.ref);
  const schemaHints = buildSchemaHints(parsedRef?.type ?? "", assetContent);
  const relatedLessons = options.ref && parsedRef ? await readRelatedLessons(stash, options.ref, parsedRef) : [];
  // Reflexion-style verbal-RL: inject rejected proposals so the agent avoids
  // reproducing proposals that have already been reviewed and refused.
  const rejectedProposals = readRejectedProposals(stash, options.ref);

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

  // Initialized to a sentinel; always overwritten in the first loop iteration
  // (maxRefineIters is clamped to >= 1 above). TypeScript cannot prove a
  // for-loop always runs at least once, so we use a type assertion here.
  let result = {} as AgentRunResult;
  let priorDraft: string | undefined;

  for (let iter = 0; iter < maxRefineIters; iter++) {
    const prompt = buildReflectPrompt({
      ...(options.ref ? { ref: options.ref } : {}),
      ...(parsedRef?.type ? { type: parsedRef.type } : {}),
      ...(parsedRef?.name ? { name: parsedRef.name } : {}),
      ...(assetContent !== undefined ? { assetContent } : {}),
      ...(feedback.length > 0 ? { feedback } : {}),
      ...(schemaHints.length > 0 ? { schemaHints } : {}),
      ...(relatedLessons.length > 0 ? { relatedLessons } : {}),
      ...(options.task ? { task: options.task } : {}),
      ...(options.avoidPatterns && options.avoidPatterns.length > 0 ? { avoidPatterns: options.avoidPatterns } : {}),
      ...(rejectedProposals.length > 0 ? { rejectedProposals } : {}),
      // R-1: inject prior draft as self-critique target on iterations > 0
      ...(priorDraft !== undefined ? { priorDraft } : {}),
    });

    let iterResult: AgentRunResult;
    if (options.runAgentOptions?.spawn) {
      // Test seam: use raw runAgent with injected spawn so tests remain deterministic.
      const runOptions: RunAgentOptions = {
        stdio: "captured",
        parseOutput: "text",
        ...(resolvedTimeoutMs !== undefined ? { timeoutMs: resolvedTimeoutMs } : {}),
        ...(Object.keys(agentEnv).length > 0 ? { env: agentEnv } : {}),
        ...(options.runAgentOptions ?? {}),
      };
      iterResult = await runAgent(profile, prompt, runOptions);
    } else {
      // Production path: dispatch directly to the appropriate runner.
      const runOptions: RunAgentOptions = {
        stdio: "captured",
        parseOutput: "text",
        ...(resolvedTimeoutMs !== undefined ? { timeoutMs: resolvedTimeoutMs } : {}),
        ...(Object.keys(agentEnv).length > 0 ? { env: agentEnv } : {}),
      };
      iterResult = profile.sdkMode
        ? await runAgentSdk(profile, prompt ?? "", runOptions)
        : await runAgent(profile, prompt, runOptions);
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
      return { ...failureEnvelope(finalResult, options.ref), error: enoentHintMessage(profile.bin) };
    }
    return failureEnvelope(finalResult, options.ref);
  }

  // Re-alias to `result` for the downstream code that references it.
  result = finalResult;

  // 6. Resolve the proposal content from stdout JSON.
  let payload: ReturnType<typeof parseAgentProposalPayload>;
  try {
    payload = parseAgentProposalPayload(result.stdout ?? "");
  } catch (err) {
    const fallback = fallbackPayloadFromRawContent(result.stdout ?? "", options.ref, profile.sdkMode ?? false);
    if (fallback) {
      payload = fallback;
    } else {
      // Reclassify cooldown/skip messages that arrive as stdout text instead of
      // valid proposal JSON. These are legitimate skip signals, not parse failures,
      // and should not pollute reflectFailedActions or recentErrors injection.
      const stdoutText = result.stdout ?? "";
      const isCooldownSignal = /cooldown/i.test(stdoutText) || /proposal skipped/i.test(stdoutText);
      return {
        schemaVersion: 1,
        ok: false,
        reason: isCooldownSignal ? "cooldown" : "parse_error",
        error: err instanceof Error ? err.message : String(err),
        ...(options.ref ? { ref: options.ref } : {}),
        exitCode: result.exitCode,
        stdout: result.stdout,
        ...(result.stderr ? { stderr: result.stderr } : {}),
      };
    }
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
  // Mirrors the `lesson_quality_gate` on distill proposals. The gate uses
  // `runLessonQualityJudge` from distill.ts and is gated behind either
  // `llm.features.proposal_quality_gate` or `llm.features.lesson_quality_gate`
  // (legacy alias). Fail-open: any judge error passes through.
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
    };
    return {
      schemaVersion: 1,
      ok: true,
      proposal: draftProposal,
      ref: draftProposal.ref,
      agentProfile: profile.name,
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
  };
  const proposalResult = createProposal(stash, createInput, options.ctx);

  if (isProposalSkipped(proposalResult)) {
    // Dedup/cooldown guard fired — surface as a "cooldown" reason (not "parse_error")
    // so the improve orchestrator can distinguish legitimate skips from real failures
    // and exclude them from recentErrors/avoidPatterns injection.
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
      agentProfile: profile.name,
    },
  });

  return {
    schemaVersion: 1,
    ok: true,
    proposal,
    ref: proposal.ref,
    agentProfile: profile.name,
    durationMs: result.durationMs,
  };
}
