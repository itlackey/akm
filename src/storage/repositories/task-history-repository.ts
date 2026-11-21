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

import { isRecord } from "../../core/common";
import { warnOnce } from "../../core/warn";
import type { Database, SqlValue } from "../database";

export type TaskHistoryDetail = {
  runId?: string;
  reason?: string;
  error?: string;
  exitCode?: number | null;
};

/** Which run of a version 5 task a row is an attempt of, and the step of another run that started it. */
export interface TaskHistoryRun {
  id: string;
  parent?: { task: string; run: string; step: string };
}

/** Experimental: one step of a `steps:` task run, as recorded in `metadata_json`. */
export interface TaskHistoryStep {
  name: string;
  kind: "run" | "prompt" | "task" | "exec";
  status: "completed" | "failed" | "skipped" | "reused";
  durationMs: number;
  attempts: number;
  /** Why the step failed. */
  reason?: string;
  /** The bounded result; kept only on a failed run, so `--resume` can reuse it. */
  result?: string;
  /** When a `task:` step's own run started (its own history row). */
  startedAt?: string;
}

export interface TaskHistoryMetadata {
  metadataVersion: 2;
  durationMs: number;
  detail: TaskHistoryDetail | null;
  engine?: string | null;
  /** Steps of a `steps:` task run (Experimental); absent for every other task. */
  steps?: TaskHistoryStep[];
  /** Whether the OS scheduler (`schedule`) or a person or script (`manual`) started the run; absent when not recorded. */
  trigger?: "schedule" | "manual";
  /** The version 5 run this row is an attempt of; absent for every other task. */
  run?: TaskHistoryRun;
  /** The bundle the task was read from; absent on rows written before it was recorded. */
  bundle?: string;
  /** The process that reserved the attempt; present only while the row is `active`. Absent on rows reserved before it was recorded. */
  owner?: TaskHistoryOwner;
}

/** Who is executing an `active` attempt: enough to tell a live owner from a gone one on the same host. */
export interface TaskHistoryOwner {
  pid: number;
  host: string;
  /** Kernel boot id and process start time (Linux); absent where `/proc` is unavailable. */
  bootId?: string;
  startTime?: string;
}

function metadataError(message: string): never {
  throw new Error(`invalid task_history metadata_json: ${message}`);
}

function validateDetail(value: unknown): asserts value is TaskHistoryDetail | null | undefined {
  if (value === undefined || value === null) return;
  if (!isRecord(value)) metadataError("detail must be an object or null");
  for (const field of ["runId", "reason", "error"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string")
      metadataError(`detail.${field} must be a string`);
  }
  if (value.exitCode !== undefined && value.exitCode !== null && typeof value.exitCode !== "number") {
    metadataError("detail.exitCode must be a number or null");
  }
}

/**
 * Decode the task-history metadata shape.
 *
 * Read-time compatibility shim (mirrors proposals-repository's
 * `storedToChanges`): `metadataVersion` was added in a later release. 58% of
 * a real install's `task_history` rows (8,596/14,801) predate the field
 * entirely, and 88 more carry additive fields (`profile`, `repairReason`)
 * written by prior releases. An absent `metadataVersion` is a LEGACY row, not
 * corruption — decode what's present (defaulting the absent `detail` key to
 * `null`) instead of throwing. Unknown keys are ignored rather than
 * hard-rejected, so the next additive field never regresses this again;
 * neither `profile` nor `repairReason` is read anywhere downstream, so they
 * are dropped harmlessly rather than round-tripped. A `metadataVersion` that
 * IS present but not `2` is a genuinely unknown/future shape and still
 * rejected, as is a non-number `durationMs` or a `detail` that fails
 * {@link validateDetail} — real corruption, not version skew.
 */
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

  if (parsed.metadataVersion !== undefined && parsed.metadataVersion !== 2) {
    warnOnce(
      `task-history-metadata-version:${String(parsed.metadataVersion)}`,
      `task_history row has metadataVersion ${String(parsed.metadataVersion)}, newer than this akm's 2 — ` +
        "decoding it best-effort as version 2 rather than rejecting the row.",
    );
  }
  if (typeof parsed.durationMs !== "number") metadataError("durationMs must be a number");
  const detail = "detail" in parsed ? parsed.detail : null;
  // A malformed `engine` (wrong type) is dropped like any other unrecognized
  // field rather than rejecting the whole row over a non-essential value.
  const engine = parsed.engine === null || typeof parsed.engine === "string" ? parsed.engine : undefined;
  const trigger = parsed.trigger === "schedule" || parsed.trigger === "manual" ? parsed.trigger : undefined;
  validateDetail(detail);
  const steps = decodeSteps(parsed.steps);
  const run = decodeRun(parsed.run);
  const bundle = typeof parsed.bundle === "string" ? parsed.bundle : undefined;
  const owner = decodeOwner(parsed.owner);
  const cleanDetail: TaskHistoryDetail | null = detail
    ? {
        ...(detail.runId !== undefined ? { runId: detail.runId } : {}),
        ...(detail.reason !== undefined ? { reason: detail.reason } : {}),
        ...(detail.error !== undefined ? { error: detail.error } : {}),
        ...(detail.exitCode !== undefined ? { exitCode: detail.exitCode } : {}),
      }
    : null;
  return {
    metadataVersion: 2,
    durationMs: parsed.durationMs,
    detail: cleanDetail,
    ...(engine !== undefined ? { engine } : {}),
    ...(steps !== undefined ? { steps } : {}),
    ...(trigger !== undefined ? { trigger } : {}),
    ...(run !== undefined ? { run } : {}),
    ...(bundle !== undefined ? { bundle } : {}),
    ...(owner !== undefined ? { owner } : {}),
  };
}

/** Tolerant: a malformed `run` is dropped, never a reason to reject the row. */
function decodeRun(value: unknown): TaskHistoryRun | undefined {
  if (!isRecord(value) || typeof value.id !== "string") return undefined;
  const parent = value.parent;
  const named =
    isRecord(parent) &&
    typeof parent.task === "string" &&
    typeof parent.run === "string" &&
    typeof parent.step === "string";
  return {
    id: value.id,
    ...(named
      ? { parent: { task: parent.task as string, run: parent.run as string, step: parent.step as string } }
      : {}),
  };
}

/** Tolerant: a malformed `owner` is dropped, never a reason to reject the row. */
function decodeOwner(value: unknown): TaskHistoryOwner | undefined {
  if (!isRecord(value) || typeof value.pid !== "number" || typeof value.host !== "string") return undefined;
  return {
    pid: value.pid,
    host: value.host,
    ...(typeof value.bootId === "string" ? { bootId: value.bootId } : {}),
    ...(typeof value.startTime === "string" ? { startTime: value.startTime } : {}),
  };
}

const STEP_STATUSES = new Set(["completed", "failed", "skipped", "reused"]);
const STEP_KINDS = new Set(["run", "prompt", "task", "exec"]);

/** Tolerant: a malformed `steps` value is dropped, never a reason to reject the row. */
function decodeSteps(value: unknown): TaskHistoryStep[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const steps: TaskHistoryStep[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.name !== "string") continue;
    if (!STEP_STATUSES.has(entry.status as string) || !STEP_KINDS.has(entry.kind as string)) continue;
    steps.push({
      name: entry.name,
      kind: entry.kind as TaskHistoryStep["kind"],
      status: entry.status as TaskHistoryStep["status"],
      durationMs: typeof entry.durationMs === "number" ? entry.durationMs : 0,
      attempts: typeof entry.attempts === "number" ? entry.attempts : 1,
      ...(typeof entry.reason === "string" ? { reason: entry.reason } : {}),
      ...(typeof entry.result === "string" ? { result: entry.result } : {}),
      ...(typeof entry.startedAt === "string" ? { startedAt: entry.startedAt } : {}),
    });
  }
  return steps;
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
 * Atomically reserve one task-attempt identity.
 *
 * The existing unique `(task_id, started_at)` index arbitrates concurrent
 * processes: exactly one caller receives `true` for a candidate timestamp.
 * Callers can advance by one millisecond and retry without a schema change.
 */
export function reserveTaskHistoryAttempt(db: Database, row: TaskHistoryRow): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO task_history
         (task_id, status, started_at, completed_at, failed_at, log_path,
          target_kind, target_ref, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
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
  return Number(result.changes) === 1;
}

/** Finalize a row previously created by {@link reserveTaskHistoryAttempt}. */
export function finalizeTaskHistoryAttempt(db: Database, row: TaskHistoryRow): boolean {
  const result = db
    .prepare(
      `UPDATE task_history
       SET status = ?, completed_at = ?, failed_at = ?, log_path = ?,
           target_kind = ?, target_ref = ?, metadata_json = ?
       WHERE task_id = ? AND started_at = ?
         AND status = 'active' AND completed_at IS NULL`,
    )
    .run(
      row.status,
      row.completed_at ?? null,
      row.failed_at ?? null,
      row.log_path ?? null,
      row.target_kind ?? null,
      row.target_ref ?? null,
      row.metadata_json,
      row.task_id,
      row.started_at,
    );
  return Number(result.changes) === 1;
}

/** Mark a still-`active` attempt `interrupted`: its owner is provably gone and it never recorded a finish. */
export function markTaskHistoryAttemptInterrupted(db: Database, id: number): boolean {
  const result = db
    .prepare(
      "UPDATE task_history SET status = 'interrupted' WHERE id = ? AND status = 'active' AND completed_at IS NULL",
    )
    .run(id);
  return Number(result.changes) === 1;
}

/** Every attempt still `active` and unfinished, oldest first. */
export function listActiveTaskHistoryAttempts(db: Database): TaskHistoryRow[] {
  return db
    .prepare(
      `SELECT id, task_id, status, started_at, completed_at, failed_at, log_path,
              target_kind, target_ref, metadata_json
       FROM task_history WHERE status = 'active' AND completed_at IS NULL ORDER BY started_at ASC, id ASC`,
    )
    .all() as TaskHistoryRow[];
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
       FROM task_history WHERE task_id = ? ORDER BY started_at DESC, id DESC LIMIT 1`,
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
       FROM task_history WHERE task_id = ? ORDER BY started_at DESC, id DESC LIMIT ?`,
    )
    .all(taskId, limit) as TaskHistoryRow[];
}

/**
 * Query task history rows by started_at range and/or status.
 */
export function queryTaskHistory(
  db: Database,
  options: {
    taskId?: string;
    /** Only rows that recorded this bundle. */
    bundle?: string;
    since?: string;
    until?: string;
    status?: string;
    targetKind?: string;
    targetRef?: string;
    limit?: number;
  } = {},
): TaskHistoryRow[] {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (options.taskId) {
    conditions.push("task_id = ?");
    params.push(options.taskId);
  }
  if (options.bundle) {
    conditions.push("json_extract(metadata_json, '$.bundle') = ?");
    params.push(options.bundle);
  }
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
  const limit = options.limit !== undefined ? "LIMIT ?" : "";
  if (options.limit !== undefined) params.push(options.limit);
  return db
    .prepare(
      `SELECT task_id, status, started_at, completed_at, failed_at, log_path,
              target_kind, target_ref, metadata_json
       FROM task_history ${where} ORDER BY started_at DESC, id DESC ${limit}`,
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

/**
 * Preview counterpart of {@link renameTaskHistoryTargetRefs} for `akm bundle
 * rename --dry-run`: the same `WHERE` predicate, read-only.
 */
export function countTaskHistoryTargetRefs(db: Database, oldBundleId: string): number {
  const prefix = `${oldBundleId}//`;
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM task_history WHERE substr(target_ref, 1, length(?)) = ?`)
      .get(prefix, prefix) as {
      n: number;
    }
  ).n;
}

/**
 * Rewrite every `task_history.target_ref` naming `oldBundleId` (a workflow
 * run's fully-qualified `<bundle>//conceptId` target) to `newBundleId`
 * (`akm bundle rename`, D6). A row whose `target_ref` is unset or not
 * bundle-qualified is not matched by the `<old>//` prefix and is left alone.
 * Returns the number of rows rewritten.
 */
export function renameTaskHistoryTargetRefs(db: Database, oldBundleId: string, newBundleId: string): number {
  const prefix = `${oldBundleId}//`;
  return Number(
    db
      .prepare(
        `UPDATE task_history SET target_ref = ? || substr(target_ref, length(?) + 1) WHERE substr(target_ref, 1, length(?)) = ?`,
      )
      .run(newBundleId, oldBundleId, prefix, prefix).changes,
  );
}
