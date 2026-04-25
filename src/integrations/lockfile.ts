import fs from "node:fs";
import path from "node:path";
import { getConfigDir } from "../core/config";
import type { KitSource } from "../registry/types";
// `KitSource` is the typed alias for the legacy install-source strings
// ("npm" | "github" | "git" | "local"). It is now derived from
// `SourceSpec["type"]` via `src/config.ts`.

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * StashLockEntry — install-time provenance for a stash.
 *
 * Companion to `StashEntry`: the StashEntry describes *where* a stash is
 * configured to come from (declared in config); the StashLockEntry records
 * *what was actually installed* (resolved version, integrity hash, etc.).
 *
 * Lock entries are keyed by `name` (the stable identifier shared with the
 * matching StashEntry). The lockfile lives at `<configDir>/akm.lock` and is
 * managed independently from `config.json`.
 */
export interface StashLockEntry {
  /** Stable identifier; matches the name on the corresponding StashEntry. */
  name: string;
  /** Resolved package version (npm registry). */
  resolvedVersion?: string;
  /** Resolved git commit SHA / revision. */
  resolvedRevision?: string;
  /** Final URL the artifact was downloaded from (post-resolution). */
  artifactUrl?: string;
  /** Filesystem directory containing the indexable content (the "stashRoot"). */
  contentDir?: string;
  /** ISO-8601 timestamp when the install completed. */
  installedAt?: string;
  /** Integrity hash (SRI / sha1 hex / sha256:hex). */
  integrity?: string;
}

/**
 * @deprecated Use {@link StashLockEntry}. Maintained for backwards
 * compatibility with code that still consumes the old shape.
 */
export interface LockfileEntry {
  /**
   * Stable identifier. Older callers used `id`; aligned with
   * {@link StashLockEntry.name} so both shapes can coexist during migration.
   */
  id: string;
  source: KitSource;
  ref: string;
  resolvedVersion?: string;
  resolvedRevision?: string;
  integrity?: string;
}

// ── Paths ───────────────────────────────────────────────────────────────────

const LOCKFILE_NAME = "akm.lock";
const LEGACY_LOCKFILE_NAME = "stash.lock";

function getLockfilePath(): string {
  return path.join(getConfigDir(), LOCKFILE_NAME);
}

function getLegacyLockfilePath(): string {
  return path.join(getConfigDir(), LEGACY_LOCKFILE_NAME);
}

/**
 * One-time migration: if the new `akm.lock` does not exist but the legacy
 * `stash.lock` does, copy it across so installed-stash tracking survives the
 * rename. Best-effort; failures are silent because the lockfile loader treats
 * a missing file as an empty lockfile.
 */
function migrateLegacyLockfileIfNeeded(): void {
  const newPath = getLockfilePath();
  const legacyPath = getLegacyLockfilePath();
  try {
    if (fs.existsSync(newPath)) return;
    if (!fs.existsSync(legacyPath)) return;
    fs.mkdirSync(path.dirname(newPath), { recursive: true });
    fs.copyFileSync(legacyPath, newPath);
  } catch {
    /* best-effort — fall through to empty lockfile */
  }
}

// ── Lock sentinel ────────────────────────────────────────────────────────────

const LOCK_MAX_RETRIES = 3;
const LOCK_RETRY_DELAY_MS = 100;

function getLockSentinelPath(): string {
  return `${getLockfilePath()}.lck`;
}

async function acquireLockSentinel(): Promise<boolean> {
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
    try {
      process.kill(pid, 0);
      return false; // Process is alive — lock is valid
    } catch {
      // Process is dead — reclaim the stale lock
      fs.unlinkSync(sentinelPath);
      return true;
    }
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
  migrateLegacyLockfileIfNeeded();
  const lockfilePath = getLockfilePath();
  try {
    const raw = JSON.parse(fs.readFileSync(lockfilePath, "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.filter(isValidLockfileEntry);
  } catch {
    return [];
  }
}

export function writeLockfile(entries: LockfileEntry[]): void {
  const lockfilePath = getLockfilePath();
  const dir = path.dirname(lockfilePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${lockfilePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
    fs.renameSync(tmpPath, lockfilePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
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
