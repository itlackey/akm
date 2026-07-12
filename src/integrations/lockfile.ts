// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../core/common";
import { ConfigError, rethrowIfTestIsolationError } from "../core/errors";
import { probeLock, releaseLock, releaseLockIfOwned, tryAcquireLockSync } from "../core/file-lock";
import { acquireMaintenanceBarrier } from "../core/maintenance-barrier";
import { getDataDir, getLockfileLockPath, getLockfilePath } from "../core/paths";
import type { InstallKind } from "../registry/types";
// `InstallKind` is the install/registry source discriminator — exactly the
// four kinds `parseRegistryRef` can emit ("npm" | "github" | "git" | "local").
// The lockfile reader validates against this 4-set at runtime.

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
  source: InstallKind;
  ref: string;
  resolvedVersion?: string;
  resolvedRevision?: string;
  integrity?: string;
}

// ── Lock sentinel ────────────────────────────────────────────────────────────

const LOCK_MAX_RETRIES = 3;
const LOCK_RETRY_DELAY_MS = 100;

async function acquireLockSentinel(): Promise<() => void> {
  const sentinelPath = getLockfileLockPath();
  // Ensure the directory exists before attempting to create the sentinel.
  fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
  for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
    const releaseBarrier = acquireMaintenanceBarrier();
    try {
      if (tryAcquireLockSync(sentinelPath, String(process.pid))) {
        return () => releaseLockIfOwned(sentinelPath, process.pid);
      }
      if (probeLock(sentinelPath).state === "stale") {
        releaseLock(sentinelPath);
        continue; // Reclaimed — retry immediately.
      }
    } finally {
      releaseBarrier();
    }
    // Another process holds the lock — wait briefly before retrying.
    if (attempt < LOCK_MAX_RETRIES - 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
    }
  }
  throw new ConfigError(
    `Could not acquire lockfile sentinel at ${sentinelPath}; refusing to write without exclusive ownership.`,
    "INVALID_CONFIG_FILE",
  );
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

function writeLockfileUnlocked(entries: LockfileEntry[]): void {
  // Always write to $DATA — never to the legacy $CONFIG location.
  const lockfilePath = getLockfilePath();
  const dir = path.dirname(lockfilePath);
  fs.mkdirSync(dir, { recursive: true });
  writeFileAtomic(lockfilePath, `${JSON.stringify(entries, null, 2)}\n`);
}

export async function writeLockfile(entries: LockfileEntry[]): Promise<void> {
  const release = await acquireLockSentinel();
  try {
    writeLockfileUnlocked(entries);
  } finally {
    release();
  }
}

export async function upsertLockEntry(entry: LockfileEntry): Promise<void> {
  const release = await acquireLockSentinel();
  try {
    const entries = readLockfile();
    const withoutExisting = entries.filter((e) => e.id !== entry.id);
    writeLockfileUnlocked([...withoutExisting, entry]);
  } finally {
    release();
  }
}

export async function removeLockEntry(id: string): Promise<void> {
  if (!fs.existsSync(getDataDir())) return;
  const release = await acquireLockSentinel();
  try {
    const entries = readLockfile();
    writeLockfileUnlocked(entries.filter((e) => e.id !== id));
  } finally {
    release();
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
