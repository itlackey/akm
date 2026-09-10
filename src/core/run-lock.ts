// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * PID-liveness-only run lock — the shared mechanics behind `akm improve`'s
 * whole-run lock (`commands/improve/locks.ts`) and the index rebuild lock
 * (`indexer/index-rebuild-lock.ts`, #956).
 *
 * No `staleAfterMs`: only a verifiably dead holder is ever reclaimed. This is
 * the #872 lesson encoded at the mechanics layer so every future caller gets
 * it for free — an age-based stale window let a live-but-wedged holder's
 * lease survive forever from the holder's own point of view while stranding
 * every OTHER invocation once the clock passed, which cost one real install
 * a half-day indexing outage. SQLite's own WAL + busy_timeout + BEGIN
 * IMMEDIATE already serialize concurrent writers at the correctness layer —
 * this lock only ever avoids duplicate LOGICAL work or lets a caller choose
 * to skip instead of contend.
 *
 * This module performs exactly one create-or-probe attempt (with the same
 * absent-race and stale-reclaim retries `improve` established) and reports
 * whether the caller now owns the lock or, if not, who currently holds it.
 * It does not decide what "held" means — skip, throw, or warn-and-proceed is
 * entirely up to the caller — and it does not serialize the attempt itself:
 * every caller must wrap the call in
 * `withMaintenanceStartBarrier`/`tryWithMaintenanceStartBarrier`
 * (`core/maintenance-barrier.ts`) so two racing processes never both create
 * the sentinel in the same window.
 */

import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "./errors";
import { createLockPayload, type LockOwnership, probeLock, reclaimStaleLock, tryAcquireLockSync } from "./file-lock";
import { describeInaccessiblePath } from "./path-access";

/** Best-effort identity of the process currently holding a contended lock. */
export interface RunLockHolder {
  pid: number | null;
  startedAt: string | null;
  /** The holder's launcher pid (#956), when its lock payload recorded one — null otherwise. */
  launcherPid: number | null;
}

/**
 * Render a lock holder's pid for a message: `"4242"`, or `"4242 (launcher
 * 4240)"` when the holder's launcher pid is known (#956) — every process
 * listing and task log shows the launcher pid, not the bun/node child's, so
 * naming only the holder pid left an operator unable to connect the two.
 */
export function formatLockHolderPid(holder: Pick<RunLockHolder, "pid" | "launcherPid">): string {
  if (holder.pid === null) return "unknown";
  return holder.launcherPid !== null ? `${holder.pid} (launcher ${holder.launcherPid})` : String(holder.pid);
}

export type RunLockAcquireResult =
  | { state: "acquired"; ownership: LockOwnership }
  | { state: "held"; holder: RunLockHolder };

/** Details of a stale (verifiably dead PID) lock reclaimed before acquisition. */
export interface RunLockReclaimInfo {
  holderPid: number | null;
  lockedAt: string | null;
  ageMs: number | null;
  reason: string;
}

export interface TryAcquireRunLockOptions {
  /** Human label used in the "lock exists but is not readable" error, e.g. "improve" or "index rebuild". */
  label: string;
  /** Extra fields merged into the lock payload alongside `pid` and a unique `lockId`. */
  payloadMetadata?: Record<string, unknown>;
  /** Invoked when a dead holder's lease is reclaimed. Never a user-facing warning — verbose log territory at most. */
  onReclaimed?: (info: RunLockReclaimInfo) => void;
}

function parseLockPayload(
  rawContent: string | undefined,
): { pid?: number; startedAt?: string; launcherPid?: number } | null {
  if (!rawContent) return null;
  try {
    return JSON.parse(rawContent) as { pid: number; startedAt: string; launcherPid?: number };
  } catch {
    return null;
  }
}

function holderOf(lock: { pid?: number; startedAt?: string; launcherPid?: number } | null): RunLockHolder {
  return { pid: lock?.pid ?? null, startedAt: lock?.startedAt ?? null, launcherPid: lock?.launcherPid ?? null };
}

/**
 * Attempt to acquire `lockPath`. Returns `{ state: "acquired" }` with an
 * ownership handle for {@link releaseLock}, or `{ state: "held", holder }`
 * naming the current holder (best-effort; `pid`/`startedAt` are `null` when
 * the holder identity could not be determined, e.g. a release-then-reacquire
 * race). Throws {@link ConfigError} if the sentinel exists but cannot be read
 * (#791: a lock we cannot see may be genuinely held — never a reclaim
 * candidate).
 */
export function tryAcquireRunLock(lockPath: string, options: TryAcquireRunLockOptions): RunLockAcquireResult {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const lockPayload = () => createLockPayload({ startedAt: new Date().toISOString(), ...options.payloadMetadata });

  let ownership = tryAcquireLockSync(lockPath, lockPayload());
  if (ownership) return { state: "acquired", ownership };

  const probe = probeLock(lockPath);

  // Race: the holder released between the failed acquire above and this
  // probe. Retry once rather than falling through with a null-PID "held"
  // report for a lock nobody actually holds.
  if (probe.state === "absent") {
    ownership = tryAcquireLockSync(lockPath, lockPayload());
    if (ownership) return { state: "acquired", ownership };
    // Re-grabbed by another racer in this exact window — no holder detail
    // available without re-probing (which could itself race again).
    return { state: "held", holder: { pid: null, startedAt: null, launcherPid: null } };
  }

  if (probe.state === "inaccessible") {
    throw new ConfigError(
      `${options.label} lock exists but is not readable: ${describeInaccessiblePath(lockPath, probe.code)}.`,
      "DATA_DIR_UNREADABLE",
    );
  }

  const lock = parseLockPayload(probe.rawContent);

  if (probe.state === "stale") {
    if (!reclaimStaleLock(lockPath, probe)) {
      return { state: "held", holder: holderOf(lock) };
    }
    options.onReclaimed?.({
      holderPid: lock?.pid ?? probe.holderPid ?? null,
      lockedAt: lock?.startedAt ?? null,
      ageMs: probe.ageMs ?? null,
      reason: probe.reason === "pid_dead" ? "pid_not_alive" : probe.reason,
    });
    ownership = tryAcquireLockSync(lockPath, lockPayload());
    if (ownership) return { state: "acquired", ownership };
    // Acquired by another racer during stale recovery.
    return { state: "held", holder: holderOf(lock) };
  }

  // probe.state === "held"
  return { state: "held", holder: holderOf(lock) };
}
