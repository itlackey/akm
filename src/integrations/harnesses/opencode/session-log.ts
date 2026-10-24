// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toErrorMessage } from "../../../core/common";
import { getDataDir } from "../../../core/paths";
import { warnOnce } from "../../../core/warn";
import { type Database, openDatabase } from "../../../storage/database";
import { copySqliteSnapshot, openSqliteReadSnapshot } from "../../../storage/sqlite-read-snapshot";
import { AbstractSessionLogProvider } from "../../session-logs/provider-base";
import type { SessionData, SessionLogHarness, SessionRef, SessionSummary } from "../../session-logs/types";
import { listV1Sessions, readV1Session, V1_TABLES } from "./session-log-v1";
import { opencodeMessageEvents } from "./session-log-v2";

function getOpenCodeBaseDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "opencode");
  }
  return path.join(os.homedir(), ".local", "share", "opencode");
}

/**
 * OpenCode session history, from two SQLite files: the user's
 * `<opencode data dir>/opencode.db`, and akm's own `<akm data dir>/opencode.db`,
 * where the embedded OpenCode stores akm's agent runs. The file's layout
 * decides the reader:
 *
 *   - OpenCode 2 (`session_v2` table): read through the embedded OpenCode
 *     (`../opencode-sdk`), which knows its own schema. Only top-level sessions;
 *     akm's model-work sessions are left out.
 *   - OpenCode 1 only (`session` table): read-only SQLite (`session-log-v1.ts`).
 *   - Neither: an unsupported layout, reported, never presented as empty.
 */

/** Filename of OpenCode's SQLite session store, in OpenCode's and in akm's data dir. */
const OPENCODE_DB_FILENAME = "opencode.db";
const V2_TABLE = "session_v2";

type Layout = "v2" | "v1" | "unsupported";

function layoutOf(db: Database): Layout {
  const rows = db.prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  const tables = new Set(rows.map((r) => r.name));
  if (tables.has(V2_TABLE)) return "v2";
  return V1_TABLES.every((t) => tables.has(t)) ? "v1" : "unsupported";
}

export class OpenCodeProvider extends AbstractSessionLogProvider implements SessionLogHarness {
  readonly name = "opencode";
  readonly #baseDir = getOpenCodeBaseDir();

  protected availabilityRoot(): string {
    return path.join(this.#baseDir, OPENCODE_DB_FILENAME);
  }

  /** The user's OpenCode history, or akm's own. */
  override isAvailable(): boolean {
    return super.isAvailable() || fs.existsSync(path.join(getDataDir(), OPENCODE_DB_FILENAME));
  }

  /** The stores to read: the one under `location`, else the user's and akm's. */
  #stores(location?: string): string[] {
    if (location) return [path.join(location, OPENCODE_DB_FILENAME)];
    return [path.join(this.#baseDir, OPENCODE_DB_FILENAME), path.join(getDataDir(), OPENCODE_DB_FILENAME)];
  }

  async listSessions(
    input: { sinceMs?: number; location?: string; isolatedSnapshot?: boolean } = {},
  ): Promise<SessionSummary[]> {
    const sinceMs = input.sinceMs ?? 0;
    const listed: SessionSummary[] = [];
    for (const dbPath of this.#stores(input.location)) {
      if (!fs.existsSync(dbPath)) continue;
      try {
        listed.push(...(await this.#listStore(dbPath, sinceMs, input.isolatedSnapshot === true)));
      } catch (error) {
        this.#warnUnavailable(dbPath, `cannot list it (${toErrorMessage(error)})`);
      }
    }
    return listed.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  }

  async readSession(ref: SessionRef): Promise<SessionData> {
    const empty: SessionData = {
      ref: this.sessionRef({ sessionId: ref.sessionId, filePath: ref.filePath }),
      events: [],
      inlineRefs: [],
    };
    try {
      const layout = this.#withDb(ref.filePath, false, layoutOf);
      if (layout === "v1") {
        const read = this.#withDb(ref.filePath, false, (db) =>
          readV1Session(db, this.name, ref.sessionId, ref.filePath),
        );
        return {
          ref: this.sessionRef({ ...read.meta, filePath: ref.filePath }),
          events: read.events,
          inlineRefs: read.inlineRefs,
        };
      }
      if (layout !== "v2") {
        this.#warnUnavailable(ref.filePath, "it has no supported OpenCode 1 or OpenCode 2 session tables");
        return empty;
      }
      const { readOpencodeSession } = await import("../opencode-sdk/sdk-runner");
      const read = await readOpencodeSession(ref.filePath, ref.sessionId);
      if (!read) return empty;
      const { events, inlineRefs } = opencodeMessageEvents(read.messages, this.name, ref.sessionId, ref.filePath);
      return {
        ref: this.sessionRef({
          sessionId: ref.sessionId,
          filePath: ref.filePath,
          startedAt: read.session.created,
          endedAt: read.session.updated,
          ...(read.session.directory ? { projectHint: read.session.directory } : {}),
          ...(read.session.title ? { title: read.session.title } : {}),
        }),
        events,
        inlineRefs,
      };
    } catch (error) {
      this.#warnUnavailable(ref.filePath, `cannot read session ${ref.sessionId} (${toErrorMessage(error)})`);
      return empty;
    }
  }

  async #listStore(dbPath: string, sinceMs: number, isolated: boolean): Promise<SessionSummary[]> {
    const layout = this.#withDb(dbPath, isolated, layoutOf);
    if (layout === "v1") {
      return this.#withDb(dbPath, isolated, (db) => listV1Sessions(db, sinceMs)).map((meta) =>
        this.sessionRef({ ...meta, filePath: dbPath }),
      );
    }
    if (layout !== "v2") {
      this.#warnUnavailable(dbPath, `it has neither the OpenCode 1 (${V1_TABLES.join("/")}) nor the OpenCode 2 tables`);
      return [];
    }
    const sdk = await import("../opencode-sdk/sdk-runner");
    // A planning caller must not attach to the live database: the embedded OpenCode reads a private copy.
    const copyDir = isolated ? fs.mkdtempSync(path.join(os.tmpdir(), "akm-opencode-sessions-")) : undefined;
    const source = copyDir ? path.join(copyDir, OPENCODE_DB_FILENAME) : dbPath;
    try {
      if (copyDir) copySqliteSnapshot(dbPath, source);
      const sessions = await sdk.listOpencodeSessions(source);
      return sessions
        .filter((session) => session.updated >= sinceMs)
        .map((session) =>
          this.sessionRef({
            sessionId: session.id,
            filePath: dbPath,
            startedAt: session.created,
            endedAt: session.updated,
            ...(session.directory ? { projectHint: session.directory } : {}),
            ...(session.title ? { title: session.title } : {}),
          }),
        );
    } finally {
      if (copyDir) {
        await sdk.closeOpencodeSessionStore(source);
        fs.rmSync(copyDir, { recursive: true, force: true });
      }
    }
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
