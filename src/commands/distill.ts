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
import { parseAssetRef } from "../core/asset-ref";
import { resolveStashDir } from "../core/common";
import type { AkmConfig, LlmConnectionConfig } from "../core/config";
import { loadConfig } from "../core/config";
import { ConfigError, UsageError } from "../core/errors";
import { appendEvent, readEvents } from "../core/events";
import { parseFrontmatter } from "../core/frontmatter";
import { lintLessonContent } from "../core/lesson-lint";
import { createProposal, type Proposal, type ProposalsContext } from "../core/proposals";
import { lookup as indexerLookup } from "../indexer/indexer";
import { type ChatMessage, chatCompletion } from "../llm/client";
import { tryLlmFeature } from "../llm/feature-gate";

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
export type DistillOutcome = "queued" | "skipped" | "validation_failed";

export interface AkmDistillOptions {
  /** Asset ref to distil from (`[origin//]type:name`). */
  ref: string;
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
}

export interface AkmDistillResult {
  schemaVersion: 1;
  ok: boolean;
  outcome: DistillOutcome;
  /** Original input ref (verbatim). */
  inputRef: string;
  /** Proposed lesson ref (always present, even when skipped — useful for UX). */
  lessonRef: string;
  /** Proposal id when `outcome === "queued"`. */
  proposalId?: string;
  /** Human-readable hint surfaced when the call was skipped. */
  message?: string;
  /** Validation findings when `outcome === "validation_failed"`. */
  findings?: { kind: string; field: string; message: string }[];
  /** The full proposal object when `outcome === "queued"`. */
  proposal?: Proposal;
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

// ── Prompt assembly ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = [
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

interface BuildPromptInput {
  inputRef: string;
  assetContent: string | null;
  feedback: { ts: string; eventType: string; metadata?: Record<string, unknown> }[];
}

/** Pure: build the user-prompt body. Exported for tests. */
export function buildDistillPrompt(input: BuildPromptInput): string {
  const lines: string[] = [];
  lines.push(`Asset ref: ${input.inputRef}`);
  lines.push("");
  lines.push("Asset content:");
  if (input.assetContent) {
    lines.push("```");
    lines.push(input.assetContent.trim());
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
  lines.push("Produce the lesson markdown file now.");
  return lines.join("\n");
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
  const lessonRef = deriveLessonRef(inputRef);

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

  const { events } = readEventsImpl({ ref: inputRef, type: "feedback" });
  const feedback = events.slice(-20).map((e) => ({
    ts: e.ts,
    eventType: e.eventType,
    ...(e.metadata !== undefined ? { metadata: e.metadata } : {}),
  }));

  const userPrompt = buildDistillPrompt({ inputRef, assetContent, feedback });
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
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
  );

  if (raw === null || raw.trim() === "") {
    appendEvent({
      eventType: "distill_invoked",
      ref: inputRef,
      metadata: { outcome: "skipped", lessonRef },
    });
    return {
      schemaVersion: 1,
      ok: true,
      outcome: "skipped",
      inputRef,
      lessonRef,
      message: "feedback distillation is disabled or the LLM call failed; no proposal created.",
    };
  }

  // Strip any stray fence the LLM might have added around the markdown.
  const content = stripMarkdownFences(raw);

  // Parse + lint the lesson before creating the proposal. The lint is the
  // canonical gate for required frontmatter (v1 spec §13). On failure we
  // surface a structured error and exit non-zero — but still emit
  // `distill_invoked` so the failure is observable.
  const lintReport = lintLessonContent(content, `distill:${inputRef}`);
  if (lintReport.findings.length > 0) {
    appendEvent({
      eventType: "distill_invoked",
      ref: inputRef,
      metadata: {
        outcome: "validation_failed",
        lessonRef,
        findingKinds: lintReport.findings.map((f) => f.kind),
      },
    });
    const message = lintReport.findings.map((f) => f.message).join("\n");
    throw new UsageError(
      `Distilled lesson failed validation:\n${message}`,
      "MISSING_REQUIRED_ARGUMENT",
      "Lessons require non-empty `description` and `when_to_use` frontmatter fields. See v1 spec §13.",
    );
  }

  // Round-trip the parsed frontmatter so the proposal carries it as a
  // structured payload alongside the raw content (matches the shape used by
  // other proposal sources).
  const parsed = parseFrontmatter(content);
  const proposal = createProposal(
    stash,
    {
      ref: lessonRef,
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
      outcome: "queued",
      lessonRef,
      proposalId: proposal.id,
      ...(options.sourceRun !== undefined ? { sourceRun: options.sourceRun } : {}),
    },
  });

  return {
    schemaVersion: 1,
    ok: true,
    outcome: "queued",
    inputRef,
    lessonRef,
    proposalId: proposal.id,
    proposal,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function defaultLookup(ref: string): Promise<string | null> {
  try {
    const entry = await indexerLookup(parseAssetRef(ref));
    return entry?.filePath ?? null;
  } catch {
    return null;
  }
}

/** Best-effort fence stripping. Keeps the body intact when no fence is present. */
function stripMarkdownFences(raw: string): string {
  const trimmed = raw.trim();
  // Only strip outer triple-fence pairs — leave inner code blocks alone.
  const fence = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (fence) return fence[1].trim();
  return trimmed;
}
