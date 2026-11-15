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
import { processIdentity } from "../../core/file-lock";
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

type AttemptLiveness = "running" | "interrupted" | "indeterminate";

function pidIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function classifyOwner(owner: TaskHistoryOwner): AttemptLiveness {
  if (owner.host !== os.hostname()) return "indeterminate";
  const self = processIdentity(process.pid);
  if (owner.bootId !== undefined && self !== undefined && owner.bootId !== self.bootId) return "interrupted";
  const current = processIdentity(owner.pid);
  if (owner.bootId !== undefined && owner.startTime !== undefined && self !== undefined) {
    if (current === undefined) return pidIsGone(owner.pid) ? "interrupted" : "indeterminate";
    return current.startTime === owner.startTime ? "running" : "interrupted";
  }
  return pidIsGone(owner.pid) ? "interrupted" : "indeterminate";
}

function classifyAttempt(row: TaskHistoryRow, bootedAtMs: number): AttemptLiveness {
  let owner: TaskHistoryOwner | undefined;
  try {
    owner = decodeTaskHistoryMetadata(row.metadata_json).owner;
  } catch {
    owner = undefined;
  }
  if (owner) return classifyOwner(owner);
  return new Date(row.started_at).getTime() < bootedAtMs ? "interrupted" : "indeterminate";
}

/** Mark every `active` attempt whose owner is provably gone `interrupted`; returns how many changed. */
export function reconcileAbandonedTaskAttempts(db: Database): number {
  const bootedAtMs = Date.now() - os.uptime() * 1000;
  let changed = 0;
  for (const row of listActiveTaskHistoryAttempts(db)) {
    if (row.id !== undefined && classifyAttempt(row, bootedAtMs) === "interrupted") {
      if (markTaskHistoryAttemptInterrupted(db, row.id)) changed++;
    }
  }
  return changed;
}

/** Settle abandoned task attempts and workflow units left running under a terminal run. */
export function reconcileAbandonedExecutionState(): void {
  withStateDb((db) => {
    reconcileAbandonedTaskAttempts(db);
    new WorkflowRunsRepository(db).finalizeUnitsOfTerminalRuns(new Date().toISOString());
  });
}
