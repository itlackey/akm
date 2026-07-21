// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../core/common";
import { ConfigError, rethrowIfTestIsolationError } from "../core/errors";
import { createLockPayload, probeLock, reclaimStaleLock, releaseLock, tryAcquireLockSync } from "../core/file-lock";
import { acquireMaintenanceBarrier } from "../core/maintenance-barrier";
import { getDataDir, getLockfileLockPath, getLockfilePath } from "../core/paths";
import type { InstallKind } from "../registry/types";
// `InstallKind` is the install/registry source discriminator — exactly the
// four kinds `parseRegistryRef` can emit ("npm" | "github" | "git" | "local").
// The lockfile reader validates against this 4-set at runtime.

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * LockfileEntry — resolved lock state for one bundle (spec §10.2).
 *
 * SHAPE BUMP (Chunk-8 WI-8.4): evolved from the pre-cutover per-source entry
 * (`{ id, source, ref, resolvedVersion?, resolvedRevision?, integrity? }`) to
 * the §10.2 bundle lock shape — ONE entry per bundle id, adding the optional
 * resolved fields the spec lists as SHOULD: `localRoot` (materialized root),
 * `manifestDigest`, `adapterIds`, and `installedAt`. The core identity/locator
 * fields are UNCHANGED (`id` = bundle id; `source` = source kind; `ref` =
 * locator), so old per-source `akm.lock` files still read (shape-tolerant:
 * `readLockfile` validates only id/source/ref and carries unknown/absent
 * optional fields through); an entry is upgraded to the new shape lazily on its
 * next `upsertLockEntry` write. The desired configuration lives in config.json's
 * `bundles`; this file records ONLY the resolved cache state (spec §10.2: the
 * config MUST NOT duplicate resolved cache paths/revisions).
 *
 * The lockfile lives at `<dataDir>/akm.lock` and is managed independently from
 * `config.json`.
 */
export interface LockfileEntry {
  /** Bundle id (the stable identifier shared with the matching bundle config). */
  id: string;
  /** Source kind. */
  source: InstallKind;
  /** Source locator (the install ref). */
  ref: string;
  resolvedVersion?: string;
  resolvedRevision?: string;
  integrity?: string;
  /** Local materialized root (spec §10.2 "local materialized root"). */
  localRoot?: string;
  /** Manifest digest (spec §10.2), when the install flow computed one. */
  manifestDigest?: string;
  /** Component adapter ids (spec §10.2), when known. */
  adapterIds?: string[];
  /** Installation timestamp (spec §10.2). */
  installedAt?: string;
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
      const ownership = tryAcquireLockSync(sentinelPath, createLockPayload());
      if (ownership) {
        return () => releaseLock(ownership);
      }
      const probe = probeLock(sentinelPath);
      if (probe.state === "stale" && reclaimStaleLock(sentinelPath, probe)) {
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

/**
 * The materialized content root recorded in the lock for a managed (git/npm)
 * bundle — spec §10.2 desired/resolved split, where the desired config carries
 * only the source LOCATOR and the resolved `localRoot` lives here.
 *
 * This is the SINGLE lock-first resolution point shared by the indexer READ
 * path (`resolveEntryContentDir` in indexer/search) and the command-layer WRITE
 * path (`adaptConfiguredSource` in core/write-source): consulting it first makes
 * a write land in exactly the directory a read walks. Returns `undefined` for a
 * bundle with no lock `localRoot` (e.g. a config migrated from a `sources[]`
 * url, whose provider re-derives the cache path) or a non-managed type, so both
 * callers fall back to the identical provider-path derivation.
 */
export function lockContentRootFor(bundleId: string | undefined, type: string): string | undefined {
  if (!bundleId || (type !== "git" && type !== "npm")) return undefined;
  for (const lock of readLockfile()) {
    if (lock.id === bundleId && typeof lock.localRoot === "string" && lock.localRoot.length > 0) {
      return lock.localRoot;
    }
  }
  return undefined;
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

/**
 * Synchronously upsert lock entries (merge by id) WITHOUT acquiring the async
 * sentinel — for a caller already holding an exclusive lifecycle lock (e.g.
 * migrate-apply's config lock + maintenance barrier) whose synchronous body
 * cannot await the sentinel's retry loop. No-op for an empty list.
 */
export function mergeLockEntriesSync(entries: LockfileEntry[]): void {
  if (entries.length === 0) return;
  const existing = readLockfile();
  const incoming = new Set(entries.map((e) => e.id));
  writeLockfileUnlocked([...existing.filter((e) => !incoming.has(e.id)), ...entries]);
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
