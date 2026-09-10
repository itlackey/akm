// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Opt-in, non-blocking rebuild lock for `akm index` (#956).
 *
 * #872 removed the blocking index-rebuild lease: the index is a regenerable
 * cache, so a concurrent rebuild only wastes work rather than corrupts
 * anything, and a live-but-wedged holder passed a PID-liveness check forever
 * — only an age-based clock could ever free it, which is exactly the hazard
 * #872 deleted. This module does not reinstate that lock. It adds a
 * PID-liveness-only sentinel an explicit `akm index` run acquires and
 * releases on exit purely so a *scheduled or opportunistic* run
 * (`--skip-if-locked`) can step aside instead of piling up behind a rebuild
 * already in progress. A human-typed `akm index` with no flag is never
 * gated: it warns and proceeds exactly as it did before this lock existed.
 *
 * Built on the shared PID-liveness mechanics in `core/run-lock.ts` (the same
 * ones `akm improve`'s whole-run lock uses) — see that module's doc for the
 * no-stale-age-window rationale.
 */

import { type LockOwnership, releaseLock } from "../core/file-lock";
import { tryWithMaintenanceStartBarrier, withMaintenanceStartBarrier } from "../core/maintenance-barrier";
import { getIndexRebuildLockPath } from "../core/paths";
import { formatLockHolderPid, type RunLockHolder, tryAcquireRunLock } from "../core/run-lock";
import { warn, warnVerbose } from "../core/warn";

export type IndexRebuildLockAcquisition =
  | { state: "acquired"; ownership: LockOwnership }
  /** `--skip-if-locked` and the lock is held: the caller must skip the run entirely (exit 0). */
  | { state: "skipped"; holder: RunLockHolder }
  /** No flag and the lock is held: the caller proceeds unlocked, contending with the holder. */
  | { state: "contended"; holder: RunLockHolder };

export function indexRebuildLockPath(): string {
  return getIndexRebuildLockPath();
}

/**
 * Acquire the rebuild lock for the duration of one `akm index` run.
 *
 *  - Free: always returns `"acquired"`.
 *  - Held, `skipIfLocked`: warns once (naming the holder) and returns
 *    `"skipped"` — the caller must not run `akmIndex()` at all.
 *  - Held, no flag: warns once and returns `"contended"` — the caller runs
 *    `akmIndex()` unlocked, exactly as every `akm index` did before #956.
 *
 * A dead holder's lease is reclaimed silently (verbose-only log line, never
 * a user-facing warning) — the operator did nothing wrong and nothing here
 * requires their attention.
 */
export function tryAcquireIndexRebuildLock(skipIfLocked: boolean | undefined): IndexRebuildLockAcquisition {
  const lockPath = indexRebuildLockPath();
  const acquire = () =>
    tryAcquireRunLock(lockPath, {
      label: "index rebuild",
      onReclaimed: (info) => {
        warnVerbose(
          `[index] reclaimed a rebuild lock left by pid ${info.holderPid ?? "unknown"} ` +
            `(${info.reason}); that process is no longer running.`,
        );
      },
    });

  if (skipIfLocked) {
    const result = tryWithMaintenanceStartBarrier(acquire);
    if (!result) {
      warn("[index] maintenance barrier held; skipping (--skip-if-locked)");
      return { state: "skipped", holder: { pid: null, startedAt: null, launcherPid: null } };
    }
    if (result.state === "acquired") return result;
    warn(
      `[index] another index run holds the lock (PID ${formatLockHolderPid(result.holder)}, started ${result.holder.startedAt}); ` +
        "skipping (--skip-if-locked)",
    );
    return { state: "skipped", holder: result.holder };
  }

  const result = withMaintenanceStartBarrier(acquire);
  if (result.state === "acquired") return result;
  warn(
    `[index] another index run is active (pid ${formatLockHolderPid(result.holder)}, started ${result.holder.startedAt}); ` +
      "this run will contend with it — pass --skip-if-locked for scheduled runs",
  );
  return { state: "contended", holder: result.holder };
}

export function releaseIndexRebuildLock(ownership: LockOwnership): void {
  releaseLock(ownership);
}
