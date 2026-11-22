// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Whether the process that owns an `active` task attempt is still there, read from the owner the attempt recorded at
 * reservation. The one rule: `reconcile-abandoned.ts` writes what it says, and the history readers show it.
 *
 * - running: the owner process is alive (same host, same boot, same start time).
 * - interrupted: the owner is provably gone: a different boot, a dead pid, or a reused pid.
 * - indeterminate: it cannot be told (another host, no liveness evidence).
 *
 * Elapsed time never decides. An attempt reserved before owners were recorded is interrupted only when it started
 * before the current boot.
 */

import os from "node:os";
import { isProcessAlive } from "../../core/common";
import { processIdentity } from "../../core/file-lock";
import {
  decodeTaskHistoryMetadata,
  type TaskHistoryOwner,
  type TaskHistoryRow,
} from "../../storage/repositories/task-history-repository";

type AttemptLiveness = "running" | "interrupted" | "indeterminate";

/** This host and process, read once per pass over rows. */
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

export function classifyAttempt(row: TaskHistoryRow, here: Here): AttemptLiveness {
  let owner: TaskHistoryOwner | undefined;
  try {
    owner = decodeTaskHistoryMetadata(row.metadata_json).owner;
  } catch {
    // A row whose metadata cannot be read says nothing about its owner: its liveness is not known.
    return "indeterminate";
  }
  if (owner) return classifyOwner(owner, here);
  return new Date(row.started_at).getTime() < here.bootedAtMs ? "interrupted" : "indeterminate";
}

export function hereNow(): Here {
  return { host: os.hostname(), self: processIdentity(process.pid), bootedAtMs: Date.now() - os.uptime() * 1000 };
}
