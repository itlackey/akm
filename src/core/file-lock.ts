// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sleepSync } from "../runtime";
import { openDatabase } from "../storage/database";
import { isProcessAlive, MAX_LOCK_METADATA_BYTES, readTextFileDescriptorWithLimit } from "./common";

// Shared primitives for sentinel-style file locks across akm. The four
// historical implementations (config-io.ts, commands/improve.ts,
// commands/vault.ts, integrations/lockfile.ts) all used the same O_EXCL
// + PID-staleness pattern but diverged in retry / async / error policy.
//
// This module factors out the three operations every call site needs
// (atomic acquire, holder probe, release/reclaim) so policy lives at
// the call site and the mechanics live here.

export type LockProbeOptions = {
  /**
   * If set, treat any lock whose file mtime is older than this many
   * milliseconds as stale, even if the holder PID is still alive. Used by
   * `improve.ts` to recover from long-running runs that crashed without
   * cleaning up. Default: undefined (no age-based staleness).
   */
  staleAfterMs?: number;
};

export type LockProbeResult =
  | { state: "absent" }
  | {
      state: "held";
      holderPid: number;
      /** The holder's launcher pid (#956), when its lock payload recorded one. */
      launcherPid?: number;
      ageMs: number;
      rawContent: string;
      identity: LockFileIdentity;
    }
  | {
      state: "stale";
      reason: "pid_dead" | "unreadable" | "invalid_pid" | "age_exceeded";
      holderPid?: number;
      /** The holder's launcher pid (#956), when its lock payload recorded one. */
      launcherPid?: number;
      ageMs?: number;
      rawContent?: string;
      identity?: LockFileIdentity;
    }
  /**
   * The sentinel is there but this process cannot read it — a permission or
   * ownership problem, not a dead holder (#791).
   *
   * Previously this collapsed into `stale`/`unreadable`, i.e. "the holder is
   * gone, take the lock". It was not destructive only by accident:
   * `reclaimStaleLock` bails when `rawContent` is undefined. But "I cannot see
   * this lock" and "the holder is dead" are opposite facts, and a caller acting
   * on the wrong one would hand out a nominally exclusive lease that someone
   * else is actively holding. Callers must treat this as a hard stop.
   */
  | { state: "inaccessible"; code?: string };

export interface ReclaimStaleLockOptions {
  /** Test seam for a replacement installed after quarantine verification. */
  afterQuarantineVerified?: () => void;
}

export interface LockFileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

export interface LockOwnership {
  lockPath: string;
  rawContent: string;
  identity: LockFileIdentity;
}

function readLockSnapshot(lockPath: string): { rawContent: string; identity: LockFileIdentity } | undefined {
  let fd: number;
  try {
    fd = fs.openSync(lockPath, "r");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  try {
    const rawContent = readTextFileDescriptorWithLimit(fd, MAX_LOCK_METADATA_BYTES, "Lock metadata", lockPath);
    const stat = fs.fstatSync(fd);
    return {
      rawContent,
      identity: { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs },
    };
  } finally {
    fs.closeSync(fd);
  }
}

function sameIdentity(left: LockFileIdentity, right: LockFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function operationMutexPath(lockPath: string): string {
  // `.sensitive` is an established non-asset suffix across stash walkers. The
  // mutex may sit beside a secret/env lock and must never surface as an asset.
  return path.join(path.dirname(lockPath), `.${path.basename(lockPath)}.operations.sensitive`);
}

/**
 * Serialize every mutation of one canonical lock path. SQLite's write lock is
 * released by the OS when a process dies, so this mutex needs no stale-owner
 * deletion protocol (which would reproduce the same check/rename race it is
 * meant to prevent).
 */
function withLockOperationMutex<T>(lockPath: string, run: () => T): T {
  const db = openDatabase(operationMutexPath(lockPath));
  let began = false;
  try {
    db.exec("PRAGMA busy_timeout = 30000");
    for (let attempt = 0; attempt < 5 && !began; attempt += 1) {
      db.exec("BEGIN IMMEDIATE");
      began = db.inTransaction;
      if (!began) sleepSync(2 ** attempt);
    }
    if (!began) throw new Error(`Could not acquire lock operation mutex for ${lockPath}.`);
    const result = run();
    db.exec("COMMIT");
    began = false;
    return result;
  } catch (error) {
    if (began && db.inTransaction) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the operation failure.
      }
    }
    throw error;
  } finally {
    db.close();
  }
}

function tryAcquireLockRaw(lockPath: string, payload: string): LockOwnership | undefined {
  try {
    fs.writeFileSync(lockPath, payload, { flag: "wx" });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw err;
  }
  let snapshot: ReturnType<typeof readLockSnapshot>;
  try {
    snapshot = readLockSnapshot(lockPath);
  } catch (error) {
    releaseLockRaw(lockPath);
    throw error;
  }
  if (!snapshot) {
    releaseLockRaw(lockPath);
    throw new Error(`Could not read newly acquired lock at ${lockPath}.`);
  }
  return { lockPath, ...snapshot };
}

function releaseLockRaw(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Sentinel already gone — fine.
  }
}

/**
 * Atomically create a sentinel at `lockPath` with `payload` as the body.
 * Returns an exact ownership handle if we now own the lock, or undefined if a sentinel already
 * exists (EEXIST). Throws any other error (permissions, missing parent
 * dir, etc.) — callers must ensure the parent directory exists.
 *
 * `payload` is typically `String(process.pid)` for the simple cases or
 * a small JSON envelope for callers that want richer metadata
 * (improve.ts records pid + startedAt so audit can correlate runs).
 */
export function tryAcquireLockSync(lockPath: string, payload: string): LockOwnership | undefined {
  return withLockOperationMutex(lockPath, () => tryAcquireLockRaw(lockPath, payload));
}

/**
 * Best-effort launcher pid from `AKM_LAUNCHER_PID` (set by
 * `scripts/node-runtime/akm`/`akm-migrate`, #956) — undefined when unset,
 * empty, or not a positive integer (never trust an ambient env var blindly
 * into a lock message). Also the gate the parent-death watchdog
 * (`core/parent-watchdog.ts`) uses to stay inert outside a launcher-managed
 * run.
 */
export function launcherPidFromEnv(): number | undefined {
  const raw = process.env.AKM_LAUNCHER_PID;
  if (!raw) return undefined;
  const pid = Number.parseInt(raw, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * Build a PID-bearing payload with a unique token for one acquisition attempt.
 * Adds `launcherPid` (#956) whenever this process is running under the
 * published launcher, so a lock's holder can be identified by the pid every
 * process listing and task log actually shows (the launcher's) as well as
 * the pid that holds the lock (the bun/node child).
 */
export function createLockPayload(metadata: Record<string, unknown> = {}): string {
  const launcherPid = launcherPidFromEnv();
  return JSON.stringify({
    ...metadata,
    pid: process.pid,
    ...(launcherPid !== undefined ? { launcherPid } : {}),
    lockId: randomUUID(),
  });
}

/**
 * Inspect an existing sentinel at `lockPath` without modifying it.
 * Returns:
 *   - `absent` if the file does not exist.
 *   - `stale` if the file is present but should be reclaimed (the holding
 *     PID is dead, the content is unparseable, or the lock has exceeded
 *     `staleAfterMs`). Includes the failure reason so callers can log it.
 *   - `held` if the lock has a live holder and is not yet age-expired.
 *
 * Does NOT remove the file. Callers decide recovery policy.
 */
export function probeLock(lockPath: string, opts?: LockProbeOptions): LockProbeResult {
  let snapshot: ReturnType<typeof readLockSnapshot>;
  try {
    snapshot = readLockSnapshot(lockPath);
  } catch (error) {
    // A permission error means the lock may be genuinely HELD by someone we
    // cannot see. Reporting it as stale would invite a caller to steal a live
    // lease (#791) — `unreadable` stays for the corrupt/undecodable case.
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EACCES" || code === "EPERM") return { state: "inaccessible", code };
    return { state: "stale", reason: "unreadable" };
  }
  if (!snapshot) return { state: "absent" };
  const { rawContent, identity } = snapshot;
  const ageMs = Date.now() - identity.mtimeMs;

  const { holderPid, launcherPid } = extractLockIdentity(rawContent);
  if (holderPid === undefined) {
    return { state: "stale", reason: "invalid_pid", ageMs, rawContent, identity };
  }
  if (!isProcessAlive(holderPid)) {
    return { state: "stale", reason: "pid_dead", holderPid, launcherPid, ageMs, rawContent, identity };
  }
  if (opts?.staleAfterMs !== undefined && ageMs > opts.staleAfterMs) {
    return { state: "stale", reason: "age_exceeded", holderPid, launcherPid, ageMs, rawContent, identity };
  }
  return { state: "held", holderPid, launcherPid, ageMs, rawContent, identity };
}

/**
 * Revalidate and quarantine the probed sentinel while holding the same operation
 * mutex used by acquisitions. A newer owner therefore cannot be renamed in the
 * check/quarantine window, and a third contender cannot acquire until cleanup
 * has completed.
 */
export function reclaimStaleLock(
  lockPath: string,
  probe: Extract<LockProbeResult, { state: "stale" }>,
  options?: ReclaimStaleLockOptions,
): boolean {
  if (probe.rawContent === undefined || probe.identity === undefined) return false;
  const expectedContent = probe.rawContent;
  const expectedIdentity = probe.identity;
  return withLockOperationMutex(lockPath, () => {
    let current: ReturnType<typeof readLockSnapshot>;
    try {
      current = readLockSnapshot(lockPath);
    } catch {
      return false;
    }
    if (!current || current.rawContent !== expectedContent || !sameIdentity(current.identity, expectedIdentity)) {
      return false;
    }

    const quarantinePath = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
    try {
      fs.renameSync(lockPath, quarantinePath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }

    let quarantined: ReturnType<typeof readLockSnapshot>;
    try {
      quarantined = readLockSnapshot(quarantinePath);
    } catch {
      quarantined = undefined;
    }
    if (
      !quarantined ||
      quarantined.rawContent !== expectedContent ||
      !sameIdentity(quarantined.identity, expectedIdentity)
    ) {
      try {
        // Restore without replacing a non-cooperating lock installed after quarantine.
        fs.linkSync(quarantinePath, lockPath);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      releaseLockRaw(quarantinePath);
      return false;
    }
    options?.afterQuarantineVerified?.();
    try {
      fs.unlinkSync(quarantinePath);
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  });
}

/**
 * Release only the exact sentinel returned by `tryAcquireLockSync`. Content and
 * file identity are revalidated while holding the acquisition operation mutex,
 * so a stale holder cannot remove a successor. Synchronous and idempotent so it
 * is safe in both `finally` blocks and process exit handlers.
 */
export function releaseLock(ownership: LockOwnership): void {
  const { lockPath } = ownership;
  if (!fs.existsSync(lockPath) && !fs.existsSync(operationMutexPath(lockPath))) return;
  withLockOperationMutex(lockPath, () => {
    let current: ReturnType<typeof readLockSnapshot>;
    try {
      current = readLockSnapshot(lockPath);
    } catch {
      // Absent or unreadable — nothing of ours to release.
      return;
    }
    if (current && current.rawContent === ownership.rawContent && sameIdentity(current.identity, ownership.identity)) {
      releaseLockRaw(lockPath);
    }
  });
}

/**
 * Extract a holder pid, and (#956) a launcher pid when the payload recorded
 * one, from a sentinel body. Accepts the two shapes used across the
 * codebase: a bare numeric string (config-io, vault, lockfile — never
 * carries a `launcherPid`) and a JSON object with `pid`/`launcherPid` fields
 * (`createLockPayload`). `holderPid` is undefined when the body is
 * unparseable or yields a non-positive integer; `launcherPid` is undefined
 * whenever the payload has none, independent of whether `holderPid` parsed.
 */
function extractLockIdentity(content: string): { holderPid?: number; launcherPid?: number } {
  const trimmed = content.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { pid?: unknown; launcherPid?: unknown };
      const pid = typeof parsed.pid === "number" ? parsed.pid : Number.NaN;
      const rawLauncherPid = typeof parsed.launcherPid === "number" ? parsed.launcherPid : Number.NaN;
      return {
        holderPid: Number.isInteger(pid) && pid > 0 ? pid : undefined,
        launcherPid: Number.isInteger(rawLauncherPid) && rawLauncherPid > 0 ? rawLauncherPid : undefined,
      };
    } catch {
      return {};
    }
  }
  const pid = Number.parseInt(trimmed, 10);
  return { holderPid: Number.isInteger(pid) && pid > 0 ? pid : undefined };
}
