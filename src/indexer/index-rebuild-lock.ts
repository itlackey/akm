// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The rebuild lock: one index build at a time on a host. A PID-liveness sentinel
 * (`$DATA/index.rebuild.lock`) that every build takes through `buildIndex` (`index-build.ts`); it stops two
 * builds repeating the same walk and tells readers a build is running. A dead holder is reclaimed at once;
 * nothing ages out.
 *
 * Built on the shared PID-liveness mechanics in `core/run-lock.ts` (the same
 * ones `akm improve`'s whole-run lock uses) — see that module's doc for the
 * no-stale-age-window rationale.
 */

import { type LockOwnership, probeLock, releaseLock } from "../core/file-lock";
import { getIndexRebuildLockPath } from "../core/paths";
import {
  formatLockHolderPid,
  type RunLockAcquireResult,
  type RunLockHolder,
  tryAcquireRunLock,
} from "../core/run-lock";
import { warnVerbose } from "../core/warn";

/**
 * One attempt at the rebuild lock: acquired, or held by a live process. A dead
 * holder's lease is reclaimed silently (verbose-only log line) — the operator
 * did nothing wrong and nothing here requires their attention.
 */
export function tryAcquireIndexRebuildLock(): RunLockAcquireResult {
  return tryAcquireRunLock(getIndexRebuildLockPath(), {
    label: "index rebuild",
    onReclaimed: (info) => {
      warnVerbose(
        `[index] reclaimed a rebuild lock left by pid ${info.holderPid ?? "unknown"} ` +
          `(${info.reason}); that process is no longer running.`,
      );
    },
  });
}

export function releaseIndexRebuildLock(ownership: LockOwnership): void {
  releaseLock(ownership);
}

/** The live process holding the rebuild lock right now, if any. Read-only: it never acquires or reclaims. */
export function heldRebuildLock(): RunLockHolder | undefined {
  const probe = probeLock(getIndexRebuildLockPath());
  if (probe.state !== "held") return undefined;
  let startedAt: string | null = null;
  try {
    startedAt = (JSON.parse(probe.rawContent) as { startedAt?: string }).startedAt ?? null;
  } catch {
    // A payload that is not JSON still names a live holder by pid.
  }
  return { pid: probe.holderPid, launcherPid: probe.launcherPid ?? null, startedAt };
}

/** How a lock holder is named in a message: `pid 4242 (launcher 4240), started <time>`. */
export function describeLockHolder(holder: RunLockHolder): string {
  return `pid ${formatLockHolderPid(holder)}, started ${holder.startedAt ?? "unknown"}`;
}
