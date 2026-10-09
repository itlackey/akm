// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Distill's lesson update (#1090): when a memory's lesson repeats a lesson the library already holds, the writer
 * is asked to extend that lesson with what the memory adds instead of the duplicate being thrown away. These are
 * the prompt, the reply schema and the two deterministic checks; the call, the judge and the proposal are in
 * `../distill`.
 */

import { parseEmbeddedJsonResponse } from "../../../core/parse";

/** A lesson the library holds, as the update writer sees it. */
export interface UpdateCandidate {
  ref: string;
  /** The lesson's body, without its frontmatter. */
  body: string;
}

export const DISTILL_LESSON_UPDATE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["reason", "decision", "ref", "body"],
  additionalProperties: false,
  properties: {
    reason: {
      type: "string",
      description: "One sentence: which listed lesson states the rule and what the memory adds to it, or why nothing.",
    },
    decision: {
      type: "string",
      enum: ["update", "none"],
      description:
        "`none` when no listed lesson states the memory's rule, or the memory adds nothing the lesson lacks: leave `ref` and `body` empty. Otherwise `update`.",
    },
    ref: { type: "string", description: "The `Existing lesson ref:` of the lesson to extend. Empty for `none`." },
    body: {
      type: "string",
      description:
        "That lesson's whole body with the new lines added, every existing line unchanged. No frontmatter. Empty for `none`.",
    },
  },
};

export function buildLessonUpdatePrompt(memory: string, feedback: string[], candidates: UpdateCandidate[]): string {
  const lines = [
    "A lesson written from the memory below would repeat a lesson the library already holds. Do not write a new lesson. Extend the existing one with what the memory adds.",
    "",
    "Memory:",
    "```",
    memory.slice(0, 3000),
    "```",
  ];
  if (feedback.length > 0)
    lines.push("", "Feedback recorded about the memory:", "```", feedback.join("\n").slice(0, 1500), "```");
  lines.push("", "Existing lessons, nearest first (they may be on another subject):");
  for (const candidate of candidates) {
    lines.push(`\nExisting lesson ref: ${candidate.ref}`, "```", candidate.body.slice(0, 3000), "```");
  }
  lines.push(
    "",
    "Pick the one existing lesson that already states the rule the memory gives. Write its whole body again with the new lines added:",
    "- Copy every existing line unchanged, in its place. Do not reword, shorten, reorder or drop any of them.",
    "- Add one line (a bullet, a sentence or a short paragraph) for each cause, step, number, limit or consequence the memory states and the lesson lacks: check every sentence of the memory against the lesson. Say nothing the memory does not say.",
    "- The memory's own incident retold (what happened in one test, project or day) is not a new fact unless it carries a cause, number, limit or consequence the lesson lacks. A memory that only retells the lesson's rule with its incident adds nothing: answer none.",
    "- If the memory contradicts a line of the lesson, answer none.",
    "- If no listed lesson states the memory's rule, or the memory adds nothing the lesson lacks, answer none.",
    "",
    'Return ONLY valid JSON, no prose: {"reason": "...", "decision": "update" | "none", "ref": "<the existing lesson ref>", "body": "<the whole body>"}',
  );
  return lines.join("\n");
}

/** The writer's chosen update, or `null` for `none` and for any reply that does not name a listed lesson with a body. */
export function parseLessonUpdate<T extends UpdateCandidate>(
  raw: string,
  candidates: readonly T[],
): { candidate: T; body: string; reason: string } | null {
  const payload = parseEmbeddedJsonResponse<Record<string, unknown>>(raw);
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.decision !== "update") return null;
  const ref = typeof payload.ref === "string" ? payload.ref.trim() : "";
  const body = typeof payload.body === "string" ? payload.body.trim() : "";
  const candidate = candidates.find((c) => c.ref === ref);
  if (!candidate || !body) return null;
  return { candidate, body, reason: typeof payload.reason === "string" ? payload.reason.trim() : "" };
}

const normalizeLine = (line: string): string => line.trim().replace(/\s+/g, " ").toLowerCase();

const bodyLines = (body: string): string[] =>
  body
    .split("\n")
    .map(normalizeLine)
    .filter((line) => line !== "");

/**
 * What an update does to a lesson's body: the existing lines it no longer holds (compared by words, in any case
 * and spacing, anywhere in the new body) and the lines it adds.
 */
export function diffLessonBody(existingBody: string, mergedBody: string): { dropped: string[]; added: string[] } {
  const existing = bodyLines(existingBody);
  const merged = bodyLines(mergedBody);
  const kept = new Set(merged);
  const had = new Set(existing);
  return {
    dropped: existing.filter((line) => !kept.has(line)),
    added: mergedBody
      .split("\n")
      .filter((line) => line.trim() !== "" && !had.has(normalizeLine(line)))
      .map((line) => line.trim()),
  };
}
