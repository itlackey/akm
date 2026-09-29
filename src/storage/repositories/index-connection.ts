// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `index.db` connection lifecycle for the storage layer.
 *
 * Opens/closes the index database, running `ensureSchema` on the managed
 * (writable) open path. This module lives BELOW the
 * indexer, so the storage loan helpers (`index-db.ts`, `registry-index-cache-repository.ts`)
 * import their opener from a sibling here instead of reaching up into the
 * indexer — inverting the old storage→indexer arrow.
 */

import fs from "node:fs";
import { ConfigError } from "../../core/errors";
import { classifyPathAccess, describeInaccessiblePath } from "../../core/path-access";
import { getDbPath } from "../../core/paths";
import { warn, warnOnce } from "../../core/warn";
import type { Database } from "../database";
import { openDatabase } from "../database";
import { openManagedDatabase } from "../managed-db";
import { SQLITE_BUSY_TIMEOUT_MS } from "../sqlite-pragmas";
import { openSqliteReadSnapshot, SqliteReadSnapshotUnavailableError } from "../sqlite-read-snapshot";
import { CANONICAL_INDEX_DB_VERSION } from "./index-entry-schema";
import { ensureSchema, newerIndexLayoutError } from "./index-schema";

/**
 * Whether `error` is SQLite reporting on-disk corruption (`SQLITE_CORRUPT`,
 * "database disk image is malformed") rather than a permission, lock, or
 * schema problem. Matched on both `code` (bun:sqlite, better-sqlite3) and
 * message text, since driver error shapes are not perfectly uniform.
 */
export function isCorruptionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  if (code === "SQLITE_CORRUPT") return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("database disk image is malformed") || message.includes("SQLITE_CORRUPT");
}

export function openIndexDatabase(dbPath?: string, options?: { beforeSchema?: (db: Database) => void }): Database {
  const resolvedPath = dbPath ?? getDbPath();
  const spec = {
    path: resolvedPath,
    init: (db: Database) => {
      // Source update uses this narrow lifecycle seam to ATTACH state.db and
      // open its coordinator-owned outer transaction before ensureSchema or
      // any indexer write can mutate the live generation.
      options?.beforeSchema?.(db);
      ensureSchema(db);
    },
  };
  try {
    return openManagedDatabase(spec);
  } catch (error) {
    // index.db is a derived cache, fully regenerable from the stash on disk
    // (see src/core/state-db.ts's "Why a separate database from index.db"
    // note) — so real on-disk corruption is recovered by deleting the file
    // and rebuilding, not by surfacing a raw SQLITE_CORRUPT to the caller or
    // quietly falling through to an unreadable index (#865). This is the ONE
    // from-scratch rebuild: an older layout is migrated in place by
    // ensureSchema, never dropped.
    if (!isCorruptionError(error)) throw error;
    warn(`Index database is corrupt at ${resolvedPath} — rebuilding.`);
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.rmSync(`${resolvedPath}${suffix}`, { force: true });
      } catch {
        // Best-effort cleanup; the retried open below still fails loudly if
        // the file could not actually be removed.
      }
    }
    return openManagedDatabase(spec);
  }
}

export function openExistingDatabase(dbPath?: string): Database {
  // Existing-DB callers do not mutate schema or embedding metadata on open;
  // they serve an older layout as-is and refuse a newer one (see checkIndexLayout).
  //
  // "Existing" is load-bearing: a missing file throws instead of being
  // created. Create-on-open used to leave a schema-less index.db behind (a
  // fire-and-forget telemetry read was enough), which every later opener then
  // saw as an existing-but-broken index ("no such table: entries") — the
  // curate→proposal file-order failure pinned by
  // tests/storage/open-existing-database-no-create.test.ts. `create: false`
  // below is the race-free backstop for this pre-check.
  const resolvedPath = dbPath ?? getDbPath();
  assertIndexPathReadable(resolvedPath);
  if (classifyPathAccess(resolvedPath).access === "absent") {
    throw new Error(`Index database not found at ${resolvedPath}. Run 'akm index' to build it.`);
  }
  const db = openManagedDatabase({ path: resolvedPath, create: false });
  try {
    checkIndexLayout(db, resolvedPath);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * A reader serves an older layout as-is (the FTS readers understand both
 * layouts, and a missing table degrades at the caller — keyword-only search,
 * an inline rebuild, or a "run akm index" notice) and names it once per
 * process; the next writable open migrates it in place. A newer layout is
 * refused, naming the upgrade ({@link newerIndexLayoutError}).
 */
function checkIndexLayout(db: Database, resolvedPath: string): void {
  let stored: number;
  try {
    const row = db.prepare("SELECT value FROM index_meta WHERE key = 'version'").get() as { value: string } | undefined;
    if (!row) return;
    stored = Number(row.value);
  } catch {
    return;
  }
  if (!Number.isFinite(stored) || stored === CANONICAL_INDEX_DB_VERSION) return;
  if (stored > CANONICAL_INDEX_DB_VERSION) throw newerIndexLayoutError(stored, resolvedPath);
  warnOnce(
    `index-db-layout:${resolvedPath}`,
    `Index database at ${resolvedPath} uses an older layout (${stored}; this akm writes ${CANONICAL_INDEX_DB_VERSION}). ` +
      "Serving it as-is; the next 'akm index' migrates it in place.",
  );
}

/**
 * Refuse to treat an UNREADABLE index as a missing one (#791).
 *
 * `fs.existsSync()` — which every one of these gates used to call — returns
 * `false` for `EACCES` exactly as for `ENOENT`, so an index this process cannot
 * read looked identical to one that had never been built. Callers then took
 * their "no index yet" branch: `search`/`curate` returned no hits at exit 0 and
 * told the user to run `akm index`, which would not have helped and which they
 * may not have permission to do either.
 *
 * A `ConfigError` here exits 78 through the standard `{ok:false, error, code}`
 * envelope, so both a human and a machine caller can tell "nothing indexed"
 * from "I cannot see the index".
 */
export function assertIndexPathReadable(resolvedPath: string): void {
  const { access, code } = classifyPathAccess(resolvedPath);
  if (access !== "inaccessible") return;
  throw new ConfigError(
    `Index database exists but is not readable: ${describeInaccessiblePath(resolvedPath, code)}.`,
    "DATA_DIR_UNREADABLE",
  );
}

function openPlainReadonly(resolvedPath: string): Database | undefined {
  return openDatabase(resolvedPath, { readonly: true, create: false });
}

function openIsolatedSnapshotOrFallBack(resolvedPath: string): Database | undefined {
  try {
    return openSqliteReadSnapshot(resolvedPath);
  } catch (error) {
    if (!(error instanceof SqliteReadSnapshotUnavailableError)) throw error;
    warnOnce(
      `index-read-snapshot-unavailable:${resolvedPath}`,
      `Could not take a non-mutating snapshot of ${resolvedPath} (${error.message}) — falling back to a plain ` +
        "read-only open of the index database.",
    );
    return openPlainReadonly(resolvedPath);
  }
}

/**
 * Open an existing index for queries without changing the source database or
 * running schema initialization. The default path attaches read-only to the
 * source. `isolatedSnapshot` instead opens a disposable main/WAL copy so even
 * SQLite's read-lock bookkeeping cannot touch the source SHM file.
 */
export function openReadonlyExistingDatabase(
  dbPath?: string,
  options?: { isolatedSnapshot?: boolean; busyTimeoutMs?: number },
): Database | undefined {
  const resolvedPath = dbPath ?? getDbPath();
  // `undefined` means "no index" — reserve it for a genuinely absent one, and
  // let an unreadable index raise instead of masquerading as absent (#791).
  assertIndexPathReadable(resolvedPath);
  if (classifyPathAccess(resolvedPath).access === "absent") return undefined;
  const db = options?.isolatedSnapshot ? openIsolatedSnapshotOrFallBack(resolvedPath) : openPlainReadonly(resolvedPath);
  if (!db) return undefined;
  // This opener bypasses openManagedDatabase/applyStandardPragmas by design (no
  // journal or schema work on a read-only handle), but that also left
  // busy_timeout at SQLite's default of 0. In WAL that is harmless — readers
  // never block — but in the DELETE/TRUNCATE modes the network-FS fallback and
  // AKM_SQLITE_JOURNAL_MODE can select, a concurrent writer makes every read
  // fail instantly with SQLITE_BUSY. busy_timeout is legal on a read-only
  // connection, so apply just that one. `busyTimeoutMs` defaults to the
  // shared 30s constant; a caller that must never sit behind another akm
  // process's write lock for long (e.g. `akm info`, which has to behave like
  // a help command and always report within a couple of seconds) can pass a
  // much shorter bound instead.
  try {
    db.exec(`PRAGMA busy_timeout = ${options?.busyTimeoutMs ?? SQLITE_BUSY_TIMEOUT_MS}`);
    checkIndexLayout(db, resolvedPath);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function closeDatabase(db: Database): void {
  db.close();
}
