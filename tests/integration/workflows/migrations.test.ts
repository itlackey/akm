import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FROZEN_WORKFLOW_MIGRATIONS } from "../../../src/migrate/legacy/workflow-migrations-bodies";
import type { Database as AkmDatabase } from "../../../src/storage/database";
import { runMigrations as runSqliteMigrations } from "../../../src/storage/engines/sqlite-migrations";
import { openLegacyWorkflowDb } from "../../_helpers/legacy-workflow-db";

/**
 * Tests for the PRE-CUTOVER workflow.db migration chain (Chunk-8 WI-8.3).
 *
 * `src/workflows/db.ts` (`openWorkflowDatabase` / live `WORKFLOW_MIGRATIONS`) is
 * deleted; the migration BODIES survive frozen in
 * `src/migrate/legacy/workflow-migrations-bodies.ts` and are rolled through the
 * shared engine by `config-migrate.ts#runFrozenWorkflowRoll` at cutover time.
 * `openLegacyWorkflowDb` (test helper) drives that same base-schema + frozen
 * migration chain. Covers:
 *  - Fresh DB: schema_migrations table is created and every frozen migration is
 *    applied exactly once, materialising all columns.
 *  - Pre-versioning DB (scope_key column present, no schema_migrations): the
 *    old bootstrap back-fill is RETIRED (0.7-era DBs are out of the migrator
 *    FROM-state), so the roll now FAILS CLOSED instead of bootstrapping.
 *  - Idempotency: a second roll adds no schema_migrations row.
 *  - Transactional safety: a failing migration leaves schema_migrations
 *    unchanged.
 */

const SCOPE_KEY_MIGRATION_ID = "001-add-scope-key";
const AGENT_IDENTITY_MIGRATION_ID = "002-add-agent-identity";
const CHECKIN_SUMMARY_MIGRATION_ID = "003-checkin-and-step-summary";
const RUN_UNITS_MIGRATION_ID = "004-workflow-run-units";
const UNIT_SESSION_MIGRATION_ID = "005-unit-session-id";
const FROZEN_PLAN_MIGRATION_ID = "006-frozen-plan-and-lease";
const UNIT_CHECKIN_MIGRATION_ID = "007-unit-last-checkin";
const UNIT_ATTEMPTS_MIGRATION_ID = "008-unit-attempts";
const UNIT_CLAIM_MIGRATION_ID = "009-unit-claim";
const IR_V3_ENGINE_MIGRATION_ID = "010-ir-v3-engine";

/** Every migration in application order — keep in sync with db.ts MIGRATIONS. */
const ALL_MIGRATION_IDS = [
  SCOPE_KEY_MIGRATION_ID,
  AGENT_IDENTITY_MIGRATION_ID,
  CHECKIN_SUMMARY_MIGRATION_ID,
  RUN_UNITS_MIGRATION_ID,
  UNIT_SESSION_MIGRATION_ID,
  FROZEN_PLAN_MIGRATION_ID,
  UNIT_CHECKIN_MIGRATION_ID,
  UNIT_ATTEMPTS_MIGRATION_ID,
  UNIT_CLAIM_MIGRATION_ID,
  IR_V3_ENGINE_MIGRATION_ID,
];

let tmpDir = "";
let dbPath = "";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-workflow-migrations-"));
  dbPath = path.join(tmpDir, "workflow.db");
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function listAppliedMigrations(db: AkmDatabase): string[] {
  return (
    db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as Array<{
      id: string;
    }>
  ).map((r) => r.id);
}

function hasColumn(db: AkmDatabase, table: string, column: string): boolean {
  const rows = db.prepare<{ name: string }>(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}

describe("workflow.db migrations (frozen pre-cutover chain)", () => {
  test("fresh DB creates schema_migrations and applies scope-key migration exactly once", () => {
    const db = openLegacyWorkflowDb(dbPath);
    try {
      // schema_migrations table must exist
      const tableInfo = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
        .get() as { name: string } | undefined;
      expect(tableInfo?.name).toBe("schema_migrations");

      // scope_key column was created
      expect(hasColumn(db, "workflow_runs", "scope_key")).toBe(true);

      // agent identity columns were created (migration 002, #501)
      expect(hasColumn(db, "workflow_runs", "agent_harness")).toBe(true);
      expect(hasColumn(db, "workflow_runs", "agent_session_id")).toBe(true);

      // check-in + step summary columns were created (migration 003, #506)
      expect(hasColumn(db, "workflow_runs", "checkin_armed_at")).toBe(true);
      expect(hasColumn(db, "workflow_run_steps", "summary")).toBe(true);

      // harness-native unit session id column was created (migration 005, P2)
      expect(hasColumn(db, "workflow_run_units", "session_id")).toBe(true);

      // frozen plan + engine lease columns were created (migration 006, R1)
      expect(hasColumn(db, "workflow_runs", "plan_json")).toBe(true);
      expect(hasColumn(db, "workflow_runs", "plan_hash")).toBe(true);
      expect(hasColumn(db, "workflow_runs", "engine_lease_until")).toBe(true);
      expect(hasColumn(db, "workflow_runs", "engine_lease_holder")).toBe(true);

      // unit-level check-in heartbeat column was created (migration 007, R3)
      expect(hasColumn(db, "workflow_run_units", "last_checkin_at")).toBe(true);

      // per-unit dispatch-attempt counter was created (migration 008, PR #714)
      expect(hasColumn(db, "workflow_run_units", "attempts")).toBe(true);

      // per-unit claim ownership columns were created (migration 009, PR #714 r2)
      expect(hasColumn(db, "workflow_run_units", "claim_holder")).toBe(true);
      expect(hasColumn(db, "workflow_run_units", "claim_expires_at")).toBe(true);

      // All migrations recorded, in order
      const applied = listAppliedMigrations(db);
      expect(applied).toEqual(ALL_MIGRATION_IDS);
    } finally {
      db.close();
    }
  });

  test("pre-versioning DB (scope_key present, no ledger) is rejected — bootstrap retired", () => {
    // Simulate a workflow.db created by the 0.7-era pre-versioning code: the
    // legacy schema had no scope_key column initially and the ad-hoc check
    // appended it via ALTER TABLE. The resulting DB has the column but NO
    // schema_migrations table. WI-8.3 retired the bootstrap back-fill; such DBs
    // are out of the migrator FROM-state, so the frozen roll fails closed
    // (migration 001's ALTER ADD scope_key hits "duplicate column name" — the
    // clean operator message lives in config-migrate.ts#runFrozenWorkflowRoll's
    // pre-versioning guard).
    const legacy = new Database(dbPath);
    legacy.exec("PRAGMA journal_mode = WAL");
    legacy.exec("PRAGMA foreign_keys = ON");
    legacy.exec(`
      CREATE TABLE workflow_runs (
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
      CREATE TABLE workflow_run_steps (
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
      ALTER TABLE workflow_runs ADD COLUMN scope_key TEXT;
    `);
    // Insert a row that we will assert survives the migration.
    const now = new Date().toISOString();
    legacy
      .prepare(
        `INSERT INTO workflow_runs
         (id, workflow_ref, workflow_entry_id, workflow_title, status,
          params_json, current_step_id, created_at, updated_at, scope_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "legacy-run-1",
        "workflows/legacy",
        7,
        "Legacy Workflow",
        "active",
        "{}",
        null,
        now,
        now,
        "dir:v1:legacy-scope",
      );
    legacy.close();

    // The frozen roll re-applies the ALTER (no bootstrap back-fill), which fails
    // with "duplicate column name" — the fail-closed rejection.
    expect(() => openLegacyWorkflowDb(dbPath)).toThrow(/duplicate column|scope_key/i);
  });

  test("re-running migrations is idempotent — row count stays 1", () => {
    const db1 = openLegacyWorkflowDb(dbPath);
    db1.close();

    const db2 = openLegacyWorkflowDb(dbPath);
    try {
      const applied = listAppliedMigrations(db2);
      expect(applied).toEqual(ALL_MIGRATION_IDS);

      // Explicit re-run on the same connection is also a no-op.
      runSqliteMigrations(db2, FROZEN_WORKFLOW_MIGRATIONS);
      runSqliteMigrations(db2, FROZEN_WORKFLOW_MIGRATIONS);
      const afterReRun = listAppliedMigrations(db2);
      expect(afterReRun).toEqual(ALL_MIGRATION_IDS);
    } finally {
      db2.close();
    }
  });

  test("failed migration leaves schema_migrations unchanged (transaction rollback)", () => {
    // Open once so the scope-key migration is recorded.
    const db = openLegacyWorkflowDb(dbPath);
    try {
      const before = listAppliedMigrations(db);
      expect(before).toEqual(ALL_MIGRATION_IDS);

      // Manually simulate a faulty migration body running through the same
      // transaction pattern used by runMigrations(). The body fails on the
      // second statement, so neither the DDL effects nor the migration row
      // should persist.
      const apply = db.transaction(() => {
        db.exec(`CREATE TABLE faulty_test_table (x INTEGER);`);
        db.exec(`THIS IS NOT VALID SQL;`);
        db.prepare("INSERT INTO schema_migrations (id) VALUES (?)").run("999-bogus");
      });
      expect(() => apply()).toThrow();

      const after = listAppliedMigrations(db);
      expect(after).toEqual(ALL_MIGRATION_IDS);
      // The DDL inside the failed transaction must also have been rolled back.
      const stillExists = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='faulty_test_table'")
        .get();
      expect(stillExists ?? undefined).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
