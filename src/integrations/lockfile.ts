// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { isProcessAlive, writeFileAtomic } from "../core/common";
import { rethrowIfTestIsolationError } from "../core/errors";
import { getDataDir } from "../core/paths";
import type { KitSource } from "../registry/types";
// `KitSource` is the typed alias for the legacy install-source strings
// ("npm" | "github" | "git" | "local"). It is now derived from
// `SourceSpec["type"]` via `src/config.ts`.

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * LockfileEntry — install-time provenance for an installed source.
 *
 * Companion to the source config entry: the config describes *where* a
 * source is configured to come from (declared in config); the LockfileEntry
 * records *what was actually installed* (resolved version, integrity hash,
 * etc.).
 *
 * Lock entries are keyed by `id` (the stable identifier shared with the
 * matching source config). The lockfile lives at `<configDir>/akm.lock` and
 * is managed independently from `config.json`.
 */
export interface LockfileEntry {
  /** Stable identifier. */
  id: string;
  source: KitSource;
  ref: string;
  resolvedVersion?: string;
  resolvedRevision?: string;
  integrity?: string;
}

// ── Paths ───────────────────────────────────────────────────────────────────

const LOCKFILE_NAME = "akm.lock";

function getLockfilePath(): string {
  return path.join(getDataDir(), LOCKFILE_NAME);
}

// ── Lock sentinel ────────────────────────────────────────────────────────────

const LOCK_MAX_RETRIES = 3;
const LOCK_RETRY_DELAY_MS = 100;

function getLockSentinelPath(): string {
  // The sentinel always lives next to the lock file it guards.
  return `${path.join(getDataDir(), LOCKFILE_NAME)}.lck`;
}

async function acquireLockSentinel(): Promise<boolean> {
  // TODO(refactor): see improve.ts acquireLock and vault.ts withVaultLock — three implementations of the same O_EXCL+PID-staleness pattern.
  const sentinelPath = getLockSentinelPath();
  // Ensure the directory exists before attempting to create the sentinel
  fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
  for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
    try {
      fs.writeFileSync(sentinelPath, String(process.pid), { flag: "wx" });
      return true; // Sentinel created — we own the lock
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Check for stale lock — if the owning PID is no longer running, reclaim it
      if (tryReclaimStaleSentinel(sentinelPath)) {
        continue; // Sentinel removed — retry immediately
      }
      // Another process holds the lock — wait briefly before retrying
      if (attempt < LOCK_MAX_RETRIES - 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
      }
    }
  }
  // Best-effort: proceed without the lock rather than failing the install
  return false;
}

/**
 * Check if the sentinel was left by a dead process and remove it if so.
 * Returns true if the sentinel was reclaimed (removed).
 */
function tryReclaimStaleSentinel(sentinelPath: string): boolean {
  try {
    const content = fs.readFileSync(sentinelPath, "utf8").trim();
    const pid = parseInt(content, 10);
    if (Number.isNaN(pid) || pid <= 0) {
      // Invalid PID in sentinel — reclaim it
      fs.unlinkSync(sentinelPath);
      return true;
    }
    // Check if the process is still alive (signal 0 doesn't kill, just checks)
    if (isProcessAlive(pid)) {
      return false; // Process is alive — lock is valid
    }
    // Process is dead — reclaim the stale lock
    fs.unlinkSync(sentinelPath);
    return true;
  } catch {
    return false; // Can't read or remove — leave it alone
  }
}

function releaseLockSentinel(): void {
  try {
    fs.unlinkSync(getLockSentinelPath());
  } catch {
    /* ignore — sentinel may already be gone */
  }
}

// ── Read / Write ────────────────────────────────────────────────────────────

export function readLockfile(): LockfileEntry[] {
  const lockfilePath = getLockfilePath();
  try {
    const raw = JSON.parse(fs.readFileSync(lockfilePath, "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.filter(isValidLockfileEntry);
  } catch (err) {
    // Defense-in-depth: getLockfilePath() is outside this try block, but a
    // future refactor that pushes a getDataDir() call inside must not mask
    // the bun-test isolation guard as "empty lockfile".
    rethrowIfTestIsolationError(err);
    return [];
  }
}

export function writeLockfile(entries: LockfileEntry[]): void {
  // Always write to $DATA — never to the legacy $CONFIG location.
  const lockfilePath = path.join(getDataDir(), LOCKFILE_NAME);
  const dir = path.dirname(lockfilePath);
  fs.mkdirSync(dir, { recursive: true });
  writeFileAtomic(lockfilePath, `${JSON.stringify(entries, null, 2)}\n`);
}

export async function upsertLockEntry(entry: LockfileEntry): Promise<void> {
  const acquired = await acquireLockSentinel();
  try {
    const entries = readLockfile();
    const withoutExisting = entries.filter((e) => e.id !== entry.id);
    writeLockfile([...withoutExisting, entry]);
  } finally {
    if (acquired) releaseLockSentinel();
  }
}

export async function removeLockEntry(id: string): Promise<void> {
  if (!fs.existsSync(getDataDir())) return;
  const acquired = await acquireLockSentinel();
  try {
    const entries = readLockfile();
    writeLockfile(entries.filter((e) => e.id !== id));
  } finally {
    if (acquired) releaseLockSentinel();
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isValidLockfileEntry(value: unknown): value is LockfileEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === "string" &&
    obj.id !== "" &&
    typeof obj.source === "string" &&
    ["npm", "github", "git", "local"].includes(obj.source) &&
    typeof obj.ref === "string" &&
    obj.ref !== ""
  );
}
