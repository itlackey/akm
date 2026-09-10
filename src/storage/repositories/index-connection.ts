// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `index.db` connection lifecycle for the storage layer.
 *
 * Opens/closes the index database, arming the sqlite-vec extension and (for the
 * managed open path) running `ensureSchema`. This module lives BELOW the
 * indexer, so the storage loan helpers (`index-db.ts`, `registry-cache.ts`)
 * import their opener from a sibling here instead of reaching up into the
 * indexer — inverting the old storage→indexer arrow.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import { ConfigError } from "../../core/errors";
import { classifyPathAccess, describeInaccessiblePath } from "../../core/path-access";
import { getDbPath } from "../../core/paths";
import { warn, warnOnce } from "../../core/warn";
import type { Database } from "../database";
import { openDatabase } from "../database";
import { openManagedDatabase } from "../managed-db";
import { SQLITE_BUSY_TIMEOUT_MS } from "../sqlite-pragmas";
import { openSqliteReadSnapshot, SqliteReadSnapshotUnavailableError } from "../sqlite-read-snapshot";
import { CANONICAL_INDEX_DB_VERSION, classifyIndexGeneration, isCanonicalIndexGeneration } from "./index-entry-schema";
import { ensureSchema } from "./index-schema";
import { loadVecExtension } from "./index-vec-repository";

/**
 * Whether `error` is SQLite reporting on-disk corruption (`SQLITE_CORRUPT`,
 * "database disk image is malformed") rather than a permission, lock, or
 * schema problem. Matched on both `code` (bun:sqlite, better-sqlite3) and
 * message text, since driver error shapes are not perfectly uniform.
 */
function isCorruptionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  if (code === "SQLITE_CORRUPT") return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("database disk image is malformed") || message.includes("SQLITE_CORRUPT");
}

export function openIndexDatabase(
  dbPath?: string,
  options?: { embeddingDim?: number; beforeSchema?: (db: Database) => void },
): Database {
  const resolvedPath = dbPath ?? getDbPath();
  const spec = {
    path: resolvedPath,
    init: (db: Database) => {
      // Try to load sqlite-vec extension
      loadVecExtension(db);

      // Source update uses this narrow lifecycle seam to ATTACH state.db and
      // open its coordinator-owned outer transaction before ensureSchema or
      // any indexer write can mutate the live generation.
      options?.beforeSchema?.(db);

      // Dim resolution: explicit option wins; otherwise consult the on-disk
      // config so unparameterised opens (registry providers, graph helpers,
      // ad-hoc CLI subcommands) honour the operator-declared dimension. Only if
      // both are absent do we fall through to the no-clobber path, which keeps
      // ensureSchema from touching `index_meta.embeddingDim` at all.
      const resolvedDim = options?.embeddingDim ?? resolveConfiguredEmbeddingDim();
      ensureSchema(db, resolvedDim);
    },
  };
  try {
    return openManagedDatabase(spec);
  } catch (error) {
    // index.db is a derived cache, fully regenerable from the stash on disk
    // (see src/core/state-db.ts's "Why a separate database from index.db"
    // note) — so real on-disk corruption is recovered by deleting the file
    // and rebuilding, not by surfacing a raw SQLITE_CORRUPT to the caller or
    // quietly falling through to an unreadable index. This mirrors the
    // existing stale-version-marker rebuild below, one layer further down
    // (that path opens fine and rewrites tables in place; corruption prevents
    // even opening, so the file itself has to go first).
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

/**
 * Read the operator-configured embedding dimension from the on-disk config.
 * Returns `undefined` when no config file is present, when the config has
 * no `embedding.dimension` set, or when reading the config throws (e.g.
 * inside isolated test fixtures with no XDG home). Failure is silent on
 * purpose — every openDatabase() call would otherwise have to handle a
 * config-not-found error path, and the fallback (no-clobber semantics) is
 * already correct.
 */
function resolveConfiguredEmbeddingDim(): number | undefined {
  try {
    const esmRequire = createRequire(import.meta.url);
    const { loadConfig } = esmRequire("../../core/config/config") as typeof import("../../core/config/config");
    const dim = loadConfig().embedding?.dimension;
    if (typeof dim === "number" && Number.isInteger(dim) && dim > 0 && dim <= 4096) {
      return dim;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function openExistingDatabase(dbPath?: string): Database {
  // Existing-DB callers do not mutate schema or embedding metadata on open.
  // They do validate the exact current derived generation before returning a
  // handle, so no current reader can accidentally serve a populated legacy
  // table and fail later on its first canonical-column query.
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
  const db = openManagedDatabase({
    path: resolvedPath,
    init: (db) => {
      loadVecExtension(db);
    },
    create: false,
  });
  try {
    assertCanonicalIndexGeneration(db, resolvedPath);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * Read callers must never receive a known-incompatible derived index.  The
 * writable opener owns rebuilding an older generation; a reader can only
 * report the one action that is safe for the direction of the mismatch.
 */
function assertCanonicalIndexGeneration(db: Database, resolvedPath: string): void {
  if (isCanonicalIndexGeneration(db)) return;
  const classification = classifyIndexGeneration(db);
  const stored = classification.storedVersion ?? "unknown";
  if (classification.status === "newer") {
    throw new ConfigError(
      `Index database at ${resolvedPath} was built by a newer akm (stored generation ${stored}; ` +
        `this binary understands ${CANONICAL_INDEX_DB_VERSION}). Upgrade akm to use this index.`,
      "INDEX_SCHEMA_INCOMPATIBLE",
      "Upgrade akm to a version that understands this index generation.",
    );
  }
  throw new ConfigError(
    `Index database at ${resolvedPath} is not usable with this akm's derived schema (stored generation ${stored}; ` +
      `this binary understands ${CANONICAL_INDEX_DB_VERSION}). Run 'akm index' to rebuild it.`,
    "INDEX_SCHEMA_INCOMPATIBLE",
    "Run `akm index` to rebuild the derived index from the currently materialized sources.",
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
  options?: { isolatedSnapshot?: boolean },
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
  // connection, so apply just that one.
  try {
    db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    assertCanonicalIndexGeneration(db, resolvedPath);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function closeDatabase(db: Database): void {
  db.close();
}
