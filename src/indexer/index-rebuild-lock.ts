// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The rebuild lock: one index build at a time on a host (#956).
 *
 * A PID-liveness-only sentinel (`$DATA/index.rebuild.lock`) that every build
 * takes through `buildIndex` (`index-build.ts`). The index is a regenerable
 * cache, so the lock is not a correctness guard (#872 removed the lease that
 * was, after a live-but-wedged holder stranded an install for hours): it only
 * stops two builds duplicating the same long walk, and it tells readers a
 * build is running. A dead holder is reclaimed at once; nothing ages out.
 *
 * Built on the shared PID-liveness mechanics in `core/run-lock.ts` (the same
 * ones `akm improve`'s whole-run lock uses) — see that module's doc for the
 * no-stale-age-window rationale.
 */

import { type LockOwnership, probeLock, releaseLock } from "../core/file-lock";
import { getIndexRebuildLockPath } from "../core/paths";
import { type RunLockAcquireResult, tryAcquireRunLock } from "../core/run-lock";
import { warnVerbose } from "../core/warn";

export function indexRebuildLockPath(): string {
  return getIndexRebuildLockPath();
}

/**
 * One attempt at the rebuild lock: acquired, or held by a live process. A dead
 * holder's lease is reclaimed silently (verbose-only log line) — the operator
 * did nothing wrong and nothing here requires their attention.
 */
export function tryAcquireIndexRebuildLock(): RunLockAcquireResult {
  return tryAcquireRunLock(indexRebuildLockPath(), {
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

/** Whether a live process holds the rebuild lock right now. Read-only: it never acquires or reclaims. */
export function indexBuildRunning(): boolean {
  return probeLock(indexRebuildLockPath()).state === "held";
}
