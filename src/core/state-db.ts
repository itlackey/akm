// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * state.db — Durable SQLite database for non-regenerable akm state.
 *
 * This module OWNS the state database's shared infrastructure: path
 * resolution, the open/loan wrappers and schema introspection. The
 * table-specific query helpers live by domain in
 * `src/storage/repositories/*-repository.ts` (events, proposals, task-history,
 * improve-runs, improve-ledger, extract-sessions, embeddings); the
 * migration registry lives in `./state/migrations` and the runner in
 * `storage/sqlite-migrations`. The `BEGIN IMMEDIATE` helpers are
 * re-exported from `storage/sqlite-transaction`.
 *
 * ## Why a separate database from index.db
 *
 * index.db is a derived cache built by an idempotent baseline schema; it is fully
 * regenerable from the stash on disk, so a corrupt index is recovered by deleting
 * it and re-running `akm index`. Events, proposals, task history, workflow runs
 * and improve-pipeline ledgers are NON-REGENERABLE — losing them is data loss.
 * They live in a database whose released migration ledger is append-only.
 *
 * ## Open sequence
 *
 * {@link openStateDatabase} opens ONE connection: mkdir the parent, open, apply
 * the standard pragmas (`busy_timeout` 30 s first, `journal_mode` WAL with the
 * network-filesystem fallback, `foreign_keys` ON — `storage/sqlite-pragmas`),
 * read the `schema_migrations` ledger on that connection, and run every
 * migration not yet applied inside one `BEGIN IMMEDIATE` transaction. A
 * missing, empty or table-less file is simply a fresh database and gets the
 * whole registry. A ledger carrying ids this akm does not know was written by
 * a newer akm: the open continues with the schema this version knows and warns
 * once ({@link warnNewerStateLedger}). Before a released migration that drops
 * schema (`018-drop-dead-lane-schema`, `028-improve-ledger`; see
 * `STATE_MIGRATION_SAFETY_BY_ID`) runs against an existing database, the
 * database is copied beside itself to `state.db.pre-<id of the first such
 * pending migration>.bak` with `VACUUM INTO` — a plain sibling copy the
 * operator can open, nothing more. A database this open created from scratch is
 * compacted once after its migrations, since the registry creates tables that
 * later migrations drop. Only a ledger that DIVERGES from this akm's registry
 * is refused (`assertMigrationLedger`).
 *
 * ## Schema design: indexed columns vs. metadata_json
 *
 * Each table holds only the columns needed for indexed queries as first-class
 * columns. All other fields live in a `metadata_json TEXT` column (a JSON
 * object), so new fields can be appended without touching the DDL.
 *
 * ## WAL mode and writer contention
 *
 * WAL lets readers proceed while a writer is active and replays after a crash;
 * CLI commands are almost always single-writer. Writer contention that
 * outlasts every `BEGIN IMMEDIATE` retry surfaces as
 * `TransientError("STATE_DB_CONTENDED")`, exit 75 (#948) — the one place that
 * mapping lives is `storage/sqlite-transaction`.
 *
 * @module state-db
 */

import fs from "node:fs";
import path from "node:path";
import { type Database, openDatabase, type SqlValue } from "../storage/database";
import { openManagedDatabase, withManagedDb } from "../storage/managed-db";
import {
  assertMigrationLedger,
  type Migration,
  type MigrationLedgerState,
  runMigrations,
} from "../storage/sqlite-migrations";
import { applyReadonlyPragmas } from "../storage/sqlite-pragmas";
import { pkgVersion } from "../version";
import { getDataDir } from "./paths";
import { getStateMigrationSafety, STATE_MIGRATIONS } from "./state/migrations";
import { warnOnce } from "./warn";

export {
  beginImmediateTransaction,
  isSqliteContentionError,
  withImmediateTransaction,
} from "../storage/sqlite-transaction";

// ── Path helper ──────────────────────────────────────────────────────────────

/**
 * Default path: `<dataDir>/state.db`.
 * Respects the same `AKM_DATA_DIR` / XDG_DATA_HOME env-isolation as `getDbPath()` so
 * cooperating processes sharing a data root automatically share the same
 * state database.
 */
export function getStateDbPath(): string {
  return path.join(getDataDir(), "state.db");
}

// ── Database open ────────────────────────────────────────────────────────────

/**
 * Tell the operator once when state.db was migrated by a newer akm than the
 * one running. The open proceeds: every migration this binary knows is already
 * applied, so it reads and writes the tables it knows. Commands that depend on
 * something a later migration changed may still report less than the truth,
 * which is why this is said out loud rather than swallowed.
 */
function warnNewerStateLedger(ledger: MigrationLedgerState): void {
  if (ledger.status !== "newer") return;
  warnOnce(
    "state-db-newer-ledger",
    `[state.db] This akm (v${pkgVersion}) is older than the state database: ${ledger.detail}. ` +
      "Continuing with the schema this version knows; upgrade akm if its output looks incomplete.",
  );
}

/**
 * Copy the database beside itself before the first pending migration that
 * drops schema runs. `VACUUM INTO` writes one consistent standalone file
 * (committed WAL content included — a raw file copy would miss it) through
 * the same connection, into a temporary name that is renamed over the final
 * one only once the copy is complete, so a crash never leaves a half-written
 * `.bak` behind. Returns the copy's path, or undefined when nothing pending
 * is destructive.
 */
function backupBeforeDestructiveMigration(
  db: Database,
  dbPath: string,
  pending: readonly Migration[],
): string | undefined {
  const destructive = pending.find((migration) => getStateMigrationSafety(migration.id) === "historical-destructive");
  if (!destructive) return undefined;
  const backupPath = `${dbPath}.pre-${destructive.id}.bak`;
  const partialPath = `${backupPath}.tmp`;
  fs.rmSync(partialPath, { force: true });
  db.prepare("VACUUM INTO ?").run(partialPath);
  fs.renameSync(partialPath, backupPath);
  return backupPath;
}

/** What one open did to the ledger: the migrations it applied and the pre-migration copy it took. */
export interface StateDatabaseMigrationReport {
  applied: string[];
  backupPath?: string;
}

/** Read the ledger, warn on a newer one, back up before destructive DDL, then run what is pending. */
function migrateStateDatabase(db: Database, dbPath: string): StateDatabaseMigrationReport {
  const ledger = assertMigrationLedger(db, STATE_MIGRATIONS);
  warnNewerStateLedger(ledger);
  const pending = STATE_MIGRATIONS.slice(ledger.migrationIds.length);
  if (pending.length === 0) return { applied: [] };
  // A database with no applied migration holds nothing akm wrote: a fresh
  // file, `:memory:`, or an empty file left by an interrupted first open.
  const fresh = ledger.migrationIds.length === 0;
  const backupPath = fresh ? undefined : backupBeforeDestructiveMigration(db, dbPath, pending);
  const applied = runMigrations(db, STATE_MIGRATIONS);
  // The registry creates tables that later migrations drop (018, 028), which
  // leaves free pages behind; a database created by this open starts compact.
  if (fresh && applied.length > 0) db.exec("VACUUM");
  return backupPath ? { applied, backupPath } : { applied };
}

function openAndMigrate(dbPath: string): StateDatabaseMigrationReport & { db: Database } {
  let report: StateDatabaseMigrationReport = { applied: [] };
  const db = openManagedDatabase({
    path: dbPath,
    pragmas: { dataDir: path.dirname(dbPath) },
    init: (handle) => {
      report = migrateStateDatabase(handle, dbPath);
    },
  });
  return { db, ...report };
}

/**
 * Open (and initialise / migrate) the state database on one connection — see
 * the module header for the sequence.
 *
 * @param dbPath - Override the database file path. Pass a tmpdir path (or
 *   `:memory:`) in tests to avoid touching the real user data dir.
 */
export function openStateDatabase(dbPath: string = getStateDbPath()): Database {
  return openAndMigrate(dbPath).db;
}

/** {@link openStateDatabase}, also reporting which migrations this open applied (`akm health`). */
export function openStateDatabaseWithReport(
  dbPath: string = getStateDbPath(),
): StateDatabaseMigrationReport & { db: Database } {
  return openAndMigrate(dbPath);
}

/**
 * Read-only: the state migration IDs the running akm would apply to `dbPath`,
 * in ledger order. Empty when the database is missing, current, or was
 * migrated by a newer akm. Never applies anything. A ledger that diverges from
 * this akm's registry throws the same refusal the open does.
 */
export function listPendingStateMigrations(dbPath: string = getStateDbPath()): string[] {
  if (!fs.existsSync(dbPath)) return [];
  const db = openDatabase(dbPath, { readonly: true, create: false });
  try {
    applyReadonlyPragmas(db);
    const ledger = assertMigrationLedger(db, STATE_MIGRATIONS);
    return STATE_MIGRATIONS.slice(ledger.migrationIds.length).map((migration) => migration.id);
  } finally {
    db.close();
  }
}

export interface HistoricalStateUpgradeResult {
  /** Whether any pending migration was applied. */
  upgraded: boolean;
  /** The migration IDs this call applied, in ledger order; empty when current. */
  applied: string[];
  /** The `state.db.pre-<id>.bak` copy taken before a schema-dropping migration, when one ran. */
  safetyCopyPath?: string;
}

/**
 * Apply every pending state migration now and report what ran — the state
 * step of `akm migrate apply`. Any open does exactly the same work; this one
 * just says what happened. Missing and current databases are no-ops.
 */
export function upgradeHistoricalStateDatabase(dbPath: string = getStateDbPath()): HistoricalStateUpgradeResult {
  const pending = listPendingStateMigrations(dbPath);
  if (pending.length === 0) return { upgraded: false, applied: [] };
  const { db, backupPath } = openAndMigrate(dbPath);
  db.close();
  return backupPath
    ? { upgraded: true, applied: pending, safetyCopyPath: backupPath }
    : { upgraded: true, applied: pending };
}

/**
 * Run `fn` against state.db, owning the handle unless one is borrowed. The loan
 * helper for state.db, mirroring `withIndexDb` / `withWorkflowRunsRepo`. Pass
 * `{ borrowed: ctx?.db }` to reuse an already-open run-scoped handle rather than
 * opening + closing a fresh one — this replaces the hand-rolled
 * `ctx?.db ?? open()` + `ownsDb` flag + `finally`/close idiom at call sites.
 */
export function withStateDb<T>(fn: (db: Database) => T, opts?: { path?: string; borrowed?: Database }): T {
  return withManagedDb(() => openStateDatabase(opts?.path), fn, opts);
}

/**
 * Fire-and-forget telemetry write to state.db (usage_events' durable home).
 * Skips entirely when state.db does not exist yet (never fabricates an
 * un-migrated DB); otherwise opens it and lowers `busy_timeout` to a short
 * window so a contended state.db (e.g. a reindex finalize holding the write
 * lock) never stalls a hot path — mirrors `withIndexDb`'s
 * `TELEMETRY_BUSY_TIMEOUT_MS`. On a current database the open itself only
 * reads, so it does not wait behind a writer. Callers wrap this in their own
 * try/catch.
 */
export function withStateDbTelemetry(fn: (db: Database) => void, busyTimeoutMs = 250): void {
  if (!fs.existsSync(getStateDbPath())) return;
  const db = openStateDatabase();
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
    fn(db);
  } finally {
    db.close();
  }
}

// ── schema introspection ─────────────────────────────────────────────────────

/**
 * Return the subset of `names` that exist as TABLEs in this database, ordered
 * by name. Used by health's state-db-schema check to detect missing required
 * tables without leaking a `sqlite_master` query into command code.
 *
 * The `IN (...)` predicate is built from parameter placeholders so table names
 * are bound, never interpolated.
 *
 * Connection-lifetime rule (WS5): `.all()` materializes a plain array before
 * returning.
 */
export function listExistingTableNames(db: Database, names: readonly string[]): Array<{ name: string }> {
  if (names.length === 0) return [];
  const placeholders = names.map(() => "?").join(", ");
  return db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders}) ORDER BY name`)
    .all(...(names as SqlValue[])) as Array<{ name: string }>;
}
