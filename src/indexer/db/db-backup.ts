// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * MVP data-directory backup for AKM.
 *
 * The DB upgrade path in `src/indexer/db/db.ts` `handleVersionUpgrade()` is
 * intentionally destructive: when `DB_VERSION` bumps and a stored DB is at an
 * older version, ~17 tables are dropped and recreated. Until 0.9.0 ships a
 * full migration framework, this MVP captures a recursive copy of the entire
 * data directory just before that drop happens so an operator can manually
 * recover lost rows by stopping akm and moving the backup contents back over
 * the live data dir (see `scripts/migrations/restore-data-dir.sh`).
 *
 * The helper is intentionally narrow:
 *   - No `VACUUM INTO`, no selective table backup — just `fs.cpSync` of the
 *     data directory into `<dataDir>/backups/<timestamp>-pre-v<targetVersion>/`.
 *   - Skips the `backups/` subdirectory inside the data dir so we never
 *     recurse into our own backup history.
 *   - Opt-out via `AKM_DB_BACKUP=0`. Backup failures NEVER abort the upgrade —
 *     they warn and proceed (the alternative would brick a user trying to
 *     start a binary that bumped DB_VERSION on a full disk).
 *   - Retention is FIFO with default of 5, configurable via
 *     `AKM_DB_BACKUP_RETAIN`.
 *   - Disk-space guard: refuses to write when free space on the destination
 *     filesystem is less than 1.1× the source size.
 */

import fs from "node:fs";
import path from "node:path";
import { bestEffort } from "../../core/best-effort";
import { warn } from "../../core/warn";

export interface BackupOptions {
  /** Absolute path to the live data directory to back up. */
  dataDir: string;
  /** Currently-stored DB version on disk (the version we're upgrading FROM). */
  sourceVersion: number | null;
  /** Target DB version (the version the running binary expects). */
  targetVersion: number;
  /** Override env for testing. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Override `Date.now()` for deterministic timestamps in tests. */
  now?: () => Date;
  /**
   * Tag distinguishing the cause of this backup. When provided, the backup
   * directory is named `<timestamp>-<reason>` instead of `<timestamp>-pre-v<N>`,
   * and the metadata sidecar records the reason verbatim.
   *
   * Defaults to `"version-upgrade"` (which preserves the historical
   * `pre-v<N>` directory naming for the DB version-upgrade hook). Pass
   * `"embedding-dim-change"` for the embedding-dimension-change path.
   */
  reason?: string;
}

export interface BackupResult {
  /** Absolute path to the newly-created backup directory. */
  path: string;
  /** Bare directory name, e.g. `2026-05-19T04-59-36-pre-v17`. */
  name: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** Total bytes copied. */
  sizeBytes: number;
  /** The version we were upgrading FROM (null if data dir was empty/unknown). */
  sourceVersion: number | null;
  /** The version we were upgrading TO. */
  targetVersion: number;
  /** The reason tag recorded for this backup. */
  reason: string;
}

/** Default reason recorded for backups that don't override it. */
export const DEFAULT_BACKUP_REASON = "version-upgrade";
/** Reason recorded for backups taken before the embedding-dim drop path. */
export const EMBEDDING_DIM_CHANGE_REASON = "embedding-dim-change";

interface BackupMetadata {
  schemaVersion: 1;
  createdAt: string;
  sourceVersion: number | null;
  targetVersion: number;
  sizeBytes: number;
  /**
   * Tag describing why the backup was taken. Existing pre-0.8.x backups
   * predate this field and are backfilled as `"version-upgrade"` on read.
   */
  reason: string;
  hostname?: string;
  // Free-form notes that future restore scripts may key off of.
  notes?: string;
}

const BACKUPS_DIR_NAME = "backups";
const BACKUP_METADATA_FILE = "backup.meta.json";
const DEFAULT_RETAIN = 5;
const FREE_SPACE_MULTIPLIER = 1.1;

/**
 * Resolve the configured retention count from the env, with a hard floor of 1.
 *
 * Invalid values (non-integer, negative) fall back to the default and emit a
 * one-line warning so operators notice their env var is wrong.
 */
export function resolveRetention(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AKM_DB_BACKUP_RETAIN?.trim();
  if (!raw) return DEFAULT_RETAIN;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    warn("[akm] AKM_DB_BACKUP_RETAIN=%s is not a positive integer; falling back to %d", raw, DEFAULT_RETAIN);
    return DEFAULT_RETAIN;
  }
  return parsed;
}

/**
 * Returns true when the user has explicitly opted out via `AKM_DB_BACKUP=0`
 * (or `false`/`no`/`off`). Any other value — including unset — opts in.
 */
export function isBackupDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.AKM_DB_BACKUP?.trim().toLowerCase();
  if (!raw) return false;
  return raw === "0" || raw === "false" || raw === "no" || raw === "off";
}

/**
 * Recursively sum the byte size of `dirPath`, skipping the embedded backups
 * directory so the size we report (and check against free space) reflects
 * what we'd actually copy.
 */
export function measureDataDirSize(dirPath: string): number {
  if (!fs.existsSync(dirPath)) return 0;
  let total = 0;
  const stack: string[] = [dirPath];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      // Unreadable directory — skip; we don't want measurement to throw.
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      // Skip the embedded backups directory at the root so we don't
      // double-count prior backups in size calculations.
      if (current === dirPath && entry.name === BACKUPS_DIR_NAME && entry.isDirectory()) continue;
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        bestEffort(() => {
          total += fs.statSync(full).size;
        }, "file vanished between readdir and stat");
      }
    }
  }
  return total;
}

/**
 * Best-effort free-space query for the filesystem hosting `dirPath`. Returns
 * `null` when the runtime cannot report statfs (older Node/Bun, exotic FS) —
 * the caller treats `null` as "skip the disk-space check" rather than
 * "abort the backup".
 */
function getFreeSpace(dirPath: string): number | null {
  try {
    // `fs.statfsSync` is available in Node 18.15+ and Bun 1.0+.
    const stats = (
      fs as unknown as {
        statfsSync?: (p: string) => { bavail: bigint; bsize: bigint };
      }
    ).statfsSync;
    if (!stats) return null;
    const res = stats(dirPath);
    return Number(res.bavail * res.bsize);
  } catch {
    return null;
  }
}

/**
 * Format the current time into a filename-safe timestamp.
 *
 * Example: `2026-05-19T04-59-36`.
 */
function formatTimestamp(d: Date): string {
  // ISO 8601 without colons/dots so the path is portable to Windows + tarballs.
  return d
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace(/Z$/, "")
    .replace(/-\d{3}$/, "");
}

/**
 * List existing backup directories (newest first by mtime), reading metadata
 * sidecars where present.
 */
export interface ListedBackup {
  path: string;
  name: string;
  createdAt: string;
  sizeBytes: number;
  sourceVersion: number | null;
  /**
   * Reason tag for the backup. Reads the `reason` field from `backup.meta.json`
   * when present; pre-0.8.x backups without the field are reported as
   * `"version-upgrade"` so downstream consumers can treat the field as
   * always-present.
   */
  reason: string;
}

export function listBackups(dataDir: string): ListedBackup[] {
  const backupsRoot = path.join(dataDir, BACKUPS_DIR_NAME);
  if (!fs.existsSync(backupsRoot)) return [];

  const entries = fs.readdirSync(backupsRoot, { withFileTypes: true });
  const results: ListedBackup[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(backupsRoot, entry.name);
    const metaPath = path.join(full, BACKUP_METADATA_FILE);

    let createdAt: string | undefined;
    let sourceVersion: number | null = null;
    let sizeBytes: number | undefined;
    let reason: string = DEFAULT_BACKUP_REASON;

    if (fs.existsSync(metaPath)) {
      bestEffort(() => {
        const raw = fs.readFileSync(metaPath, "utf8");
        const parsed = JSON.parse(raw) as Partial<BackupMetadata>;
        if (typeof parsed.createdAt === "string") createdAt = parsed.createdAt;
        if (typeof parsed.sourceVersion === "number") sourceVersion = parsed.sourceVersion;
        else if (parsed.sourceVersion === null) sourceVersion = null;
        if (typeof parsed.sizeBytes === "number") sizeBytes = parsed.sizeBytes;
        if (typeof parsed.reason === "string" && parsed.reason.length > 0) reason = parsed.reason;
      }, "malformed backup metadata — fall back to filesystem-derived values");
    }

    if (!createdAt) {
      try {
        createdAt = fs.statSync(full).mtime.toISOString();
      } catch {
        createdAt = new Date(0).toISOString();
      }
    }
    if (sizeBytes === undefined) {
      sizeBytes = measureDataDirSize(full);
    }

    results.push({
      path: full,
      name: entry.name,
      createdAt,
      sizeBytes,
      sourceVersion,
      reason,
    });
  }

  // Sort newest first.
  results.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return results;
}

/**
 * Drop oldest backups until at most `retain` remain. The newest backup (the
 * one we just created) is always preserved — pruning happens AFTER the new
 * backup is written, so `retain=5` plus a fresh write means we keep the new
 * write and prune down to 5 total entries.
 */
function pruneOldBackups(dataDir: string, retain: number): void {
  const existing = listBackups(dataDir);
  if (existing.length <= retain) return;
  const toRemove = existing.slice(retain);
  for (const entry of toRemove) {
    try {
      fs.rmSync(entry.path, { recursive: true, force: true });
    } catch (err) {
      warn("[akm] failed to prune old backup %s — %s", entry.path, err instanceof Error ? err.message : String(err));
    }
  }
}

/**
 * Capture a recursive copy of `dataDir` under `<dataDir>/backups/`, skipping
 * the backups subdirectory itself. Returns the BackupResult on success or
 * `null` when the backup was skipped (opt-out, missing data dir, insufficient
 * disk space, or a copy error — all of which should be non-fatal so the
 * upgrade path can still proceed).
 */
export function backupDataDir(opts: BackupOptions): BackupResult | null {
  const env = opts.env ?? process.env;
  if (isBackupDisabled(env)) return null;

  const { dataDir, sourceVersion, targetVersion } = opts;
  const reason = opts.reason && opts.reason.length > 0 ? opts.reason : DEFAULT_BACKUP_REASON;

  if (!fs.existsSync(dataDir)) {
    // Fresh install — nothing to back up.
    return null;
  }

  const dataDirStat = fs.statSync(dataDir);
  if (!dataDirStat.isDirectory()) {
    warn("[akm] data dir backup skipped — %s is not a directory", dataDir);
    return null;
  }

  // Empty data dir (or only a `backups/` subdir) → nothing meaningful to back up.
  const sourceSize = measureDataDirSize(dataDir);
  if (sourceSize === 0) return null;

  const backupsRoot = path.join(dataDir, BACKUPS_DIR_NAME);
  try {
    fs.mkdirSync(backupsRoot, { recursive: true });
  } catch (err) {
    warn(
      "[akm] data dir backup skipped — could not create %s: %s",
      backupsRoot,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }

  // Disk-space guard. Skip the check when statfs is unavailable.
  const free = getFreeSpace(backupsRoot);
  if (free !== null && free < sourceSize * FREE_SPACE_MULTIPLIER) {
    warn(
      "[akm] data dir backup skipped — free space %d bytes is less than 1.1× source size %d bytes (need %d)",
      free,
      sourceSize,
      Math.ceil(sourceSize * FREE_SPACE_MULTIPLIER),
    );
    return null;
  }

  const now = (opts.now ?? (() => new Date()))();
  const stamp = formatTimestamp(now);
  // Reason tags drive the directory suffix so operators can tell a
  // version-upgrade snapshot apart from an embedding-dim-change snapshot.
  // `version-upgrade` keeps the historical `pre-v<N>` suffix for backward
  // compatibility with `scripts/migrations/restore-data-dir.sh` and existing
  // tests; any other reason is appended verbatim.
  const dirSuffix = reason === DEFAULT_BACKUP_REASON ? `pre-v${targetVersion}` : reason;
  const dirName = `${stamp}-${dirSuffix}`;
  const destPath = path.join(backupsRoot, dirName);

  // If a previous run on the same second tried to write this name, append a
  // short disambiguator. We don't want to overwrite or merge into an existing
  // backup directory.
  let finalDest = destPath;
  let suffix = 1;
  while (fs.existsSync(finalDest)) {
    finalDest = `${destPath}-${suffix}`;
    suffix += 1;
  }

  try {
    // We can't use fs.cpSync directly because the destination
    // (<dataDir>/backups/<stamp>-pre-v<N>/) is inside the source dataDir, and
    // cpSync refuses to copy into a subdirectory of the source. So we do a
    // manual recursive walk that explicitly skips the backups subtree, plus
    // the lockfile/sentinel that would race with any live process.
    copyDataDirExcludingBackups(dataDir, finalDest);
  } catch (err) {
    warn(
      "[akm] data dir backup failed — %s; upgrade will proceed without a snapshot",
      err instanceof Error ? err.message : String(err),
    );
    // Best-effort cleanup of the partial copy so we don't litter the data dir.
    bestEffort(() => fs.rmSync(finalDest, { recursive: true, force: true }), "cleanup partial backup copy");
    return null;
  }

  const createdAt = now.toISOString();
  const metadata: BackupMetadata = {
    schemaVersion: 1,
    createdAt,
    sourceVersion,
    targetVersion,
    sizeBytes: sourceSize,
    reason,
    hostname: tryHostname(),
    notes:
      reason === DEFAULT_BACKUP_REASON
        ? "Created by AKM before a destructive DB version upgrade. Restore manually by stopping akm and copying the contents back over the live data dir."
        : `Created by AKM before a destructive ${reason} operation. Restore manually by stopping akm and copying the contents back over the live data dir.`,
  };
  try {
    fs.writeFileSync(path.join(finalDest, BACKUP_METADATA_FILE), JSON.stringify(metadata, null, 2));
  } catch (err) {
    // Metadata is non-essential — warn but keep the copy.
    warn(
      "[akm] data dir backup created at %s but metadata write failed — %s",
      finalDest,
      err instanceof Error ? err.message : String(err),
    );
  }

  const retain = resolveRetention(env);
  pruneOldBackups(dataDir, retain);

  return {
    path: finalDest,
    name: path.basename(finalDest),
    createdAt,
    sizeBytes: sourceSize,
    sourceVersion,
    targetVersion,
    reason,
  };
}

/**
 * Recursively copy `srcRoot` to `destRoot`, skipping:
 *   - `<srcRoot>/backups` (so we don't recurse into our own backup history)
 *   - `<srcRoot>/akm.lock` and `<srcRoot>/akm.lock.lck` (per-process state
 *     that would race with a live process holding the lock)
 *
 * Implemented manually because `fs.cpSync` refuses to copy a directory into a
 * subdirectory of itself, and our destination (`<dataDir>/backups/<stamp>`)
 * is by design inside the source `<dataDir>`.
 */
function copyDataDirExcludingBackups(srcRoot: string, destRoot: string): void {
  fs.mkdirSync(destRoot, { recursive: true });
  const stack: Array<{ src: string; dest: string }> = [{ src: srcRoot, dest: destRoot }];

  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    const { src, dest } = frame;
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      // Skip the embedded backups directory and the lockfile/sentinel — only
      // at the root level. (A `backups` directory deep in a wiki source tree,
      // for instance, must still be copied.)
      if (src === srcRoot) {
        if (entry.name === BACKUPS_DIR_NAME && entry.isDirectory()) continue;
        if (entry.name === "akm.lock" || entry.name === "akm.lock.lck") continue;
      }
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(destPath, { recursive: true });
        stack.push({ src: srcPath, dest: destPath });
      } else if (entry.isFile()) {
        fs.copyFileSync(srcPath, destPath);
      } else if (entry.isSymbolicLink()) {
        // Preserve symlinks as-is rather than dereferencing them. A stash
        // dir occasionally carries symlinked source roots; following them
        // could explode the backup size unexpectedly.
        const target = fs.readlinkSync(srcPath);
        bestEffort(() => fs.symlinkSync(target, destPath), "symlink creation can fail on Windows without admin");
      }
      // Other entry types (block/character/fifo/socket) are silently skipped.
    }
  }
}

function tryHostname(): string | undefined {
  try {
    const os = require("node:os") as typeof import("node:os");
    return os.hostname();
  } catch {
    return undefined;
  }
}
