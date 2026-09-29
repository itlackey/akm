// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `data-dir-usage` advisory for `akm health` (#896).
 *
 * A real environment's `$XDG_DATA_HOME/akm` grew to 74 GB with none of the
 * ~20 health checks saying a word about disk. 70 of the 74 GB turned out to
 * be `backups/` (unpruned migration snapshots, see #897); the live working
 * set (state.db + index.db + logs.db) was ~4.2 GB. Naming the largest
 * top-level contributor and its share of the total is most of the value —
 * `backups/ is 70G (94% of data dir)` is self-diagnosing where "akm health
 * says nothing" is not.
 *
 * Best-effort and read-only: a plain recursive `fs` stat walk over the data
 * dir, no `du` shell-out. Silent (returns `undefined`) whenever nothing
 * looks wrong, matching the stash-exposure/type-directory-check house
 * pattern — this is not a "always show a pass line" check.
 */

import fs from "node:fs";
import path from "node:path";
import type { HealthCheckResult } from "./types";

/**
 * Warn when the data dir's total size is more than this many times the
 * combined size of the three live databases (state.db + index.db +
 * logs.db). Chosen so a healthy install (backups roughly comparable to the
 * live working set) stays quiet, while an order-of-magnitude blowup like
 * the 74 GB/4.2 GB (~17x) incident trips it.
 */
const DATA_DIR_BLOAT_RATIO_THRESHOLD = 3;

/**
 * Warn when a single top-level subdirectory accounts for more than this
 * percentage of the data dir's total size — the "one thing ate the disk"
 * signal (94% for `backups/` in the incident).
 */
const DOMINANT_SUBDIR_PERCENT_THRESHOLD = 50;

/**
 * Cap on the number of filesystem entries the recursive size walk will
 * `stat`. A 70 GB tree of a few thousand backup copies is cheap to walk
 * (stat-only), but a data dir polluted with hundreds of thousands of small
 * files (task logs, npm logs) must not make `akm health` slow. Past this
 * cap the walk stops descending further and the advisory says its size
 * figures are a lower bound.
 */
export const MAX_WALK_ENTRIES = 100_000;

/**
 * Below this the data dir is not worth an opinion. The advisory exists for
 * disk blowups (74 GB in the incident); on a small directory a ratio is
 * arithmetic noise, and akm's own housekeeping can dominate it outright.
 */
const MIN_TOTAL_BYTES_TO_REPORT = 1_000_000_000;

const LIVE_DB_FILES = ["state.db", "index.db", "logs.db"] as const;

/**
 * SQLite writes `-wal` and `-shm` beside each database. They are part of the
 * live working set, not overhead sitting next to it, so they must count as
 * live: on a fresh install the WAL is most of the data dir, and leaving it
 * out of the denominator made an empty install report a ~126x ratio.
 */
function liveDbBytesFor(name: string, sizes: ReadonlyMap<string, { bytes: number }>): number {
  return (
    (sizes.get(name)?.bytes ?? 0) + (sizes.get(`${name}-wal`)?.bytes ?? 0) + (sizes.get(`${name}-shm`)?.bytes ?? 0)
  );
}

export interface WalkResult {
  bytes: number;
  /** Regular files counted (a directory itself is never counted, only its leaves). */
  files: number;
  truncated: boolean;
}

/**
 * Recursively sum file sizes (and count files) under `root` (stat-only,
 * symlinks not followed so a cyclic or huge-target symlink can't blow up the
 * walk). `budget` is a shared mutable counter across the whole tree so the
 * entry cap applies to the walk as a whole, not per-branch — callers
 * typically pass {@link MAX_WALK_ENTRIES}, sized for this module's own data
 * dir walk, but a smaller/larger budget is fine for a different tree.
 * Shared with the `archive-usage` advisory (N2) — the same "don't let a
 * pathological tree hang a health check" concern applies to both.
 */
export function sizeOfPath(root: string, budget: { remaining: number }): WalkResult {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(root);
  } catch {
    return { bytes: 0, files: 0, truncated: false };
  }
  if (stat.isSymbolicLink()) return { bytes: 0, files: 0, truncated: false };
  if (!stat.isDirectory()) return { bytes: stat.size, files: 1, truncated: false };

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { bytes: 0, files: 0, truncated: false };
  }

  let bytes = 0;
  let files = 0;
  let truncated = false;
  for (const entry of entries) {
    if (budget.remaining <= 0) {
      truncated = true;
      break;
    }
    budget.remaining--;
    const sub = sizeOfPath(path.join(root, entry.name), budget);
    bytes += sub.bytes;
    files += sub.files;
    if (sub.truncated) truncated = true;
  }
  return { bytes, files, truncated };
}

/** `1610612736` -> `"1.5G"`. Values under 10 in a unit keep one decimal; 10+ round to an integer. */
function formatBytes(bytes: number): string {
  const units = ["B", "K", "M", "G", "T"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const rendered = unit === 0 ? String(Math.round(value)) : value < 10 ? value.toFixed(1) : String(Math.round(value));
  return `${rendered}${units[unit]}`;
}

interface DataDirSubdirUsage {
  name: string;
  bytes: number;
  percent: number;
}

/**
 * Build the `data-dir-usage` advisory, or `undefined` when the data dir is
 * missing/empty/unreadable or its size looks unremarkable (neither
 * threshold trips). `dataDir` is the caller-resolved `getDataDir()` path —
 * this module never resolves paths or reads env itself.
 */
export function collectDataDirUsageAdvisory(dataDir: string): HealthCheckResult | undefined {
  let topEntries: fs.Dirent[];
  try {
    topEntries = fs.readdirSync(dataDir, { withFileTypes: true });
  } catch {
    return undefined; // no data dir yet — nothing to report.
  }

  const budget = { remaining: MAX_WALK_ENTRIES };
  let totalBytes = 0;
  let truncated = false;
  const sizes = new Map<string, { bytes: number; isDirectory: boolean }>();

  for (const entry of topEntries) {
    const size = sizeOfPath(path.join(dataDir, entry.name), budget);
    totalBytes += size.bytes;
    if (size.truncated) truncated = true;
    sizes.set(entry.name, { bytes: size.bytes, isDirectory: entry.isDirectory() });
  }
  if (totalBytes === 0) return undefined;

  const subdirs: DataDirSubdirUsage[] = [...sizes]
    .filter(([, size]) => size.isDirectory)
    .map(([name, size]) => ({ name, bytes: size.bytes, percent: (size.bytes / totalBytes) * 100 }))
    .sort((a, b) => b.bytes - a.bytes);
  const largest = subdirs[0];

  const liveDbBreakdown = Object.fromEntries(LIVE_DB_FILES.map((f) => [f, liveDbBytesFor(f, sizes)]));
  const liveDbBytes = Object.values(liveDbBreakdown).reduce((a, b) => a + b, 0);
  const ratio = liveDbBytes > 0 ? totalBytes / liveDbBytes : undefined;

  if (totalBytes < MIN_TOTAL_BYTES_TO_REPORT) return undefined;

  const bloatWarn = ratio !== undefined && ratio > DATA_DIR_BLOAT_RATIO_THRESHOLD;
  const dominantWarn = largest !== undefined && largest.percent > DOMINANT_SUBDIR_PERCENT_THRESHOLD;
  if (!bloatWarn && !dominantWarn) return undefined;

  const parts = [`data dir is ${formatBytes(totalBytes)} at ${dataDir}`];
  if (largest) {
    parts.push(`${largest.name}/ is ${formatBytes(largest.bytes)} (${Math.round(largest.percent)}% of data dir)`);
  }
  if (ratio !== undefined) {
    parts.push(
      `live databases (${LIVE_DB_FILES.join("+")}) total ${formatBytes(liveDbBytes)}, ~${ratio.toFixed(1)}x smaller`,
    );
  }
  if (truncated) {
    parts.push(`size figures are a lower bound — the walk stopped after ${MAX_WALK_ENTRIES} entries`);
  }
  const message = `${parts.join("; ")}.`;

  return {
    name: "data-dir-usage",
    kind: "deterministic",
    status: "warn",
    confidence: "medium",
    message,
    evidence: {
      dataDir,
      totalBytes,
      liveDbBytes,
      liveDbBreakdown,
      largestSubdir: largest,
      ratio,
      walkBounded: truncated,
      maxWalkEntries: MAX_WALK_ENTRIES,
    },
  };
}
