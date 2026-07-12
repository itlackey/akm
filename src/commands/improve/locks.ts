// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { probeLock, reclaimStaleLock, releaseLockIfOwned, tryAcquireLockSync } from "../../core/file-lock";
import { withMaintenanceStartBarrier } from "../../core/maintenance-barrier";
import { warn } from "../../core/warn";

// #607 Lock Decomposition: fine-grained per-process locks replace the single
// `improve.lock`. Three independent locks allow concurrent improve runs when
// they touch different subsystems (e.g. quick-shredder consolidate can run
// alongside daily reflect+distill).
//
//   consolidate.lock   — protects consolidate + memoryInference (both write index.db)
//   reflect-distill.lock — protects reflect + distill (both write state.db proposals)
//   triage.lock         — protects triage (writes proposal promotions)
//
// Stale timeouts are per-lock, tuned to the expected runtime of the protected
// processes: consolidate is disk-bound (1h), reflect+distill is GPU-bound (2h),
// triage is fast (30min).

export const PROCESS_LOCK_DEFS = {
  consolidate: { fileName: "consolidate.lock", staleAfterMs: 60 * 60 * 1000 },
  reflectDistill: { fileName: "reflect-distill.lock", staleAfterMs: 2 * 60 * 60 * 1000 },
  triage: { fileName: "triage.lock", staleAfterMs: 30 * 60 * 1000 },
} as const;

const heldProcessLocks = new Set<string>();

export function resetHeldProcessLocks(): void {
  heldProcessLocks.clear();
}

export function processLockPath(lockBaseDir: string, lockName: keyof typeof PROCESS_LOCK_DEFS): string {
  return path.join(lockBaseDir, PROCESS_LOCK_DEFS[lockName].fileName);
}

export function tryAcquireProcessLock(
  lockPath: string,
  staleAfterMs: number,
  skipIfLocked: boolean | undefined,
  lockLabel: string,
): "acquired" | "skipped" {
  let recoveryEvent: Parameters<typeof appendEvent>[0] | undefined;
  const result = withMaintenanceStartBarrier(() =>
    tryAcquireProcessLockUnlocked(lockPath, staleAfterMs, skipIfLocked, lockLabel, (event) => {
      recoveryEvent = event;
    }),
  );
  if (recoveryEvent) {
    try {
      appendEvent(recoveryEvent);
    } catch {
      /* event emission is best-effort; never block lock recovery */
    }
  }
  return result;
}

function tryAcquireProcessLockUnlocked(
  lockPath: string,
  staleAfterMs: number,
  skipIfLocked: boolean | undefined,
  lockLabel: string,
  onRecovered: (event: Parameters<typeof appendEvent>[0]) => void,
): "acquired" | "skipped" {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const lockPayload = () => JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  if (tryAcquireLockSync(lockPath, lockPayload())) {
    heldProcessLocks.add(lockPath);
    return "acquired";
  }

  const probe = probeLock(lockPath, { staleAfterMs });

  // Race: the holder released the lock between our failed `tryAcquireLockSync`
  // and this probe, so the probe sees no file (`absent`). Retry acquisition once
  // rather than falling through to the contended skip/throw below — otherwise we
  // would warn/throw with a null PID for a lock that nobody actually holds.
  // (Mirrors the absent/stale reclaim-and-retry in `acquireExtractSessionLock`.)
  if (probe.state === "absent") {
    if (tryAcquireLockSync(lockPath, lockPayload())) {
      heldProcessLocks.add(lockPath);
      return "acquired";
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
        warn(`[improve] ${lockLabel} lock changed ownership during stale recovery; skipping (--skip-if-locked)`);
        return "skipped";
      }
      throw new ConfigError(
        `akm improve ${lockLabel} is already running. Delete ${lockPath} to force.`,
        "INVALID_CONFIG_FILE",
      );
    }
    onRecovered({
      eventType: "improve_lock_recovered",
      metadata: {
        lockName: lockLabel,
        stalePid: lock?.pid ?? null,
        lockedAt: lock?.startedAt ?? null,
        recoveredAt: new Date().toISOString(),
        lockAgeMs: probe.ageMs ?? null,
        reason: probe.reason === "pid_dead" ? "pid_not_alive" : probe.reason,
      },
    });
    if (tryAcquireLockSync(lockPath, lockPayload())) {
      heldProcessLocks.add(lockPath);
      return "acquired";
    }
    if (skipIfLocked) {
      warn(`[improve] ${lockLabel} lock acquired by another run during stale recovery; skipping (--skip-if-locked)`);
      return "skipped";
    }
    throw new ConfigError(
      `akm improve ${lockLabel} is already running. Delete ${lockPath} to force.`,
      "INVALID_CONFIG_FILE",
    );
  }

  if (skipIfLocked) {
    warn(
      `[improve] ${lockLabel} lock held by another run (PID ${lock?.pid}, started ${lock?.startedAt}); skipping (--skip-if-locked)`,
    );
    return "skipped";
  }

  throw new ConfigError(
    `akm improve ${lockLabel} is already running (PID ${lock?.pid}, started ${lock?.startedAt}). Delete ${lockPath} to force.`,
    "INVALID_CONFIG_FILE",
  );
}

export function releaseProcessLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // ignore
  }
  heldProcessLocks.delete(lockPath);
}

export function releaseAllProcessLocks(): void {
  for (const p of heldProcessLocks) {
    try {
      fs.unlinkSync(p);
    } catch {
      // ignore
    }
  }
  heldProcessLocks.clear();
}

/**
 * Ownership-safe release of every currently-held lock, for the `process.on("exit")`
 * backstop (signal handler / budget watchdog paths that skip the normal finally).
 * Uses `releaseLockIfOwned` so a lock another PID legitimately re-acquired after a
 * stale recovery is never deleted. Does NOT clear the Set (the process is exiting).
 */
export function releaseHeldLocksIfOwned(pid: number): void {
  for (const p of heldProcessLocks) {
    releaseLockIfOwned(p, pid);
  }
}

/**
 * RAII for the "best-effort stage" lock pattern: acquire the lock if available,
 * run `body` REGARDLESS of acquisition, and release the lock in a `finally` iff
 * we acquired it (on both the normal and the throw path). This makes
 * release-on-throw LOCAL instead of relying on a distant outer catch.
 *
 * Behaviour matches the hand-rolled `acquired = tryAcquire(...) === "acquired";
 * …run stage…; if (acquired) release` idiom it replaces:
 *   - When the lock is held and `skipIfLocked` is set, `tryAcquireProcessLock`
 *     returns "skipped" → the stage still runs (unlocked), nothing to release.
 *   - When the lock is held and `skipIfLocked` is NOT set, `tryAcquireProcessLock`
 *     throws (propagated here before `body` runs; nothing acquired, nothing released).
 *   - The process-exit backstop (`releaseHeldLocksIfOwned`) still covers a
 *     `process.exit` that skips this `finally`.
 */
export async function withOptionalProcessLock<T>(
  opts: { lockPath: string; staleAfterMs: number; skipIfLocked: boolean | undefined; label: string },
  body: () => Promise<T>,
): Promise<T> {
  const acquired =
    tryAcquireProcessLock(opts.lockPath, opts.staleAfterMs, opts.skipIfLocked, opts.label) === "acquired";
  try {
    return await body();
  } finally {
    if (acquired) releaseProcessLock(opts.lockPath);
  }
}
