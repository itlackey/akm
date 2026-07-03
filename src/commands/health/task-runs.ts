// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Attribute each improve run to the scheduled `task_history` occurrence that
 * launched it and compute per-run wall times for `akm health --group-by run`.
 */

import type { Database } from "../../storage/database";
import { queryImproveRuns } from "../../storage/repositories/improve-runs-repository";
import { queryCompletedTaskIntervals, queryTaskHistory } from "../../storage/repositories/task-history-repository";
import { projectImproveRunSummary } from "./improve-metrics";
import type { ImproveRunSummary } from "./types";

interface TaskRunInterval {
  startMs: number;
  endMs: number;
  durationMs: number;
}

/**
 * Load task_history intervals for `task_id='akm-improve'` in the window.
 * Returned sorted by startMs ascending so containment lookups can use a
 * linear scan (typical N is ~24/day; not worth a tree).
 *
 * The window filter is widened by 5 minutes on each side because the cron
 * task wraps `akm improve` — the task `started_at` fires at e.g. :07:01
 * while `recordImproveRun` writes the matching `improve_runs.started_at`
 * later (after config load, planning, etc.), so the improve_runs row can
 * be inside the window even when its enclosing task_history row started
 * just before the window opened.
 */
function loadTaskIntervals(db: Database, since: string, until?: string): TaskRunInterval[] {
  const sinceMs = new Date(since).getTime();
  const untilMs = until ? new Date(until).getTime() : Number.POSITIVE_INFINITY;
  const widenedSince = new Date(sinceMs - 5 * 60 * 1000).toISOString();
  const widenedUntil = Number.isFinite(untilMs) ? new Date(untilMs + 5 * 60 * 1000).toISOString() : undefined;

  const rows = queryCompletedTaskIntervals(db, widenedSince, widenedUntil);

  const intervals: TaskRunInterval[] = [];
  for (const row of rows) {
    const startMs = new Date(row.started_at).getTime();
    const endMs = new Date(row.completed_at).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) continue;
    intervals.push({ startMs, endMs, durationMs: endMs - startMs });
  }
  return intervals;
}

/**
 * Find the task_history interval that contains the given timestamp. The
 * task wraps `akm improve`, so `improve_runs.started_at` (when
 * `recordImproveRun` writes) always falls inside the enclosing task's
 * [started_at, completed_at]. Returns undefined when no interval
 * contains the timestamp (which happens for manually-invoked improve
 * runs not driven by the `akm-improve` task).
 *
 * Linear scan because N is small. We tolerate a 1s slop on the upper
 * bound to handle clock skew between the wrapper's `completed_at` write
 * and recordImproveRun's `started_at` write.
 */
function findContainingTaskInterval(timestampMs: number, intervals: TaskRunInterval[]): TaskRunInterval | undefined {
  const SLOP_MS = 1000;
  for (const interval of intervals) {
    if (timestampMs >= interval.startMs && timestampMs <= interval.endMs + SLOP_MS) {
      return interval;
    }
  }
  return undefined;
}

/** A scheduled-task occurrence used to attribute an improve run to its task. */
interface ImproveTaskRun {
  taskId: string;
  startMs: number;
  endMs: number;
}

/**
 * Load `task_history` rows whose `task_id` begins `akm-improve` (the scheduled
 * improve tasks: `akm-improve-frequent`, `akm-improve-proactive-weekly`, …) in
 * the window, widened ±5 min so a task that fired just before the window opened
 * still matches a run inside it. Used to attribute each improve run to the task
 * that launched it.
 */
function loadImproveTaskRuns(db: Database, since: string, until?: string): ImproveTaskRun[] {
  const sinceMs = new Date(since).getTime();
  const untilMs = until ? new Date(until).getTime() : undefined;
  const widenedSince = new Date(sinceMs - 5 * 60 * 1000).toISOString();
  const widenedUntil = untilMs !== undefined ? new Date(untilMs + 5 * 60 * 1000).toISOString() : undefined;
  const runs: ImproveTaskRun[] = [];
  for (const row of queryTaskHistory(db, { since: widenedSince, until: widenedUntil })) {
    if (!row.task_id.startsWith("akm-improve")) continue;
    const startMs = new Date(row.started_at).getTime();
    if (!Number.isFinite(startMs)) continue;
    const endIso = row.completed_at ?? row.failed_at;
    const endMs = endIso ? new Date(endIso).getTime() : Number.NaN;
    runs.push({ taskId: row.task_id, startMs, endMs });
  }
  return runs;
}

/**
 * Attribute an improve run to the scheduled task that launched it by matching
 * start times within ±5 min, scored by start delta (plus end delta when both
 * ends are known). Port of the health-report skill's `match_task_id`. Returns
 * `"manual"` when no scheduled improve task matches.
 */
export function matchImproveTaskId(startedAt: string, completedAt: string | null, taskRuns: ImproveTaskRun[]): string {
  const startMs = new Date(startedAt).getTime();
  if (!Number.isFinite(startMs)) return "manual";
  const endMs = completedAt ? new Date(completedAt).getTime() : Number.NaN;
  let best: string | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const task of taskRuns) {
    const startDelta = Math.abs(task.startMs - startMs);
    if (startDelta > 5 * 60 * 1000) continue;
    let score = startDelta;
    if (Number.isFinite(endMs) && Number.isFinite(task.endMs)) score += Math.abs(task.endMs - endMs);
    if (score < bestScore) {
      bestScore = score;
      best = task.taskId;
    }
  }
  return best ?? "manual";
}

export function buildPerRunSummaries(db: Database, since: string, until?: string): ImproveRunSummary[] {
  const rows = queryImproveRuns(db, since, until);
  const taskIntervals = loadTaskIntervals(db, since, until);
  const improveTaskRuns = loadImproveTaskRuns(db, since, until);
  const summaries: ImproveRunSummary[] = [];
  for (const row of rows) {
    const startMs = new Date(row.started_at).getTime();
    const endMs = new Date(row.completed_at).getTime();
    // Prefer the improve_runs row's own (completed_at - started_at) delta:
    // recordImproveRun now persists distinct start/end timestamps, so the
    // row's own delta is the authoritative per-run wall time even for
    // manually-invoked `akm improve` runs with no enclosing task_history.
    // Only fall back to the task_history containing-interval join for legacy/
    // backfill rows where started_at == completed_at (row delta is 0).
    const hasRowDelta = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs;
    let wallTimeMs: number;
    if (hasRowDelta) {
      wallTimeMs = endMs - startMs;
    } else {
      const interval = Number.isFinite(startMs) ? findContainingTaskInterval(startMs, taskIntervals) : undefined;
      wallTimeMs = interval?.durationMs ?? 0;
    }
    const taskId = matchImproveTaskId(row.started_at, row.completed_at, improveTaskRuns);
    summaries.push(projectImproveRunSummary(row, wallTimeMs, taskId));
  }
  return summaries;
}
