// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * OpenCode 2 session store: the `session_v2` and `session_message` tables, read
 * with SQLite only. Nothing here starts OpenCode (which would migrate the file
 * and resume its suspended sessions); it reads the rows as they are.
 *
 * A message row is `(id, type, data)`; OpenCode decodes it as `{ ...data, id, type }`,
 * which is rebuilt here. Only top-level sessions are read, and akm's own
 * model-work sessions are left out: OpenCode 2 stores the agent a session ran as,
 * and akm runs model work as one agent (`./agent-builder.ts`).
 *
 * Mapping to events follows the Codex reader: user and assistant text become events of
 * that role, a tool call becomes `[tool:<name>] <input>` and its outcome a
 * `tool` event `[tool_result] <output>`, so the inline-ref scanner sees shell
 * commands. Reasoning, compaction, synthetic/system and bookkeeping messages
 * are skipped.
 */

import { asRecord, tryParseJson } from "../../../core/common";
import type { Database } from "../../../storage/database";
import { extractInlineRefMentions } from "../../session-logs/inline-refs";
import type { InlineRefMention, SessionEvent } from "../../session-logs/types";
import { MODEL_WORK_AGENT } from "./agent-builder";
import { type OpenCodeSessionMeta, type OpenCodeSessionRead, toMeta } from "./session-log-v1";

type Json = Record<string, unknown>;
const asObject = asRecord;

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

/** One session's events and inline refs, from its messages oldest first. A message that is not an object is skipped. */
export function opencodeMessageEvents(
  messages: readonly unknown[],
  harness: string,
  sessionId: string,
  filePath: string,
): { events: SessionEvent[]; inlineRefs: InlineRefMention[] } {
  const events: SessionEvent[] = [];
  const inlineRefs: InlineRefMention[] = [];
  const push = (role: SessionEvent["role"], text: string, ts: number | undefined) => {
    const trimmed = text.trim();
    if (trimmed.length < 1) return;
    events.push({ harness, text: trimmed, ts, sessionId, role, filePath });
    inlineRefs.push(...extractInlineRefMentions(trimmed, ts));
  };

  for (const message of messages) {
    const data = asObject(message);
    if (!data) continue;
    const ts = asNumber(asObject(data.time)?.created);

    if (data.type === "user") {
      if (typeof data.text === "string") push("user", data.text, ts);
    } else if (data.type === "assistant") {
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
    } else if (data.type === "shell") {
      if (typeof data.command === "string") push("assistant", `[tool:shell] ${data.command}`, ts);
      const out = asObject(data.output)?.output;
      if (typeof out === "string") push("tool", `[tool_result] ${out}`, ts);
    }
  }

  return { events, inlineRefs };
}

/** The columns of each table akm reads; a file lacking one is a schema akm does not support. */
const V2_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  session_v2: ["id", "parent_id", "title", "directory", "agent", "time_created", "time_updated"],
  session_message: ["id", "session_id", "type", "seq", "data"],
};

/** Whether `db` has the OpenCode 2 session tables with the columns akm reads. */
export function hasV2Tables(db: Database): boolean {
  return Object.entries(V2_COLUMNS).every(([table, columns]) => {
    const present = new Set(
      db
        .prepare<{ name: string }>(`PRAGMA table_info(${table})`)
        .all()
        .map((c) => c.name),
    );
    return columns.every((column) => present.has(column));
  });
}

/** Top-level sessions that are not akm's model work. */
const AKM_USER_SESSIONS = `parent_id IS NULL AND (agent IS NULL OR agent != '${MODEL_WORK_AGENT}')`;

type V2SessionRow = {
  id: string;
  title: string | null;
  directory: string | null;
  time_created: number | null;
  time_updated: number | null;
};

/** Every top-level OpenCode 2 session updated at or after `sinceMs`, newest first. Throws on an incompatible schema. */
export function listV2Sessions(db: Database, sinceMs: number): OpenCodeSessionMeta[] {
  return db
    .prepare<V2SessionRow>(
      `SELECT id, title, directory, time_created, time_updated FROM session_v2 WHERE ${AKM_USER_SESSIONS} AND time_updated >= ? ORDER BY time_updated DESC`,
    )
    .all(sinceMs)
    .map((row) => toMeta(row, row.id));
}

/**
 * The tokens one session's turns used: OpenCode records them on each assistant message and keeps their sums on the
 * session row (equal, measured on 2.1.4 and 2.2.0). Undefined when the session is not in the file.
 */
export function v2SessionTokens(
  db: Database,
  sessionId: string,
): { readonly input: number; readonly output: number; readonly reasoning: number } | undefined {
  const row = db
    .prepare<{ tokens_input: number; tokens_output: number; tokens_reasoning: number }>(
      "SELECT tokens_input, tokens_output, tokens_reasoning FROM session_v2 WHERE id = ?",
    )
    .get(sessionId);
  return row ? { input: row.tokens_input, output: row.tokens_output, reasoning: row.tokens_reasoning } : undefined;
}

/**
 * The message a session's turn failed with, as OpenCode recorded it on the session's `idle` message (an error a plugin
 * hook threw, a provider's refusal). Undefined when the session is not in the file or its turn did not fail.
 */
export function v2SessionFailure(db: Database, sessionId: string): string | undefined {
  const row = db
    .prepare<{ message: unknown }>(
      "SELECT json_extract(data, '$.error.message') AS message FROM session_message WHERE session_id = ? AND type = 'idle' AND json_extract(data, '$.outcome') = 'failed' ORDER BY seq DESC LIMIT 1",
    )
    .get(sessionId);
  return typeof row?.message === "string" && row.message.trim() !== "" ? row.message : undefined;
}

/** One session's events, from its messages in order. Throws when the session is not in the file. */
export function readV2Session(db: Database, harness: string, sessionId: string, filePath: string): OpenCodeSessionRead {
  const row = db
    .prepare<Omit<V2SessionRow, "id">>(
      "SELECT title, directory, time_created, time_updated FROM session_v2 WHERE id = ?",
    )
    .get(sessionId);
  if (!row) throw new Error(`session ${sessionId} is not in the file`);
  const messages = db
    .prepare<{ id: string; type: string; data: string }>(
      "SELECT id, type, data FROM session_message WHERE session_id = ? ORDER BY seq ASC",
    )
    .all(sessionId)
    .map((message) => ({ ...asRecord(tryParseJson(message.data)), id: message.id, type: message.type }));
  return { meta: toMeta(row, sessionId), ...opencodeMessageEvents(messages, harness, sessionId, filePath) };
}
