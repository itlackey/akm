// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Prompt + schema for `akm extract <session>`.
 *
 * Mirrors the REFLECT_JSON_SCHEMA pattern: a strict JSON Schema describing
 * the LLM output, plus a {@link buildExtractPrompt} helper that interpolates
 * session data into the markdown template loaded from
 * `src/assets/prompts/extract-session.md`.
 *
 * The schema is intentionally strict — providers with `supportsJsonSchema:
 * true` enforce shape upstream, so the parser only has to handle the
 * happy path. `additionalProperties: false` means any hallucinated keys
 * the model emits get dropped before we parse.
 */

import promptTemplate from "../../assets/prompts/extract-session.md" with { type: "text" };
import type { InlineRefMention, SessionData, SessionEvent } from "../../integrations/session-logs/types";

/**
 * JSON Schema for the structured extract output. Passed to `chatCompletion`
 * when the configured LLM connection has `supportsJsonSchema: true`.
 *
 * Shape:
 *   {
 *     "candidates": [{type, name, description, when_to_use?, body, confidence, evidence,
 *                     orderedActions?, outcomeData?}, ...],
 *     "rationale_if_empty"?: string
 *   }
 *
 * `additionalProperties: false` at each level so any hallucinated keys are
 * dropped before parsing.
 *
 * `orderedActions` and `outcomeData` are additive fields for #615 procedural
 * compilation (WS-0 data-capture hook). Source transcripts are external logs
 * not guaranteed re-extractable; we capture the ordered-action sequence and
 * outcome now even though the detection/compilation feature is deferred to 0.10+.
 */
export const EXTRACT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["candidates"],
  additionalProperties: false,
  properties: {
    candidates: {
      type: "array",
      description: "Zero or more durable-insight candidates extracted from the session.",
      items: {
        type: "object",
        required: ["type", "name", "description", "body", "confidence", "evidence"],
        additionalProperties: false,
        properties: {
          type: {
            type: "string",
            enum: ["memory", "lesson", "knowledge"],
            description: "Asset type the candidate would land as.",
          },
          name: {
            type: "string",
            description: "Kebab-case slug, optionally under one stable scope/domain segment.",
            pattern: "^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)?$",
          },
          description: {
            type: "string",
            minLength: 20,
            maxLength: 400,
            description:
              "One-sentence summary of the candidate. Must be a complete sentence in active voice. Do NOT start with 'When', 'If', 'How', 'Use', or 'Avoid'. Do NOT end with ':', ';', or ','. Do NOT use heading-fragment text ('Summary', 'Overview', 'Key finding:'). Minimum 20 characters, maximum 400 characters.",
          },
          when_to_use: {
            type: "string",
            minLength: 15,
            maxLength: 400,
            description: "Trigger sentence for the candidate; REQUIRED when type=lesson.",
          },
          body: {
            type: "string",
            minLength: 50,
            description: "Markdown body of the candidate asset.",
          },
          confidence: {
            type: "number",
            minimum: 0,
            maximum: 1,
            description: "Self-rated confidence in [0, 1] that this candidate is a real durable insight.",
          },
          evidence: {
            type: "string",
            minLength: 5,
            description: "One-line pointer to the moment in the session that supports this candidate.",
          },
          orderedActions: {
            type: "array",
            description:
              "OPTIONAL. Ordered list of discrete actions taken during this episode, as brief imperative phrases (e.g. 'run deploy.sh', 'check VPN status', 'retry with --force'). Capture only when the candidate represents a recurring action sequence that could become a skill or workflow. Omit when the candidate is a standalone fact or observation.",
            items: { type: "string", minLength: 3 },
            maxItems: 20,
          },
          outcomeData: {
            type: "string",
            description:
              "OPTIONAL. One-sentence description of the outcome when the ordered action sequence completed (e.g. 'deploy succeeded after VPN reconnect', 'build failed with error X'). Required when orderedActions is present; omit otherwise.",
            maxLength: 400,
          },
        },
      },
    },
    rationale_if_empty: {
      type: "string",
      minLength: 10,
      description: "Required when `candidates` is empty — explains why nothing rose to durable-insight level.",
    },
  },
};

export interface ExtractPromptInput {
  data: SessionData;
  /** Pre-filtered events (post-{@link preFilterSession}). */
  events: SessionEvent[];
  /** Inline refs the agent already preserved during the session. */
  inlineRefs: InlineRefMention[];
  /**
   * Stash authoring standards (convention/meta fact bodies). Extract output is
   * memories/lessons/knowledge (non-wiki). Empty/omitted when none exist;
   * rendered to an empty string in the template when absent.
   */
  standardsContext?: string;
}

/**
 * Format inline refs as a bullet list for the "Already preserved" section.
 * If empty, returns a sentinel string so the LLM knows the agent saved
 * nothing inline.
 */
function formatAlreadyPreserved(inlineRefs: InlineRefMention[]): string {
  if (inlineRefs.length === 0) {
    return "(none — the agent did not call `akm remember` or `akm feedback` during this session)";
  }
  return inlineRefs
    .map((ref) => {
      const prefix = ref.kind === "remember" ? "- remember:" : `- feedback ${ref.ref ?? "<ref>"}:`;
      const body = ref.text.trim().slice(0, 200);
      return `${prefix} ${body}${ref.text.length > 200 ? "…" : ""}`;
    })
    .join("\n");
}

/**
 * Delimiters that fence the untrusted session transcript in the extract prompt.
 * Mirrors the `=== ASSET N ===` convention (`graph-extract.ts`): everything
 * between the markers is DATA to analyze, never instructions to obey. The
 * transcript is external, attacker-influenceable content, so an explicit,
 * greppable boundary defuses prompt-injection that tries to pose as a command.
 */
export const TRANSCRIPT_FENCE_BEGIN = "=== BEGIN UNTRUSTED SESSION TRANSCRIPT ===";
export const TRANSCRIPT_FENCE_END = "=== END UNTRUSTED SESSION TRANSCRIPT ===";

/**
 * Format pre-filtered events as a transcript snippet. Each event becomes:
 *   [<role> @ <iso>] <text>
 * Events are already truncated/cleaned by the pre-filter; this is purely
 * a render step.
 *
 * Anti-spoof: any occurrence of the fence markers inside the transcript text is
 * neutralised so a crafted session cannot forge the boundary and "escape" the
 * fence to inject trusted-looking instructions.
 */
function formatTranscript(events: SessionEvent[]): string {
  if (events.length === 0) return "(empty — pre-filter removed all events as noise)";
  const body = events
    .map((e) => {
      const tsLabel = e.ts ? new Date(e.ts).toISOString() : "unknown-ts";
      const roleLabel = e.role ?? "unknown";
      return `[${roleLabel} @ ${tsLabel}] ${e.text}`;
    })
    .join("\n\n");
  return body.split(TRANSCRIPT_FENCE_BEGIN).join("=== (fence) ===").split(TRANSCRIPT_FENCE_END).join("=== (fence) ===");
}

/**
 * Build the user-prompt body for the extract LLM call by interpolating
 * session metadata, already-preserved refs, and the filtered transcript
 * into the template.
 */
export function buildExtractPrompt(input: ExtractPromptInput): string {
  const ref = input.data.ref;
  const startedAt = ref.startedAt ? new Date(ref.startedAt).toISOString() : "unknown";
  const endedAt = ref.endedAt ? new Date(ref.endedAt).toISOString() : "unknown";
  // Optional standards block — rendered to the lead-in + body when present,
  // or an empty string (no section) when absent. Gated on non-empty.
  const standards = input.standardsContext?.trim()
    ? `\n## Standards to follow (the rulebook for this target)\n\n${input.standardsContext.trim()}\n`
    : "";
  return promptTemplate
    .replace("{{HARNESS}}", ref.harness)
    .replace("{{TITLE}}", ref.title ?? "(no title)")
    .replace("{{STARTED_AT}}", startedAt)
    .replace("{{ENDED_AT}}", endedAt)
    .replace("{{PROJECT_HINT}}", ref.projectHint ?? "(no project hint)")
    .replace("{{ALREADY_PRESERVED}}", formatAlreadyPreserved(input.inlineRefs))
    .replace("{{STANDARDS}}", standards)
    .replace("{{TRANSCRIPT}}", `${TRANSCRIPT_FENCE_BEGIN}\n${formatTranscript(input.events)}\n${TRANSCRIPT_FENCE_END}`);
}

// ── Parser ──────────────────────────────────────────────────────────────────

export interface ExtractCandidate {
  type: "memory" | "lesson" | "knowledge";
  name: string;
  description: string;
  when_to_use?: string;
  body: string;
  confidence: number;
  evidence: string;
  /**
   * #615 procedural-compilation data-capture hook (WS-0).
   * Ordered list of discrete actions taken during this episode. Captured now
   * so the data survives even if source transcripts are not re-extractable
   * later. The detection/compilation feature itself is deferred to 0.10+.
   * Optional — only populated when the candidate represents an action sequence.
   */
  orderedActions?: string[];
  /**
   * #615 procedural-compilation data-capture hook (WS-0).
   * One-sentence description of the outcome of the ordered action sequence.
   * Present only when `orderedActions` is non-empty.
   */
  outcomeData?: string;
}

export interface ExtractPayload {
  candidates: ExtractCandidate[];
  rationale_if_empty?: string;
}

/**
 * Parse the LLM's JSON response into a structured {@link ExtractPayload}.
 * Defensive — drops candidates that violate the shape rather than failing
 * the whole call. Returns the empty-candidates payload when nothing parses.
 */
export function parseExtractPayload(stdout: string): ExtractPayload {
  if (!stdout || stdout.trim().length === 0) {
    return { candidates: [], rationale_if_empty: "LLM returned empty response" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Tolerate prose preamble/postamble by extracting the first balanced
    // top-level JSON object.
    const start = stdout.indexOf("{");
    const end = stdout.lastIndexOf("}");
    if (start === -1 || end <= start) {
      return { candidates: [], rationale_if_empty: `LLM response was not parseable JSON` };
    }
    try {
      parsed = JSON.parse(stdout.slice(start, end + 1));
    } catch {
      return { candidates: [], rationale_if_empty: `LLM response was not parseable JSON` };
    }
  }
  if (!parsed || typeof parsed !== "object") {
    return { candidates: [], rationale_if_empty: "LLM response was not an object" };
  }
  const obj = parsed as Record<string, unknown>;
  const rawCandidates = Array.isArray(obj.candidates) ? obj.candidates : [];
  const candidates: ExtractCandidate[] = [];
  for (const raw of rawCandidates) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    const type = c.type;
    if (type !== "memory" && type !== "lesson" && type !== "knowledge") continue;
    if (typeof c.name !== "string" || !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(c.name)) continue;
    if (typeof c.description !== "string" || c.description.trim().length < 20) continue;
    if (typeof c.body !== "string" || c.body.trim().length < 50) continue;
    if (typeof c.confidence !== "number" || !Number.isFinite(c.confidence)) continue;
    if (typeof c.evidence !== "string" || c.evidence.trim().length < 5) continue;
    if (type === "lesson") {
      if (typeof c.when_to_use !== "string" || c.when_to_use.trim().length < 15) continue;
    }
    const confidence = Math.max(0, Math.min(1, c.confidence));
    const candidate: ExtractCandidate = {
      type,
      name: c.name,
      description: c.description.trim(),
      body: c.body,
      confidence,
      evidence: c.evidence.trim(),
    };
    if (typeof c.when_to_use === "string") candidate.when_to_use = c.when_to_use.trim();
    // #615 WS-0: parse optional ordered-action + outcome fields.
    // Defensive: silently drop malformed entries rather than rejecting the whole candidate.
    if (Array.isArray(c.orderedActions) && c.orderedActions.length > 0) {
      const actions = c.orderedActions
        .filter((a): a is string => typeof a === "string" && a.trim().length >= 3)
        .map((a) => a.trim())
        .slice(0, 20);
      if (actions.length > 0) {
        candidate.orderedActions = actions;
        if (typeof c.outcomeData === "string" && c.outcomeData.trim().length > 0) {
          candidate.outcomeData = c.outcomeData.trim().slice(0, 400);
        }
      }
    }
    candidates.push(candidate);
  }
  const result: ExtractPayload = { candidates };
  if (typeof obj.rationale_if_empty === "string") {
    result.rationale_if_empty = obj.rationale_if_empty.trim();
  }
  return result;
}
