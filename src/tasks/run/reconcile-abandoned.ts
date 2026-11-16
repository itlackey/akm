// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Settle execution state whose owner is provably gone. An `active` task
 * attempt is classified from the owner it recorded at reservation:
 *
 * - running: the owner process is alive (same host, same boot, same start time).
 * - interrupted: the owner is provably gone — a different boot, a dead pid, or
 *   a reused pid. Marked `interrupted`; its finish time and outcome stay unknown.
 * - indeterminate: it cannot be told (another host, no liveness evidence). Left `active`.
 *
 * Elapsed time never decides: a long-running attempt with a live owner stays `active`.
 * An attempt reserved before owners were recorded is interrupted only when it
 * started before the current boot.
 */

import os from "node:os";
import { isProcessAlive } from "../../core/common";
import { probeLock, processIdentity } from "../../core/file-lock";
import { withStateDb } from "../../core/state-db";
import type { Database } from "../../storage/database";
import {
  decodeTaskHistoryMetadata,
  listActiveTaskHistoryAttempts,
  markTaskHistoryAttemptInterrupted,
  type TaskHistoryOwner,
  type TaskHistoryRow,
} from "../../storage/repositories/task-history-repository";
import { WorkflowRunsRepository } from "../../storage/repositories/workflow-runs-repository";
import { workflowRunLockPath } from "../../workflows/exec/run-workflow";

type AttemptLiveness = "running" | "interrupted" | "indeterminate";

/** This host and process, read once per reconcile. */
interface Here {
  host: string;
  self: ReturnType<typeof processIdentity>;
  bootedAtMs: number;
}

function classifyOwner(owner: TaskHistoryOwner, here: Here): AttemptLiveness {
  if (owner.host !== here.host) return "indeterminate";
  if (owner.bootId !== undefined && here.self !== undefined && owner.bootId !== here.self.bootId) return "interrupted";
  if (owner.startTime !== undefined && here.self !== undefined) {
    const current = processIdentity(owner.pid);
    if (current !== undefined) return current.startTime === owner.startTime ? "running" : "interrupted";
  }
  return isProcessAlive(owner.pid) ? "indeterminate" : "interrupted";
}

function classifyAttempt(row: TaskHistoryRow, here: Here): AttemptLiveness {
  let owner: TaskHistoryOwner | undefined;
  try {
    owner = decodeTaskHistoryMetadata(row.metadata_json).owner;
  } catch {
    owner = undefined;
  }
  if (owner) return classifyOwner(owner, here);
  return new Date(row.started_at).getTime() < here.bootedAtMs ? "interrupted" : "indeterminate";
}

/** Mark every `active` attempt whose owner is provably gone `interrupted`. */
function reconcileAbandonedTaskAttempts(db: Database): void {
  const here: Here = {
    host: os.hostname(),
    self: processIdentity(process.pid),
    bootedAtMs: Date.now() - os.uptime() * 1000,
  };
  for (const row of listActiveTaskHistoryAttempts(db)) {
    if (row.id !== undefined && classifyAttempt(row, here) === "interrupted")
      markTaskHistoryAttemptInterrupted(db, row.id);
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
