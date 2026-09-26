// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Session assets (#561): besides its memory proposals, extract writes each
 * session to `sessions/<harness>/<session-id>.md` as a searchable `session`
 * asset. Additive and fail-open — no summary means nothing is written — and
 * `log_path` + `access` in the frontmatter tell any agent how to read the raw log.
 */

import fs from "node:fs";
import path from "node:path";
import { stashDirFor } from "../../core/asset/asset-placement";
import { assembleAsset } from "../../core/asset/asset-serialize";
import { conceptIdFromTypeName } from "../../core/asset/resolve-ref";
import { parseEmbeddedJsonResponse } from "../../core/parse";
import { recordWrittenPath } from "../../core/write-provenance";
import type { SessionData, SessionEvent } from "../../integrations/session-logs/types";

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

export interface SessionSummaryResult {
  /** 2–4 dense sentences for semantic search. */
  summary: string;
  keyTopics: string[];
  tags?: string[];
}

/** Summarize a session; `undefined` (disabled, no LLM) writes no asset. */
export type SessionSummaryGenerator = (data: SessionData) => Promise<SessionSummaryResult | undefined>;

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

/** The transcript for the summary prompt, capped at `maxChars`. */
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

/** The summary JSON, tolerating prose around it; `undefined` when nothing usable parses. */
export function parseSessionSummary(raw: string): SessionSummaryResult | undefined {
  if (!raw || raw.trim().length === 0) return undefined;
  const obj = parseEmbeddedJsonResponse<Record<string, unknown>>(raw);
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
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

/** Long enough to index (`<= 0` disables; a missing timestamp is no evidence of a trivial session). */
export function sessionMeetsDurationGate(data: SessionData, minDurationMinutes: number): boolean {
  if (!Number.isFinite(minDurationMinutes) || minDurationMinutes <= 0) return true;
  const { startedAt, endedAt } = data.ref;
  if (typeof startedAt !== "number" || typeof endedAt !== "number") return true;
  return (endedAt - startedAt) / 60_000 >= minDurationMinutes;
}

/** How an agent reads and parses the raw log at `log_path`, per harness (`cat` otherwise). */
export function buildSessionAccessInstructions(harness: string, logPath: string, sessionId: string): string {
  if (harness === "claude") {
    return [
      `Read with: cat ${logPath}`,
      `Parse messages: jq -r 'select(.type=="message") | .message.content[]? | select(.type=="text") | .text' ${logPath}`,
    ].join("\n");
  }
  if (harness === "opencode") {
    return [
      `Open the SQLite database at ${JSON.stringify(logPath)} in read-only mode.`,
      "Query: SELECT m.data, p.data FROM message AS m JOIN part AS p ON p.message_id = m.id WHERE m.session_id = ? AND p.session_id = ? ORDER BY m.time_created, p.time_created;",
      `Bind both parameters to ${JSON.stringify(sessionId)}.`,
    ].join("\n");
  }
  return `Read with: cat ${logPath}`;
}

function isoOrUndefined(ms: number | undefined): string | undefined {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** Default session-name slug: `<harness>-session-<yyyy-mm-dd>-<shortId>`. */
export function buildSessionAssetName(harness: string, sessionId: string, startedAtMs?: number): string {
  return `${harness}-session-${isoOrUndefined(startedAtMs)?.slice(0, 10) ?? "unknown-date"}-${sessionId.slice(0, 8)}`;
}

/** The session asset: frontmatter plus `## Summary` and `## Key topics`. */
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

  const baseTags = ["session", harness];
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
    access: buildSessionAccessInstructions(harness, logPath, ref.sessionId),
    tags,
  };

  const topics = summary.keyTopics
    .filter((t) => typeof t === "string" && t.trim().length > 0)
    .map((t) => `- ${t.trim()}`)
    .join("\n");
  const body = `## Summary\n\n${summary.summary.trim()}\n\n## Key topics\n\n${topics || "- (none extracted)"}\n`;

  // The summary doubles as the description, as for other types.
  const content = assembleAsset({ ...frontmatter, description: summary.summary.trim() }, body);
  return { name, frontmatter, content };
}

/** Resolve `<stash>/sessions/<harness>/<session-id>.md`. */
export function resolveSessionAssetPath(stashDir: string, harness: string, sessionId: string): string {
  const dir = stashDirFor("session") ?? "sessions";
  return path.join(stashDir, dir, harness, `${sessionId}.md`);
}

export interface WriteSessionAssetResult {
  written: boolean;
  filePath?: string;
  /** `sessions/<harness>/<id>`. */
  ref?: string;
  /** The recorded `log_path` (state.db correlation). */
  logPath?: string;
}

/** Summarize and write a session asset; nothing without a summary. The caller swallows write errors. */
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
  // Written outside the proposal queue: journal it so auto-sync commits it (#652).
  recordWrittenPath(filePath);

  return {
    written: true,
    filePath,
    ref: conceptIdFromTypeName("session", `${harness}/${sessionId}`),
    logPath: data.ref.filePath,
  };
}
