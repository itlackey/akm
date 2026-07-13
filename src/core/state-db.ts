// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * state.db — Durable SQLite database for non-regenerable akm state.
 *
 * This module OWNS the state database's shared infrastructure: path resolution,
 * the managed-db open/loan wrappers, the `BEGIN IMMEDIATE` transaction helper,
 * and schema introspection. The table-specific query helpers live by domain in
 * `src/storage/repositories/*-repository.ts` (events, proposals, task-history,
 * improve-runs, extract-sessions, consolidation, recombine, embeddings,
 * canaries); importers reference those modules directly. The migration engine
 * lives in `./state/migrations`.
 *
 * The state DB replaces flat-file storage for data that is NON-REGENERABLE —
 * events (events.jsonl), proposals (per-uuid JSON directories), task history
 * (per-task JSONL), and the improve-pipeline ledgers.
 *
 * ## Why a separate database from index.db
 *
 * index.db is a derived cache built by an idempotent baseline schema; it is fully
 * regenerable from the stash on disk, so a corrupt index is recovered by deleting
 * it and re-running `akm index` (no destructive version-bump rebuild). Events,
 * proposals, and task history are NON-REGENERABLE — losing them is data loss. They
 * must live in a database whose schema evolves via incremental, additive migrations
 * that never drop rows.
 *
 * ## Migration-safety contract
 *
 * The `schema_migrations` table records every applied migration by a stable string
 * ID. `runMigrations(db)` is idempotent: new installs run all migrations in order;
 * upgrades run only the ones not yet applied. No migration may DROP a table that
 * holds durable data, RENAME a column, or change a column's type.
 *
 * Permitted schema evolution operations (always migration-safe in SQLite):
 *   - ALTER TABLE … ADD COLUMN <name> <type> DEFAULT <value>
 *   - CREATE INDEX IF NOT EXISTS …
 *   - CREATE TABLE IF NOT EXISTS … (additive new tables)
 *
 * ## Schema design: indexed columns vs. metadata_json
 *
 * Each table holds only the columns needed for indexed queries as first-class
 * columns. All other fields live in a `metadata_json TEXT` column (a JSON object).
 * New fields can be appended to the JSON blob at any time without touching the
 * DDL. This is the same pattern used by `usage_events.metadata` in index.db and
 * by the original events.jsonl format (the `metadata` field was always free-form
 * JSON).
 *
 * ## WAL mode
 *
 * SQLite WAL mode allows concurrent readers while a writer is active and makes
 * crashes safe (the WAL is replayed on next open). The O_APPEND multi-writer model
 * of events.jsonl is replaced by WAL-mode serialised writes — acceptable because
 * CLI commands are almost always single-writer.
 *
 * @module state-db
 */

import fs from "node:fs";
import path from "node:path";
import { type Database, openDatabase, type SqlValue } from "../storage/database";
import { assertCurrentMigrationLedger, assertMigrationLedger } from "../storage/engines/sqlite-migrations";
import { openManagedDatabase, withManagedDb, withManagedDbAsync } from "../storage/managed-db";
import { acquireMaintenanceActivitySync } from "./maintenance-barrier";
import { assertNoPendingMigrationOperation } from "./migration-operation";
import { getDataDir } from "./paths";
import { runMigrations, STATE_MIGRATIONS } from "./state/migrations";

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
 * Open (and initialise / migrate) the state database.
 *
 * @param dbPath - Override the database file path. Pass a tmpdir path in tests
 *   to avoid touching the real user cache. Mirrors the `filePath` test seam
 *   on `EventsContext`.
 *
 * PRAGMA rationale:
 *
 *   journal_mode = WAL
 *     Write-Ahead Logging: readers never block writers and vice-versa. Crashes
 *     are safe — the WAL is replayed on next open. Required for concurrent CLI
 *     invocations that may read while another writes.
 *
 *   foreign_keys = ON
 *     Enforces FK constraints at runtime. SQLite disables them by default for
 *     backwards compatibility; enabling them prevents orphaned rows in tables
 *     that reference each other (not used in v1 schema but guards future ones).
 *
 *   busy_timeout = 30000
 *     When another connection holds a write lock, SQLite retries for up to
 *     30 000 ms before returning SQLITE_BUSY. Without this, the default timeout
 *     is 0 ms — any concurrent writer causes an immediate error. 30 s (#589)
 *     matches the value used in openDatabase() for index.db; 5 s proved too
 *     narrow when a post-inference reindex overlapped a parallel event write.
 */
export function openStateDatabase(dbPath?: string): Database {
  const canonicalPath = getStateDbPath();
  const resolvedPath = dbPath ?? canonicalPath;
  const isCanonical = path.resolve(resolvedPath) === path.resolve(canonicalPath);
  if (isCanonical) assertNoPendingMigrationOperation();
  const releaseActivity = isCanonical ? acquireMaintenanceActivitySync("state-db") : undefined;
  try {
    if (isCanonical) assertNoPendingMigrationOperation();
    const existed = fs.existsSync(resolvedPath);
    if (existed) {
      const preflight = openDatabase(resolvedPath, { readonly: true });
      try {
        preflight.exec("PRAGMA busy_timeout = 30000");
        if (isCanonical) assertCurrentMigrationLedger(preflight, STATE_MIGRATIONS);
        else assertMigrationLedger(preflight, STATE_MIGRATIONS);
      } finally {
        preflight.close();
      }
    }
    const db = openManagedDatabase({
      path: resolvedPath,
      init: (db) => runMigrations(db, { applyPending: !(isCanonical && existed) }),
    });
    if (!releaseActivity) return db;
    let closed = false;
    return {
      prepare: db.prepare.bind(db),
      exec: db.exec.bind(db),
      run: db.run.bind(db),
      transaction: db.transaction.bind(db),
      get inTransaction() {
        return db.inTransaction;
      },
      close() {
        if (closed) return;
        closed = true;
        try {
          db.close();
        } finally {
          releaseActivity();
        }
      },
    };
  } catch (error) {
    releaseActivity?.();
    throw error;
  }
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
 * Async sibling of {@link withStateDb} — for `fn`s that hold the handle across
 * an `await` (the sync version would close it too early). Same borrow/own +
 * optional `path` override semantics.
 */
export function withStateDbAsync<T>(
  fn: (db: Database) => Promise<T>,
  opts?: { path?: string; borrowed?: Database },
): Promise<T> {
  return withManagedDbAsync(() => openStateDatabase(opts?.path), fn, opts);
}

// ── Migration engine ─────────────────────────────────────────────────────────
//
// The MIGRATIONS registry + runMigrations live in ./state/migrations (the single
// append-only ordered source of truth). Imported for internal use by
// openStateDatabase.
// ── BEGIN IMMEDIATE transaction helper ───────────────────────────────────────

/**
 * Run `fn` inside a `BEGIN IMMEDIATE` transaction.
 *
 * `db.transaction()` is DEFERRED by default on both Bun and better-sqlite3,
 * which means two writers can both perform stale preflight reads and only race
 * when they finally attempt the write. Proposal creation and queue mutation
 * need the write lock BEFORE those reads so concurrent processes serialize on
 * the live queue state rather than clobbering each other.
 */
/**
 * Errors `BEGIN IMMEDIATE` can throw under concurrent-writer contention that are
 * transient (the statement did NOT start a usable transaction) and safe to
 * retry:
 *   - "database is locked" / SQLITE_BUSY — another writer holds the lock.
 * These are start-of-transaction failures only; an error thrown by `fn` is a
 * real failure and is NEVER retried.
 *
 * "cannot start a transaction within a transaction" is deliberately NOT
 * retryable: it means a transaction is already open on this connection (a
 * re-entrant call — handled by the entry guard in withImmediateTransaction),
 * and "retrying" it with a ROLLBACK would destroy the caller's transaction
 * (issue #686).
 */
function isRetryableBeginError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("database is locked") ||
    msg.includes("database table is locked") ||
    // Phantom BEGIN (see below) — synthesized when BEGIN IMMEDIATE returns
    // without opening a transaction. Safe to retry: fn() has not run.
    msg.includes("did not open a transaction")
  );
}

const WITH_IMMEDIATE_TX_MAX_ATTEMPTS = 5;

/** Portable synchronous sleep (works under both Bun and Node). */
function sleepSyncMs(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function withImmediateTransaction<T>(db: Database, fn: () => T): T {
  // Re-entrancy guard (issue #686): if a transaction is already open on this
  // connection (e.g. a nested withImmediateTransaction call inside an outer
  // frame's fn), join it — run fn directly with no BEGIN/COMMIT/ROLLBACK of
  // our own. Without this, the nested BEGIN throws "cannot start a transaction
  // within a transaction", which the old retry path answered with an
  // unconditional ROLLBACK — destroying the OUTER transaction and leaving its
  // COMMIT to fail with "cannot commit - no transaction is active".
  if (db.inTransaction) {
    return fn();
  }
  let lastBeginErr: unknown;
  for (let attempt = 1; attempt <= WITH_IMMEDIATE_TX_MAX_ATTEMPTS; attempt++) {
    try {
      db.exec("BEGIN IMMEDIATE");
      // bun:sqlite can return from BEGIN IMMEDIATE under writer contention WITHOUT
      // actually opening a transaction (no throw). That phantom state otherwise
      // surfaces as "cannot commit - no transaction is active" at COMMIT — AFTER
      // fn() has already run in autocommit, so its writes escaped the intended
      // serialization (the concurrent proposal-queue race). Detect it here, before
      // fn(), and route it through the same retry path as a contended BEGIN.
      if (!db.inTransaction) {
        throw new Error("BEGIN IMMEDIATE did not open a transaction (phantom contention state)");
      }
    } catch (err) {
      lastBeginErr = err;
      if (isRetryableBeginError(err) && attempt < WITH_IMMEDIATE_TX_MAX_ATTEMPTS) {
        // Only roll back a transaction we can see — never blind-ROLLBACK, since
        // that could destroy a transaction this frame does not own.
        if (db.inTransaction) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // Transaction already gone — fine.
          }
        }
        sleepSyncMs(2 ** (attempt - 1));
        continue;
      }
      throw err;
    }
    try {
      const result = fn();
      if (!db.inTransaction) {
        // The transaction we opened vanished while fn() ran (e.g. an
        // auto-rollback or a stray ROLLBACK inside fn). fn's writes may have
        // escaped serialization, so retrying is unsafe — fail loudly instead of
        // letting COMMIT throw the opaque "cannot commit - no transaction is
        // active" SQLiteError.
        throw new Error(
          "withImmediateTransaction invariant violated: transaction opened by BEGIN IMMEDIATE was no longer active after the transaction body ran; refusing to COMMIT (writes may have escaped serialization)",
        );
      }
      db.exec("COMMIT");
      return result;
    } catch (err) {
      if (db.inTransaction) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Ignore rollback failures so the original error is preserved.
        }
      }
      throw err; // a real error inside the transaction body — never retried.
    }
  }
  // Exhausted retries on transient begin failures.
  throw lastBeginErr;
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
