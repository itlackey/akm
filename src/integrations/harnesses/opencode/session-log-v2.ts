// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * OpenCode 2 session-store adapter. V2 keeps one `session_v2` row per session
 * and the ordered conversation as `session_message` rows (`type` + JSON `data`
 * minus `id`/`type`, shapes from `@opencode/client` `SessionMessageInfo`).
 * Read-only: the database is never migrated; V1 rows a native upgrade copied
 * here arrive as the same shapes under the same session id.
 *
 * Mapping into the session-log contract follows the Codex reader: user and
 * assistant text become events of that role, a tool call becomes
 * `[tool:<name>] <input>` and its outcome a `tool` event
 * `[tool_result] <output>`, so the inline-ref scanner sees shell commands.
 * Reasoning, compaction, synthetic/system and bookkeeping messages are skipped.
 */

import { warnOnce } from "../../../core/warn";
import type { Database } from "../../../storage/database";
import { extractInlineRefMentions } from "../../session-logs/inline-refs";
import type { InlineRefMention, SessionEvent } from "../../session-logs/types";
import type { OpenCodeSessionMeta, OpenCodeSessionRead } from "./session-log-types";

export const V2_TABLES = ["session_v2", "session_message"] as const;

type SessionRow = {
  id: string;
  title: string | null;
  directory: string | null;
  time_created: number | null;
  time_updated: number | null;
};

function toMeta(r: Partial<SessionRow>, sessionId: string): OpenCodeSessionMeta {
  return {
    sessionId,
    startedAt: typeof r.time_created === "number" ? r.time_created : undefined,
    endedAt: typeof r.time_updated === "number" ? r.time_updated : undefined,
    projectHint: typeof r.directory === "string" && r.directory.length > 0 ? r.directory : undefined,
    title: typeof r.title === "string" && r.title.length > 0 ? r.title : undefined,
  };
}

/** Every V2 session updated at or after `sinceMs`, newest first. Throws on an incompatible schema. */
export function listV2Sessions(db: Database, sinceMs: number): OpenCodeSessionMeta[] {
  const rows = db
    .prepare<SessionRow>(
      "SELECT id, title, directory, time_created, time_updated FROM session_v2 WHERE time_updated >= ? ORDER BY time_updated DESC",
    )
    .all(sinceMs);
  return rows.map((r) => toMeta(r, r.id));
}

/** Whether `sessionId` has a `session_v2` row, and how many `session_message` rows it owns. */
export function v2SessionState(db: Database, sessionId: string): { exists: boolean; messages: number } {
  const row = db.prepare<{ id: string }>("SELECT id FROM session_v2 WHERE id = ?").get(sessionId);
  if (!row) return { exists: false, messages: 0 };
  const count = db
    .prepare<{ n: number }>("SELECT COUNT(*) AS n FROM session_message WHERE session_id = ?")
    .get(sessionId);
  return { exists: true, messages: count?.n ?? 0 };
}

type Json = Record<string, unknown>;

function asObject(v: unknown): Json | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/** A tool input as text: a shell command stays a bare command line so inline-ref scanning matches it. */
function toolInputText(input: unknown): string {
  const fields = asObject(input);
  const cmd = fields?.command ?? fields?.cmd;
  if (typeof cmd === "string") return cmd;
  if (typeof input === "string") return input;
  return JSON.stringify(input ?? {}) ?? "";
}

/** Tool output blocks as text: text blocks verbatim, file blocks as a `[file: uri]` marker. */
function toolContentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const block of content) {
    const b = asObject(block);
    if (!b) continue;
    if (b.type === "text" && typeof b.text === "string") out.push(b.text);
    else if (b.type === "file" && typeof b.uri === "string") out.push(`[file: ${b.uri}]`);
  }
  return out.join("\n");
}

function structuredErrorText(err: unknown): string {
  const e = asObject(err);
  if (typeof e?.message === "string") return e.message;
  return typeof e?.type === "string" ? e.type : "error";
}

/**
 * Rebuild one session's events in `seq` order. Throws on an incompatible
 * schema; a message whose JSON cannot be read is skipped with one warning.
 */
export function readV2Session(db: Database, harness: string, sessionId: string, filePath: string): OpenCodeSessionRead {
  const meta = db
    .prepare<Omit<SessionRow, "id">>("SELECT title, directory, time_created, time_updated FROM session_v2 WHERE id = ?")
    .get(sessionId);
  const rows = db
    .prepare<{ id: string; type: string; data: string; time_created: number | null }>(
      "SELECT id, type, data, time_created FROM session_message WHERE session_id = ? ORDER BY seq ASC, time_created ASC, id ASC",
    )
    .all(sessionId);

  const events: SessionEvent[] = [];
  const inlineRefs: InlineRefMention[] = [];
  const push = (role: SessionEvent["role"], text: string, ts: number | undefined) => {
    const trimmed = text.trim();
    if (trimmed.length < 1) return;
    events.push({ harness, text: trimmed, ts, sessionId, role, filePath });
    inlineRefs.push(...extractInlineRefMentions(trimmed, ts));
  };

  for (const row of rows) {
    let data: Json | undefined;
    try {
      data = asObject(JSON.parse(row.data));
    } catch {
      data = undefined;
    }
    if (!data) {
      warnOnce(
        `opencode-v2-message:${filePath}:${row.id}`,
        `OpenCode 2 history: skipped unreadable message ${row.id} in session ${sessionId} (${filePath}).`,
      );
      continue;
    }
    const ts = asNumber(asObject(data.time)?.created) ?? asNumber(row.time_created);

    if (row.type === "user") {
      if (typeof data.text === "string") push("user", data.text, ts);
    } else if (row.type === "assistant") {
      const content = Array.isArray(data.content) ? data.content : [];
      const text = content
        .map((c) => asObject(c))
        .filter((c): c is Json => c?.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string)
        .join("\n");
      push("assistant", text, ts);
      for (const item of content) {
        const tool = asObject(item);
        if (tool?.type !== "tool") continue;
        const state = asObject(tool.state);
        const name = typeof tool.name === "string" ? tool.name : "tool";
        const toolTime = asObject(tool.time);
        const callTs = asNumber(toolTime?.created) ?? ts;
        push("assistant", `[tool:${name}] ${toolInputText(state?.input)}`, callTs);
        // Streaming/running calls are incomplete history: the call is kept, no result is invented.
        const doneTs = asNumber(toolTime?.completed) ?? callTs;
        if (state?.status === "completed") {
          push("tool", `[tool_result] ${toolContentText(state.content)}`, doneTs);
        } else if (state?.status === "error") {
          const body = toolContentText(state.content) || structuredErrorText(state.error);
          push("tool", `[tool_result] ${body}`, doneTs);
        }
      }
    } else if (row.type === "shell") {
      if (typeof data.command === "string") push("assistant", `[tool:shell] ${data.command}`, ts);
      const out = asObject(data.output)?.output;
      if (typeof out === "string") push("tool", `[tool_result] ${out}`, ts);
    }
  }

  return { meta: meta ? toMeta(meta, sessionId) : { sessionId }, events, inlineRefs };
}
