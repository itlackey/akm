// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Repository for the state.db `task_history` table (per-task run ledger,
 * replaces the old per-task JSONL files). Extracted verbatim from
 * core/state-db.ts — queries unchanged, only relocated behind the repository
 * boundary. Re-exported by core/state-db.ts so existing importers resolve.
 *
 * @module task-history-repository
 */

import type { Database, SqlValue } from "../database";

export type TaskHistoryDetail = {
  runId?: string;
  reason?: string;
  error?: string;
  exitCode?: number | null;
};

export type TaskHistoryMetadata =
  | {
      metadataVersion: 1;
      durationMs?: number;
      detail?: TaskHistoryDetail;
      legacyProfile?: string;
    }
  | {
      metadataVersion: 2;
      durationMs: number;
      detail: TaskHistoryDetail | null;
      engine?: string | null;
    };

function metadataError(message: string): never {
  throw new Error(`invalid task_history metadata_json: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateDetail(value: unknown): asserts value is TaskHistoryDetail | null | undefined {
  if (value === undefined || value === null) return;
  if (!isRecord(value)) metadataError("detail must be an object or null");
  const allowed = new Set(["runId", "reason", "error", "exitCode"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) metadataError(`unknown detail fields: ${unknown.sort().join(", ")}`);
  for (const field of ["runId", "reason", "error"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string")
      metadataError(`detail.${field} must be a string`);
  }
  if (value.exitCode !== undefined && value.exitCode !== null && typeof value.exitCode !== "number") {
    metadataError("detail.exitCode must be a number or null");
  }
}

/** Decode historical v1 and current v2 metadata without cross-version aliases. */
export function decodeTaskHistoryMetadata(input: string | unknown): TaskHistoryMetadata {
  let parsed: unknown = input;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input);
    } catch {
      metadataError("not valid JSON");
    }
  }
  if (!isRecord(parsed)) metadataError("root must be an object");

  const version = parsed.metadataVersion ?? 1;
  if (version === 1) {
    const allowed = new Set(["metadataVersion", "durationMs", "detail", "profile"]);
    const unknown = Object.keys(parsed).filter((key) => !allowed.has(key));
    if (unknown.length > 0) metadataError(`unknown v1 fields: ${unknown.sort().join(", ")}`);
    if (parsed.metadataVersion !== undefined && parsed.metadataVersion !== 1)
      metadataError("invalid v1 metadataVersion");
    if (parsed.durationMs !== undefined && typeof parsed.durationMs !== "number")
      metadataError("durationMs must be a number");
    if (parsed.profile !== undefined && typeof parsed.profile !== "string") metadataError("profile must be a string");
    validateDetail(parsed.detail);
    return {
      metadataVersion: 1,
      ...(typeof parsed.durationMs === "number" ? { durationMs: parsed.durationMs } : {}),
      ...(parsed.detail !== undefined && parsed.detail !== null ? { detail: parsed.detail } : {}),
      ...(typeof parsed.profile === "string" ? { legacyProfile: parsed.profile } : {}),
    };
  }

  if (version === 2) {
    const allowed = new Set(["metadataVersion", "durationMs", "detail", "engine"]);
    const unknown = Object.keys(parsed).filter((key) => !allowed.has(key));
    if (unknown.length > 0) metadataError(`unknown v2 fields: ${unknown.sort().join(", ")}`);
    if (typeof parsed.durationMs !== "number") metadataError("durationMs must be a number");
    if (!("detail" in parsed)) metadataError("detail is required in v2");
    if (parsed.engine !== undefined && parsed.engine !== null && typeof parsed.engine !== "string") {
      metadataError("engine must be a string or null");
    }
    validateDetail(parsed.detail);
    return {
      metadataVersion: 2,
      durationMs: parsed.durationMs,
      detail: parsed.detail ?? null,
      ...(parsed.engine !== undefined ? { engine: parsed.engine as string | null } : {}),
    };
  }

  metadataError(`unsupported metadataVersion: ${String(version)}`);
}

/**
 * Raw SQLite row shape for the `task_history` table.
 */
export interface TaskHistoryRow {
  id?: number; // AUTOINCREMENT — absent on insert, present on read
  task_id: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  failed_at: string | null;
  log_path: string | null;
  target_kind: string | null;
  target_ref: string | null;
  metadata_json: string;
}

/**
 * Upsert a task history row.
 */
export function upsertTaskHistory(db: Database, row: TaskHistoryRow): void {
  // INSERT OR IGNORE: if a run with the same (task_id, started_at) was already
  // imported (e.g. by the migration script), skip it silently.
  db.prepare(`
    INSERT OR IGNORE INTO task_history
      (task_id, status, started_at, completed_at, failed_at, log_path,
       target_kind, target_ref, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.task_id,
    row.status,
    row.started_at,
    row.completed_at ?? null,
    row.failed_at ?? null,
    row.log_path ?? null,
    row.target_kind ?? null,
    row.target_ref ?? null,
    row.metadata_json,
  );
}

/**
 * Look up a task history row by task_id. Returns undefined when not found.
 */
/**
 * Return the most recent run for a given task_id, or undefined if no runs exist.
 */
export function getTaskHistory(db: Database, taskId: string): TaskHistoryRow | undefined {
  return db
    .prepare(
      `SELECT id, task_id, status, started_at, completed_at, failed_at, log_path,
              target_kind, target_ref, metadata_json
       FROM task_history WHERE task_id = ? ORDER BY started_at DESC LIMIT 1`,
    )
    .get(taskId) as TaskHistoryRow | undefined;
}

/**
 * Return all runs for a given task_id, newest first.
 */
export function getTaskHistoryRuns(db: Database, taskId: string, limit = 50): TaskHistoryRow[] {
  return db
    .prepare(
      `SELECT id, task_id, status, started_at, completed_at, failed_at, log_path,
              target_kind, target_ref, metadata_json
       FROM task_history WHERE task_id = ? ORDER BY started_at DESC LIMIT ?`,
    )
    .all(taskId, limit) as TaskHistoryRow[];
}

/**
 * Query task history rows by started_at range and/or status.
 */
export function queryTaskHistory(
  db: Database,
  options: { since?: string; until?: string; status?: string; targetKind?: string; targetRef?: string } = {},
): TaskHistoryRow[] {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (options.since) {
    conditions.push("started_at >= ?");
    params.push(options.since);
  }
  if (options.until) {
    conditions.push("started_at <= ?");
    params.push(options.until);
  }
  if (options.status) {
    conditions.push("status = ?");
    params.push(options.status);
  }
  if (options.targetKind) {
    conditions.push("target_kind = ?");
    params.push(options.targetKind);
  }
  if (options.targetRef) {
    conditions.push("target_ref = ?");
    params.push(options.targetRef);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return db
    .prepare(
      `SELECT task_id, status, started_at, completed_at, failed_at, log_path,
              target_kind, target_ref, metadata_json
       FROM task_history ${where} ORDER BY started_at DESC`,
    )
    .all(...(params as SqlValue[])) as TaskHistoryRow[];
}

/**
 * Slim projection of a `task_history` row used by health interval analysis.
 */
export interface TaskIntervalRow {
  started_at: string;
  completed_at: string;
}

/**
 * Read COMPLETED `akm-improve` task_history runs whose `started_at` falls in
 * `[since, until)` (or `started_at >= since` when `until` is omitted), ordered
 * oldest-first by `started_at`. Only rows with a non-null `completed_at` are
 * returned (in-flight runs are excluded). The `task_id = 'akm-improve'`
 * predicate is fixed because the only caller (commands/health.ts
 * `loadTaskIntervals`) builds wall-time intervals for the improve cron task.
 *
 * Owns the SQL formerly inlined in commands/health.ts. Note the bound is
 * EXCLUSIVE on the upper end (`started_at < ?`) — callers pass an already
 * widened window; this helper does not widen.
 *
 * Connection-lifetime rule (WS5): `.all()` materializes a plain array before
 * returning.
 */
export function queryCompletedTaskIntervals(db: Database, since: string, until?: string): TaskIntervalRow[] {
  const sql = until
    ? "SELECT started_at, completed_at FROM task_history WHERE task_id = 'akm-improve' AND started_at >= ? AND started_at < ? AND completed_at IS NOT NULL ORDER BY started_at"
    : "SELECT started_at, completed_at FROM task_history WHERE task_id = 'akm-improve' AND started_at >= ? AND completed_at IS NOT NULL ORDER BY started_at";
  return (until ? db.prepare(sql).all(since, until) : db.prepare(sql).all(since)) as TaskIntervalRow[];
}
