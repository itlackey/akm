// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "./errors";
import { createLockPayload, probeLock, reclaimStaleLock, releaseLock, tryAcquireLockSync } from "./file-lock";
import { getMaintenanceBarrierPath } from "./paths";

const heldBarrierContext = new AsyncLocalStorage<{ active: boolean }>();

/**
 * Serialize restore with the short critical section that creates every
 * long-lived AKM lock or workflow lease. The long operation keeps its own
 * lock/lease; this barrier is released immediately after acquisition.
 */
export function tryAcquireMaintenanceBarrier(): (() => void) | undefined {
  const lockPath = getMaintenanceBarrierPath();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const ownership = tryAcquireLockSync(lockPath, createLockPayload({ purpose: "maintenance-start" }));
    if (ownership) {
      return () => releaseLock(ownership);
    }
    const probe = probeLock(lockPath);
    if (probe.state !== "stale" || !reclaimStaleLock(lockPath, probe)) return undefined;
  }
  return undefined;
}

export function acquireMaintenanceBarrier(): () => void {
  const release = tryAcquireMaintenanceBarrier();
  if (release) return release;
  throw new ConfigError(
    `AKM maintenance is in progress (barrier ${getMaintenanceBarrierPath()}); retry after it completes.`,
    "INVALID_CONFIG_FILE",
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
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
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

/** Register a long-lived operation atomically with restore's blocker scan. */
export async function acquireMaintenanceActivity(name: string): Promise<() => void> {
  return withMaintenanceStartBarrierAsync(async () => {
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
