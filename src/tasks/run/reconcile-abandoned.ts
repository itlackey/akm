// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Settle execution state whose owner is provably gone: an `active` task attempt whose owner `classifyAttempt`
 * (`./attempt-liveness`) proves gone is marked `interrupted`, with its finish time and outcome unknown. An attempt of a
 * version 5 run also says which step was running, read from the run's record, which is written after every step.
 * Whether the owner is gone never depends on elapsed time: a long-running attempt with a live owner stays `active`.
 */

import fs from "node:fs";
import { probeLock } from "../../core/file-lock";
import { withStateDb } from "../../core/state-db";
import type { Database } from "../../storage/database";
import {
  decodeTaskHistoryMetadata,
  listActiveTaskHistoryAttempts,
  markTaskHistoryAttemptInterrupted,
  type TaskHistoryRow,
  type TaskHistoryStep,
} from "../../storage/repositories/task-history-repository";
import { WorkflowRunsRepository } from "../../storage/repositories/workflow-runs-repository";
import { workflowRunLockPath } from "../../workflows/exec/run-workflow";
import { taskV5StepLabel } from "../v5/source";
import { runRecordPath } from "./attempt-lifecycle";
import { classifyAttempt, hereNow } from "./attempt-liveness";

/**
 * What an interrupted attempt of a version 5 run records: its steps (those the run's record shows finished, the one
 * that was running, the rest skipped), and the step named in the reason. A record that cannot be read says so.
 */
function interruptedMetadata(row: TaskHistoryRow): string | undefined {
  let meta: ReturnType<typeof decodeTaskHistoryMetadata>;
  try {
    meta = decodeTaskHistoryMetadata(row.metadata_json);
  } catch {
    return undefined;
  }
  if (!meta.run) return undefined;
  const withDetail = (detail: { reason: string; error: string }, steps?: TaskHistoryStep[]): string =>
    JSON.stringify({ ...JSON.parse(row.metadata_json), detail, ...(steps ? { steps } : {}) });
  let record: { steps?: { name: string; status: string; kind?: TaskHistoryStep["kind"] }[] };
  try {
    record = JSON.parse(fs.readFileSync(runRecordPath(row.task_id, meta.run.id), "utf8"));
  } catch {
    return withDetail({
      reason: "interrupted",
      error: "akm ended while the run was in progress; its record cannot be read, so the step is not known",
    });
  }
  const listed = record.steps ?? [];
  const running = listed.findIndex((step) => step.status !== "completed");
  if (running < 0 || listed.some((step) => step.kind === undefined)) {
    return withDetail({
      reason: "interrupted",
      error: "akm ended while the run was in progress; its record does not say which step was running",
    });
  }
  const label = taskV5StepLabel((listed[running] as { name: string }).name);
  const steps = listed.map((step, index): TaskHistoryStep => {
    const status = index < running ? "completed" : index === running ? "failed" : "skipped";
    return {
      name: taskV5StepLabel(step.name),
      kind: step.kind as TaskHistoryStep["kind"],
      status,
      durationMs: 0,
      attempts: 0,
      ...(status === "failed" ? { reason: "interrupted" } : {}),
    };
  });
  return withDetail({ reason: "interrupted", error: `akm ended while step ${label} was running` }, steps);
}

/** Mark every `active` attempt whose owner is provably gone `interrupted`. */
function reconcileAbandonedTaskAttempts(db: Database): void {
  const here = hereNow();
  for (const row of listActiveTaskHistoryAttempts(db)) {
    if (row.id !== undefined && classifyAttempt(row, here) === "interrupted") {
      markTaskHistoryAttemptInterrupted(db, row.id, interruptedMetadata(row));
    }
  }
}

/**
 * Settle abandoned task attempts, and workflow units left running under a terminal run that no live process drives
 * (its lock is absent or stale; a held or unreadable lock leaves the run alone).
 */
export function reconcileAbandonedExecutionState(): void {
  withStateDb((db) => {
    reconcileAbandonedTaskAttempts(db);
    const repo = new WorkflowRunsRepository(db);
    const now = new Date().toISOString();
    for (const runId of repo.listTerminalRunsWithRunningUnits()) {
      const lock = probeLock(workflowRunLockPath(runId)).state;
      if (lock === "absent" || lock === "stale") repo.settleRunningUnitsOfTerminalRun(runId, now);
    }
  });
}
