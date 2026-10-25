// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * OpenCode 1 session-store adapter: the Drizzle `session` / `message` / `part`
 * tables. Message text lives in `part` rows (`data` JSON, `type: "text"`);
 * `message.data` holds role and timing. Read only for a database with no
 * OpenCode 2 tables (`session-log-v2.ts` reads those).
 */

import type { Database } from "../../../storage/database";
import { extractInlineRefMentions } from "../../session-logs/inline-refs";
import type { InlineRefMention, SessionEvent } from "../../session-logs/types";

/** Per-session metadata a store adapter hands back to the provider (no harness stamp yet). */
export interface OpenCodeSessionMeta {
  sessionId: string;
  startedAt?: number;
  endedAt?: number;
  projectHint?: string;
  title?: string;
}

/** One session read from a store: its metadata, events and the akm commands the agent ran. */
export interface OpenCodeSessionRead {
  meta: OpenCodeSessionMeta;
  events: SessionEvent[];
  inlineRefs: InlineRefMention[];
}

/** The `session` table's columns akm reads (OpenCode 1). */
type SessionRow = {
  id: string;
  title: string | null;
  directory: string | null;
  time_created: number | null;
  time_updated: number | null;
};

/** The metadata of a row, with a column that is absent or empty left out. */
export function toMeta(r: Partial<SessionRow>, sessionId: string): OpenCodeSessionMeta {
  return {
    sessionId,
    startedAt: typeof r.time_created === "number" ? r.time_created : undefined,
    endedAt: typeof r.time_updated === "number" ? r.time_updated : undefined,
    projectHint: typeof r.directory === "string" && r.directory.length > 0 ? r.directory : undefined,
    title: typeof r.title === "string" && r.title.length > 0 ? r.title : undefined,
  };
}

/** Listing needs only `session`; reading a session needs `message` and `part`, and fails loudly without them. */
export const V1_TABLES = ["session"] as const;

/** Every V1 session updated at or after `sinceMs`, newest first. Throws on an incompatible schema. */
export function listV1Sessions(db: Database, sinceMs: number): OpenCodeSessionMeta[] {
  const rows = db
    .prepare<SessionRow>(
      "SELECT id, title, directory, time_created, time_updated FROM session WHERE time_updated >= ? ORDER BY time_updated DESC",
    )
    .all(sinceMs);
  return rows.map((r) => toMeta(r, r.id));
}

/**
 * One event per message, text-parts concatenated in time order. Throws on an
 * incompatible schema; individual unparsable rows are skipped.
 */
export function readV1Session(db: Database, harness: string, sessionId: string, filePath: string): OpenCodeSessionRead {
  const meta = db
    .prepare<Omit<SessionRow, "id">>("SELECT title, directory, time_created, time_updated FROM session WHERE id = ?")
    .get(sessionId);

  const messages = db
    .prepare<{ id: string; data: string; time_created: number | null }>(
      "SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC",
    )
    .all(sessionId);
  const parts = db
    .prepare<{ message_id: string; data: string }>(
      "SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created ASC, id ASC",
    )
    .all(sessionId);

  const textByMessage = new Map<string, string[]>();
  for (const part of parts) {
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = JSON.parse(part.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed?.type !== "text") continue;
    const text = parsed.text;
    if (typeof text !== "string" || text.length < 1) continue;
    const bucket = textByMessage.get(part.message_id) ?? [];
    bucket.push(text);
    textByMessage.set(part.message_id, bucket);
  }

  const events: SessionEvent[] = [];
  const inlineRefs: InlineRefMention[] = [];
  for (const message of messages) {
    let mdata: Record<string, unknown> = {};
    try {
      mdata = JSON.parse(message.data) as Record<string, unknown>;
    } catch {
      // role/timing unavailable — fall through with defaults
    }
    const role = typeof mdata.role === "string" ? (mdata.role as SessionEvent["role"]) : "unknown";
    const mtime = (mdata.time as Record<string, unknown> | undefined)?.created;
    const ts =
      typeof mtime === "number" ? mtime : typeof message.time_created === "number" ? message.time_created : undefined;
    const text = (textByMessage.get(message.id) ?? []).join("\n").trim();
    if (text.length < 1) continue;
    events.push({ harness, text, ts, sessionId, role, filePath });
    inlineRefs.push(...extractInlineRefMentions(text, ts));
  }
  events.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  return { meta: meta ? toMeta(meta, sessionId) : { sessionId }, events, inlineRefs };
}
