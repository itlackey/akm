// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import { toErrorMessage } from "../../../core/common";
import { warnOnce } from "../../../core/warn";
import { type Database, openDatabase } from "../../../storage/database";
import { openSqliteReadSnapshot } from "../../../storage/sqlite-read-snapshot";
import { AbstractSessionLogProvider } from "../../session-logs/provider-base";
import type { SessionData, SessionLogHarness, SessionRef, SessionSummary } from "../../session-logs/types";
import { akmOpencodeDatabasePath, databaseIn, opencodeDatabasePath } from "./roots";
import { listV1Sessions, readV1Session, V1_TABLES } from "./session-log-v1";
import { hasV2Tables, listV2Sessions, readV2Session } from "./session-log-v2";

/**
 * OpenCode session history, from two SQLite files: the user's
 * `<opencode data dir>/opencode.db`, and akm's own `<akm data dir>/opencode.db`,
 * where the embedded OpenCode stores akm's runtime runs. This reader opens them
 * read-only, with SQLite alone, and starts no OpenCode on them; the embedded
 * OpenCode writes akm's file. The file's layout decides the reader:
 *
 *   - OpenCode 2 (`session_v2` and `session_message`): `session-log-v2.ts`.
 *     Only top-level sessions; akm's model-work sessions are left out.
 *   - OpenCode 1 only (`session` table): `session-log-v1.ts`. Model work on
 *     OpenCode 1 runs with no marker (`./agent-builder.ts`), so it is read like
 *     any other session.
 *   - Neither: an unsupported layout, reported, never presented as empty.
 */

type Layout = "v2" | "v1" | "unsupported";

function layoutOf(db: Database): Layout {
  const rows = db.prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  const tables = new Set(rows.map((r) => r.name));
  if (tables.has("session_v2") && hasV2Tables(db)) return "v2";
  return V1_TABLES.every((t) => tables.has(t)) && !tables.has("session_v2") ? "v1" : "unsupported";
}

export class OpenCodeProvider extends AbstractSessionLogProvider implements SessionLogHarness {
  readonly name = "opencode";
  readonly #userDatabase = opencodeDatabasePath();

  protected availabilityRoot(): string {
    return this.#userDatabase;
  }

  /** The user's OpenCode history, or akm's own. */
  override isAvailable(): boolean {
    return super.isAvailable() || fs.existsSync(akmOpencodeDatabasePath());
  }

  /** The stores to read: the one under `location`, else the user's and akm's. */
  #stores(location?: string): string[] {
    if (location) return [databaseIn(location)];
    return [this.#userDatabase, akmOpencodeDatabasePath()];
  }

  async listSessions(
    input: { sinceMs?: number; location?: string; isolatedSnapshot?: boolean } = {},
  ): Promise<SessionSummary[]> {
    const sinceMs = input.sinceMs ?? 0;
    const listed: SessionSummary[] = [];
    for (const dbPath of this.#stores(input.location)) {
      if (!fs.existsSync(dbPath)) continue;
      try {
        listed.push(...this.#listStore(dbPath, sinceMs, input.isolatedSnapshot === true));
      } catch (error) {
        this.#warnUnavailable(dbPath, `cannot list it (${toErrorMessage(error)})`);
      }
    }
    return listed.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  }

  /** One session's events. A file or session that cannot be read throws, so the caller records the failure. */
  async readSession(ref: SessionRef): Promise<SessionData> {
    const layout = this.#withDb(ref.filePath, false, layoutOf);
    if (layout === "unsupported") {
      throw new Error(`${ref.filePath} has no supported OpenCode 1 or OpenCode 2 session tables`);
    }
    const read = this.#withDb(ref.filePath, false, (db) =>
      layout === "v2"
        ? readV2Session(db, this.name, ref.sessionId, ref.filePath)
        : readV1Session(db, this.name, ref.sessionId, ref.filePath),
    );
    return {
      ref: this.sessionRef({ ...read.meta, filePath: ref.filePath }),
      events: read.events,
      inlineRefs: read.inlineRefs,
    };
  }

  #listStore(dbPath: string, sinceMs: number, isolated: boolean): SessionSummary[] {
    const layout = this.#withDb(dbPath, isolated, layoutOf);
    if (layout === "unsupported") {
      this.#warnUnavailable(dbPath, `it has neither the OpenCode 1 (${V1_TABLES.join("/")}) nor the OpenCode 2 tables`);
      return [];
    }
    const metas = this.#withDb(dbPath, isolated, (db) =>
      layout === "v2" ? listV2Sessions(db, sinceMs) : listV1Sessions(db, sinceMs),
    );
    return metas.map((meta) => this.sessionRef({ ...meta, filePath: dbPath }));
  }

  /** Run `use` on the SQLite file at `dbPath`, read-only (a private copy when `isolated`). */
  #withDb<T>(dbPath: string, isolated: boolean, use: (db: Database) => T): T {
    const db = isolated ? openSqliteReadSnapshot(dbPath) : openDatabase(dbPath, { readonly: true, create: false });
    if (!db) throw new Error("the file disappeared");
    try {
      return use(db);
    } finally {
      db.close();
    }
  }

  #warnUnavailable(dbPath: string, why: string): void {
    warnOnce(
      `opencode-history:${dbPath}:${why}`,
      `OpenCode session history at ${dbPath} was not read: ${why}. This is an unsupported or damaged store, not an empty history.`,
    );
  }
}
