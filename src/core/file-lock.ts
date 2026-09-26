// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * PID-stamped exclusive lock files.
 *
 * A lock is one file created with `O_EXCL` (`wx`), which the filesystem
 * makes atomic: exactly one creator wins, so no further mutex or barrier is
 * needed around acquisition. The payload records the holder's PID (and the
 * launcher PID under a scheduler) so a probe can tell a live holder from a
 * dead one; only a verifiably dead holder — or, when the caller opts in via
 * `staleAfterMs`, an over-age one — is ever reclaimed. Reclaim moves the
 * stale file aside, re-verifies it is the very file that was probed, and only
 * then unlinks it, so two reclaimers cannot both "win" the same stale lock.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { isProcessAlive, MAX_LOCK_METADATA_BYTES, readTextFileDescriptorWithLimit } from "./common";

export type LockProbeOptions = {
  /** Treat a lock older than this as stale even when its holder PID is alive. */
  staleAfterMs?: number;
};

export type LockProbeResult =
  | { state: "absent" }
  | {
      state: "held";
      holderPid: number;
      launcherPid?: number;
      ageMs: number;
      rawContent: string;
      identity: LockFileIdentity;
    }
  | {
      state: "stale";
      reason: "pid_dead" | "unreadable" | "invalid_pid" | "age_exceeded";
      holderPid?: number;
      launcherPid?: number;
      ageMs?: number;
      rawContent?: string;
      identity?: LockFileIdentity;
    }
  | { state: "inaccessible"; code?: string };

export interface ReclaimStaleLockOptions {
  /** Runs once the stale file has been moved aside and verified, before it is unlinked. */
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

function releaseLockRaw(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Already gone.
  }
}

/** Create the lock file atomically; `undefined` when another holder already has it. */
export function tryAcquireLockSync(lockPath: string, payload: string): LockOwnership | undefined {
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

export function launcherPidFromEnv(): number | undefined {
  const raw = process.env.AKM_LAUNCHER_PID;
  if (!raw) return undefined;
  const pid = Number.parseInt(raw, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

export function createLockPayload(metadata: Record<string, unknown> = {}): string {
  const launcherPid = launcherPidFromEnv();
  return JSON.stringify({
    ...metadata,
    pid: process.pid,
    ...(launcherPid !== undefined ? { launcherPid } : {}),
    lockId: randomUUID(),
  });
}

export function probeLock(lockPath: string, opts?: LockProbeOptions): LockProbeResult {
  let snapshot: ReturnType<typeof readLockSnapshot>;
  try {
    snapshot = readLockSnapshot(lockPath);
  } catch (error) {
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
 * Remove a lock that `probeLock` reported stale. Returns `false` when the file
 * changed since the probe (someone else reclaimed or re-acquired it) so the
 * caller re-probes instead of assuming the path is free.
 */
export function reclaimStaleLock(
  lockPath: string,
  probe: Extract<LockProbeResult, { state: "stale" }>,
  options?: ReclaimStaleLockOptions,
): boolean {
  if (probe.rawContent === undefined || probe.identity === undefined) return false;
  const expectedContent = probe.rawContent;
  const expectedIdentity = probe.identity;
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
    // The file we moved aside is not the one we probed: a fresh holder took
    // the path in between. Put it back and report no reclaim.
    try {
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
}

/** Unlink the lock only while it is still the exact file this owner created. */
export function releaseLock(ownership: LockOwnership): void {
  const { lockPath } = ownership;
  let current: ReturnType<typeof readLockSnapshot>;
  try {
    current = readLockSnapshot(lockPath);
  } catch {
    return;
  }
  if (current && current.rawContent === ownership.rawContent && sameIdentity(current.identity, ownership.identity)) {
    releaseLockRaw(lockPath);
  }
}

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
