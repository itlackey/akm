// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { getWorkflowDbPath } from "../core/paths";
import { type Database, openDatabase } from "../storage/database";
import { type Migration, runMigrations as runSqliteMigrations } from "../storage/engines/sqlite-migrations";
import { applyStandardPragmas } from "../storage/sqlite-pragmas";

/**
 * workflow.db — Durable SQLite database for workflow run state.
 *
 * Owns the `workflow_runs` and `workflow_run_steps` tables that track active /
 * completed workflow executions. Like `state.db` (and unlike `index.db`), the
 * rows here are NON-REGENERABLE — losing them is data loss. Schema must evolve
 * via incremental, additive migrations recorded in `schema_migrations`.
 *
 * ## Migration-safety contract
 *
 * The `schema_migrations` table records every applied migration by a stable
 * string ID. `runMigrations(db)` is idempotent: new installs run every
 * migration in order; upgrades run only the ones not yet applied. The
 * migration framework here intentionally mirrors `src/core/state-db.ts` so
 * future schema evolution follows a single proven pattern.
 *
 * Permitted schema evolution operations (always migration-safe in SQLite):
 *   - ALTER TABLE … ADD COLUMN <name> <type> DEFAULT <value>
 *   - CREATE INDEX IF NOT EXISTS …
 *   - CREATE TABLE IF NOT EXISTS … (additive new tables)
 *
 * ## Bootstrapping pre-versioning databases
 *
 * Workflow databases created before this file gained `schema_migrations`
 * already have the `workflow_runs.scope_key` column applied by the previous
 * ad-hoc `PRAGMA table_info` + `ALTER TABLE` code. To avoid re-running the
 * migration (which would no-op but still wastes work and clutters logs), the
 * runner detects this state and back-fills the `schema_migrations` row for
 * the scope-key migration before evaluating the migration list. See
 * `bootstrapPreVersioningDb()`.
 *
 * @module workflows/db
 */

// ── Public API ───────────────────────────────────────────────────────────────

export function openWorkflowDatabase(dbPath = getWorkflowDbPath()): Database {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = openDatabase(dbPath);
  // #589: 30 s busy timeout, matching index.db / state.db. Without it the
  // default is 0 ms, so any concurrent writer fails immediately with
  // SQLITE_BUSY. #628: journal_mode is configurable via AKM_SQLITE_JOURNAL_MODE.
  applyStandardPragmas(db, { dataDir: dir });
  ensureBaseSchema(db);
  runMigrations(db);
  return db;
}

export function closeWorkflowDatabase(db: Database): void {
  db.close();
}

// ── Base schema ──────────────────────────────────────────────────────────────

/**
 * Create the baseline `workflow_runs` and `workflow_run_steps` tables if they
 * do not exist. These statements are idempotent: existing databases keep their
 * current schema, and migrations evolve them further.
 *
 * NOTE: the `scope_key` column on `workflow_runs` is intentionally NOT declared
 * here. It is added by migration `001-add-scope-key`. Fresh databases will run
 * the migration immediately on first open; pre-versioning databases that
 * already have the column are bootstrapped — see {@link runMigrations}.
 */
function ensureBaseSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id                TEXT PRIMARY KEY,
      workflow_ref      TEXT NOT NULL,
      workflow_entry_id INTEGER,
      workflow_title    TEXT NOT NULL,
      status            TEXT NOT NULL CHECK (status IN ('active', 'completed', 'blocked', 'failed')),
      params_json       TEXT NOT NULL DEFAULT '{}',
      current_step_id   TEXT,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL,
      completed_at      TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_workflow_runs_ref ON workflow_runs(workflow_ref);
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);

    CREATE TABLE IF NOT EXISTS workflow_run_steps (
      run_id          TEXT NOT NULL,
      step_id         TEXT NOT NULL,
      step_title      TEXT NOT NULL,
      instructions    TEXT NOT NULL,
      completion_json TEXT,
      sequence_index  INTEGER NOT NULL,
      status          TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'blocked', 'failed', 'skipped')),
      notes           TEXT,
      evidence_json   TEXT,
      completed_at    TEXT,
      PRIMARY KEY (run_id, step_id),
      FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_workflow_run_steps_run_sequence
      ON workflow_run_steps(run_id, sequence_index);
  `);
}

// ── Migration engine ─────────────────────────────────────────────────────────
//
// The runner itself (ensureMigrationsTable + runMigrations) lives in the shared
// engine at src/storage/engines/sqlite-migrations.ts. This module owns its own
// MIGRATIONS array plus the pre-versioning `bootstrap` hook, and delegates
// application to that shared runner. The {@link Migration} interface is imported
// from there.

/**
 * All workflow.db migrations in application order. New migrations are
 * APPENDED — never inserted in the middle or reordered.
 */
const MIGRATIONS: Migration[] = [
  // ── Migration 001 — add scope_key column ────────────────────────────────────
  //
  // Adds the `scope_key` column to `workflow_runs` so runs can be partitioned
  // per stash/scope. Pre-versioning databases that already have this column
  // are bootstrapped before this migration runs — see runMigrations().
  {
    id: "001-add-scope-key",
    up: `
      ALTER TABLE workflow_runs ADD COLUMN scope_key TEXT;

      CREATE INDEX IF NOT EXISTS idx_workflow_runs_scope_ref_status
        ON workflow_runs(scope_key, workflow_ref, status);
    `,
  },
  // ── Migration 002 — record agent harness + session identity ──────────────────
  //
  // Persists the agent harness identifier (e.g. "claude-code", "opencode") and
  // the platform-native session id that owns each workflow run. This is the
  // first concrete slice of #501 / #506: capturing *who* is driving a run so a
  // future (separately-approved) monitor can correlate workflow runs with
  // session activity. Both columns are nullable — runs started outside an agent
  // harness, and all pre-existing runs, simply have NULL identity.
  {
    id: "002-add-agent-identity",
    up: `
      ALTER TABLE workflow_runs ADD COLUMN agent_harness TEXT;
      ALTER TABLE workflow_runs ADD COLUMN agent_session_id TEXT;

      CREATE INDEX IF NOT EXISTS idx_workflow_runs_agent_session
        ON workflow_runs(agent_harness, agent_session_id);
    `,
  },
  // ── Migration 003 — check-in arming + per-step summary (#506) ────────────────
  //
  // Builds on the agent identity recorded by migration 002. Arms a file-signal
  // check-in (a timestamp, NOT a background thread — see
  // docs/technical/workflow-agent-checkin-adr.md) so a stalled run can be
  // re-targeted with a `continue` directive, and adds a per-step `summary`
  // column so step/workflow completion can capture and validate a required
  // summary of work done. Both columns are nullable.
  {
    id: "003-checkin-and-step-summary",
    up: `
      ALTER TABLE workflow_runs ADD COLUMN checkin_armed_at TEXT;
      ALTER TABLE workflow_run_steps ADD COLUMN summary TEXT;
    `,
  },
];

/**
 * Stable id of the scope_key migration. Exported for bootstrap detection and
 * tests.
 */
const SCOPE_KEY_MIGRATION_ID = "001-add-scope-key";

/**
 * Detect whether a column exists on a given table.
 */
function hasColumn(db: Database, table: string, column: string): boolean {
  const rows = db.prepare<{ name: string }>(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}

/**
 * Back-fill `schema_migrations` rows for any schema state that existed before
 * this file gained migration tracking.
 *
 * The pre-versioning code added the `scope_key` column on `workflow_runs` via
 * an ad-hoc PRAGMA / ALTER TABLE pair. Those databases must not re-run the
 * scope_key migration (the ALTER would fail with "duplicate column name"
 * since the migration body does not use IF NOT EXISTS — SQLite does not
 * support that clause on ALTER TABLE ADD COLUMN). Instead, we mark the
 * migration as already applied.
 *
 * This function is a no-op on fresh databases: the `scope_key` column does
 * not exist, so the migration runs normally and records itself.
 */
function bootstrapPreVersioningDb(db: Database): void {
  const alreadyRecorded = db.prepare("SELECT 1 FROM schema_migrations WHERE id = ?").get(SCOPE_KEY_MIGRATION_ID);
  if (alreadyRecorded) return;

  if (hasColumn(db, "workflow_runs", "scope_key")) {
    db.prepare("INSERT INTO schema_migrations (id) VALUES (?)").run(SCOPE_KEY_MIGRATION_ID);
  }
}

/**
 * Apply every pending migration in a single transaction per migration.
 *
 * Delegates to the shared SQLite migration engine, passing the
 * `bootstrapPreVersioningDb` hook so databases created before this file gained
 * migration tracking back-fill their scope_key row instead of re-running the
 * ALTER.
 *
 * Called automatically by {@link openWorkflowDatabase}.
 */
export function runMigrations(db: Database): void {
  runSqliteMigrations(db, MIGRATIONS, { bootstrap: bootstrapPreVersioningDb });
}
