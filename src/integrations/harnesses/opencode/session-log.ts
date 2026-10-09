// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toErrorMessage } from "../../../core/common";
import { warnOnce } from "../../../core/warn";
import { type Database, openDatabase } from "../../../storage/database";
import { openSqliteReadSnapshot } from "../../../storage/sqlite-read-snapshot";
import { AbstractSessionLogProvider } from "../../session-logs/provider-base";
import type { SessionData, SessionLogHarness, SessionRef, SessionSummary } from "../../session-logs/types";
import type { OpenCodeSessionMeta } from "./session-log-types";
import { hasV1Session, listV1Sessions, readV1Session, V1_TABLES } from "./session-log-v1";
import { listV2Sessions, readV2Session, V2_TABLES, v2SessionState } from "./session-log-v2";

function getOpenCodeBaseDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "opencode");
  }
  return path.join(os.homedir(), ".local", "share", "opencode");
}

/**
 * OpenCode session storage: one SQLite file, `<base>/opencode.db`, whose
 * layout decides the reader, never the installed binary or its version:
 *
 *   - V1: `session` table, with `message` / `part` for content (`session-log-v1.ts`).
 *   - V2: `session_v2` / `session_message` tables (`session-log-v2.ts`).
 *   - Both: a natively upgraded V1 file keeps its V1 tables and gains the V2
 *     ones. Sessions are merged by id, V2 winning, V1-only ones kept.
 *   - Neither: an unsupported layout, reported, never presented as empty.
 *
 * The file is opened read-only and never migrated or written.
 */

/** Filename of opencode's SQLite session store, relative to its base dir. */
const OPENCODE_DB_FILENAME = "opencode.db";

/** What a session store holds, from its actual tables. */
export type OpenCodeStoreStatus =
  | { kind: "missing" }
  | { kind: "ok"; v1: boolean; v2: boolean }
  /** Readable SQLite file with neither supported layout. */
  | { kind: "unsupported"; tables: string[] }
  /** Present but not openable or queryable as SQLite. */
  | { kind: "unreadable"; reason: string };

function tableNames(db: Database): Set<string> {
  const rows = db.prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  return new Set(rows.map((r) => r.name));
}

function classify(tables: Set<string>): OpenCodeStoreStatus {
  const v1 = V1_TABLES.every((t) => tables.has(t));
  const v2 = V2_TABLES.every((t) => tables.has(t));
  return v1 || v2 ? { kind: "ok", v1, v2 } : { kind: "unsupported", tables: [...tables].sort() };
}

export class OpenCodeProvider extends AbstractSessionLogProvider implements SessionLogHarness {
  readonly name = "opencode";
  readonly #baseDir = getOpenCodeBaseDir();

  protected availabilityRoot(): string {
    return this.#dbPath(this.#baseDir);
  }

  /** Absolute path to opencode's SQLite store under `base`. */
  #dbPath(base: string): string {
    return path.join(base, OPENCODE_DB_FILENAME);
  }

  /** Classify the store under `location` (default: opencode's data dir) without listing anything. */
  inspectStore(location?: string): OpenCodeStoreStatus {
    const dbPath = this.#dbPath(location ?? this.#baseDir);
    if (!fs.existsSync(dbPath)) return { kind: "missing" };
    let db: Database;
    try {
      db = openDatabase(dbPath, { readonly: true, create: false });
    } catch (error) {
      return { kind: "unreadable", reason: toErrorMessage(error) };
    }
    try {
      return classify(tableNames(db));
    } catch (error) {
      return { kind: "unreadable", reason: toErrorMessage(error) };
    } finally {
      db.close();
    }
  }

  listSessions(input: { sinceMs?: number; location?: string; isolatedSnapshot?: boolean } = {}): SessionSummary[] {
    const dbPath = this.#dbPath(input.location ?? this.#baseDir);
    if (!fs.existsSync(dbPath)) return [];
    let db: Database | undefined;
    try {
      db = input.isolatedSnapshot
        ? openSqliteReadSnapshot(dbPath)
        : openDatabase(dbPath, { readonly: true, create: false });
    } catch (error) {
      this.#warnUnavailable(dbPath, `cannot open it (${toErrorMessage(error)})`);
      return [];
    }
    if (!db) return [];
    try {
      const status = classify(tableNames(db));
      if (status.kind !== "ok") {
        this.#warnUnavailable(
          dbPath,
          `it has neither the OpenCode 1 (${V1_TABLES.join("/")}) nor the OpenCode 2 (${V2_TABLES.join("/")}) tables`,
        );
        return [];
      }
      return this.#listFromDb(db, dbPath, input.sinceMs ?? 0, status.v1, status.v2);
    } catch (error) {
      this.#warnUnavailable(dbPath, `cannot query it (${toErrorMessage(error)})`);
      return [];
    } finally {
      db.close();
    }
  }

  readSession(ref: SessionRef): SessionData {
    const emptyRef = this.sessionRef({ sessionId: ref.sessionId, filePath: ref.filePath });
    const empty: SessionData = { ref: emptyRef, events: [], inlineRefs: [] };
    let db: Database;
    try {
      db = openDatabase(ref.filePath, { readonly: true, create: false });
    } catch (error) {
      this.#warnUnavailable(ref.filePath, `cannot open it (${toErrorMessage(error)})`);
      return empty;
    }
    try {
      const status = classify(tableNames(db));
      if (status.kind !== "ok") {
        this.#warnUnavailable(ref.filePath, "it has no supported OpenCode 1 or OpenCode 2 session tables");
        return empty;
      }
      // V2 owns a session that has messages there; otherwise a retained V1 copy (a
      // session the upgrade has not copied, or copied without messages) is the history.
      const v2 = status.v2 ? v2SessionState(db, ref.sessionId) : { exists: false, messages: 0 };
      const useV2 = v2.exists && (v2.messages > 0 || !status.v1 || !hasV1Session(db, ref.sessionId));
      const read = useV2
        ? readV2Session(db, this.name, ref.sessionId, ref.filePath)
        : readV1Session(db, this.name, ref.sessionId, ref.filePath);
      return {
        ref: this.sessionRef({ ...read.meta, filePath: ref.filePath }),
        events: read.events,
        inlineRefs: read.inlineRefs,
      };
    } catch (error) {
      this.#warnUnavailable(ref.filePath, `cannot read session ${ref.sessionId} (${toErrorMessage(error)})`);
      return empty;
    } finally {
      db.close();
    }
  }

  /** List each present layout; one failing layout is reported and the other still listed. */
  #listFromDb(db: Database, dbPath: string, sinceMs: number, v1: boolean, v2: boolean): SessionSummary[] {
    const merged = new Map<string, OpenCodeSessionMeta>();
    const attempt = (label: string, list: () => OpenCodeSessionMeta[]) => {
      try {
        for (const meta of list()) if (!merged.has(meta.sessionId)) merged.set(meta.sessionId, meta);
      } catch (error) {
        this.#warnUnavailable(dbPath, `its ${label} session tables cannot be queried (${toErrorMessage(error)})`);
      }
    };
    if (v2) attempt("OpenCode 2", () => listV2Sessions(db, sinceMs));
    if (v1) attempt("OpenCode 1", () => listV1Sessions(db, sinceMs));
    return [...merged.values()]
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
      .map((meta) => this.sessionRef({ ...meta, filePath: dbPath }));
  }

  #warnUnavailable(dbPath: string, why: string): void {
    warnOnce(
      `opencode-history:${dbPath}:${why}`,
      `OpenCode session history at ${dbPath} was not read: ${why}. This is an unsupported or damaged store, not an empty history.`,
    );
  }
}
