// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../../../storage/database";
import { extractInlineRefMentions } from "../../session-logs/inline-refs";
import type {
  InlineRefMention,
  SessionData,
  SessionEvent,
  SessionLogHarness,
  SessionRef,
  SessionSummary,
} from "../../session-logs/types";

function getOpenCodeBaseDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "opencode");
  }
  return path.join(os.homedir(), ".local", "share", "opencode");
}

/**
 * Opencode storage layouts:
 *
 *   SQLite (current, observed 2026-06): `<base>/opencode.db` — a Drizzle-managed
 *   database with `session` / `message` / `part` tables. Message text lives in
 *   `part` rows (`data` JSON, `type: "text"`); `message.data` holds role/timing.
 *   This is the layout current opencode builds write; it is preferred whenever
 *   `opencode.db` exists.
 *
 *   JSON files (legacy, observed 2026-05): `<base>/storage/session/<projectId>/
 *   <sessionId>.json` (metadata) + `<base>/storage/message/<sessionId>/
 *   <messageId>.json` (one per message). Read only when `opencode.db` is absent.
 *
 * Older builds wrote logs directly into `<base>/log/` and `<base>/*.log`;
 * those are still scanned by {@link OpenCodeProvider.readEvents} for
 * backward compatibility with the existing failure-pattern aggregator.
 */

/** Filename of opencode's SQLite session store, relative to its base dir. */
const OPENCODE_DB_FILENAME = "opencode.db";

export class OpenCodeProvider implements SessionLogHarness {
  readonly name = "opencode";
  readonly #baseDir = getOpenCodeBaseDir();

  isAvailable(): boolean {
    return fs.existsSync(this.#baseDir);
  }

  /** Absolute path to opencode's SQLite store under `base`. */
  #dbPath(base: string): string {
    return path.join(base, OPENCODE_DB_FILENAME);
  }

  /**
   * Directories/files opencode writes session data under. Returns the base dir
   * when the SQLite store (`opencode.db`) exists, the legacy JSON session root
   * (`<base>/storage/session`) when present, or both during a migration overlap.
   * Empty when neither exists. See {@link SessionLogHarness.watchRoots}.
   */
  watchRoots(): string[] {
    const roots: string[] = [];
    if (fs.existsSync(this.#dbPath(this.#baseDir))) roots.push(this.#baseDir);
    const sessionRoot = path.join(this.#baseDir, "storage", "session");
    if (fs.existsSync(sessionRoot)) roots.push(sessionRoot);
    return roots;
  }

  *readEvents(input: { sinceMs: number }): Iterable<SessionEvent> {
    // Legacy behavior: stream raw log lines from the top-level dir and `log/`
    // subdirectory. Kept to keep `getExecutionLogCandidates` working without
    // a coordinated change to its caller. New code should use
    // {@link listSessions} + {@link readSession} instead.
    const candidates = [this.#baseDir, path.join(this.#baseDir, "log")];
    for (const dir of candidates) {
      if (!fs.existsSync(dir)) continue;
      try {
        for (const file of fs.readdirSync(dir)) {
          const full = path.join(dir, file);
          let stat: fs.Stats;
          try {
            stat = fs.statSync(full);
          } catch {
            continue;
          }
          if (!stat.isFile()) continue;
          if (stat.mtimeMs < input.sinceMs) continue;
          if (!file.endsWith(".json") && !file.endsWith(".jsonl") && !file.endsWith(".log")) continue;

          const content = fs.readFileSync(full, "utf8");
          const lines = content.includes("\n") ? content.split("\n") : [content];
          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              const text = entry?.content ?? entry?.message ?? entry?.text ?? "";
              if (typeof text !== "string" || text.length < 10) continue;
              yield {
                harness: this.name,
                text,
                ts: typeof entry?.timestamp === "number" ? entry.timestamp : stat.mtimeMs,
                sessionId: typeof entry?.sessionId === "string" ? entry.sessionId : undefined,
                role: typeof entry?.role === "string" ? entry.role : "unknown",
                filePath: full,
              };
            } catch {
              // skip malformed
            }
          }
        }
      } catch {
        // unreadable dir — skip
      }
    }
  }

  listSessions(input: { sinceMs?: number; location?: string } = {}): SessionSummary[] {
    const base = input.location ?? this.#baseDir;
    const sinceMs = input.sinceMs ?? 0;
    const dbPath = this.#dbPath(base);
    if (fs.existsSync(dbPath)) return this.#listSessionsFromDb(dbPath, sinceMs);
    const sessionRoot = path.join(base, "storage", "session");
    if (!fs.existsSync(sessionRoot)) return [];
    const summaries: SessionSummary[] = [];
    try {
      for (const projectId of fs.readdirSync(sessionRoot)) {
        const projectDir = path.join(sessionRoot, projectId);
        let pstat: fs.Stats;
        try {
          pstat = fs.statSync(projectDir);
        } catch {
          continue;
        }
        if (!pstat.isDirectory()) continue;
        for (const file of fs.readdirSync(projectDir)) {
          if (!file.endsWith(".json")) continue;
          const filePath = path.join(projectDir, file);
          let stat: fs.Stats;
          try {
            stat = fs.statSync(filePath);
          } catch {
            continue;
          }
          if (stat.mtimeMs < sinceMs) continue;
          let meta: Record<string, unknown> | undefined;
          try {
            meta = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
          } catch {
            continue;
          }
          const sessionId = typeof meta?.id === "string" ? meta.id : path.basename(file, ".json");
          const time = (meta?.time as Record<string, unknown> | undefined) ?? undefined;
          const startedAt = typeof time?.created === "number" ? time.created : stat.ctimeMs;
          const endedAt = typeof time?.updated === "number" ? time.updated : stat.mtimeMs;
          const title = typeof meta?.title === "string" ? meta.title : undefined;
          const projectHint = typeof meta?.directory === "string" ? meta.directory : projectId;
          summaries.push({
            harness: this.name,
            sessionId,
            filePath,
            startedAt,
            endedAt,
            projectHint,
            ...(title ? { title } : {}),
          });
        }
      }
    } catch {
      // unreadable session root — return what we have
    }
    return summaries.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  }

  readSession(ref: SessionRef): SessionData {
    if (path.basename(ref.filePath) === OPENCODE_DB_FILENAME) return this.#readSessionFromDb(ref);
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(fs.readFileSync(ref.filePath, "utf8")) as Record<string, unknown>;
    } catch {
      // metadata missing — proceed with empty defaults
    }
    const time = (meta.time as Record<string, unknown> | undefined) ?? undefined;
    const startedAt = typeof time?.created === "number" ? time.created : undefined;
    const endedAt = typeof time?.updated === "number" ? time.updated : undefined;
    const title = typeof meta.title === "string" ? meta.title : undefined;
    const projectHint = typeof meta.directory === "string" ? meta.directory : undefined;

    const events: SessionEvent[] = [];
    const inlineRefs: InlineRefMention[] = [];

    // Resolve message directory: <baseDir>/storage/message/<sessionId>/
    const inferredBase = this.#inferBaseFromSessionPath(ref.filePath) ?? this.#baseDir;
    const msgDir = path.join(inferredBase, "storage", "message", ref.sessionId);
    if (fs.existsSync(msgDir)) {
      try {
        const files = fs.readdirSync(msgDir).filter((f) => f.endsWith(".json"));
        for (const file of files) {
          const full = path.join(msgDir, file);
          let msg: Record<string, unknown> | undefined;
          try {
            msg = JSON.parse(fs.readFileSync(full, "utf8")) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (!msg) continue;
          const evt = this.#messageToEvent(msg, ref.sessionId, full);
          if (evt) {
            events.push(evt);
            inlineRefs.push(...extractInlineRefMentions(evt.text, evt.ts));
          }
        }
      } catch {
        // unreadable msg dir — skip
      }
    }
    events.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));

    return {
      ref: {
        harness: this.name,
        sessionId: ref.sessionId,
        filePath: ref.filePath,
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(endedAt !== undefined ? { endedAt } : {}),
        ...(projectHint ? { projectHint } : {}),
        ...(title ? { title } : {}),
      },
      events,
      inlineRefs,
    };
  }

  /**
   * List sessions from the SQLite store. `filePath` on each summary is the
   * `opencode.db` path so {@link readSession} can route back to the DB reader.
   * Returns `[]` (never throws) when the DB is unreadable or lacks the expected
   * schema — callers treat a missing harness as "no sessions".
   */
  #listSessionsFromDb(dbPath: string, sinceMs: number): SessionSummary[] {
    let db: ReturnType<typeof openDatabase>;
    try {
      db = openDatabase(dbPath, { readonly: true, create: false });
    } catch {
      return [];
    }
    try {
      const rows = db
        .prepare<{
          id: string;
          title: string | null;
          directory: string | null;
          time_created: number | null;
          time_updated: number | null;
        }>(
          "SELECT id, title, directory, time_created, time_updated FROM session WHERE time_updated >= ? ORDER BY time_updated DESC",
        )
        .all(sinceMs);
      return rows.map((r) => {
        const startedAt = typeof r.time_created === "number" ? r.time_created : undefined;
        const endedAt = typeof r.time_updated === "number" ? r.time_updated : undefined;
        const title = typeof r.title === "string" && r.title.length > 0 ? r.title : undefined;
        const projectHint = typeof r.directory === "string" && r.directory.length > 0 ? r.directory : undefined;
        return {
          harness: this.name,
          sessionId: r.id,
          filePath: dbPath,
          ...(startedAt !== undefined ? { startedAt } : {}),
          ...(endedAt !== undefined ? { endedAt } : {}),
          ...(projectHint ? { projectHint } : {}),
          ...(title ? { title } : {}),
        };
      });
    } catch {
      // Missing `session` table / unexpected schema — treat as no sessions.
      return [];
    } finally {
      db.close();
    }
  }

  /**
   * Read one session from the SQLite store. Message text lives in `part` rows
   * (`type: "text"`); `message.data` carries role + timing. One event per
   * message, text-parts concatenated in time order. Returns empty events
   * (never throws) when the DB is unreadable.
   */
  #readSessionFromDb(ref: SessionRef): SessionData {
    const emptyRef: SessionSummary = { harness: this.name, sessionId: ref.sessionId, filePath: ref.filePath };
    let db: ReturnType<typeof openDatabase>;
    try {
      db = openDatabase(ref.filePath, { readonly: true, create: false });
    } catch {
      return { ref: emptyRef, events: [], inlineRefs: [] };
    }
    try {
      const meta = db
        .prepare<{
          title: string | null;
          directory: string | null;
          time_created: number | null;
          time_updated: number | null;
        }>("SELECT title, directory, time_created, time_updated FROM session WHERE id = ?")
        .get(ref.sessionId);
      const startedAt = typeof meta?.time_created === "number" ? meta.time_created : undefined;
      const endedAt = typeof meta?.time_updated === "number" ? meta.time_updated : undefined;
      const title = typeof meta?.title === "string" && meta.title.length > 0 ? meta.title : undefined;
      const projectHint = typeof meta?.directory === "string" && meta.directory.length > 0 ? meta.directory : undefined;

      const messages = db
        .prepare<{ id: string; data: string; time_created: number | null }>(
          "SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC",
        )
        .all(ref.sessionId);
      const parts = db
        .prepare<{ message_id: string; data: string }>(
          "SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created ASC, id ASC",
        )
        .all(ref.sessionId);

      // Group text-part bodies by their parent message.
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
          typeof mtime === "number"
            ? mtime
            : typeof message.time_created === "number"
              ? message.time_created
              : undefined;
        const text = (textByMessage.get(message.id) ?? []).join("\n").trim();
        if (text.length < 1) continue;
        events.push({ harness: this.name, text, ts, sessionId: ref.sessionId, role, filePath: ref.filePath });
        inlineRefs.push(...extractInlineRefMentions(text, ts));
      }
      events.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));

      return {
        ref: {
          harness: this.name,
          sessionId: ref.sessionId,
          filePath: ref.filePath,
          ...(startedAt !== undefined ? { startedAt } : {}),
          ...(endedAt !== undefined ? { endedAt } : {}),
          ...(projectHint ? { projectHint } : {}),
          ...(title ? { title } : {}),
        },
        events,
        inlineRefs,
      };
    } catch {
      return { ref: emptyRef, events: [], inlineRefs: [] };
    } finally {
      db.close();
    }
  }

  /**
   * Derive opencode base dir from a session metadata file path so a caller
   * passing a custom `--location` can still find the message dir.
   * Layout: `<base>/storage/session/<projectId>/<id>.json` → base.
   */
  #inferBaseFromSessionPath(filePath: string): string | undefined {
    // Walk up: <id>.json → <projectId> → session → storage → <base>
    const dir = path.dirname(filePath);
    const parts = dir.split(path.sep);
    if (parts.length < 3) return undefined;
    const last = parts[parts.length - 1];
    const sndLast = parts[parts.length - 2];
    const thirdLast = parts[parts.length - 3];
    if (sndLast !== "session" || thirdLast !== "storage" || !last) return undefined;
    return parts.slice(0, parts.length - 3).join(path.sep);
  }

  #messageToEvent(msg: Record<string, unknown>, sessionId: string, filePath: string): SessionEvent | undefined {
    const time = (msg.time as Record<string, unknown> | undefined) ?? undefined;
    const ts = typeof time?.created === "number" ? time.created : typeof msg.timestamp === "number" ? msg.timestamp : 0;
    const role = typeof msg.role === "string" ? (msg.role as SessionEvent["role"]) : "unknown";
    // Opencode message bodies live in summary.title / summary.diffs[].before/after /
    // parts (referenced from storage/part/<msg-id>/). For listing+extraction
    // purposes the summary block is sufficient — it's what the platform itself
    // surfaces as the message preview.
    const summary = msg.summary as Record<string, unknown> | undefined;
    const parts: string[] = [];
    if (typeof summary?.title === "string") parts.push(summary.title);
    if (Array.isArray(summary?.parts)) {
      for (const p of summary.parts as unknown[]) {
        if (typeof p === "string") parts.push(p);
        else if (p && typeof p === "object") {
          const text = (p as Record<string, unknown>).text;
          if (typeof text === "string") parts.push(text);
        }
      }
    }
    // content field for some opencode versions
    if (typeof msg.content === "string") parts.push(msg.content);
    const text = parts.join("\n").trim();
    if (text.length < 1) return undefined;
    return {
      harness: this.name,
      text,
      ts: ts || undefined,
      sessionId,
      role,
      filePath,
    };
  }
}
