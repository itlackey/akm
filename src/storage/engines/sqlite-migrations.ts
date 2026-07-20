// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared SQLite migration engine.
 *
 * state.db (`src/core/state-db.ts`) evolves its schema through this idempotent,
 * transaction-per-migration runner backed by a `schema_migrations` ledger. The
 * migrator's frozen pre-cutover workflow-schema roll
 * (`src/migrate/legacy/workflow-migrations-bodies.ts`, driven by
 * `config-migrate.ts`) reuses the SAME runner. The `bootstrap` hook — a one-line
 * pre-versioning back-fill — is now unused by live callers (the pre-cutover
 * workflow.db that once needed it fails closed at migrate time).
 *
 * This module factors that runner out once. Each caller supplies only its own
 * `MIGRATIONS` array (plus, historically, an optional `bootstrap` hook).
 *
 * Migration-safety contract:
 *   - `id` is permanent and must never be reused.
 *   - `up` must be idempotent (use IF NOT EXISTS, INSERT OR IGNORE, etc.).
 *   - `up` must not DROP any table that holds durable (non-regenerable) data.
 *   - `up` must not RENAME or change the type of an existing column.
 *   - To add a column: use `ALTER TABLE … ADD COLUMN … DEFAULT …`.
 *   - Applied IDs must be an exact ordered prefix of the registry.
 *   - Released migration bodies are sealed by SHA-256 in the same ledger.
 */

import crypto from "node:crypto";
import type { Database } from "../database";

/**
 * A single, append-only schema migration.
 *
 * @see The migration-safety contract in this module's header.
 */
export interface Migration {
  id: string;
  up: string;
}

/**
 * Optional hook invoked AFTER `ensureMigrationsTable` but BEFORE the migration
 * list is evaluated. Used by workflow.db to back-fill `schema_migrations` rows
 * for schema state that existed before the database gained migration tracking,
 * so those migrations are not re-applied.
 */
export type MigrationBootstrap = (db: Database) => void;

/**
 * Options for {@link runMigrations}.
 */
export interface RunMigrationsOptions {
  /**
   * Back-fill hook for pre-versioning databases. Invoked once, after the
   * migrations table is ensured and before the migration list is applied.
   */
  bootstrap?: MigrationBootstrap;
  /** Called immediately before each pending migration and before its transaction. */
  beforeMigration?: (migration: Migration) => void;
  /** Validate the ledger but leave known pending migrations unapplied. */
  applyPending?: boolean;
  /** Durable operation marker used to authenticate migration-journal adjacent generations. */
  generationMarker?: { operationId: string; phase: string };
}

export type MigrationLedgerStatus = "old" | "current" | "newer" | "inconsistent";

export interface MigrationLedgerState {
  status: MigrationLedgerStatus;
  migrationIds: string[];
  checksums: Array<string | null>;
  detail?: string;
}

/**
 * A released migration's IDENTITY without its `up` body: the stable `id` plus
 * the pre-computed {@link migrationChecksum}. This is what a ledger inspection
 * actually needs — the `up` body is only used to derive the checksum. A frozen
 * copy of a since-deleted migration array (e.g. the pre-cutover workflow.db
 * ledger, `src/migrate/legacy/workflow-migrations-frozen.ts`) is expressed as
 * `SealedMigration[]` so backups stay verifiable without the live bodies.
 */
export interface SealedMigration {
  id: string;
  checksum: string;
}

export function migrationChecksum(migration: Migration): string {
  return crypto.createHash("sha256").update(migration.id).update("\0").update(migration.up).digest("hex");
}

function migrationsTableExists(db: Database): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
}

function ledgerHasChecksum(db: Database): boolean {
  return (db.prepare("PRAGMA table_info(schema_migrations)").all() as Array<{ name: string }>).some(
    (column) => column.name === "checksum",
  );
}

/**
 * Core ledger inspection against the expected ordered `{ id, checksum }`
 * registry. Both {@link inspectMigrationLedger} (bodies → checksums) and
 * {@link inspectSealedMigrationLedger} (frozen pre-computed checksums) route
 * here so the two entry points can never diverge.
 */
function inspectLedgerAgainst(db: Database, expected: readonly SealedMigration[]): MigrationLedgerState {
  const registryIds = expected.map((entry) => entry.id);
  if (new Set(registryIds).size !== registryIds.length) {
    return {
      status: "inconsistent",
      migrationIds: [],
      checksums: [],
      detail: "migration registry contains duplicate IDs",
    };
  }
  if (!migrationsTableExists(db))
    return { status: registryIds.length === 0 ? "current" : "old", migrationIds: [], checksums: [] };

  const hasChecksum = ledgerHasChecksum(db);
  const rows = db
    .prepare(`SELECT id${hasChecksum ? ", checksum" : ""} FROM schema_migrations ORDER BY rowid`)
    .all() as Array<{ id: string; checksum?: string | null }>;
  const migrationIds = rows.map((row) => row.id);
  const checksums = rows.map((row) => row.checksum ?? null);

  for (let index = 0; index < rows.length; index += 1) {
    const entry = expected[index];
    const row = rows[index];
    if (!entry) {
      return { status: "newer", migrationIds, checksums, detail: `unknown migration ID ${row.id}` };
    }
    if (row.id !== entry.id) {
      const knownLater = registryIds.includes(row.id);
      return {
        status: knownLater ? "inconsistent" : "newer",
        migrationIds,
        checksums,
        detail: knownLater
          ? `migration ledger is not an exact ordered prefix at position ${index + 1}`
          : `unknown migration ID ${row.id}`,
      };
    }
    if (row.checksum && row.checksum !== entry.checksum) {
      return {
        status: "inconsistent",
        migrationIds,
        checksums,
        detail: `migration ${row.id} checksum does not match the released migration body`,
      };
    }
  }

  const missingChecksum = checksums.indexOf(null);
  if (missingChecksum >= 0) {
    return {
      status: "old",
      migrationIds,
      checksums,
      detail: `migration ${migrationIds[missingChecksum]} has not been sealed with a checksum`,
    };
  }

  return {
    status: rows.length === expected.length ? "current" : "old",
    migrationIds,
    checksums,
  };
}

export function inspectMigrationLedger(db: Database, migrations: readonly Migration[]): MigrationLedgerState {
  return inspectLedgerAgainst(
    db,
    migrations.map((migration) => ({ id: migration.id, checksum: migrationChecksum(migration) })),
  );
}

/**
 * Ledger inspection against a FROZEN `{ id, checksum }` copy of a migration
 * array whose live source is gone (plan §3.3 item 1). Behaviourally identical
 * to {@link inspectMigrationLedger} — the checksums are simply pre-computed
 * rather than derived from `up` bodies.
 */
export function inspectSealedMigrationLedger(db: Database, sealed: readonly SealedMigration[]): MigrationLedgerState {
  return inspectLedgerAgainst(db, sealed);
}

export function assertMigrationLedger(db: Database, migrations: readonly Migration[]): MigrationLedgerState {
  const state = inspectMigrationLedger(db, migrations);
  if (state.status === "newer") {
    throw new Error(`Refusing to open a database with a newer migration ledger: ${state.detail}.`);
  }
  if (state.status === "inconsistent") {
    throw new Error(`Refusing a database whose migrations are not an exact ordered prefix: ${state.detail}.`);
  }
  return state;
}

export function assertCurrentMigrationLedger(db: Database, migrations: readonly Migration[]): MigrationLedgerState {
  const state = assertMigrationLedger(db, migrations);
  if (state.status !== "current") {
    throw new Error(
      `Refusing to open an obsolete writable schema; run \`akm migrate apply\`: ${state.detail ?? "pending migrations"}.`,
    );
  }
  return state;
}

/**
 * Create the migrations ledger table if it does not exist. Must be called
 * unconditionally on every open so a fresh database bootstraps correctly.
 */
export function ensureMigrationsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT    PRIMARY KEY,
      applied_at TEXT    NOT NULL DEFAULT (datetime('now')),
      checksum   TEXT
    );
  `);
  if (!ledgerHasChecksum(db)) db.exec("ALTER TABLE schema_migrations ADD COLUMN checksum TEXT");
}

/**
 * Apply every pending migration, one transaction per migration.
 *
 * Each migration is applied in its own transaction so a failure in migration N
 * does not roll back already-applied migrations 1..N-1. The migration row is
 * inserted AFTER the DDL succeeds, so a crash mid-migration leaves no row and
 * the migration is retried on next open (all DDL in `up` uses IF NOT EXISTS so
 * the retry is safe).
 *
 * @param db          The open SQLite database.
 * @param migrations  The module's ordered, append-only migration list.
 * @param opts        Optional `bootstrap` hook (see {@link RunMigrationsOptions}).
 */
export function runMigrations(db: Database, migrations: readonly Migration[], opts?: RunMigrationsOptions): void {
  if (opts?.applyPending === false) {
    assertMigrationLedger(db, migrations);
    return;
  }
  if (migrationsTableExists(db)) assertMigrationLedger(db, migrations);
  ensureMigrationsTable(db);
  opts?.bootstrap?.(db);

  const ledger = assertMigrationLedger(db, migrations);
  db.transaction(() => {
    const update = db.prepare("UPDATE schema_migrations SET checksum = ? WHERE id = ? AND checksum IS NULL");
    for (let index = 0; index < ledger.migrationIds.length; index += 1) {
      update.run(migrationChecksum(migrations[index]), ledger.migrationIds[index]);
    }
    if (opts?.generationMarker) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS akm_migration_generation (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          operation_id TEXT NOT NULL,
          phase TEXT NOT NULL
        )
      `);
      db.prepare(
        "INSERT INTO akm_migration_generation(singleton, operation_id, phase) VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET operation_id=excluded.operation_id, phase=excluded.phase",
      ).run(opts.generationMarker.operationId, opts.generationMarker.phase);
    }
  })();

  const appliedRows = db.prepare("SELECT id FROM schema_migrations ORDER BY rowid").all() as Array<{ id: string }>;
  const applied = new Set(appliedRows.map((r) => r.id));

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;

    opts?.beforeMigration?.(migration);

    db.transaction(() => {
      db.exec(migration.up);
      db.prepare("INSERT INTO schema_migrations (id, checksum) VALUES (?, ?)").run(
        migration.id,
        migrationChecksum(migration),
      );
    })();
  }
}
