// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Asset-mutation lease — serializes writes to real, authored user content
 * (source updates, `akm remember`, proposal apply, ...) so two concurrent
 * writers cannot both pass a git exact-path preflight check before either
 * commits.
 *
 * This module previously also gated full index REBUILDS behind the same
 * lease with a 12-hour age-based stale-reclaim window (#872). That guard was
 * removed: the index is a regenerable cache, concurrent rebuilds only waste
 * work rather than corrupt anything, and a live-but-wedged holder passed the
 * PID-liveness check forever, so only the 12h clock could ever free it —
 * which cost one real install a half-day indexing outage. Index rebuilds no
 * longer take any lease.
 *
 * What remains here guards actual data loss (a lost or conflicting git
 * commit), so per AGENTS.md `## Defensive Code` it stays — but with the same
 * fix applied: no age-based stale-reclaim. A holder is only ever reclaimed
 * once its PID is verifiably dead; a live-but-wedged holder makes an
 * acquisition attempt wait (bounded by `maxWaitMs`) or fail, never silently
 * override a lease someone might still be using.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import {
  createLockPayload,
  type LockOwnership,
  probeLock,
  reclaimStaleLock,
  releaseLock,
  tryAcquireLockSync,
} from "../core/file-lock";
import { tryAcquireMaintenanceBarrier } from "../core/maintenance-barrier";
import { getDbPath, getIndexWriterLockPath } from "../core/paths";
import { warn } from "../core/warn";
import { sleepSync } from "../runtime";

const ASSET_MUTATION_WAIT_MS = 100;
const DEFAULT_ASSET_MUTATION_MAX_WAIT_MS = 10 * 60 * 1000;
/** How often a blocked sync waiter re-announces that it is still waiting. Mirrors the async path's cadence. */
const ASSET_MUTATION_WAIT_NOTICE_INTERVAL_MS = 15_000;

/** TEST-ONLY. Shrinks the sync path's max-wait/notice-cadence so a test doesn't block for real minutes/seconds. */
let syncTimingOverridesForTests: { maxWaitMs?: number; waitNoticeIntervalMs?: number } | undefined;
export function _setAssetMutationLeaseSyncTimingForTests(overrides?: {
  maxWaitMs?: number;
  waitNoticeIntervalMs?: number;
}): void {
  syncTimingOverridesForTests = overrides;
}

const leaseContext = new AsyncLocalStorage<Set<string>>();

export interface AssetMutationLease {
  lockPath: string;
  release: () => void;
}

export interface AcquireAssetMutationLeaseOptions {
  mode?: "wait" | "try";
  purpose: string;
  signal?: AbortSignal;
  maxWaitMs?: number;
  onWait?: (info: { waitedMs: number }) => void;
  onAcquired?: (info: { waitedMs: number }) => void;
}

function buildPayload(purpose: string): string {
  return createLockPayload({
    purpose,
    dbPath: getDbPath(),
    startedAt: new Date().toISOString(),
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Describe who currently holds `lockPath`, from `probeLock`'s own payload
 * (the same `purpose`/`pid`/`startedAt` fields `buildPayload` writes) —
 * never the waiting caller's own `purpose`, which names what SELF is trying
 * to do, not who is in the way.
 */
function describeAssetMutationHolder(lockPath: string): string {
  const probe = probeLock(lockPath);
  const rawContent = probe.state === "held" || probe.state === "stale" ? probe.rawContent : undefined;
  if (!rawContent) return "an asset write";
  try {
    const payload = JSON.parse(rawContent) as { pid?: number; purpose?: string; startedAt?: string };
    const who = payload.purpose ?? "an asset write";
    return `${who} (pid ${payload.pid ?? "?"}, started ${payload.startedAt ?? "?"})`;
  } catch {
    return "an asset write";
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("asset mutation lease wait aborted");
}

function createLease(lockPath: string, ownership: LockOwnership): AssetMutationLease {
  const exitHandler = () => releaseLock(ownership);
  process.on("exit", exitHandler);
  let released = false;
  return {
    lockPath,
    release: () => {
      if (released) return;
      released = true;
      process.off("exit", exitHandler);
      releaseLock(ownership);
    },
  };
}

function tryAcquireAssetMutationLease(lockPath: string, purpose: string): AssetMutationLease | undefined {
  while (true) {
    const releaseBarrier = tryAcquireMaintenanceBarrier();
    if (!releaseBarrier) return undefined;
    try {
      const ownership = tryAcquireLockSync(lockPath, buildPayload(purpose));
      if (ownership) return createLease(lockPath, ownership);

      // No `staleAfterMs`: only a verifiably dead holder is ever reclaimed.
      const probe = probeLock(lockPath);
      if (probe.state !== "stale" || !reclaimStaleLock(lockPath, probe)) return undefined;
    } finally {
      releaseBarrier();
    }
  }
}

export async function acquireAssetMutationLease(
  options: AcquireAssetMutationLeaseOptions,
): Promise<AssetMutationLease | undefined> {
  const mode = options.mode ?? "wait";
  const lockPath = getIndexWriterLockPath();
  const startedAt = Date.now();
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_ASSET_MUTATION_MAX_WAIT_MS;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  let lastWaitNoticeMs = 0;

  while (true) {
    throwIfAborted(options.signal);

    const lease = tryAcquireAssetMutationLease(lockPath, options.purpose);
    if (lease) {
      options.onAcquired?.({ waitedMs: Date.now() - startedAt });
      return lease;
    }
    if (mode === "try") return undefined;

    // Held by another live process. Time out only *after* a real acquisition
    // attempt, so a caller with maxWaitMs:0 still gets one chance at a free lock
    // instead of throwing before it ever tries.
    if (maxWaitMs >= 0 && Date.now() - startedAt >= maxWaitMs) {
      throw new Error(`timed out waiting for asset mutation lease for ${options.purpose}`);
    }
    const waitedMs = Date.now() - startedAt;
    if (waitedMs - lastWaitNoticeMs >= 15000) {
      options.onWait?.({ waitedMs });
      lastWaitNoticeMs = waitedMs;
    }
    await delay(ASSET_MUTATION_WAIT_MS);
  }
}

/** Asset writes share one lease so two concurrent writers cannot both pass preflight before either commits. */
export async function withAssetMutationLease<T>(purpose: string, run: () => Promise<T>): Promise<T> {
  const lockPath = getIndexWriterLockPath();
  const inherited = leaseContext.getStore();
  if (inherited?.has(lockPath)) return run();

  const context = inherited ?? new Set<string>();
  const execute = async (): Promise<T> => {
    const lease = await acquireAssetMutationLease({ purpose });
    if (!lease) throw new Error(`asset mutation lease unavailable for ${purpose}`);
    context.add(lockPath);
    try {
      return await run();
    } finally {
      context.delete(lockPath);
      lease.release();
    }
  };
  return inherited ? execute() : leaseContext.run(context, execute);
}

/** Synchronous asset-write boundary over the same interprocess lease. */
export function withAssetMutationLeaseSync<T>(purpose: string, run: () => T): T {
  const lockPath = getIndexWriterLockPath();
  const inherited = leaseContext.getStore();
  if (inherited?.has(lockPath)) return run();

  const context = inherited ?? new Set<string>();
  const execute = (): T => {
    const startedAt = Date.now();
    const maxWaitMs = syncTimingOverridesForTests?.maxWaitMs ?? DEFAULT_ASSET_MUTATION_MAX_WAIT_MS;
    const waitNoticeIntervalMs =
      syncTimingOverridesForTests?.waitNoticeIntervalMs ?? ASSET_MUTATION_WAIT_NOTICE_INTERVAL_MS;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    let lease: AssetMutationLease | undefined;
    let lastWaitNoticeMs = 0;
    while (!lease) {
      lease = tryAcquireAssetMutationLease(lockPath, purpose);
      if (!lease) {
        const waitedMs = Date.now() - startedAt;
        if (waitedMs >= maxWaitMs) {
          throw new Error(`timed out waiting for asset mutation lease for ${purpose}`);
        }
        // #956: the sync path used to wait up to 10 minutes with zero
        // progress feedback. Mirror the async path's 15s onWait cadence, but
        // actually warn by default — no caller wires onWait on this path.
        if (waitedMs - lastWaitNoticeMs >= waitNoticeIntervalMs) {
          warn(`waiting for ${describeAssetMutationHolder(lockPath)} — ${Math.round(waitedMs / 1000)}s`);
          lastWaitNoticeMs = waitedMs;
        }
        sleepSync(ASSET_MUTATION_WAIT_MS);
      }
    }
    context.add(lockPath);
    try {
      return run();
    } finally {
      context.delete(lockPath);
      lease.release();
    }
  };
  return inherited ? execute() : leaseContext.run(context, execute);
}

export function probeAssetMutationLease() {
  return probeLock(getIndexWriterLockPath());
}
