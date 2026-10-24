// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../core/common";
import { ConfigError, rethrowIfTestIsolationError, TransientError } from "../core/errors";
import { createLockPayload, probeLock, reclaimStaleLock, releaseLock, tryAcquireLockSync } from "../core/file-lock";
import { classifyPathAccess, describeInaccessiblePath } from "../core/path-access";
import { getDataDir, getLockfileLockPath, getLockfilePath } from "../core/paths";
import { warn } from "../core/warn";
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

const LOCK_ACQUIRE_TIMEOUT_MS = 30_000;
const LOCK_RETRY_INITIAL_DELAY_MS = 50;
const LOCK_RETRY_MAX_DELAY_MS = 1_000;

let lockAcquireTimeoutMsForTests: number | undefined;

export function _setLockAcquireTimeoutMsForTests(ms: number | undefined): void {
  lockAcquireTimeoutMsForTests = ms;
}

async function acquireLockSentinel(): Promise<() => void> {
  const sentinelPath = getLockfileLockPath();
  // Ensure the directory exists before attempting to create the sentinel.
  fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
  const timeoutMs = lockAcquireTimeoutMsForTests ?? LOCK_ACQUIRE_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let delayMs = LOCK_RETRY_INITIAL_DELAY_MS;
  let announced = false;
  for (;;) {
    const ownership = tryAcquireLockSync(sentinelPath, createLockPayload());
    if (ownership) {
      return () => releaseLock(ownership);
    }
    const probe = probeLock(sentinelPath);
    if (probe.state === "stale" && reclaimStaleLock(sentinelPath, probe)) {
      continue; // Reclaimed — retry immediately.
    }
    // Another process holds the lock: ordinary contention, exit 75, not a
    // config error a supervisor should stop retrying on.
    if (Date.now() >= deadline) {
      throw new TransientError(
        `Could not acquire lockfile sentinel at ${sentinelPath} after ${(timeoutMs / 1000).toFixed(1)}s; refusing to write without exclusive ownership.`,
        "LOCKFILE_CONTENDED",
      );
    }
    if (!announced) {
      announced = true;
      warn("[akm] Waiting for another akm process to release the lockfile...");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    delayMs = Math.min(delayMs * 2, LOCK_RETRY_MAX_DELAY_MS);
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

/**
 * Refuse to treat an UNREADABLE lockfile (or data dir) as an absent one (#791).
 *
 * Every write path here is read-modify-WRITE: it loads the current entries and
 * writes the whole array back. An unreadable `akm.lock` that reads as `[]`
 * therefore does not merely lose information — the very next
 * `writeFileAtomic` replaces the operator's entire lock record with the single
 * entry this call happened to be adding. That is the same catastrophe R-012
 * guards against for a *corrupt* file, reached instead through a permission
 * fault, and `fs.existsSync`/a swallowed `readFileSync` could not tell the two
 * apart from "the file was never created".
 *
 * No-op when the path is genuinely absent — that case really does have nothing
 * to preserve.
 */
function assertLockfilePathReadable(target: string): void {
  const { access, code } = classifyPathAccess(target);
  if (access !== "inaccessible") return;
  throw new ConfigError(
    `Refusing to modify the lockfile: ${describeInaccessiblePath(target, code)}. akm cannot read the existing lock ` +
      "records, and writing over them would destroy every bundle they track. Fix the ownership or mode of that " +
      "path (or point AKM_DATA_DIR / XDG_DATA_HOME somewhere this user owns) and retry.",
    "DATA_DIR_UNREADABLE",
  );
}

/**
 * Like {@link readLockfile}, but THROWS instead of silently degrading to `[]`
 * when the on-disk lockfile exists yet cannot be read or parsed (R-012, #791).
 *
 * `readLockfile`'s fail-open contract is intentional for READ paths — a
 * corrupt lock degrades a managed bundle to "unmanaged" rather than erroring
 * every read-only command. But every writer below reads the current entries
 * and writes the whole array back; if that read silently returned `[]` for a
 * corrupt or unreadable file, the write would replace it with only the one
 * entry being changed — permanently destroying every other lock record (a
 * corrupt lockfile once wiped every entry this way). A missing file is NOT
 * corruption: there is nothing to preserve, so that case returns `[]`.
 */
function readLockfileOrThrow(): LockfileEntry[] {
  const lockfilePath = getLockfilePath();
  let raw: string;
  try {
    raw = fs.readFileSync(lockfilePath, "utf8");
  } catch (err) {
    rethrowIfTestIsolationError(err);
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    // An UNREADABLE lockfile has everything to preserve and we cannot see it.
    // Classify AFTER the failed read so the happy path costs no extra syscall.
    assertLockfilePathReadable(lockfilePath);
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(
      `Refusing to modify lockfile ${lockfilePath}: existing content is not valid JSON (${error instanceof Error ? error.message : String(error)}). Fix or remove the file by hand before retrying — every existing lock entry would otherwise be lost.`,
      "INVALID_CONFIG_FILE",
    );
  }
  if (!Array.isArray(parsed)) {
    throw new ConfigError(
      `Refusing to modify lockfile ${lockfilePath}: existing content is not a JSON array. Fix or remove the file by hand before retrying — every existing lock entry would otherwise be lost.`,
      "INVALID_CONFIG_FILE",
    );
  }
  // Refuse rather than filter. This is the WRITE path's read: everything it
  // returns is what gets written back, so silently dropping entries that fail
  // per-entry validation destroyed them on the next write — the same
  // data-losing overwrite the two refusals above exist to prevent, just at
  // entry granularity instead of file granularity.
  const invalid = parsed.filter((entry) => !isValidLockfileEntry(entry));
  if (invalid.length > 0) {
    throw new ConfigError(
      `Refusing to modify lockfile ${lockfilePath}: ${invalid.length} existing entr${invalid.length === 1 ? "y is" : "ies are"} malformed. ` +
        "Fix or remove the file by hand before retrying — those entries would otherwise be lost.",
      "INVALID_CONFIG_FILE",
    );
  }
  return parsed as LockfileEntry[];
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
 * bundle with no lock `localRoot` or a non-managed type, so both callers fall
 * back to the identical provider-path derivation.
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
    // R-012: readLockfileOrThrow (not readLockfile) — a corrupt/malformed
    // lockfile must abort the upsert loudly rather than read as `[]` and get
    // silently overwritten with just this one entry.
    const entries = readLockfileOrThrow();
    const withoutExisting = entries.filter((e) => e.id !== entry.id);
    writeLockfileUnlocked([...withoutExisting, entry]);
  } finally {
    release();
  }
}

/**
 * Rename a lock entry's id in place (D6 — `akm bundle rename`), keeping every
 * other resolved field (`localRoot`, `resolvedVersion`, …) unchanged. Returns
 * `true` when an entry for `oldId` existed and was renamed, `false` when
 * there was nothing to rename (e.g. a filesystem bundle, which has no lock
 * entry).
 */
export async function renameLockEntry(oldId: string, newId: string): Promise<boolean> {
  const release = await acquireLockSentinel();
  try {
    // R-012: see upsertLockEntry — a corrupt lockfile must abort loudly
    // rather than read as `[]` and get silently overwritten.
    const entries = readLockfileOrThrow();
    const existing = entries.find((e) => e.id === oldId);
    if (!existing) return false;
    const renamed = entries.map((e) => (e.id === oldId ? { ...e, id: newId } : e));
    writeLockfileUnlocked(renamed);
    return true;
  } finally {
    release();
  }
}

export async function removeLockEntry(id: string): Promise<void> {
  // Returning early says "there is no lock record to remove", and the uninstall
  // that called us reports success on that basis. Only an absent data dir earns
  // it — one we cannot read may hold the very entry we were asked to drop, and
  // silently leaving it behind is how a bundle stays "installed" forever (#791).
  const dataDir = getDataDir();
  assertLockfilePathReadable(dataDir);
  if (!fs.existsSync(dataDir)) return;
  const release = await acquireLockSentinel();
  try {
    // R-012: see upsertLockEntry — same destructive-overwrite risk on a
    // corrupt lockfile, so the same strict reader is used here.
    const entries = readLockfileOrThrow();
    writeLockfileUnlocked(entries.filter((e) => e.id !== id));
  } finally {
    release();
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export function isValidLockfileEntry(value: unknown): value is LockfileEntry {
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
