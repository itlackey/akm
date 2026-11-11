// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Attribute each improve run to the scheduled `task_history` occurrence that
 * launched it and compute per-run wall times for `akm health --group-by run`.
 */

import type { Database } from "../../storage/database";
import { queryImproveRuns } from "../../storage/repositories/improve-runs-repository";
import { queryTaskHistory } from "../../storage/repositories/task-history-repository";
import { projectImproveRunSummary } from "./improve-metrics";
import type { ImproveRunSummary } from "./types";

/** A scheduled-task occurrence used to attribute an improve run to its task. */
interface ImproveTaskRun {
  taskId: string;
  startMs: number;
  endMs: number;
}

/**
 * Load the shipped `improve` task and older `akm-improve*` tasks in
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
    if (row.task_id !== "improve" && !row.task_id.startsWith("akm-improve")) continue;
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
export function matchImproveTaskId(startedAt: string, completedAt: string, taskRuns: ImproveTaskRun[]): string {
  const startMs = new Date(startedAt).getTime();
  if (!Number.isFinite(startMs)) return "manual";
  const endMs = new Date(completedAt).getTime();
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
  const improveTaskRuns = loadImproveTaskRuns(db, since, until);
  const summaries: ImproveRunSummary[] = [];
  for (const row of rows) {
    const startMs = new Date(row.started_at).getTime();
    const endMs = new Date(row.completed_at).getTime();
    const wallTimeMs = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs ? endMs - startMs : 0;
    const taskId = matchImproveTaskId(row.started_at, row.completed_at, improveTaskRuns);
    summaries.push(projectImproveRunSummary(row, wallTimeMs, taskId));
  }
  return summaries;
}
