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
 * The schema is intentionally strict — a provider that honours
 * `response_format` enforces shape upstream, so the parser only has to handle
 * the happy path. `additionalProperties: false` means any hallucinated keys
 * the model emits get dropped before we parse.
 */

import promptTemplate from "../../assets/prompts/extract-session.md" with { type: "text" };
import { escapeJsonStringControls, stripCodeFences, stripThinkBlocks } from "../../core/parse";
import type { InlineRefMention, SessionData, SessionEvent } from "../../integrations/session-logs/types";

const EXTRACT_CANDIDATE_NAME_PATTERN = "^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)?$";
const EXTRACT_CANDIDATE_NAME_RE = new RegExp(EXTRACT_CANDIDATE_NAME_PATTERN);

/**
 * JSON Schema for the structured extract output. Passed to `chatCompletion`
 * unless the configured LLM connection sets `supportsJsonSchema: false`.
 *
 * Shape:
 *   {
 *     "candidates": [{type, name, description, when_to_use, body, confidence, evidence}, ...],
 *     "rationale_if_empty": string
 *   }
 *
 * `additionalProperties: false` at each level so any hallucinated keys are
 * dropped before parsing. Every property is required, as a strict structured-
 * output provider needs (#1046), and an empty string stands for "none": a
 * `when_to_use` only a lesson needs, a `rationale_if_empty` only an empty
 * answer needs. Before, `when_to_use` was optional, so a model that followed
 * the schema could leave it out of a lesson and the parser dropped the lesson
 * (#1047).
 */
export const EXTRACT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["candidates", "rationale_if_empty"],
  additionalProperties: false,
  properties: {
    candidates: {
      type: "array",
      description: "Zero or more durable-insight candidates extracted from the session.",
      items: {
        type: "object",
        required: ["type", "name", "description", "when_to_use", "body", "confidence", "evidence"],
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
            pattern: EXTRACT_CANDIDATE_NAME_PATTERN,
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
            maxLength: 400,
            description:
              "Trigger sentence of at least 15 characters; REQUIRED when type=lesson (a lesson without one is dropped). An empty string for a memory or knowledge candidate.",
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
        },
      },
    },
    rationale_if_empty: {
      type: "string",
      description:
        "When `candidates` is empty, one sentence on why nothing rose to durable-insight level; an empty string otherwise.",
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
 * Everything between the markers is DATA to analyze, never instructions to obey. The
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
}

export interface ExtractPayload {
  candidates: ExtractCandidate[];
  /** Candidates the model wrote that the contract refuses, each as `type:name dropped: <why>`. Absent when none. */
  dropped?: string[];
  rationale_if_empty?: string;
  /** Present only when the model response could not satisfy the payload boundary. */
  parseFailure?: {
    code: "empty_response" | "no_json_object" | "invalid_json_object" | "invalid_payload";
    message: string;
  };
}

function failedExtractPayload(
  code: NonNullable<ExtractPayload["parseFailure"]>["code"],
  message: string,
): ExtractPayload {
  return { candidates: [], rationale_if_empty: message, parseFailure: { code, message } };
}

function parseFirstJsonObject(stdout: string): { objectFound: boolean; value?: unknown } {
  const text = escapeJsonStringControls(stripCodeFences(stripThinkBlocks(stdout)));
  try {
    return { objectFound: text.startsWith("{"), value: JSON.parse(text) as unknown };
  } catch {
    // Continue with the first object embedded in prose. Once an opening brace
    // is found, never descend into a nested object if that outer object is
    // malformed or truncated: doing so can turn a broken candidate into a
    // superficially valid top-level payload.
  }
  const start = text.indexOf("{");
  if (start < 0) return { objectFound: false };
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth !== 0) continue;
      try {
        return { objectFound: true, value: JSON.parse(text.slice(start, index + 1)) as unknown };
      } catch {
        return { objectFound: true };
      }
    }
  }
  return { objectFound: true };
}

/** The candidate the model wrote when the contract keeps it, else the first rule it breaks. */
function readCandidate(c: Record<string, unknown>): { candidate: ExtractCandidate } | { problem: string } {
  const { type, name, description, body, confidence, evidence } = c;
  if (type !== "memory" && type !== "lesson" && type !== "knowledge") {
    return { problem: "type is not memory, lesson or knowledge" };
  }
  if (typeof name !== "string" || !EXTRACT_CANDIDATE_NAME_RE.test(name)) {
    return { problem: "name is not a kebab-case slug" };
  }
  if (typeof description !== "string" || description.trim().length < 20) {
    return { problem: "description is shorter than 20 characters" };
  }
  if (typeof body !== "string" || body.trim().length < 50) return { problem: "body is shorter than 50 characters" };
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return { problem: "confidence is not a number" };
  if (typeof evidence !== "string" || evidence.trim().length < 5) {
    return { problem: "evidence is shorter than 5 characters" };
  }
  // An empty string is how a strict-schema reply says "none".
  const whenToUse = typeof c.when_to_use === "string" ? c.when_to_use.trim() : "";
  if (type === "lesson" && whenToUse.length < 15) {
    return { problem: "a lesson needs a when_to_use of at least 15 characters" };
  }
  return {
    candidate: {
      type,
      name,
      description: description.trim(),
      ...(whenToUse ? { when_to_use: whenToUse } : {}),
      body,
      confidence: Math.max(0, Math.min(1, confidence)),
      evidence: evidence.trim(),
    },
  };
}

/**
 * Parse the LLM's JSON response into a structured {@link ExtractPayload}.
 * Defensive — drops candidates that violate the shape rather than failing
 * the whole call, and names each one in `dropped` so the run can say so.
 * Returns the empty-candidates payload when nothing parses.
 */
export function parseExtractPayload(stdout: string): ExtractPayload {
  if (!stdout || stdout.trim().length === 0) {
    return failedExtractPayload("empty_response", "LLM returned an empty response");
  }
  const parsed = parseFirstJsonObject(stdout);
  if (parsed.value === undefined) {
    return parsed.objectFound
      ? failedExtractPayload("invalid_json_object", "JSON object was found but could not be parsed")
      : failedExtractPayload("no_json_object", "LLM response: no JSON object found");
  }
  if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return failedExtractPayload("invalid_payload", "LLM response JSON was not an object");
  }
  const obj = parsed.value as Record<string, unknown>;
  if (!Array.isArray(obj.candidates)) {
    return failedExtractPayload("invalid_payload", "LLM response JSON did not contain a candidates array");
  }
  const rawCandidates = obj.candidates;
  const candidates: ExtractCandidate[] = [];
  const dropped: string[] = [];
  for (const raw of rawCandidates) {
    if (!raw || typeof raw !== "object") {
      dropped.push("candidate dropped: not an object");
      continue;
    }
    const c = raw as Record<string, unknown>;
    const read = readCandidate(c);
    if ("problem" in read) {
      dropped.push(
        `${typeof c.type === "string" ? c.type : "candidate"}:${typeof c.name === "string" ? c.name : "(unnamed)"} dropped: ${read.problem}`,
      );
      continue;
    }
    candidates.push(read.candidate);
  }
  const result: ExtractPayload = { candidates };
  if (dropped.length > 0) result.dropped = dropped;
  if (typeof obj.rationale_if_empty === "string" && obj.rationale_if_empty.trim()) {
    result.rationale_if_empty = obj.rationale_if_empty.trim();
  }
  return result;
}
