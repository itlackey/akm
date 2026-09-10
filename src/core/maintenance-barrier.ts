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
 * any real filesystem. Two akm processes racing to register a lock/lease/
 * activity in the very same instant (e.g. two `akm index` runs a scheduler
 * launched back to back, both opening canonical state.db) can still collide
 * on it; retrying briefly resolves that ordinary case instead of failing a
 * legitimate concurrent invocation outright
 * (field follow-up to #956, G1). Bounded short so a genuinely wedged holder
 * still surfaces the busy error promptly rather than making a losing
 * process hang — comfortably above the barrier's normal hold time, well
 * below a length that would make this feel like the blocking lock #872
 * removed. Never applies to whatever lock/lease/activity is registered
 * after the barrier releases — that thing's own held/skip/throw/wait
 * policy belongs to its caller, not to the barrier (#872).
 */
const MAINTENANCE_BARRIER_BUSY_RETRY_BOUND_MS = 1_500;

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

/** Synchronous activity registration for synchronous database handle lifetimes. */
export function acquireMaintenanceActivitySync(name: string): () => void {
  return withMaintenanceStartBarrierSyncWait(() => {
    const directory = path.join(path.dirname(getMaintenanceBarrierPath()), "maintenance-activities");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const lockPath = path.join(directory, `${name}-${process.pid}-${randomUUID()}.lock`);
    const ownership = tryAcquireLockSync(lockPath, createLockPayload({ purpose: name }));
    if (!ownership) {
      throw new ConfigError(`Could not register AKM maintenance activity at ${lockPath}.`, "INVALID_CONFIG_FILE");
    }
    return () => releaseLock(ownership);
  });
}
