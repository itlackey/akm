// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared SQLite migration engine.
 *
 * state.db (`src/core/state-db.ts`) and workflow.db (`src/workflows/db.ts`)
 * both evolve their schema through an identical, idempotent, transaction-per-
 * migration runner backed by a `schema_migrations` ledger. The two runners
 * were byte-identical except for ONE line: workflow.db must back-fill a
 * `schema_migrations` row for pre-versioning databases before evaluating the
 * migration list (see `bootstrapPreVersioningDb` in workflows/db.ts).
 *
 * This module factors that runner out once. Each DB module supplies only its
 * own `MIGRATIONS` array; workflow.db additionally passes a `bootstrap` hook.
 *
 * Migration-safety contract (enforced by convention in each module's array):
 *   - `id` is permanent and must never be reused.
 *   - `up` must be idempotent (use IF NOT EXISTS, INSERT OR IGNORE, etc.).
 *   - `up` must not DROP any table that holds durable (non-regenerable) data.
 *   - `up` must not RENAME or change the type of an existing column.
 *   - To add a column: use `ALTER TABLE … ADD COLUMN … DEFAULT …`.
 */

import type { Database } from "bun:sqlite";

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
}

/**
 * Create the migrations ledger table if it does not exist. Must be called
 * unconditionally on every open so a fresh database bootstraps correctly.
 */
export function ensureMigrationsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT    PRIMARY KEY,
      applied_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);
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
  ensureMigrationsTable(db);
  opts?.bootstrap?.(db);

  const appliedRows = db.prepare("SELECT id FROM schema_migrations").all() as Array<{ id: string }>;
  const applied = new Set(appliedRows.map((r) => r.id));

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;

    db.transaction(() => {
      db.exec(migration.up);
      db.prepare("INSERT INTO schema_migrations (id) VALUES (?)").run(migration.id);
    })();
  }
}
