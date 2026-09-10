// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm index status` — a cheap, read-only snapshot of `index.db`'s current
 * state: files tracked, entries, unit coverage for the active embedding
 * identity, and the last reconcile time. Mirrors `assembleInfo`'s
 * absent/inaccessible handling (`src/commands/sources/info.ts`) so a missing
 * index reads as the ordinary first-run state and an unreadable one is
 * reported, never silently presented as empty (#791).
 */

import { classifyPathAccess, describeInaccessiblePath } from "../../core/path-access";
import { getDbPath } from "../../core/paths";
import { error } from "../../core/warn";
import type { Database } from "../../storage/database";
import { closeDatabase, openExistingDatabase } from "../../storage/repositories/index-connection";
import { getEntryCount } from "../../storage/repositories/index-entries-repository";
import { getMeta } from "../../storage/repositories/index-meta-repository";

export interface IndexStatusUnits {
  /** Distinct unit hashes the current `entry_units` mapping references. */
  total: number;
  /** Of those, hashes with a vector for the active embedding identity. */
  withVector: number;
  /** `total - withVector` — what the embedding queue still has to do. */
  pending: number;
}

export interface IndexStatusResponse {
  indexPath: string;
  /** Files tracked by reconcile's stat cache. */
  files: number;
  entries: number;
  units: IndexStatusUnits;
  /** `index_meta.embeddingIdentity` — the one identity `units`/`units_vec` currently carry, or `null` if none has been learned yet. */
  activeIdentity: string | null;
  /** `index_meta.lastReconcileAt` — when `reconcileRoots` last finished, or `null` before the first run. */
  lastReconcileAt: string | null;
  /** `index_meta.builtAt` — when `akmIndex()` last finished, or `null` before the first run. */
  builtAt: string | null;
  /** Set only when the index database exists but could not be read. */
  unreadable?: string;
}

function emptyStatus(indexPath: string): IndexStatusResponse {
  return {
    indexPath,
    files: 0,
    entries: 0,
    units: { total: 0, withVector: 0, pending: 0 },
    activeIdentity: null,
    lastReconcileAt: null,
    builtAt: null,
  };
}

function readUnitsStatus(db: Database, identity: string | null): IndexStatusUnits {
  const total = (db.prepare("SELECT COUNT(DISTINCT unit_hash) AS n FROM entry_units").get() as { n: number }).n;
  const withVector = identity
    ? (
        db
          .prepare(
            "SELECT COUNT(DISTINCT eu.unit_hash) AS n FROM entry_units eu " +
              "JOIN units u ON u.unit_hash = eu.unit_hash AND u.identity = ?",
          )
          .get(identity) as { n: number }
      ).n
    : 0;
  return { total, withVector, pending: Math.max(0, total - withVector) };
}

/**
 * Assemble `akm index status`'s envelope.
 *
 * @param options.dbPath - Override the database path (useful for testing)
 */
export function assembleIndexStatus(options?: { dbPath?: string }): IndexStatusResponse {
  const resolvedDbPath = options?.dbPath ?? getDbPath();
  const empty = emptyStatus(resolvedDbPath);

  // "Absent" is the ordinary first-run state; "inaccessible" is a fault that
  // must not present as an empty index (#791).
  const { access, code } = classifyPathAccess(resolvedDbPath);
  if (access === "absent") return empty;
  if (access === "inaccessible") {
    const detail = describeInaccessiblePath(resolvedDbPath, code);
    error(`[akm index status] index database is not readable: ${detail}`);
    return { ...empty, unreadable: detail };
  }

  let db: Database | undefined;
  try {
    db = openExistingDatabase(resolvedDbPath);
    const files = (db.prepare("SELECT COUNT(*) AS n FROM files").get() as { n: number }).n;
    const identity = getMeta(db, "embeddingIdentity") ?? null;
    return {
      indexPath: resolvedDbPath,
      files,
      entries: getEntryCount(db),
      units: readUnitsStatus(db, identity),
      activeIdentity: identity,
      lastReconcileAt: getMeta(db, "lastReconcileAt") ?? null,
      builtAt: getMeta(db, "builtAt") ?? null,
    };
  } catch (err) {
    const detail = String(err instanceof Error ? err.message : err);
    error(`[akm index status] failed to read index status from ${resolvedDbPath}: ${detail}`);
    // A path that classified as accessible can still fail to open as a
    // database (corrupt content, a truncated file, an ABI mismatch) — that
    // is exactly the "unreadable, not silently empty" case #791 exists for,
    // just discovered a step later than the access-classification check
    // above rather than by it.
    return { ...empty, unreadable: detail };
  } finally {
    if (db) {
      try {
        closeDatabase(db);
      } catch {
        // Best-effort close; the read already happened.
      }
    }
  }
}
