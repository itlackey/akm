// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Session asset generation for the `extract` pass (#561).
 *
 * After the extractor distills memory proposals from a session, it ALSO writes
 * the session itself to the stash as a first-class `session` asset so any agent
 * — on any harness — can discover prior work via `akm search` / `akm curate`.
 *
 * Design constraints (see #561):
 *   - ADDITIVE + FAIL-OPEN + CONFIG-GATED. Disabled (or no LLM provider) →
 *     extract behaves EXACTLY as before. Nothing is written.
 *   - The LLM summary call routes through the injectable {@link SessionSummaryGenerator}
 *     seam so tests never touch a real provider, and so production wraps the
 *     call in the existing `tryLlmFeature` fail-open pattern.
 *   - The `log_path` + `access` frontmatter fields are the durable correlation
 *     key — they survive index rebuilds (the body is re-derived from disk).
 *
 * The asset is written to `sessions/<harness>/<session-id>.md`; the registered
 * `session` asset type (see `asset-spec.ts`) makes the normal index pass pick it
 * up for FTS + vector search with no special-casing.
 */

import fs from "node:fs";
import path from "node:path";
import { assembleAsset } from "../../core/asset/asset-serialize";
import { TYPE_DIRS } from "../../core/asset/asset-spec";
import { normalizeHarnessId } from "../../integrations/harnesses";
import type { SessionData, SessionEvent } from "../../integrations/session-logs/types";

/**
 * Frontmatter carried by a `session` asset. Mirrors the shape in #561.
 * `log_path` + `access` give any agent concrete instructions for fetching the
 * full session content when the summary alone is not enough.
 */
export interface SessionAssetFrontmatter {
  name: string;
  type: "session";
  harness: string;
  session_id: string;
  started_at?: string;
  ended_at?: string;
  project?: string;
  log_path: string;
  access: string;
  tags: string[];
}

/** The LLM-derived body for a session asset. */
export interface SessionSummaryResult {
  /** 2–4 sentence dense description for semantic search. */
  summary: string;
  /** Bullet list of entities, files, issues, and concepts touched. */
  keyTopics: string[];
  /** Optional extra tags the summarizer surfaced. */
  tags?: string[];
}

/**
 * Injectable seam that turns a read session into a summary. Production wires
 * this to a bounded in-tree LLM call via `tryLlmFeature`; tests inject a fake.
 * Returning `undefined` means "no summary available" (fail-open: no asset is
 * written) — used for the no-LLM / disabled path.
 */
export type SessionSummaryGenerator = (data: SessionData) => Promise<SessionSummaryResult | undefined>;

/**
 * JSON Schema for the session-summary LLM call. Strict so providers that
 * support schema enforcement constrain the output upstream; the parser only
 * has to handle the happy path. `additionalProperties: false` drops any
 * hallucinated keys before parsing.
 */
export const SESSION_SUMMARY_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["summary", "key_topics"],
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    key_topics: { type: "array", items: { type: "string" } },
    tags: { type: "array", items: { type: "string" } },
  },
};

/**
 * Render a compact transcript snippet from session events for the summary
 * prompt. Mirrors the extract transcript format but caps total length so the
 * summary prompt stays bounded regardless of session size.
 */
function renderTranscriptForSummary(events: SessionEvent[], maxChars = 12_000): string {
  if (events.length === 0) return "(empty — no events)";
  const lines: string[] = [];
  let total = 0;
  for (const e of events) {
    const role = e.role ?? "unknown";
    const text = e.text.trim();
    if (!text) continue;
    const line = `[${role}] ${text}`;
    if (total + line.length > maxChars) break;
    lines.push(line);
    total += line.length + 2;
  }
  return lines.join("\n\n") || "(empty — no textual events)";
}

/**
 * Build the user prompt for the session-summary LLM call. Pure — no IO. The
 * model is asked for a dense 2–4 sentence summary plus key topics, optimised
 * for semantic search recall.
 */
export function buildSessionSummaryPrompt(data: SessionData): string {
  const ref = data.ref;
  const startedAt = isoOrUndefined(ref.startedAt) ?? "unknown";
  const endedAt = isoOrUndefined(ref.endedAt) ?? "unknown";
  return [
    "You are summarizing an agent coding session so it can be found later via semantic search.",
    "Write a DENSE 2–4 sentence summary of what was worked on, the key decisions made, and the outcomes.",
    "Then list the concrete entities touched: files, GitHub issues/PRs, commands, concepts, and people.",
    "Optimise the summary for recall — include the specific nouns an agent would search for.",
    "",
    `Harness: ${ref.harness}`,
    `Project: ${ref.projectHint ?? "(unknown)"}`,
    `Started: ${startedAt}  Ended: ${endedAt}`,
    `Title: ${ref.title ?? "(none)"}`,
    "",
    "Transcript:",
    renderTranscriptForSummary(data.events),
    "",
    'Respond as JSON: {"summary": string, "key_topics": string[], "tags"?: string[]}.',
  ].join("\n");
}

/**
 * Parse the session-summary LLM response into a {@link SessionSummaryResult}.
 * Defensive: tolerates prose preamble/postamble around the JSON, and returns
 * `undefined` when nothing usable parses (fail-open: no asset is written).
 */
export function parseSessionSummary(raw: string): SessionSummaryResult | undefined {
  if (!raw || raw.trim().length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end <= start) return undefined;
    try {
      parsed = JSON.parse(raw.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const obj = parsed as Record<string, unknown>;
  const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
  if (summary.length === 0) return undefined;
  const keyTopics = Array.isArray(obj.key_topics)
    ? obj.key_topics.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
    : [];
  const tags = Array.isArray(obj.tags)
    ? obj.tags.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
    : undefined;
  return { summary, keyTopics, ...(tags && tags.length > 0 ? { tags } : {}) };
}

/**
 * Decide whether a session is long enough to index. `minDurationMinutes <= 0`
 * disables the gate. When either timestamp is missing we DON'T gate it out —
 * fail-open toward indexing, since a missing timestamp is not evidence of a
 * trivial session.
 */
export function sessionMeetsDurationGate(data: SessionData, minDurationMinutes: number): boolean {
  if (!Number.isFinite(minDurationMinutes) || minDurationMinutes <= 0) return true;
  const { startedAt, endedAt } = data.ref;
  if (typeof startedAt !== "number" || typeof endedAt !== "number") return true;
  const durationMinutes = (endedAt - startedAt) / 60_000;
  return durationMinutes >= minDurationMinutes;
}

/**
 * Build per-harness `access` instructions for reading the raw session log.
 *
 * Documented convention (#561, checklist item "Document `access` field
 * convention per harness"): the string tells a downstream agent exactly how to
 * read and parse the log at `log_path`. New harnesses fall back to a generic
 * `cat <log_path>` hint, which is always correct for a file-backed log.
 */
export function buildSessionAccessInstructions(harness: string, logPath: string): string {
  const canonical = normalizeHarnessId(harness);
  if (canonical === "claude") {
    return [
      `Read with: cat ${logPath}`,
      `Parse messages: jq -r 'select(.type=="message") | .message.content[]? | select(.type=="text") | .text' ${logPath}`,
    ].join("\n");
  }
  if (canonical === "opencode") {
    return [
      `Read with: cat ${logPath}`,
      `The log is opencode session storage (JSON). Inspect with: jq '.' ${logPath}`,
    ].join("\n");
  }
  // Generic fallback — file-backed logs are always readable with cat.
  return `Read with: cat ${logPath}`;
}

/** ISO-8601 (UTC) from a ms-epoch, or undefined when absent/non-finite. */
function isoOrUndefined(ms: number | undefined): string | undefined {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** Default session-name slug: `<harness>-session-<yyyy-mm-dd>-<shortId>`. */
export function buildSessionAssetName(harness: string, sessionId: string, startedAtMs?: number): string {
  const canonical = normalizeHarnessId(harness);
  const datePart = isoOrUndefined(startedAtMs)?.slice(0, 10) ?? "unknown-date";
  const shortId = sessionId.slice(0, 8);
  return `${canonical}-session-${datePart}-${shortId}`;
}

/**
 * Assemble the full session asset (frontmatter + `## Summary` / `## Key topics`).
 * Pure — no IO. Returns the serialized markdown string.
 */
export function buildSessionAssetContent(
  data: SessionData,
  summary: SessionSummaryResult,
): { name: string; frontmatter: SessionAssetFrontmatter; content: string } {
  const ref = data.ref;
  const harness = ref.harness;
  const startedAt = isoOrUndefined(ref.startedAt);
  const endedAt = isoOrUndefined(ref.endedAt);
  const name = buildSessionAssetName(harness, ref.sessionId, ref.startedAt);
  const logPath = ref.filePath;

  const baseTags = ["session", normalizeHarnessId(harness)];
  const extraTags = (summary.tags ?? []).filter((t) => typeof t === "string" && t.trim().length > 0);
  const tags = Array.from(new Set([...baseTags, ...extraTags]));

  const frontmatter: SessionAssetFrontmatter = {
    name,
    type: "session",
    harness,
    session_id: ref.sessionId,
    ...(startedAt ? { started_at: startedAt } : {}),
    ...(endedAt ? { ended_at: endedAt } : {}),
    ...(ref.projectHint ? { project: ref.projectHint } : {}),
    log_path: logPath,
    access: buildSessionAccessInstructions(harness, logPath),
    tags,
  };

  const topics = summary.keyTopics
    .filter((t) => typeof t === "string" && t.trim().length > 0)
    .map((t) => `- ${t.trim()}`)
    .join("\n");
  const body = `## Summary\n\n${summary.summary.trim()}\n\n## Key topics\n\n${topics || "- (none extracted)"}\n`;

  // `description` is duplicated into frontmatter so the metadata pass surfaces
  // it without re-reading the body — matches how other content types behave.
  const content = assembleAsset({ ...frontmatter, description: summary.summary.trim() }, body);
  return { name, frontmatter, content };
}

/** Resolve `<stash>/sessions/<harness>/<session-id>.md`. */
export function resolveSessionAssetPath(stashDir: string, harness: string, sessionId: string): string {
  const dir = TYPE_DIRS.session ?? "sessions";
  return path.join(stashDir, dir, normalizeHarnessId(harness), `${sessionId}.md`);
}

export interface WriteSessionAssetResult {
  written: boolean;
  /** Absolute path of the written asset (when `written`). */
  filePath?: string;
  /** Canonical asset ref (`session:<harness>/<id>`) when written. */
  ref?: string;
  /** The `log_path` recorded in frontmatter (for state-db correlation). */
  logPath?: string;
}

/**
 * Build a DETERMINISTIC session asset from `SessionData.ref` fields only —
 * no LLM call, no generator. Used by the #640 skip-path write so that
 * too_short / triaged_out sessions are still indexed for coverage even when
 * they don't merit full LLM extraction. The body is minimal but structurally
 * valid: a `## Metadata` section with the session ref fields so the asset
 * can be correlated back to the source session.
 *
 * This is PURE — it makes no IO calls. The caller is responsible for writing
 * the returned content to disk (fail-open around any errors).
 */
export function buildDeterministicSessionAssetContent(data: SessionData): {
  name: string;
  frontmatter: SessionAssetFrontmatter;
  content: string;
} {
  const ref = data.ref;
  const harness = ref.harness;
  const startedAt = isoOrUndefined(ref.startedAt);
  const endedAt = isoOrUndefined(ref.endedAt);
  const name = buildSessionAssetName(harness, ref.sessionId, ref.startedAt);
  const logPath = ref.filePath;

  const baseTags = ["session", normalizeHarnessId(harness), "deterministic-index"];
  const tags = Array.from(new Set(baseTags));

  const frontmatter: SessionAssetFrontmatter = {
    name,
    type: "session",
    harness,
    session_id: ref.sessionId,
    ...(startedAt ? { started_at: startedAt } : {}),
    ...(endedAt ? { ended_at: endedAt } : {}),
    ...(ref.projectHint ? { project: ref.projectHint } : {}),
    log_path: logPath,
    access: buildSessionAccessInstructions(harness, logPath),
    tags,
  };

  const metadataLines: string[] = [
    `- session_id: ${ref.sessionId}`,
    `- harness: ${normalizeHarnessId(harness)}`,
    `- log_path: ${logPath}`,
    ...(startedAt ? [`- started_at: ${startedAt}`] : []),
    ...(endedAt ? [`- ended_at: ${endedAt}`] : []),
    ...(ref.title ? [`- title: ${ref.title}`] : []),
  ];
  const body = `## Metadata\n\n${metadataLines.join("\n")}\n`;
  const content = assembleAsset({ ...frontmatter }, body);
  return { name, frontmatter, content };
}

/**
 * Write a DETERMINISTIC (no-LLM) session asset for a skipped session (#640).
 *
 * FAIL-OPEN: any IO error is caught and returned as `{ written: false }` so
 * the caller can proceed without disrupting the skip result. The caller MUST
 * only call this when `sessionIndexing.enabled` is true AND the skip is NOT
 * an `improve_review` skip.
 */
export async function writeDeterministicSessionAsset(
  data: SessionData,
  stashDir: string,
): Promise<WriteSessionAssetResult> {
  try {
    const { content } = buildDeterministicSessionAssetContent(data);
    const harness = data.ref.harness;
    const sessionId = data.ref.sessionId;
    const filePath = resolveSessionAssetPath(stashDir, harness, sessionId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
    return {
      written: true,
      filePath,
      ref: `session:${normalizeHarnessId(harness)}/${sessionId}`,
      logPath: data.ref.filePath,
    };
  } catch {
    return { written: false };
  }
}

/**
 * Generate (via the injected summarizer) and write a session asset to the stash.
 *
 * FAIL-OPEN: when the summarizer returns `undefined` (disabled / no LLM /
 * error), NOTHING is written and `{ written: false }` is returned. Any write
 * error is swallowed by the caller — session indexing must NEVER break extract.
 */
export async function writeSessionAsset(
  data: SessionData,
  stashDir: string,
  generate: SessionSummaryGenerator,
): Promise<WriteSessionAssetResult> {
  const summary = await generate(data);
  if (!summary?.summary || summary.summary.trim().length === 0) {
    return { written: false };
  }

  const { content } = buildSessionAssetContent(data, summary);
  const harness = data.ref.harness;
  const sessionId = data.ref.sessionId;
  const filePath = resolveSessionAssetPath(stashDir, harness, sessionId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");

  return {
    written: true,
    filePath,
    ref: `session:${normalizeHarnessId(harness)}/${sessionId}`,
    logPath: data.ref.filePath,
  };
}
