// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import path from "node:path";
import { TransientError } from "../../core/errors";
import { appendEvent, type EventsContext } from "../../core/events";
import { type LockOwnership, releaseLock } from "../../core/file-lock";
import { tryWithMaintenanceStartBarrier, withMaintenanceStartBarrier } from "../../core/maintenance-barrier";
import { formatLockHolderPid, tryAcquireRunLock } from "../../core/run-lock";
import { warn } from "../../core/warn";

export type ImproveLockAcquisition = { state: "acquired"; ownership: LockOwnership } | { state: "skipped" };

export function improveLockPath(lockBaseDir: string): string {
  return path.join(lockBaseDir, "improve.lock");
}

export function tryAcquireImproveLock(
  lockPath: string,
  skipIfLocked: boolean | undefined,
  eventsCtx?: EventsContext,
): ImproveLockAcquisition {
  let recoveryEvent: Parameters<typeof appendEvent>[0] | undefined;
  const acquire = () =>
    tryAcquireImproveLockUnlocked(lockPath, skipIfLocked, (event) => {
      recoveryEvent = event;
    });
  const result = skipIfLocked ? tryWithMaintenanceStartBarrier(acquire) : withMaintenanceStartBarrier(acquire);
  if (!result) {
    warn("[improve] maintenance barrier held; skipping (--skip-if-locked)");
    return { state: "skipped" };
  }
  if (recoveryEvent) {
    try {
      // R25: lock acquisition runs BEFORE akmImprove opens its long-lived
      // handle, so the caller passes the C2 boundary-pinned dbPath ctx — the
      // rare stale-recovery event lands in the RIGHT state.db (correctness,
      // not the handle fast path; no handle exists yet at lock time).
      appendEvent(recoveryEvent, eventsCtx);
    } catch {
      /* event emission is best-effort; never block lock recovery */
    }
  }
  return result;
}

function tryAcquireImproveLockUnlocked(
  lockPath: string,
  skipIfLocked: boolean | undefined,
  onRecovered: (event: Parameters<typeof appendEvent>[0]) => void,
): ImproveLockAcquisition {
  // Mechanics (PID-liveness-only acquire/probe/absent-race-retry/stale-reclaim)
  // live in the shared `core/run-lock.ts` module (#956) — this wrapper only
  // owns improve's own policy: what "held" means (skip vs throw) and the
  // improve_lock_recovered audit event.
  const result = tryAcquireRunLock(lockPath, {
    label: "improve",
    onReclaimed: (info) => {
      onRecovered({
        eventType: "improve_lock_recovered",
        metadata: {
          lockName: "improve",
          stalePid: info.holderPid,
          lockedAt: info.lockedAt,
          recoveredAt: new Date().toISOString(),
          lockAgeMs: info.ageMs,
          reason: info.reason,
        },
      });
    },
  });
  if (result.state === "acquired") {
    return { state: "acquired", ownership: result.ownership };
  }

  const { startedAt } = result.holder;
  const pid = formatLockHolderPid(result.holder);
  if (skipIfLocked) {
    warn(
      `[improve] another improve run holds the lock (PID ${pid}, started ${startedAt}); skipping (--skip-if-locked)`,
    );
    return { state: "skipped" };
  }
  // #948 field follow-up: two legitimate `improve` invocations colliding on
  // this lock is ordinary, retryable contention — not a broken config file.
  // A `ConfigError` here surfaced as exit 78 (INVALID_CONFIG_FILE) and told
  // a supervisor to stop retrying a normal lock collision. Reclassified to
  // `TransientError`/`IMPROVE_LOCK_HELD` (exit 75), mirroring the
  // `MAINTENANCE_BARRIER_BUSY`/`INDEX_DB_CONTENDED` treatment #956 already
  // applied to the index rebuild lock and the maintenance-start barrier.
  throw new TransientError(
    `akm improve is already running (PID ${pid}, started ${startedAt}). Delete ${lockPath} to force.`,
    "IMPROVE_LOCK_HELD",
  );
}

export function releaseImproveLock(ownership: LockOwnership): void {
  releaseLock(ownership);
}
