// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The task_history read/write boundary: `appendHistory` (write) and
 * `readTaskHistory` / `taskHistoryRowToResult` (read).
 *
 * `appendHistory` is called by every dispatch arm (run-native-task.ts,
 * run-workflow-task.ts, run-command-task.ts), attempt-lifecycle.ts, and
 * run-task.ts's disabled-task path.
 *
 * `task_history` is DB-owned data, so legacy `target_kind` vocabulary is
 * rewritten by a one-time schema migration
 * (`025-task-history-vocabulary-backfill` in src/core/state/migrations.ts)
 * rather than a read-side shim. Every row the read side sees carries the
 * current vocabulary's `target_kind` strings; the null fallbacks still apply
 * (workflow `ref` falls back to `""`, the command arm's `engine` falls back
 * to `null`).
 *
 * A DAG leaf with respect to the rest of src/tasks/run/**: this module
 * imports TaskRunResult/TaskRunStatus's TYPE from ./task-result but no VALUE
 * from it, and nothing at all from ./task-log or ./attempt-lifecycle — so
 * nothing here risks closing an import cycle with a module that itself
 * imports appendHistory or readTaskHistory from here.
 */

import { rethrowIfTestIsolationError } from "../../core/errors";
import { withStateDb } from "../../core/state-db";
import { warn } from "../../core/warn";
import {
  decodeTaskHistoryMetadata,
  finalizeTaskHistoryAttempt,
  getTaskHistory,
  getTaskHistoryRuns,
  queryTaskHistory,
  type TaskHistoryRow,
  upsertTaskHistory,
} from "../../storage/repositories/task-history-repository";
import type { TaskRunResult, TaskRunStatus } from "./task-result";

/** Append (or finalize a reserved attempt into) one task_history row. */
export function appendHistory(result: TaskRunResult, historyReserved = false): void {
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
      // Every new row carries the vocabulary marker.
      targetVocab: 2,
      ...(result.target.kind === "command" ? { engine: result.target.engine } : {}),
    }),
  };
  try {
    withStateDb((db) => {
      if (historyReserved && finalizeTaskHistoryAttempt(db, row)) return;
      upsertTaskHistory(db, row);
    });
  } catch (error) {
    rethrowIfTestIsolationError(error);
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
  limit?: number;
}

export function readTaskHistory(options: ReadHistoryOptions = {}): TaskRunResult[] {
  return withStateDb((db) => {
    if (options.limit === 0) return [];
    if (options.id) {
      // An id-scoped query used the single-row helper, so `--limit` was silently
      // discarded and `akm task history --id X --limit 20` always returned one
      // run. The CLI documents --limit as "Maximum rows to return"; honour it.
      if (options.limit !== undefined && options.limit > 0) {
        return decodeTaskHistoryRows(getTaskHistoryRuns(db, options.id, options.limit));
      }
      const row = getTaskHistory(db, options.id);
      return row ? decodeTaskHistoryRows([row]) : [];
    }
    return decodeTaskHistoryRows(
      queryTaskHistory(db, options.limit !== undefined && options.limit > 0 ? { limit: options.limit } : {}),
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
  for (const row of rows) {
    try {
      results.push(taskHistoryRowToResult(row));
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
 * Reads `target_kind` directly in the current vocabulary — the
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
  };
}
