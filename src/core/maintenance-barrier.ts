// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "./errors";
import { probeLock, releaseLock, releaseLockIfOwned, tryAcquireLockSync } from "./file-lock";
import { getMaintenanceBarrierPath } from "./paths";

/**
 * Serialize restore with the short critical section that creates every
 * long-lived AKM lock or workflow lease. The long operation keeps its own
 * lock/lease; this barrier is released immediately after acquisition.
 */
export function tryAcquireMaintenanceBarrier(): (() => void) | undefined {
  const lockPath = getMaintenanceBarrierPath();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (tryAcquireLockSync(lockPath, JSON.stringify({ pid: process.pid, purpose: "maintenance-start" }))) {
      return () => releaseLockIfOwned(lockPath, process.pid);
    }
    if (probeLock(lockPath).state !== "stale") return undefined;
    releaseLock(lockPath);
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
  const release = acquireMaintenanceBarrier();
  try {
    return run();
  } finally {
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
  const release = await acquireMaintenanceBarrierAsync();
  try {
    return await run();
  } finally {
    release();
  }
}

/** Register a long-lived operation atomically with restore's blocker scan. */
export async function acquireMaintenanceActivity(name: string): Promise<() => void> {
  return withMaintenanceStartBarrierAsync(async () => {
    const directory = path.join(path.dirname(getMaintenanceBarrierPath()), "maintenance-activities");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const lockPath = path.join(directory, `${name}-${process.pid}-${randomUUID()}.lock`);
    if (!tryAcquireLockSync(lockPath, JSON.stringify({ pid: process.pid, purpose: name }))) {
      throw new ConfigError(`Could not register AKM maintenance activity at ${lockPath}.`, "INVALID_CONFIG_FILE");
    }
    return () => releaseLockIfOwned(lockPath, process.pid);
  });
}
