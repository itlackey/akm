// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared SQLite migration engine.
 *
 * SQLite schemas evolve through this runner backed by a `schema_migrations`
 * ledger. Each caller supplies only its own `MIGRATIONS` array (state.db:
 * `src/core/state/migrations.ts`; logs.db: `src/core/logs-db.ts`).
 *
 * Ledger contract:
 *   - `id` is permanent and must never be reused.
 *   - Applied IDs must be an exact ordered prefix of the registry. A ledger
 *     that runs PAST the registry (migrated by a newer akm) is fine: nothing is
 *     pending. A ledger that DIVERGES from it is refused
 *     ({@link assertMigrationLedger}).
 *   - Every pending migration and its ledger row commit in ONE `BEGIN IMMEDIATE`
 *     transaction ({@link runMigrations}), so a failure part-way leaves the
 *     database exactly as it was.
 */

import type { Database } from "../database";
import { withImmediateTransaction } from "../sqlite-transaction";

/** A single, append-only schema migration. */
export interface Migration {
  id: string;
  up: string;
}

export type MigrationLedgerStatus = "old" | "current" | "newer" | "inconsistent";

export interface MigrationLedgerState {
  status: MigrationLedgerStatus;
  migrationIds: string[];
  detail?: string;
}

export function assertMigrationRegistry(migrations: readonly Migration[]): void {
  const seen = new Set<string>();
  for (const migration of migrations) {
    if (seen.has(migration.id)) throw new Error(`Migration registry contains duplicate ID ${migration.id}.`);
    seen.add(migration.id);
  }
}

export function migrationLedgerExists(db: Database): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
}

/** Inspect the database's applied IDs against the exact ordered registry prefix. */
function inspectLedgerAgainst(db: Database, registryIds: readonly string[]): MigrationLedgerState {
  if (!migrationLedgerExists(db)) return { status: registryIds.length === 0 ? "current" : "old", migrationIds: [] };

  const rows = db.prepare("SELECT id FROM schema_migrations ORDER BY rowid").all() as Array<{ id: string }>;
  const migrationIds = rows.map((row) => row.id);

  for (const [index, row] of rows.entries()) {
    const expectedId = registryIds[index];
    // Every id this binary knows matched in order and the ledger carries more:
    // the database was migrated by a newer akm. Nothing here is applicable —
    // this binary's whole registry is already applied — so this is version
    // skew, not divergence.
    if (!expectedId) {
      return {
        status: "newer",
        migrationIds,
        detail: `applied migration ID${rows.length - registryIds.length === 1 ? "" : "s"} ${migrationIds
          .slice(registryIds.length)
          .join(", ")} unknown to this akm`,
      };
    }
    // A mismatch at a position this binary has a migration for is divergence,
    // whether or not the id is one this binary knows later: this binary's
    // migration at `index` was never applied, and something else was.
    if (row.id !== expectedId) {
      return {
        status: "inconsistent",
        migrationIds,
        detail:
          `migration ledger is not an exact ordered prefix at position ${index + 1} (found '${row.id}', expected '${expectedId}'). ` +
          `Applied, in order: [${migrationIds.join(", ")}]. This akm's expected order: [${registryIds.join(", ")}].`,
      };
    }
  }

  return {
    status: rows.length === registryIds.length ? "current" : "old",
    migrationIds,
  };
}

export function inspectMigrationLedger(db: Database, migrations: readonly Migration[]): MigrationLedgerState {
  assertMigrationRegistry(migrations);
  return inspectLedgerAgainst(
    db,
    migrations.map((migration) => migration.id),
  );
}

/**
 * Reject only a ledger this binary cannot reason about at all.
 *
 * A `newer` ledger — an exact ordered prefix of this binary's registry plus
 * migrations a later akm added — is NOT rejected. Two akm versions sharing one
 * data directory is a supported deployment (a bundled CLI alongside a newer
 * global install), and refusing the open bricked the older one for every
 * command while protecting nothing: its entire registry is already applied, so
 * it has no pending migration to run. Callers that want to tell an operator
 * about the skew read {@link MigrationLedgerState.status}.
 *
 * An `inconsistent` ledger is different: this binary has a migration that was
 * never applied and something else was applied in its place, so running the
 * pending set could conflict with schema it cannot see. That still refuses.
 */
export function assertMigrationLedger(db: Database, migrations: readonly Migration[]): MigrationLedgerState {
  const state = inspectMigrationLedger(db, migrations);
  if (state.status === "inconsistent") {
    throw new Error(
      `Refusing a database whose migrations are not an exact ordered prefix: ${state.detail} ` +
        "Applying this binary's missing migration now could run it against a schema a later migration already " +
        "changed underneath it, which is a real risk of producing a wrong schema — not something akm can guess " +
        "its way out of safely. This usually means the database was migrated by an incompatible akm build or " +
        "fork, or schema_migrations was edited by hand. Restore this file from a backup taken before the " +
        "divergence, or — if there is no backup and the data is not needed — delete it and let akm rebuild it " +
        "from scratch (a derived index.db regenerates from your sources on the next 'akm index'; state.db loses " +
        "durable history such as improve/proposal state and must be treated as a last resort).",
    );
  }
  return state;
}

/** Create the migrations ledger table if it does not exist. */
export function ensureMigrationsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT    PRIMARY KEY,
      applied_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

/** The registry entries not yet recorded in the ledger, in order. Throws on a divergent ledger. */
export function pendingMigrations(db: Database, migrations: readonly Migration[]): readonly Migration[] {
  return migrations.slice(assertMigrationLedger(db, migrations).migrationIds.length);
}

/**
 * Apply every pending migration in one `BEGIN IMMEDIATE` transaction.
 *
 * A database with nothing pending is only read, never write-locked. Otherwise
 * the write lock is taken up front — a second process bootstrapping the same
 * database WAITS for the first to commit instead of racing it — and the
 * pending set is re-read under that lock, so the process that lost the race
 * finds nothing left to do rather than re-running DDL. Each migration's ledger
 * row is inserted right after its SQL inside the same transaction: a failing
 * migration rolls back every migration this call applied, and their ledger
 * rows with them. Contention that outlasts every BEGIN retry surfaces as
 * `TransientError("STATE_DB_CONTENDED")` (`../sqlite-transaction`). Returns the
 * IDs this call applied, in order — empty when another process got there first.
 */
export function runMigrations(db: Database, migrations: readonly Migration[]): string[] {
  if (pendingMigrations(db, migrations).length === 0) return [];
  return withImmediateTransaction(db, () => {
    ensureMigrationsTable(db);
    const applied: string[] = [];
    for (const migration of pendingMigrations(db, migrations)) {
      db.exec(migration.up);
      db.prepare("INSERT INTO schema_migrations (id) VALUES (?)").run(migration.id);
      applied.push(migration.id);
    }
    return applied;
  });
}
