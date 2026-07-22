// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "../../core/errors";
import { appendEvent, type EventsContext } from "../../core/events";
import {
  createLockPayload,
  type LockOwnership,
  probeLock,
  reclaimStaleLock,
  releaseLock,
  tryAcquireLockSync,
} from "../../core/file-lock";
import { tryWithMaintenanceStartBarrier, withMaintenanceStartBarrier } from "../../core/maintenance-barrier";
import { warn } from "../../core/warn";

export const MIN_IMPROVE_LOCK_STALE_MS = 4 * 60 * 60 * 1000;

export type ImproveLockAcquisition = { state: "acquired"; ownership: LockOwnership } | { state: "skipped" };

export function improveLockPath(lockBaseDir: string): string {
  return path.join(lockBaseDir, "improve.lock");
}

export function tryAcquireImproveLock(
  lockPath: string,
  staleAfterMs: number,
  skipIfLocked: boolean | undefined,
  eventsCtx?: EventsContext,
): ImproveLockAcquisition {
  let recoveryEvent: Parameters<typeof appendEvent>[0] | undefined;
  const acquire = () =>
    tryAcquireImproveLockUnlocked(lockPath, staleAfterMs, skipIfLocked, (event) => {
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
  staleAfterMs: number,
  skipIfLocked: boolean | undefined,
  onRecovered: (event: Parameters<typeof appendEvent>[0]) => void,
): ImproveLockAcquisition {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const lockPayload = () => createLockPayload({ startedAt: new Date().toISOString() });
  let ownership = tryAcquireLockSync(lockPath, lockPayload());
  if (ownership) {
    return { state: "acquired", ownership };
  }

  const probe = probeLock(lockPath, { staleAfterMs });

  // Race: the holder released the lock between our failed `tryAcquireLockSync`
  // and this probe, so the probe sees no file (`absent`). Retry acquisition once
  // rather than falling through to the contended skip/throw below — otherwise we
  // would warn/throw with a null PID for a lock that nobody actually holds.
  // (Mirrors the absent/stale reclaim-and-retry in `acquireExtractSessionLock`.)
  if (probe.state === "absent") {
    ownership = tryAcquireLockSync(lockPath, lockPayload());
    if (ownership) {
      return { state: "acquired", ownership };
    }
    // Re-grabbed by another racer in the window — fall through and treat as held.
  }

  const rawContent = probe.state === "absent" ? undefined : probe.rawContent;
  const lock = rawContent
    ? (() => {
        try {
          return JSON.parse(rawContent) as { pid: number; startedAt: string };
        } catch {
          return null;
        }
      })()
    : null;

  if (probe.state === "stale") {
    if (!reclaimStaleLock(lockPath, probe)) {
      if (skipIfLocked) {
        warn("[improve] lock changed ownership during stale recovery; skipping (--skip-if-locked)");
        return { state: "skipped" };
      }
      throw new ConfigError(`akm improve is already running. Delete ${lockPath} to force.`, "INVALID_CONFIG_FILE");
    }
    onRecovered({
      eventType: "improve_lock_recovered",
      metadata: {
        lockName: "improve",
        stalePid: lock?.pid ?? null,
        lockedAt: lock?.startedAt ?? null,
        recoveredAt: new Date().toISOString(),
        lockAgeMs: probe.ageMs ?? null,
        reason: probe.reason === "pid_dead" ? "pid_not_alive" : probe.reason,
      },
    });
    ownership = tryAcquireLockSync(lockPath, lockPayload());
    if (ownership) {
      return { state: "acquired", ownership };
    }
    if (skipIfLocked) {
      warn("[improve] lock acquired by another run during stale recovery; skipping (--skip-if-locked)");
      return { state: "skipped" };
    }
    throw new ConfigError(`akm improve is already running. Delete ${lockPath} to force.`, "INVALID_CONFIG_FILE");
  }

  if (skipIfLocked) {
    warn(
      `[improve] another improve run holds the lock (PID ${lock?.pid}, started ${lock?.startedAt}); skipping (--skip-if-locked)`,
    );
    return { state: "skipped" };
  }

  throw new ConfigError(
    `akm improve is already running (PID ${lock?.pid}, started ${lock?.startedAt}). Delete ${lockPath} to force.`,
    "INVALID_CONFIG_FILE",
  );
}

export function releaseImproveLock(ownership: LockOwnership): void {
  releaseLock(ownership);
}
