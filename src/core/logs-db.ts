// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * logs.db — Dedicated SQLite database for task/run log lines (#579).
 *
 * Replaces grep-the-flat-file consumption of `<cacheDir>/tasks/logs/<id>/<ts>.log`
 * with structured, indexed rows: `{ts, task_id, run_id, stream, level, line}`.
 * The strategic direction (stop scattering data across files/folders) means
 * every NEW log consumer queries this database; the per-run text file written
 * by the task runner is retained only as a transitional tail for humans —
 * per the #579 logs audit of every producer.
 *
 * ## Why a separate database from state.db
 *
 * Log lines are high-volume, append-only, and freely purgeable; state.db rows
 * (events, proposals, task_history) are durable records. Separating them keeps
 * state.db small and lets log retention be aggressive without touching durable
 * state. Callers that need to correlate a task_history row with its log lines do
 * an application-side join on the {@link buildTaskRunId} key (e.g. `health` via
 * {@link getLoggedRunIds}) — no SQLite ATTACH, so the split survives a future
 * provider change.
 *
 * ## run_id
 *
 * state.db's `task_history` identifies a run by the unique pair
 * `(task_id, started_at)` (see migration 002 in state-db.ts). logs.db encodes
 * that pair as a single string — {@link buildTaskRunId} — so log rows can be
 * joined back to their history row:
 *
 *   l.run_id = th.task_id || '@' || th.started_at
 *
 * ## Schema evolution
 *
 * Same migration-safety contract as state.db: append-only `MIGRATIONS` applied
 * through the shared runner in src/storage/engines/sqlite-migrations.ts.
 *
 * @module logs-db
 */

import path from "node:path";
import type { Database, SqlValue } from "../storage/database";
import { type Migration, runMigrations as runSqliteMigrations } from "../storage/engines/sqlite-migrations";
import { openManagedDatabase } from "../storage/managed-db";
import { getDataDir } from "./paths";

// Re-export the boundary Database type so consumers can type their handles
// against this owner module rather than the runtime boundary directly.
export type { Database };

// ── Path helper ──────────────────────────────────────────────────────────────

/**
 * Default path: `<dataDir>/logs.db` — alongside state.db so cooperating
 * processes sharing a data root automatically share the same logs database
 * (same `AKM_DATA_DIR` / XDG env-isolation as {@link getStateDbPath}).
 */
export function getLogsDbPath(): string {
  return path.join(getDataDir(), "logs.db");
}

// ── Database open ────────────────────────────────────────────────────────────

/**
 * Open (and initialise / migrate) the logs database.
 *
 * @param dbPath - Override the database file path (tests pass a tmpdir path).
 *
 * PRAGMA rationale:
 *
 *   journal_mode = WAL
 *     Readers never block writers and vice-versa; crashes are safe (the WAL is
 *     replayed on next open). Required because the task runner writes log rows
 *     while `akm health` may be reading them.
 *
 *   busy_timeout = 30000
 *     Log writes happen at the end of scheduled task runs, which can pile up
 *     (cron fan-out). 30 s of retry absorbs a slow concurrent writer instead of
 *     surfacing SQLITE_BUSY and dropping log lines.
 */
export function openLogsDatabase(dbPath?: string): Database {
  const resolvedPath = dbPath ?? getLogsDbPath();
  // foreignKeys:false preserves this opener's historical behaviour — logs.db
  // has never enforced foreign keys.
  return openManagedDatabase({
    path: resolvedPath,
    pragmas: { dataDir: path.dirname(resolvedPath), foreignKeys: false },
    init: runMigrations,
  });
}

// ── Migrations ───────────────────────────────────────────────────────────────

/**
 * All migrations in application order. APPEND only — never insert in the
 * middle or reorder. Same contract as state.db's MIGRATIONS array.
 */
const MIGRATIONS: Migration[] = [
  // ── Migration 001 — task_logs ───────────────────────────────────────────────
  //
  // One row per log line emitted by a task run.
  //
  // Indexed (query) columns:
  //   ts       TEXT — ISO-8601 UTC; range queries ("logs in the last hour").
  //   task_id  TEXT — task identifier; per-task log views.
  //   run_id   TEXT — buildTaskRunId(task_id, started_at); per-run log views
  //                   and the join key back to state.db task_history.
  //
  // Non-indexed columns:
  //   stream   TEXT — 'stdout' | 'stderr'; which pipe the line came from.
  //   level    TEXT — 'info' | 'warn' | 'error'; runner-assigned severity
  //                   ('info' for captured stdout, 'error' for stderr and
  //                   failure diagnostics).
  //   line     TEXT — the log line itself (no trailing newline).
  //
  // ADD COLUMN extension points (future migrations):
  //   ALTER TABLE task_logs ADD COLUMN seq INTEGER DEFAULT NULL;
  //   ALTER TABLE task_logs ADD COLUMN source TEXT DEFAULT NULL;
  //
  // TTL: rows where ts < NOW() - retention can be deleted by purgeOldTaskLogs().
  // No automatic deletion occurs here.
  {
    id: "001-task-logs",
    up: `
      CREATE TABLE IF NOT EXISTS task_logs (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        ts      TEXT    NOT NULL,
        task_id TEXT    NOT NULL,
        run_id  TEXT    NOT NULL,
        stream  TEXT    NOT NULL DEFAULT 'stdout',
        level   TEXT    NOT NULL DEFAULT 'info',
        line    TEXT    NOT NULL
      );

      -- Query patterns:
      --   SELECT … WHERE ts >= ? AND ts <= ?   → idx_task_logs_ts (purge, windows)
      --   SELECT … WHERE task_id = ?           → idx_task_logs_task_id
      --   SELECT … WHERE run_id = ?            → idx_task_logs_run_id (per-run tail)
      CREATE INDEX IF NOT EXISTS idx_task_logs_ts      ON task_logs(ts);
      CREATE INDEX IF NOT EXISTS idx_task_logs_task_id ON task_logs(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_logs_run_id  ON task_logs(run_id);
    `,
  },
];

/**
 * Apply every pending migration. Called automatically by
 * {@link openLogsDatabase}; exported for the same test seams state-db exposes.
 */
export function runMigrations(db: Database): void {
  runSqliteMigrations(db, MIGRATIONS);
}

// ── Row types ────────────────────────────────────────────────────────────────

/** Which pipe a log line was captured from. */
export type TaskLogStream = "stdout" | "stderr";

/** Runner-assigned severity of a log line. */
export type TaskLogLevel = "info" | "warn" | "error";

/** Raw SQLite row shape for the `task_logs` table. */
export interface TaskLogRow {
  id: number;
  ts: string;
  task_id: string;
  run_id: string;
  stream: TaskLogStream;
  level: TaskLogLevel;
  line: string;
}

// ── run_id ───────────────────────────────────────────────────────────────────

/**
 * Encode a task run's identity — the unique `(task_id, started_at)` pair from
 * state.db `task_history` — as a single run_id string.
 *
 * The format MUST stay in sync with the application-side join key that callers
 * build from a `task_history` row's `task_id` and `started_at`.
 */
export function buildTaskRunId(taskId: string, startedAtIso: string): string {
  return `${taskId}@${startedAtIso}`;
}

// ── Writer ───────────────────────────────────────────────────────────────────

/** One log line to insert. `stream`/`level` default to 'stdout'/'info'. */
export interface TaskLogLineInput {
  stream?: TaskLogStream;
  level?: TaskLogLevel;
  line: string;
}

/**
 * Insert a batch of log lines for one task run in a single transaction.
 * Returns the number of rows inserted. Lines are stored in array order
 * (ascending rowid), so reading back `ORDER BY id` reproduces emission order.
 *
 * Errors propagate — the task runner wraps this in its own best-effort
 * handling (mirroring `appendHistory`) so an unwritable logs.db never fails
 * a task run.
 */
export function insertTaskLogLines(
  db: Database,
  input: { taskId: string; runId: string; ts: string; lines: readonly TaskLogLineInput[] },
): number {
  if (input.lines.length === 0) return 0;
  const stmt = db.prepare(
    `INSERT INTO task_logs (ts, task_id, run_id, stream, level, line)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (const entry of input.lines) {
      stmt.run(input.ts, input.taskId, input.runId, entry.stream ?? "stdout", entry.level ?? "info", entry.line);
    }
  })();
  return input.lines.length;
}

// ── Readers ──────────────────────────────────────────────────────────────────

export interface QueryTaskLogsOptions {
  /** Filter to one task. */
  taskId?: string;
  /** Filter to one run (see {@link buildTaskRunId}). */
  runId?: string;
  /** Filter to one stream. */
  stream?: TaskLogStream;
  /** ISO timestamp lower bound (inclusive). */
  since?: string;
  /** ISO timestamp upper bound (exclusive). */
  until?: string;
  /** Cap the number of rows returned. */
  limit?: number;
}

/**
 * Read log lines matching the filter, in emission order (ascending id).
 *
 * Connection-lifetime rule (WS5): `.all()` materializes a plain array before
 * returning.
 */
export function queryTaskLogs(db: Database, options: QueryTaskLogsOptions = {}): TaskLogRow[] {
  const conditions: string[] = [];
  const params: SqlValue[] = [];
  if (options.taskId) {
    conditions.push("task_id = ?");
    params.push(options.taskId);
  }
  if (options.runId) {
    conditions.push("run_id = ?");
    params.push(options.runId);
  }
  if (options.stream) {
    conditions.push("stream = ?");
    params.push(options.stream);
  }
  if (options.since) {
    conditions.push("ts >= ?");
    params.push(options.since);
  }
  if (options.until) {
    conditions.push("ts < ?");
    params.push(options.until);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = options.limit !== undefined && options.limit >= 0 ? ` LIMIT ${Math.floor(options.limit)}` : "";
  return db
    .prepare(`SELECT id, ts, task_id, run_id, stream, level, line FROM task_logs ${where} ORDER BY id ASC${limit}`)
    .all(...params) as TaskLogRow[];
}

/**
 * Bulk membership check: which of `runIds` have at least one log row?
 * Used by `akm health` to compute the log-backing rate from the database
 * instead of `fs.existsSync` over scattered files. Chunked to stay under
 * SQLite's bound-parameter ceiling.
 */
export function getLoggedRunIds(db: Database, runIds: readonly string[]): Set<string> {
  const out = new Set<string>();
  if (runIds.length === 0) return out;
  const CHUNK = 500;
  for (let i = 0; i < runIds.length; i += CHUNK) {
    const chunk = runIds.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT DISTINCT run_id FROM task_logs WHERE run_id IN (${placeholders})`)
      .all(...chunk) as Array<{ run_id: string }>;
    for (const row of rows) out.add(row.run_id);
  }
  return out;
}

// ── Retention ────────────────────────────────────────────────────────────────

/**
 * Delete task_logs rows older than `retentionDays` (default: 90). Mirrors
 * `purgeOldEvents` / `purgeOldImproveRuns` in state-db.ts — same default, same
 * return shape (rows deleted), same disabled-when-non-positive semantics.
 * Wired into the improve maintenance pass alongside the state.db purges.
 */
export function purgeOldTaskLogs(db: Database, retentionDays = 90): number {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  const result = db.prepare("DELETE FROM task_logs WHERE ts < ?").run(cutoff);
  const changes = (result as { changes?: number | bigint }).changes ?? 0;
  return typeof changes === "bigint" ? Number(changes) : changes;
}
