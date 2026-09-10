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
 * improve-runs, extract-sessions, consolidation, embeddings, canaries);
 * importers reference those modules directly. The migration engine
 * lives in `./state/migrations`.
 *
 * The state DB stores non-regenerable events, proposals, task history, workflow
 * runs, and improve-pipeline ledgers.
 *
 * ## Why a separate database from index.db
 *
 * index.db is a derived cache built by an idempotent baseline schema; it is fully
 * regenerable from the stash on disk, so a corrupt index is recovered by deleting
 * it and re-running `akm index` (no destructive version-bump rebuild). Events,
 * proposals, and task history are NON-REGENERABLE — losing them is data loss. They
 * live in a database whose released migration ledger is immutable and whose
 * application policy is explicit.
 *
 * ## Migration-safety contract
 *
 * The `schema_migrations` table records every applied migration by a stable string
 * ID. New installs run all migrations in order. Existing exact-prefix ledgers
 * automatically apply additive migrations and the verified data-preserving 002
 * table rebuild. Released migration 018 contains destructive cleanup DDL and is
 * never applied by an ordinary managed open. The successful `akm upgrade` path
 * must first create and verify a sibling `VACUUM INTO` snapshot, then supplies
 * the narrow explicit intent that admits 018. A pre-existing file with no
 * applied migration IDs (whether the ledger table is absent or empty) is also
 * rejected without writes; explicit upgrade snapshots its exact inode before
 * creating the ledger or applying migration 001, then retains the same writer
 * lock through migration 002's rebuild. Unknown and divergent ledgers fail
 * closed.
 *
 * Normal automatic schema evolution uses:
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
 * ## Writer contention (#948)
 *
 * Every open already carries a 30s `busy_timeout` (`sqlite-pragmas.ts`), so a
 * single blocked statement waits before failing. `withImmediateTransaction`
 * additionally retries `BEGIN IMMEDIATE` itself
 * ({@link WITH_IMMEDIATE_TX_MAX_ATTEMPTS} attempts) for the rarer case of two
 * writers racing the BEGIN statement back-to-back. If every attempt is still
 * contention-shaped ({@link isSqliteContentionError} — SQLITE_BUSY/LOCKED, the
 * matching message text, or the phantom-BEGIN marker), the exhaustion throw is
 * reclassified into `TransientError("STATE_DB_CONTENDED")` (exit 75, #948
 * addendum) instead of surfacing the raw driver text: another akm process (an
 * unrelated `improve`, `workflow run`, or task run — not necessarily
 * contending for the same row) is writing state.db right now. A genuinely
 * unrelated error (real corruption, a body-thrown failure) is never
 * reclassified and rethrows exactly as raised.
 *
 * @module state-db
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sleepSync } from "../runtime";
import { type Database, openDatabase, type SqlValue } from "../storage/database";
import { assertMigrationLedger, type MigrationLedgerState } from "../storage/engines/sqlite-migrations";
import { openManagedDatabase, withManagedDb } from "../storage/managed-db";
import { pkgVersion } from "../version";
import { TransientError } from "./errors";
import { acquireMaintenanceActivitySync } from "./maintenance-barrier";
import { getDataDir } from "./paths";
import { runMigrations, STATE_MIGRATIONS } from "./state/migrations";
import { warnOnce } from "./warn";

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

interface OpenStateDatabaseOptions {
  /**
   * Narrow intent supplied only by `akm upgrade` and `akm migrate apply` --
   * never by an ordinary managed open, which refuses instead.
   */
  allowHistoricalDestructiveStateUpgrade?: boolean;
  /** Internal result seam used to report the verified safety-copy path. */
  onHistoricalStateSafetyCopy?: (safetyCopyPath: string) => void;
}

export interface HistoricalStateUpgradeResult {
  /** Whether any pending migration was applied. */
  upgraded: boolean;
  /** The migration IDs this call applied, in ledger order; empty when current. */
  applied: string[];
  safetyCopyPath?: string;
}

function safetyCopyTimestamp(): string {
  return new Date().toISOString().replaceAll(/[^0-9]/g, "");
}

interface FileIdentityHandle {
  path: string;
  fd: number;
  identity: fs.BigIntStats;
}

type OwnedFileReservation = FileIdentityHandle;

type StateDatabaseSource = FileIdentityHandle;

function noFollowFlag(): number {
  return process.platform !== "win32" && typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
}

function samePhysicalFile(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  if (left.dev !== 0n || left.ino !== 0n || right.dev !== 0n || right.ino !== 0n) {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return left.birthtimeNs === right.birthtimeNs && left.rdev === right.rdev;
}

function assertOwnedFileReservation(reservation: OwnedFileReservation, label: string): fs.BigIntStats {
  const descriptorStat = fs.fstatSync(reservation.fd, { bigint: true });
  let pathStat: fs.BigIntStats;
  try {
    pathStat = fs.lstatSync(reservation.path, { bigint: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} ownership/inode verification failed because its path disappeared: ${detail}`);
  }
  if (
    pathStat.isSymbolicLink() ||
    !pathStat.isFile() ||
    !descriptorStat.isFile() ||
    !samePhysicalFile(reservation.identity, descriptorStat) ||
    !samePhysicalFile(descriptorStat, pathStat)
  ) {
    throw new Error(`${label} ownership/inode verification failed: its path is a symlink or was replaced.`);
  }
  if (process.platform !== "win32" && typeof process.geteuid === "function") {
    const expectedUid = BigInt(process.geteuid());
    if (descriptorStat.uid !== expectedUid || pathStat.uid !== expectedUid) {
      throw new Error(`${label} ownership verification failed: the reserved file is not owned by the current user.`);
    }
  }
  return pathStat;
}

function assertStateDatabaseSource(source: StateDatabaseSource): fs.BigIntStats {
  const descriptorStat = fs.fstatSync(source.fd, { bigint: true });
  let pathStat: fs.BigIntStats;
  try {
    pathStat = fs.lstatSync(source.path, { bigint: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`state.db source inode verification failed because its path disappeared: ${detail}`);
  }
  if (
    pathStat.isSymbolicLink() ||
    !pathStat.isFile() ||
    !descriptorStat.isFile() ||
    !samePhysicalFile(source.identity, descriptorStat) ||
    !samePhysicalFile(descriptorStat, pathStat) ||
    descriptorStat.uid !== source.identity.uid ||
    pathStat.uid !== source.identity.uid
  ) {
    throw new Error("state.db source ownership/inode verification failed: its path is a symlink or was replaced.");
  }
  return descriptorStat;
}

function descriptorAlias(handle: FileIdentityHandle): string | undefined {
  const candidates =
    process.platform === "linux"
      ? [`/proc/self/fd/${handle.fd}`, `/dev/fd/${handle.fd}`]
      : process.platform === "win32"
        ? []
        : [`/dev/fd/${handle.fd}`];
  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate, { bigint: true });
      if (samePhysicalFile(handle.identity, stat)) return candidate;
    } catch {
      // The caller verifies the pathname immediately around SQLite open on
      // platforms without a SQLite-openable descriptor alias.
    }
  }
  return undefined;
}

function sqliteBoundFilePath(handle: FileIdentityHandle): string {
  // A descriptor-backed alias (/proc/self/fd, /dev/fd) lets SQLite open the
  // exact held inode even if its path gets swapped out from under it. It is
  // an optimization, not the actual protection: every caller re-verifies the
  // held identity (dev/ino/uid) immediately before and after every open that
  // uses this path, so a plain path is safe whenever no alias is available —
  // Windows never has one, and macOS's /dev/fd is a small fixed-size devfs
  // table that a process holding higher fd numbers (as a bundled standalone
  // binary routinely does) can miss entirely. Either way, a swap in that
  // window is still caught by the surrounding identity checks.
  return descriptorAlias(handle) ?? handle.path;
}

function closeFileIdentity(handle: FileIdentityHandle): void {
  try {
    fs.closeSync(handle.fd);
  } catch {
    // Preserve the authoritative operation failure.
  }
}

function reserveFreshStateDatabase(dbPath: string): OwnedFileReservation | undefined {
  let fd: number;
  try {
    fd = fs.openSync(dbPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | noFollowFlag(), 0o666);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") return undefined;
    throw error;
  }
  try {
    return {
      path: dbPath,
      fd,
      identity: fs.fstatSync(fd, { bigint: true }),
    };
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch {
      // Preserve the fstat failure.
    }
    throw error;
  }
}

function openExistingStateDatabaseSource(dbPath: string): StateDatabaseSource {
  let fd: number;
  try {
    fd = fs.openSync(dbPath, fs.constants.O_RDONLY | noFollowFlag());
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not bind the existing state.db source inode: ${detail}`);
  }
  try {
    return {
      path: dbPath,
      fd,
      identity: fs.fstatSync(fd, { bigint: true }),
    };
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch {
      // Preserve the fstat failure.
    }
    throw error;
  }
}

function reserveHistoricalSafetyCopy(
  source: StateDatabaseSource,
  migrationId: string,
): { reservation: OwnedFileReservation; finalMode: number } {
  const sourceStat = assertStateDatabaseSource(source);
  const finalMode = Number(sourceStat.mode & 0o600n);
  const prefix = `${source.path}.pre-${migrationId}.${safetyCopyTimestamp()}`;

  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = `${prefix}.${randomUUID()}.bak`;
    let fd: number;
    try {
      fd = fs.openSync(
        candidate,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | noFollowFlag(),
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "EEXIST") continue;
      throw error;
    }
    let reservation: OwnedFileReservation | undefined;
    try {
      reservation = {
        path: candidate,
        fd,
        identity: fs.fstatSync(fd, { bigint: true }),
      };
      // Keep recovery bytes owner-only throughout creation. The source-derived
      // (never broader) final mode is restored only after verification.
      fs.fchmodSync(fd, 0o600);
      assertOwnedFileReservation(reservation, "Reserved state.db safety copy");
      return { reservation, finalMode };
    } catch (error) {
      try {
        fs.closeSync(fd);
      } catch {
        // Preserve the reservation/ownership failure.
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not secure reserved state.db safety-copy path ${candidate}: ${detail}. ` +
          "The reserved pathname was not removed.",
      );
    }
  }
  throw new Error("Could not reserve a unique randomized state.db safety-copy path after 32 attempts.");
}

function fsyncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const fd = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Create one verified, standalone SQLite snapshot immediately before released
 * migration 018 removes its retired tables/column. `VACUUM INTO` includes
 * committed WAL content in one consistent sibling database; a raw file copy
 * would not.
 */
function createHistoricalStateSafetyCopy(source: StateDatabaseSource, migrationId: string): string {
  const { reservation, finalMode } = reserveHistoricalSafetyCopy(source, migrationId);
  let reader: Database | undefined;
  try {
    assertOwnedFileReservation(reservation, "Reserved state.db safety copy");
    assertStateDatabaseSource(source);
    // The migration connection already holds BEGIN IMMEDIATE. A distinct
    // read-only connection bound to the held source inode can snapshot the
    // committed WAL view without trying to VACUUM from inside that transaction.
    reader = openDatabase(sqliteBoundFilePath(source), { readonly: true });
    assertStateDatabaseSource(source);
    reader.prepare("VACUUM INTO ?").run(sqliteBoundFilePath(reservation));
    assertStateDatabaseSource(source);
    reader.close();
    reader = undefined;

    assertOwnedFileReservation(reservation, "Reserved state.db safety copy");
    fs.fsyncSync(reservation.fd);
    assertOwnedFileReservation(reservation, "Reserved state.db safety copy");

    const verified = openDatabase(sqliteBoundFilePath(reservation), {
      readonly: true,
    });
    try {
      const quickCheck = verified.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined;
      if (!quickCheck || Object.values(quickCheck)[0] !== "ok") {
        throw new Error("SQLite quick_check did not report ok");
      }
      assertMigrationLedger(verified, STATE_MIGRATIONS);
    } finally {
      verified.close();
    }
    assertOwnedFileReservation(reservation, "Reserved state.db safety copy");
    fs.fchmodSync(reservation.fd, finalMode);
    fs.fsyncSync(reservation.fd);
    assertOwnedFileReservation(reservation, "Reserved state.db safety copy");
    fsyncDirectory(path.dirname(reservation.path));
    closeFileIdentity(reservation);
    return reservation.path;
  } catch (error) {
    try {
      reader?.close();
    } catch {
      // Preserve the snapshot/verification failure below.
    }
    closeFileIdentity(reservation);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not create a verified state.db safety copy before ${migrationId}: ${detail}. ` +
        `The reserved safety-copy pathname was not removed: ${reservation.path}`,
    );
  }
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

function unversionedDatabaseHasNoTables(db: Database): boolean {
  const tables = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != ?")
    .get("schema_migrations");
  return !tables;
}

export function openStateDatabase(dbPath?: string, options?: OpenStateDatabaseOptions): Database {
  const canonicalPath = getStateDbPath();
  const resolvedPath = dbPath ?? canonicalPath;
  // `:memory:` is a SQLite connection identity, not a filesystem pathname.
  // Never pass it through the durable-file reservation/inode/snapshot path:
  // doing so creates a literal `:memory:` file and makes later in-process
  // opens look like an unversioned durable database. Each in-memory handle is
  // fresh and cannot be path-swapped, so the ownership proof is intrinsically
  // satisfied for this explicit test/internal seam.
  if (resolvedPath === ":memory:") {
    return openManagedDatabase({
      path: resolvedPath,
      pragmas: { dataDir: path.dirname(resolvedPath) },
      init: (db) => runMigrations(db, { freshDatabase: true }),
    });
  }
  const isCanonical = path.resolve(resolvedPath) === path.resolve(canonicalPath);
  const releaseActivity = isCanonical ? acquireMaintenanceActivitySync("state-db") : undefined;
  let freshReservation: OwnedFileReservation | undefined;
  let existingSource: StateDatabaseSource | undefined;
  let openedDb: Database | undefined;
  let existingUnversionedDatabase = false;
  let treatUnversionedAsFresh = false;
  let stateSafetyCopyCreated = false;
  try {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    freshReservation = reserveFreshStateDatabase(resolvedPath);
    if (!freshReservation) {
      existingSource = openExistingStateDatabaseSource(resolvedPath);
      const preflight = openDatabase(sqliteBoundFilePath(existingSource), {
        readonly: true,
      });
      try {
        preflight.exec("PRAGMA busy_timeout = 30000");
        const ledger = assertMigrationLedger(preflight, STATE_MIGRATIONS);
        warnNewerStateLedger(ledger);
        existingUnversionedDatabase = ledger.migrationIds.length === 0;
        if (existingUnversionedDatabase && unversionedDatabaseHasNoTables(preflight)) {
          existingUnversionedDatabase = false;
          treatUnversionedAsFresh = true;
        }
        if (existingUnversionedDatabase && !options?.allowHistoricalDestructiveStateUpgrade) {
          throw new Error(
            "Refusing to migrate an existing unversioned state.db during an ordinary managed open. " +
              "Run `akm upgrade` (or `akm migrate apply`) to create a verified snapshot before migration 001 " +
              "and apply it deliberately.",
          );
        }
      } finally {
        preflight.close();
      }
    }
    const boundSource = existingSource;
    openedDb = openManagedDatabase({
      path: boundSource ? sqliteBoundFilePath(boundSource) : resolvedPath,
      pragmas: { dataDir: path.dirname(resolvedPath) },
      init: (db) => {
        runMigrations(db, {
          freshDatabase: !!freshReservation || treatUnversionedAsFresh,
          existingUnversionedDatabase,
          allowHistoricalDestructiveStateUpgrade: options?.allowHistoricalDestructiveStateUpgrade,
          beforeExistingUnversionedStateMigration: options?.allowHistoricalDestructiveStateUpgrade
            ? (migration) => {
                if (!boundSource) throw new Error("An existing unversioned state.db has no bound source inode.");
                const safetyCopyPath = createHistoricalStateSafetyCopy(boundSource, migration.id);
                stateSafetyCopyCreated = true;
                options.onHistoricalStateSafetyCopy?.(safetyCopyPath);
              }
            : undefined,
          beforeHistoricalDestructiveMigration: options?.allowHistoricalDestructiveStateUpgrade
            ? (migration) => {
                if (stateSafetyCopyCreated) return;
                if (!boundSource) throw new Error("Historical state migration has no bound source inode.");
                const safetyCopyPath = createHistoricalStateSafetyCopy(boundSource, migration.id);
                stateSafetyCopyCreated = true;
                options.onHistoricalStateSafetyCopy?.(safetyCopyPath);
              }
            : undefined,
        });
      },
    });
    if (existingSource) {
      closeFileIdentity(existingSource);
      existingSource = undefined;
    }
    if (freshReservation) {
      closeFileIdentity(freshReservation);
      freshReservation = undefined;
    }
    const db = openedDb;
    if (!releaseActivity) return db;
    let closed = false;
    return {
      prepare: db.prepare.bind(db),
      exec: db.exec.bind(db),
      run: db.run.bind(db),
      transaction: db.transaction.bind(db),
      loadExtension: db.loadExtension.bind(db),
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
    if (openedDb) {
      try {
        openedDb.close();
      } catch {
        // Preserve the open/migration ownership failure.
      }
    }
    if (existingSource) closeFileIdentity(existingSource);
    if (freshReservation) closeFileIdentity(freshReservation);
    releaseActivity?.();
    throw error;
  }
}

/**
 * Read-only: the state migration IDs the running akm would apply to `dbPath`,
 * in ledger order. Empty when the database is missing or current. Throws on a
 * ledger this akm cannot own (newer, or not an exact ordered prefix) -- the
 * same refusal a managed open makes.
 */
export function listPendingStateMigrations(dbPath = getStateDbPath()): string[] {
  if (!fs.existsSync(dbPath)) return [];
  const preflight = openDatabase(dbPath, { readonly: true });
  try {
    preflight.exec("PRAGMA busy_timeout = 30000");
    const ledger = assertMigrationLedger(preflight, STATE_MIGRATIONS);
    return STATE_MIGRATIONS.slice(ledger.migrationIds.length).map((migration) => migration.id);
  } finally {
    preflight.close();
  }
}

/**
 * Apply every pending state migration, historical-destructive ones included:
 * the one step `akm upgrade` and `akm migrate apply` share, and the only
 * caller that may admit migration 018 (an ordinary managed open refuses it by
 * design). Missing/current databases are no-ops. A pre-018 exact ledger, or an
 * unversioned database, is snapshotted beside state.db and verified before the
 * immutable released migration runs.
 */
export function upgradeHistoricalStateDatabase(dbPath = getStateDbPath()): HistoricalStateUpgradeResult {
  const pending = listPendingStateMigrations(dbPath);
  if (pending.length === 0) return { upgraded: false, applied: [] };

  let safetyCopyPath: string | undefined;
  try {
    const db = openStateDatabase(dbPath, {
      allowHistoricalDestructiveStateUpgrade: true,
      onHistoricalStateSafetyCopy(copyPath) {
        safetyCopyPath = copyPath;
      },
    });
    db.close();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const recovery = safetyCopyPath ? ` Verified safety copy: ${safetyCopyPath}.` : "";
    throw new Error(`${detail}${recovery}`);
  }
  return safetyCopyPath ? { upgraded: true, applied: pending, safetyCopyPath } : { upgraded: true, applied: pending };
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
 * Fire-and-forget telemetry write to state.db (Chunk-8 WI-8.3: usage_events'
 * durable home). Skips entirely when state.db does not exist yet (never
 * fabricates an un-migrated DB); otherwise opens the migrated DB and lowers
 * `busy_timeout` to a short window so a contended state.db (e.g. a reindex
 * finalize holding the write lock while relinking usage_events) never stalls a
 * hot path — mirrors `withIndexDb`'s `TELEMETRY_BUSY_TIMEOUT_MS`. WAL mode lets
 * the read-only migration-preflight run concurrently with a writer, so the open
 * itself does not block. Callers wrap this in their own try/catch.
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
 * Whether `err` is one of the SQLite conditions a concurrent-writer race can
 * throw that are transient — the statement did NOT corrupt anything, another
 * writer just holds the lock right now — and therefore safe to retry or
 * reclassify as ordinary contention rather than a genuine failure:
 *   - `SQLITE_BUSY` / `SQLITE_LOCKED` (either driver's `.code`).
 *   - "database is locked" / "database table is locked" message text.
 *   - the phantom-BEGIN marker synthesized below when `BEGIN IMMEDIATE`
 *     returns without actually opening a transaction.
 *
 * This is the single shared classifier for "is this ordinary state.db
 * contention" (#948) — `isRetryableBeginError` below delegates to it, and so
 * does {@link WorkflowRunsRepository}'s lease-contention classifier (which
 * additionally matches a couple of corruption-shaped texts specific to its
 * own narrower cross-process race and keeps its own live-lease confirmation
 * before reclassifying). Matching this set alone is never sufficient to
 * declare something DEFINITELY contention when a caller needs corroborating
 * evidence (see the lease path); for `beginImmediateTransaction`'s own
 * exhaustion case there is no such evidence available, so the five 30s
 * `busy_timeout` waits already spent stand as the evidence instead.
 */
export function isSqliteContentionError(err: unknown): boolean {
  const code = (err as { code?: unknown } | undefined)?.code;
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return true;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("database is locked") ||
    msg.includes("database table is locked") ||
    // Phantom BEGIN (see below) — synthesized when BEGIN IMMEDIATE returns
    // without opening a transaction. Safe to retry: fn() has not run.
    msg.includes("did not open a transaction")
  );
}

/**
 * Errors `BEGIN IMMEDIATE` can throw under concurrent-writer contention that
 * are transient (the statement did NOT start a usable transaction) and safe
 * to retry. An error thrown by `fn` is a real failure and is NEVER retried.
 *
 * "cannot start a transaction within a transaction" is deliberately NOT
 * retryable: it means a transaction is already open on this connection (a
 * re-entrant call — handled by the entry guard in withImmediateTransaction),
 * and "retrying" it with a ROLLBACK would destroy the caller's transaction
 * (issue #686).
 */
function isRetryableBeginError(err: unknown): boolean {
  return isSqliteContentionError(err);
}

const WITH_IMMEDIATE_TX_MAX_ATTEMPTS = 5;

/** Portable synchronous sleep (works under both Bun and Node). Delegates to the runtime boundary's `sleepSync`. */
function sleepSyncMs(ms: number): void {
  if (ms <= 0) return;
  sleepSync(ms);
}

/**
 * Open, but deliberately do not finish, an immediate transaction.
 *
 * This is the split-phase counterpart to {@link withImmediateTransaction} for
 * the source-update coordinator: index finalization must mutate state.db in a
 * transaction that remains pending until content, lockfile, and index
 * publication have all succeeded. The caller that asked for this split phase
 * owns the matching COMMIT/ROLLBACK.
 */
/**
 * Reclassify an exhausted-retry BEGIN failure that is still contention-shaped
 * (#948) into a `TransientError("STATE_DB_CONTENDED")`, mirroring the
 * RUN_LEASE_HELD precedent (`WorkflowRunsRepository.acquireEngineLease`): the
 * driver text is accurate but unhelpful (`{"ok":false,"error":"database is
 * locked"}`, exit 70/INTERNAL) — this instead reads as a retryable-shortly
 * signal (exit 75, sysexits EX_TEMPFAIL — #948 addendum) with the original
 * error preserved as `cause` for `--verbose`/debugging. A genuinely unrelated
 * error (not contention-shaped) is rethrown exactly as raised, never
 * reclassified.
 */
function throwBeginFailure(err: unknown): never {
  if (isSqliteContentionError(err)) {
    const contended = new TransientError(
      "akm's state database is busy (another akm process is writing it); retry shortly.",
      "STATE_DB_CONTENDED",
    );
    contended.cause = err;
    throw contended;
  }
  throw err;
}

export function beginImmediateTransaction(db: Database): void {
  if (db.inTransaction) {
    throw new Error("beginImmediateTransaction requires a connection with no active transaction");
  }
  let lastBeginErr: unknown;
  for (let attempt = 1; attempt <= WITH_IMMEDIATE_TX_MAX_ATTEMPTS; attempt++) {
    try {
      db.exec("BEGIN IMMEDIATE");
      if (!db.inTransaction) {
        throw new Error("BEGIN IMMEDIATE did not open a transaction (phantom contention state)");
      }
      return;
    } catch (err) {
      lastBeginErr = err;
      if (isRetryableBeginError(err) && attempt < WITH_IMMEDIATE_TX_MAX_ATTEMPTS) {
        if (db.inTransaction) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // Transaction already gone — safe to retry BEGIN.
          }
        }
        sleepSyncMs(2 ** (attempt - 1));
        continue;
      }
      throwBeginFailure(err);
    }
  }
  throwBeginFailure(lastBeginErr);
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
  beginImmediateTransaction(db);
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
    throw err;
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
