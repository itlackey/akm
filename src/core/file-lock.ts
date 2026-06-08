// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
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
    }
  | {
      state: "stale";
      reason: "pid_dead" | "unreadable" | "invalid_pid" | "age_exceeded";
      holderPid?: number;
      ageMs?: number;
      rawContent?: string;
    };

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
  try {
    fs.writeFileSync(lockPath, payload, { flag: "wx" });
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
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
  let rawContent: string;
  let ageMs: number;
  try {
    rawContent = fs.readFileSync(lockPath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
    return { state: "stale", reason: "unreadable" };
  }
  try {
    const stat = fs.statSync(lockPath);
    ageMs = Date.now() - stat.mtimeMs;
  } catch {
    // Stat failed even though read succeeded — race-y removal in flight.
    return { state: "stale", reason: "unreadable", rawContent };
  }

  const holderPid = extractHolderPid(rawContent);
  if (holderPid === undefined) {
    return { state: "stale", reason: "invalid_pid", ageMs, rawContent };
  }
  if (!isProcessAlive(holderPid)) {
    return { state: "stale", reason: "pid_dead", holderPid, ageMs, rawContent };
  }
  if (opts?.staleAfterMs !== undefined && ageMs > opts.staleAfterMs) {
    return { state: "stale", reason: "age_exceeded", holderPid, ageMs, rawContent };
  }
  return { state: "held", holderPid, ageMs, rawContent };
}

/**
 * Remove a lock file. Idempotent — silently ignores ENOENT. Used both to
 * reclaim stale locks (after probeLock returns `state: "stale"`) and to
 * release locks we own (after a successful tryAcquireLockSync).
 */
export function releaseLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Sentinel already gone — fine.
  }
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
  let rawContent: string;
  try {
    rawContent = fs.readFileSync(lockPath, "utf8");
  } catch {
    // Absent or unreadable — nothing of ours to release.
    return;
  }
  if (extractHolderPid(rawContent) === ownerPid) {
    releaseLock(lockPath);
  }
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
