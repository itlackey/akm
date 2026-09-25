// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sleepSync } from "../runtime";
import { backoffDelay } from "./common";
import { ConfigError, TransientError } from "./errors";
import { createLockPayload, probeLock, reclaimStaleLock, releaseLock, tryAcquireLockSync } from "./file-lock";
import { getMaintenanceBarrierPath } from "./paths";

const heldBarrierContext = new AsyncLocalStorage<{ active: boolean }>();

/**
 * The barrier is meant to be held only for the short critical section that
 * registers one lock/lease/activity — a process that still holds it past
 * this age is wedged (crashed mid-section, deadlocked, killed without
 * cleanup), not doing legitimate long-running work. Without an age bound, a
 * probe only reclaims a lock whose holder PID has verifiably died; a wedged
 * — but still-alive — holder (or a PID a container/namespace boundary
 * reused, making `isProcessAlive` see the wrong process as live) locked
 * every other akm invocation out of ANY maintenance registration forever,
 * with no recovery but killing the holder by hand.  5 minutes matches the
 * stale-lock window already used for the improve extract-session lock
 * (`commands/improve/extract.ts`).
 */
const MAINTENANCE_BARRIER_STALE_AFTER_MS = 5 * 60 * 1000;

/**
 * The barrier normally holds for one lock-file write — sub-millisecond on
 * any real filesystem. Two akm processes racing to register a lock in the
 * very same instant (e.g. two `akm index` runs a scheduler launched back to
 * back) can still collide on it; retrying briefly resolves that ordinary
 * case instead of failing a legitimate concurrent invocation outright
 * (field follow-up to #956, G1). Five seconds matches the async and
 * synchronous-activity registration paths below and tolerates a holder being
 * descheduled under heavy process-shard load; the barrier's normal hold time
 * remains sub-millisecond. The bound still surfaces a genuinely wedged holder
 * promptly and never applies to the rebuild lock itself, which stays
 * non-blocking (#872).
 */
const MAINTENANCE_BARRIER_BUSY_RETRY_BOUND_MS = 5_000;

let busyRetryBoundMsForTests: number | undefined;

/** Test-only override for {@link MAINTENANCE_BARRIER_BUSY_RETRY_BOUND_MS}, so a unit test can exercise the
 * exhausted-retry throw without a real ~1.5s wait. Restored via tests/_helpers/seams.ts's resetAllSeams(). */
export function _setMaintenanceBarrierBusyRetryBoundMsForTests(ms: number | undefined): void {
  busyRetryBoundMsForTests = ms;
}

/**
 * Serialize the short critical section that creates each long-lived AKM lock,
 * lease, or state activity. The operation keeps its own ownership record; this
 * barrier is released immediately after acquisition.
 */
export function tryAcquireMaintenanceBarrier(): (() => void) | undefined {
  const lockPath = getMaintenanceBarrierPath();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const ownership = tryAcquireLockSync(lockPath, createLockPayload({ purpose: "maintenance-start" }));
    if (ownership) {
      return () => releaseLock(ownership);
    }
    const probe = probeLock(lockPath, { staleAfterMs: MAINTENANCE_BARRIER_STALE_AFTER_MS });
    if (probe.state !== "stale" || !reclaimStaleLock(lockPath, probe)) return undefined;
  }
  return undefined;
}

export function acquireMaintenanceBarrier(): () => void {
  const boundMs = busyRetryBoundMsForTests ?? MAINTENANCE_BARRIER_BUSY_RETRY_BOUND_MS;
  const deadline = Date.now() + boundMs;
  for (let attempt = 0; ; attempt += 1) {
    const release = tryAcquireMaintenanceBarrier();
    if (release) return release;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    sleepSync(Math.min(backoffDelay(attempt), remainingMs));
  }
  throw new TransientError(
    `AKM maintenance is in progress (barrier ${getMaintenanceBarrierPath()}); retry shortly. ` +
      `A sentinel older than ${MAINTENANCE_BARRIER_STALE_AFTER_MS / 60_000} minute(s) is reclaimed automatically on the next attempt.`,
    "MAINTENANCE_BARRIER_BUSY",
  );
}

export function withMaintenanceStartBarrier<T>(run: () => T): T {
  if (heldBarrierContext.getStore()?.active) return run();
  const release = acquireMaintenanceBarrier();
  const ownership = { active: true };
  try {
    return heldBarrierContext.run(ownership, run);
  } finally {
    ownership.active = false;
    release();
  }
}

/** Run while holding the start barrier, or return undefined when it is busy. */
export function tryWithMaintenanceStartBarrier<T>(run: () => T): T | undefined {
  if (heldBarrierContext.getStore()?.active) return run();
  const release = tryAcquireMaintenanceBarrier();
  if (!release) return undefined;
  const ownership = { active: true };
  try {
    return heldBarrierContext.run(ownership, run);
  } finally {
    ownership.active = false;
    release();
  }
}

async function acquireMaintenanceBarrierAsync(): Promise<() => void> {
  const deadline = Date.now() + 5_000;
  while (true) {
    const release = tryAcquireMaintenanceBarrier();
    if (release) return release;
    if (Date.now() >= deadline) return acquireMaintenanceBarrier();
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

export async function withMaintenanceStartBarrierAsync<T>(run: () => Promise<T>): Promise<T> {
  if (heldBarrierContext.getStore()?.active) return run();
  const release = await acquireMaintenanceBarrierAsync();
  const ownership = { active: true };
  try {
    return await heldBarrierContext.run(ownership, run);
  } finally {
    ownership.active = false;
    release();
  }
}

function withMaintenanceStartBarrierSyncWait<T>(run: () => T): T {
  if (heldBarrierContext.getStore()?.active) return run();
  const deadline = Date.now() + 5_000;
  let release = tryAcquireMaintenanceBarrier();
  while (!release && Date.now() < deadline) {
    sleepSync(5);
    release = tryAcquireMaintenanceBarrier();
  }
  if (!release) release = acquireMaintenanceBarrier();
  const ownership = { active: true };
  try {
    return heldBarrierContext.run(ownership, run);
  } finally {
    ownership.active = false;
    release();
  }
}

function maintenanceActivitiesDir(): string {
  return path.join(path.dirname(getMaintenanceBarrierPath()), "maintenance-activities");
}

/**
 * Every activity lock path is unique per acquisition (`name-pid-uuid.lock`),
 * so nothing ever contends on the same one twice — the operation mutex's job
 * of serializing repeat use of one canonical path doesn't apply here. Deriving
 * a mutex sidecar from each unique path (the file-lock.ts default) built up
 * one abandoned `.operations.sensitive` file per acquisition forever, since
 * nothing revisits a path no one will ever use again to clean it up. One
 * shared, reused mutex file for the whole activities directory keeps the same
 * critical-section protection — two acquisitions racing on the filesystem
 * still serialize — with a bounded footprint.
 */
function activityLockMutexPath(directory: string): string {
  return path.join(directory, ".activities.operations.sensitive");
}

/** Synchronous activity registration for synchronous database handle lifetimes. */
export function acquireMaintenanceActivitySync(name: string): () => void {
  return withMaintenanceStartBarrierSyncWait(() => {
    const directory = maintenanceActivitiesDir();
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const lockPath = path.join(directory, `${name}-${process.pid}-${randomUUID()}.lock`);
    const mutexPath = activityLockMutexPath(directory);
    const ownership = tryAcquireLockSync(lockPath, createLockPayload({ purpose: name }), mutexPath);
    if (!ownership) {
      throw new ConfigError(`Could not register AKM maintenance activity at ${lockPath}.`, "INVALID_CONFIG_FILE");
    }
    return () => releaseLock(ownership, mutexPath);
  });
}

/**
 * Bound on how many `maintenance-activities/` files one sweep inspects, so a
 * large pre-existing backlog (per-acquisition sidecars leaked before the
 * shared-mutex fix above) drains over several calls instead of stalling one.
 */
const MAINTENANCE_ACTIVITY_SWEEP_MAX_FILES = 2_000;

/**
 * Remove orphaned `maintenance-activities/` files:
 *   - a `.operations.sensitive` sidecar whose lock file no longer exists (the
 *     pre-fix per-acquisition mutex leak — its acquisition long since
 *     released or crashed, and nothing else will ever reopen that path);
 *   - an activity lock file whose recorded owner pid has died (a process that
 *     crashed mid-registration, reclaimed the same way `probeLock` /
 *     `reclaimStaleLock` already reclaim any other lock).
 *
 * Bounded per call ({@link MAINTENANCE_ACTIVITY_SWEEP_MAX_FILES}) and
 * best-effort: a missing directory or a file that vanishes mid-sweep (another
 * process released it concurrently) is not an error. Call only from an
 * existing maintenance point that already runs off the hot path (e.g. `akm
 * index`'s finalize phase) — never on every lock acquisition.
 */
export function sweepMaintenanceActivityOrphans(): { scanned: number; removed: number } {
  const directory = maintenanceActivitiesDir();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return { scanned: 0, removed: 0 };
  }

  const mutexPath = activityLockMutexPath(directory);
  const sidecarSuffix = ".lock.operations.sensitive";
  let scanned = 0;
  let removed = 0;
  for (const entry of entries) {
    if (scanned >= MAINTENANCE_ACTIVITY_SWEEP_MAX_FILES) break;
    if (!entry.isFile()) continue;
    const fullPath = path.join(directory, entry.name);
    if (fullPath === mutexPath) continue;
    scanned++;

    if (entry.name.startsWith(".") && entry.name.endsWith(sidecarSuffix)) {
      // `.{name-pid-uuid}.lock.operations.sensitive` -> its lock file is the
      // same name minus the leading dot and the `.operations.sensitive` tail.
      const lockName = entry.name.slice(1, -".operations.sensitive".length);
      if (!fs.existsSync(path.join(directory, lockName))) {
        try {
          fs.unlinkSync(fullPath);
          removed++;
        } catch {
          // Already gone, or a permission race — leave it for the next sweep.
        }
      }
      continue;
    }

    if (entry.name.endsWith(".lock")) {
      const probe = probeLock(fullPath);
      if (probe.state === "stale" && probe.reason === "pid_dead" && reclaimStaleLock(fullPath, probe, { mutexPath })) {
        removed++;
      }
    }
  }
  return { scanned, removed };
}
