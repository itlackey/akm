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

import promptTemplate from "../assets/prompts/extract-session.md" with { type: "text" };
import type { InlineRefMention, SessionData, SessionEvent } from "../integrations/session-logs/types";

/**
 * JSON Schema for the structured extract output. Passed to `chatCompletion`
 * when the configured LLM connection has `supportsJsonSchema: true`.
 *
 * Shape:
 *   {
 *     "candidates": [{type, name, description, when_to_use?, body, confidence, evidence}, ...],
 *     "rationale_if_empty"?: string
 *   }
 *
 * `additionalProperties: false` at each level so any hallucinated keys are
 * dropped before parsing.
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
            description: "Kebab-case slug for the new asset.",
            pattern: "^[a-z0-9][a-z0-9-]*[a-z0-9]$",
          },
          description: {
            type: "string",
            minLength: 20,
            maxLength: 400,
            description: "One-sentence summary of the candidate. Must be a complete sentence; do not end mid-clause.",
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
 * Format pre-filtered events as a transcript snippet. Each event becomes:
 *   [<role> @ <iso>] <text>
 * Events are already truncated/cleaned by the pre-filter; this is purely
 * a render step.
 */
function formatTranscript(events: SessionEvent[]): string {
  if (events.length === 0) return "(empty — pre-filter removed all events as noise)";
  return events
    .map((e) => {
      const tsLabel = e.ts ? new Date(e.ts).toISOString() : "unknown-ts";
      const roleLabel = e.role ?? "unknown";
      return `[${roleLabel} @ ${tsLabel}] ${e.text}`;
    })
    .join("\n\n");
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
  return promptTemplate
    .replace("{{HARNESS}}", ref.harness)
    .replace("{{TITLE}}", ref.title ?? "(no title)")
    .replace("{{STARTED_AT}}", startedAt)
    .replace("{{ENDED_AT}}", endedAt)
    .replace("{{PROJECT_HINT}}", ref.projectHint ?? "(no project hint)")
    .replace("{{ALREADY_PRESERVED}}", formatAlreadyPreserved(input.inlineRefs))
    .replace("{{TRANSCRIPT}}", formatTranscript(input.events));
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
    candidates.push(candidate);
  }
  const result: ExtractPayload = { candidates };
  if (typeof obj.rationale_if_empty === "string") {
    result.rationale_if_empty = obj.rationale_if_empty.trim();
  }
  return result;
}
