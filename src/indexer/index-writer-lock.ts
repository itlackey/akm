// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { probeLock, releaseLock, releaseLockIfOwned, tryAcquireLockSync } from "../core/file-lock";
import { getDbPath, getIndexWriterLockPath } from "../core/paths";

const INDEX_WRITER_LOCK_STALE_AFTER_MS = 12 * 60 * 60 * 1000;
const INDEX_WRITER_WAIT_MS = 100;

const heldLocks = new Map<string, { depth: number; exitHandler: () => void }>();

export interface IndexWriterLease {
  lockPath: string;
  release: () => void;
}

interface AcquireIndexWriterLeaseOptions {
  mode?: "wait" | "try";
  purpose: string;
  signal?: AbortSignal;
}

function buildPayload(purpose: string, pid = process.pid): string {
  return JSON.stringify({
    pid,
    purpose,
    dbPath: getDbPath(),
    startedAt: new Date().toISOString(),
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("index writer wait aborted");
}

function releaseHeldLock(lockPath: string): void {
  const held = heldLocks.get(lockPath);
  if (!held) return;
  held.depth -= 1;
  if (held.depth > 0) return;
  heldLocks.delete(lockPath);
  process.off("exit", held.exitHandler);
  releaseLockIfOwned(lockPath, process.pid);
}

function retainHeldLock(lockPath: string): IndexWriterLease {
  const existing = heldLocks.get(lockPath);
  if (existing) {
    existing.depth += 1;
    return { lockPath, release: () => releaseHeldLock(lockPath) };
  }
  const exitHandler = () => releaseLockIfOwned(lockPath, process.pid);
  process.on("exit", exitHandler);
  heldLocks.set(lockPath, { depth: 1, exitHandler });
  return { lockPath, release: () => releaseHeldLock(lockPath) };
}

function detachHeldLock(lockPath: string): void {
  const held = heldLocks.get(lockPath);
  if (!held) return;
  heldLocks.delete(lockPath);
  process.off("exit", held.exitHandler);
}

export async function acquireIndexWriterLease(
  options: AcquireIndexWriterLeaseOptions,
): Promise<IndexWriterLease | undefined> {
  const mode = options.mode ?? "wait";
  const lockPath = getIndexWriterLockPath();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  if (heldLocks.has(lockPath)) {
    return retainHeldLock(lockPath);
  }

  while (true) {
    throwIfAborted(options.signal);

    if (tryAcquireLockSync(lockPath, buildPayload(options.purpose))) {
      return retainHeldLock(lockPath);
    }

    const probe = probeLock(lockPath, { staleAfterMs: INDEX_WRITER_LOCK_STALE_AFTER_MS });
    if (probe.state === "held" && probe.holderPid === process.pid) {
      return retainHeldLock(lockPath);
    }
    if (probe.state === "stale") {
      releaseLock(lockPath);
      continue;
    }
    if (mode === "try") return undefined;
    await delay(INDEX_WRITER_WAIT_MS);
  }
}

export async function withIndexWriterLease<T>(
  options: AcquireIndexWriterLeaseOptions,
  run: () => Promise<T>,
): Promise<T> {
  const lease = await acquireIndexWriterLease(options);
  if (!lease) {
    throw new Error(`index writer lease unavailable for ${options.purpose}`);
  }
  try {
    return await run();
  } finally {
    lease.release();
  }
}

export function handoffIndexWriterLeaseToPid(lease: IndexWriterLease, pid: number, purpose: string): void {
  fs.writeFileSync(lease.lockPath, buildPayload(purpose, pid), "utf8");
  detachHeldLock(lease.lockPath);
}

export function probeIndexWriterLease() {
  return probeLock(getIndexWriterLockPath(), { staleAfterMs: INDEX_WRITER_LOCK_STALE_AFTER_MS });
}
