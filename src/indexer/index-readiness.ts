// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * "Is there a usable index for this library?" — the one answer every reader
 * of `index.db` uses (`search`, `curate`, `feedback`, write-through).
 *
 * Usable means the keyword data for the library is persisted: the `entries`
 * table exists and `stashDir` / `stashDirs` names this library. The persist
 * transaction records both with the entries and their FTS rows
 * (`persistDirRecords`), so a build that is still embedding, was interrupted
 * after the scan, or had one source fail is usable, and so is an empty library
 * that was indexed. An index an older akm finished carries the same two keys.
 * `builtAt` is not part of the answer: it is the incremental watermark, written
 * when a build completes.
 *
 * Reads never build and never wait. A library with no usable index gets an
 * empty result and {@link noIndexWarning}; one whose build has not completed
 * gets {@link incompleteIndexWarning} alongside its results.
 */

import { ConfigError } from "../core/errors";
import { classifyPathAccess } from "../core/path-access";
import { getDbPath } from "../core/paths";
import type { Database } from "../storage/database";
import {
  assertIndexPathReadable,
  closeDatabase,
  openExistingDatabase,
  openReadonlyExistingDatabase,
} from "../storage/repositories/index-connection";
import { hasCurrentEntriesTable } from "../storage/repositories/index-entry-schema";
import { getMeta } from "../storage/repositories/index-meta-repository";
import { heldRebuildLock } from "./index-rebuild-lock";

/** Said when the library has no usable index and no build is running. */
export const NO_INDEX_MESSAGE = "There is no search index for this library yet; run `akm index` to build one.";

/** The single "no usable index" warning; it names the build when a live process holds the rebuild lock. */
export function noIndexWarning(): string {
  return heldRebuildLock()
    ? "The search index for this library is being built; results will appear when the build has persisted them."
    : NO_INDEX_MESSAGE;
}

/** The warning served beside results from an index whose build has not completed; it says whether a build is running. */
export function incompleteIndexWarning(): string {
  return heldRebuildLock()
    ? "The search index for this library is still being built; results may be incomplete."
    : "The last index build for this library did not complete (it was interrupted or a source could not be scanned); " +
        "results may be incomplete. Run `akm index`.";
}

export interface UsableIndex {
  db: Database;
  /** A build has completed (`builtAt` is set); false while the first build is still running, or after one was interrupted. */
  complete: boolean;
}

/**
 * Open the index when it can serve `stashDir` (any library when omitted: the
 * workspace reads every bundle's entries), or return `undefined`: no file,
 * no schema, nothing persisted for this library, built for another library, or
 * a file that cannot be read as an index (corrupt, mid-write). Never creates,
 * migrates, deletes or waits. The caller closes `db`.
 *
 * Two failures are not "no index" and still raise: a file akm lacks permission
 * to read (#791, `DATA_DIR_UNREADABLE`), and an index laid out by a newer akm.
 */
export function openUsableIndex(
  stashDir: string | undefined,
  options: { readOnly?: boolean; busyTimeoutMs?: number } = {},
): UsableIndex | undefined {
  const dbPath = getDbPath();
  assertIndexPathReadable(dbPath);
  if (classifyPathAccess(dbPath).access === "absent") return undefined;
  let db: Database | undefined;
  try {
    // Read-only for the workspace: a read-write handle can checkpoint the WAL into the main file on close.
    db = options.readOnly ? openReadonlyExistingDatabase(dbPath) : openExistingDatabase(dbPath);
    if (!db) return undefined;
    if (options.busyTimeoutMs !== undefined)
      db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs))}`);
    const servesLibrary =
      hasCurrentEntriesTable(db) &&
      (stashDir === undefined ||
        getMeta(db, "stashDir") === stashDir ||
        (JSON.parse(getMeta(db, "stashDirs") ?? "[]") as string[]).includes(stashDir));
    if (servesLibrary) return { db, complete: Boolean(getMeta(db, "builtAt")) };
  } catch (error) {
    // Anything else (corrupt, unreadable meta, mid-write) is an index that cannot serve.
    if (error instanceof ConfigError) {
      if (db) closeDatabase(db);
      throw error;
    }
  }
  if (db) closeDatabase(db);
  return undefined;
}

/**
 * Run `read` against the usable index, or return `fallback` when there is none
 * or a query fails on a damaged one: an index that cannot answer is no index.
 * Permission and newer-layout errors (`ConfigError`) still raise.
 */
export function readUsableIndex<T>(read: (db: Database) => T, fallback: T): T {
  const usable = openUsableIndex(undefined, { readOnly: true });
  if (!usable) return fallback;
  try {
    return read(usable.db);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    return fallback;
  } finally {
    closeDatabase(usable.db);
  }
}
