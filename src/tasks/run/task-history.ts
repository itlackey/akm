// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The task_history read/write boundary: `appendHistory` (write) and
 * `readTaskHistory` / `taskHistoryRowToResult` (read).
 *
 * `appendHistory` is exported because every dispatch arm (run-native-task.ts,
 * run-workflow-task.ts, run-command-task.ts) and attempt-lifecycle.ts call it.
 *
 * The READ side carries no legacy-vocabulary mapping: `task_history` is
 * DB-owned data, so the remap to the current vocabulary is a one-time schema
 * migration (`025-task-history-vocabulary-backfill` in
 * src/core/state/migrations.ts) rather than a read-side shim run forever.
 * Every row this function sees carries the current vocabulary's `target_kind`
 * strings; the null fallbacks still apply (workflow `ref` falls back to `""`,
 * the command arm's `engine` falls back to `null`).
 *
 * A DAG leaf with respect to the rest of src/tasks/run/**: this module
 * imports TaskRunResult/TaskRunStatus's TYPE from ./task-result but no VALUE
 * from it, and nothing at all from ./task-log or ./attempt-lifecycle — so
 * nothing here risks closing an import cycle with a module that itself
 * imports appendHistory or readTaskHistory from here.
 */

import { parseBundleRef } from "../../core/asset/asset-ref";
import { withStateDb } from "../../core/state-db";
import { warn } from "../../core/warn";
import {
  decodeTaskHistoryMetadata,
  finalizeTaskHistoryAttempt,
  queryTaskHistory,
  type TaskHistoryRow,
  upsertTaskHistory,
} from "../../storage/repositories/task-history-repository";
import { classifyAttempt, hereNow } from "./attempt-liveness";
import type { TaskRunResult, TaskRunStatus } from "./task-result";

/** The `bundle` a task's history row records, from its qualified ref `bundle//tasks/<name>`. */
export function taskBundle(taskRef: string): { bundle?: string } {
  const { bundle } = parseBundleRef(taskRef);
  return bundle === undefined ? {} : { bundle };
}

/**
 * Append (or finalize a reserved attempt into) one task_history row. `scheduled` says whether the OS scheduler started
 * the run (stored as `trigger`); a caller that does not know leaves it out.
 */
export function appendHistory(result: TaskRunResult, historyReserved = false, scheduled?: boolean): void {
  const row = {
    task_id: result.id,
    status: result.status,
    started_at: result.startedAt,
    completed_at: result.finishedAt,
    failed_at: result.status === "failed" ? result.finishedAt : null,
    log_path: result.log || null,
    target_kind: result.target.kind === "unknown" ? null : result.target.kind,
    target_ref: result.target.kind === "workflow" ? result.target.ref : null,
    metadata_json: JSON.stringify({
      metadataVersion: 2,
      durationMs: result.durationMs,
      detail: result.detail ?? null,
      ...(result.target.kind === "command" ? { engine: result.target.engine } : {}),
      ...(result.steps ? { steps: result.steps } : {}),
      ...(result.run ? { run: result.run } : {}),
      ...(result.bundle ? { bundle: result.bundle } : {}),
      ...(scheduled === undefined ? {} : { trigger: scheduled ? "schedule" : "manual" }),
    }),
  };
  try {
    withStateDb((db) => {
      if (historyReserved && finalizeTaskHistoryAttempt(db, row)) return;
      upsertTaskHistory(db, row);
    });
  } catch (error) {
    // History recording must not alter the task's own result/exit status —
    // the task already ran and its outcome is independent of whether we can
    // persist a history row. But silence would make a failed write
    // indistinguishable from the task never having run, so warn.
    warn(
      `task history: failed to record history for task ${result.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Read recent history rows for one or all tasks.
 *
 * Returns rows in reverse-chronological order, optionally limited.
 */
export interface ReadHistoryOptions {
  id?: string;
  /** Only the rows of this bundle, and those that recorded none: a row written before the bundle was recorded is shown without one. */
  bundle?: string;
  limit?: number;
}

export function readTaskHistory(options: ReadHistoryOptions = {}): TaskRunResult[] {
  return withStateDb((db) => {
    if (options.limit === 0) return [];
    // An id-scoped query without a limit is the latest run: `--limit` is "Maximum rows to return" and is honoured.
    const limit = options.limit !== undefined && options.limit > 0 ? options.limit : options.id ? 1 : undefined;
    return decodeTaskHistoryRows(
      queryTaskHistory(db, {
        ...(options.id ? { taskId: options.id } : {}),
        ...(options.bundle ? { bundle: options.bundle } : {}),
        ...(limit !== undefined ? { limit } : {}),
      }),
    );
  });
}

/**
 * Per-row skip-and-warn (mirrors `listStateProposals` in
 * proposals-repository.ts): a single genuinely-corrupt `metadata_json` row
 * must not abort the entire history read. `decodeTaskHistoryMetadata` (via
 * `taskHistoryRowToResult`) already tolerates legacy/additive shapes; only
 * real corruption reaches this catch.
 */
function decodeTaskHistoryRows(rows: TaskHistoryRow[]): TaskRunResult[] {
  const results: TaskRunResult[] = [];
  const here = rows.some((row) => row.status === "active") ? hereNow() : undefined;
  for (const row of rows) {
    try {
      const result = taskHistoryRowToResult(row);
      // An attempt whose owner is gone is shown as interrupted without waiting for a later start to write it.
      results.push(
        here && row.status === "active" && classifyAttempt(row, here) === "interrupted"
          ? { ...result, status: "interrupted" }
          : result,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[akm] Skipping unparseable task_history row (task_id=${row.task_id}, started_at=${row.started_at}): ${message}`,
      );
    }
  }
  return results;
}

/**
 * Convert a `TaskHistoryRow` from state.db back to a `TaskRunResult` shape
 * that callers of `readTaskHistory()` expect.
 *
 * Reads `target_kind` directly in the current (post-D8) vocabulary — the
 * `025-task-history-vocabulary-backfill` state migration rewrites every
 * legacy-vocabulary row before this ever runs against it.
 */
function taskHistoryRowToResult(row: TaskHistoryRow): TaskRunResult {
  const meta = decodeTaskHistoryMetadata(row.metadata_json);

  const target: TaskRunResult["target"] = (() => {
    switch (row.target_kind) {
      case "workflow":
        return { kind: "workflow", ref: row.target_ref ?? "" };
      case "command":
        return { kind: "command", engine: meta.engine ?? null };
      case "shell":
        return { kind: "shell" };
      case "script":
        return { kind: "script" };
      case "steps":
        return { kind: "steps" };
      default:
        return { kind: "unknown" };
    }
  })();

  return {
    id: row.task_id,
    status: row.status as TaskRunStatus,
    startedAt: row.started_at,
    finishedAt: row.completed_at ?? row.failed_at ?? row.started_at,
    durationMs: meta.durationMs,
    log: row.log_path ?? "",
    target,
    ...(meta.detail ? { detail: meta.detail } : {}),
    ...(meta.steps ? { steps: meta.steps } : {}),
    ...(meta.trigger ? { trigger: meta.trigger } : {}),
    ...(meta.run ? { run: meta.run } : {}),
    ...(meta.bundle ? { bundle: meta.bundle } : {}),
  };
}
