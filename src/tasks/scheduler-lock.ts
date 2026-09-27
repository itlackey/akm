// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The one process lock around native scheduler writes.
 *
 * `task sync|add|enable|disable|prune --yes` read the installed rows, plan,
 * and apply under it, so two akm processes never interleave their writes to
 * the same crontab or LaunchAgents directory. It is an `O_EXCL` lock file
 * under `$STATE/locks`, reclaimed only from a verifiably dead holder, and
 * re-entrant within one process (`add` runs `sync` inside it).
 */

import fs from "node:fs";
import path from "node:path";
import { TransientError } from "../core/errors";
import { createLockPayload, probeLock, reclaimStaleLock, releaseLock, tryAcquireLockSync } from "../core/file-lock";
import { getStateDir } from "../core/paths";

export function schedulerLockPath(): string {
  return path.join(getStateDir(), "locks", "scheduler.lock");
}

let depth = 0;

export async function withSchedulerLock<T>(fn: () => Promise<T>): Promise<T> {
  if (depth > 0) {
    depth += 1;
    try {
      return await fn();
    } finally {
      depth -= 1;
    }
  }
  const lockPath = schedulerLockPath();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const acquire = () => tryAcquireLockSync(lockPath, createLockPayload({ purpose: "scheduler" }));
  let ownership = acquire();
  if (!ownership) {
    const probe = probeLock(lockPath);
    if (probe.state === "absent" || (probe.state === "stale" && reclaimStaleLock(lockPath, probe))) {
      ownership = acquire();
    }
  }
  if (!ownership) {
    throw new TransientError("Another akm process is syncing the scheduler right now.", "SCHEDULER_LOCK_HELD");
  }
  depth = 1;
  try {
    return await fn();
  } finally {
    depth = 0;
    releaseLock(ownership);
  }
}
