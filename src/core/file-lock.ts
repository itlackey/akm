// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { openDatabase } from "../storage/database";
import { isProcessAlive } from "./common";

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
      ageMs: number;
      rawContent: string;
      identity: LockFileIdentity;
    }
  | {
      state: "stale";
      reason: "pid_dead" | "unreadable" | "invalid_pid" | "age_exceeded";
      holderPid?: number;
      ageMs?: number;
      rawContent?: string;
      identity?: LockFileIdentity;
    };

export interface ReclaimStaleLockOptions {
  /** Test seam for a replacement installed after quarantine verification. */
  afterQuarantineVerified?: () => void;
}

interface LockFileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
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
    const rawContent = fs.readFileSync(fd, "utf8");
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
      if (!began) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2 ** attempt);
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

function tryAcquireLockRaw(lockPath: string, payload: string): boolean {
  try {
    fs.writeFileSync(lockPath, payload, { flag: "wx" });
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
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
 * Returns true if we now own the lock, false if a sentinel already
 * exists (EEXIST). Throws any other error (permissions, missing parent
 * dir, etc.) — callers must ensure the parent directory exists.
 *
 * `payload` is typically `String(process.pid)` for the simple cases or
 * a small JSON envelope for callers that want richer metadata
 * (improve.ts records pid + startedAt so audit can correlate runs).
 */
export function tryAcquireLockSync(lockPath: string, payload: string): boolean {
  return withLockOperationMutex(lockPath, () => tryAcquireLockRaw(lockPath, payload));
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
  } catch {
    return { state: "stale", reason: "unreadable" };
  }
  if (!snapshot) return { state: "absent" };
  const { rawContent, identity } = snapshot;
  const ageMs = Date.now() - identity.mtimeMs;

  const holderPid = extractHolderPid(rawContent);
  if (holderPid === undefined) {
    return { state: "stale", reason: "invalid_pid", ageMs, rawContent, identity };
  }
  if (!isProcessAlive(holderPid)) {
    return { state: "stale", reason: "pid_dead", holderPid, ageMs, rawContent, identity };
  }
  if (opts?.staleAfterMs !== undefined && ageMs > opts.staleAfterMs) {
    return { state: "stale", reason: "age_exceeded", holderPid, ageMs, rawContent, identity };
  }
  return { state: "held", holderPid, ageMs, rawContent, identity };
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
 * Remove a lock file. Idempotent — silently ignores ENOENT. Used both to
 * reclaim stale locks (after probeLock returns `state: "stale"`) and to
 * release locks we own (after a successful tryAcquireLockSync).
 */
export function releaseLock(lockPath: string): void {
  if (!fs.existsSync(lockPath) && !fs.existsSync(operationMutexPath(lockPath))) return;
  withLockOperationMutex(lockPath, () => releaseLockRaw(lockPath));
}

/**
 * Release a lock ONLY if it is still owned by `ownerPid`. Safe to call from a
 * `process.exit()` / `'exit'` handler as a backstop: `process.exit()` skips
 * `finally` blocks — so the normal lock-release never runs on signal death
 * (SIGTERM/SIGINT) — but it DOES fire `'exit'` listeners synchronously. Checking
 * ownership first means that if the lock was already released and re-acquired by
 * a different process, this leaves that process's lock intact (no cross-run
 * deletion / PID-reuse footgun). Synchronous so it is valid inside an exit handler.
 */
export function releaseLockIfOwned(lockPath: string, ownerPid: number): void {
  if (!fs.existsSync(lockPath) && !fs.existsSync(operationMutexPath(lockPath))) return;
  withLockOperationMutex(lockPath, () => {
    let rawContent: string;
    try {
      rawContent = fs.readFileSync(lockPath, "utf8");
    } catch {
      // Absent or unreadable — nothing of ours to release.
      return;
    }
    if (extractHolderPid(rawContent) === ownerPid) releaseLockRaw(lockPath);
  });
}

/**
 * Extract a PID from a sentinel body. Accepts the two shapes used across
 * the codebase: a bare numeric string (config-io, vault, lockfile) and
 * a JSON object with a `pid` field (improve). Returns undefined when the
 * body is unparseable or yields a non-positive integer.
 */
function extractHolderPid(content: string): number | undefined {
  const trimmed = content.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { pid?: unknown };
      const pid = typeof parsed.pid === "number" ? parsed.pid : Number.NaN;
      return Number.isInteger(pid) && pid > 0 ? pid : undefined;
    } catch {
      return undefined;
    }
  }
  const pid = Number.parseInt(trimmed, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}
