// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations as runStateMigrations } from "../../src/core/state/migrations";
import { openStateDatabase } from "../../src/core/state-db";
import { FROZEN_WORKFLOW_MIGRATIONS } from "../../src/migrate/legacy/workflow-migrations-bodies";
import type { Database as AkmDatabase } from "../../src/storage/database";
import { migrationChecksum, runMigrations as runSqliteMigrations } from "../../src/storage/engines/sqlite-migrations";
import { openLegacyWorkflowDb } from "../_helpers/legacy-workflow-db";

/**
 * Characterization test for the two SQLite migration runners (state.db and the
 * pre-cutover workflow.db chain).
 *
 * WI-8.3: `src/workflows/db.ts` is deleted; the workflow-runner half now targets
 * the FROZEN migration bodies (`src/migrate/legacy/workflow-migrations-bodies.ts`)
 * driven through the shared engine (`openLegacyWorkflowDb` = base schema +
 * `runSqliteMigrations(FROZEN_WORKFLOW_MIGRATIONS)`) — the exact path
 * `config-migrate.ts#runFrozenWorkflowRoll` uses at cutover time. Because the
 * frozen bodies + base DDL are byte-identical to the deleted live ones, the
 * produced schema/ledger snapshots are unchanged (the old-behaviour invariant is
 * still locked, now against the frozen source).
 *
 * Applying each source's migrations to a fresh DB must produce a byte-identical
 * set of `schema_migrations` rows AND a byte-identical final schema.
 */

/**
 * Snapshot of a database's durable schema + applied-migration ledger.
 *
 * - `migrations`: the ordered list of migration ids recorded in
 *   `schema_migrations` (applied_at is volatile and therefore excluded).
 * - `schema`: every CREATE statement in sqlite_master, ordered deterministically
 *   by (type, name). Auto-generated internal objects (sqlite_*) are excluded.
 */
function snapshotSchema(db: AkmDatabase): {
  migrations: string[];
  schema: Array<{ type: string; name: string; sql: string | null }>;
} {
  const migrations = (db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as Array<{ id: string }>).map(
    (r) => r.id,
  );

  const schema = (
    db
      .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
      .all() as Array<{ type: string; name: string; sql: string | null }>
  ).map((r) => ({ type: r.type, name: r.name, sql: r.sql }));

  return { migrations, schema };
}

describe("SQLite migration runner characterization", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-sqlite-migrations-char-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("state.db: fresh-DB migration replay produces a stable schema + ledger", () => {
    const db = openStateDatabase(path.join(tmpDir, "state.db"));
    try {
      const snap = snapshotSchema(db);

      // The full ledger of applied migrations, in order.
      expect(snap.migrations).toEqual([
        "001-initial-schema",
        "002-task-history-per-run",
        "003-improve-runs",
        "004-extract-sessions-seen",
        "005-proposal-fs-imports",
        "006-proposals-pending-ref-source",
        "007-consolidation-judged",
        "008-body-embeddings",
        "009-asset-salience",
        "010-asset-outcome",
        "011-asset-salience-homeostatic-demoted-at",
        "012-improve-gate-thresholds",
        "013-extract-sessions-content-hash",
        "014-recombine-hypotheses",
        "015-asset-salience-encoding-source",
        "016-collapse-churn-detector",
        "017-improve-run-strategy",
        "018-drop-dead-lane-schema",
        "019-proposal-fingerprints",
        // Chunk 8, WI-8.2: the three-DB cutover baseline DDL (pure additive
        // CREATE TABLE IF NOT EXISTS — the merge-target tables at final shape).
        "020-three-db-cutover",
      ]);

      // The set of durable objects the migrations create.
      const names = snap.schema.map((o) => `${o.type}:${o.name}`);
      expect(names).toContain("table:events");
      expect(names).toContain("table:proposals");
      expect(names).toContain("table:task_history");
      expect(names).toContain("table:schema_migrations");
      expect(names).toContain("table:body_embeddings");
      // consolidation_judged (migration 007) and recombine_hypotheses (migration
      // 014) are created and then DROPPED by migration 018 (Chunk 7, WI-7.3) —
      // the ledger records both migration ids (append-only), but neither table
      // survives to the final schema.
      expect(names).not.toContain("table:consolidation_judged");
      expect(names).not.toContain("table:recombine_hypotheses");
      // Migration 020 (three-DB cutover) folds the workflow.db tables + the
      // index.db usage_events / legacy_state homes into state.db at final shape.
      expect(names).toContain("table:workflow_runs");
      expect(names).toContain("table:workflow_run_steps");
      expect(names).toContain("table:workflow_run_units");
      expect(names).toContain("table:usage_events");
      expect(names).toContain("table:legacy_state");

      // Lock the exact DDL snapshot so any drift in the produced schema fails.
      expect(snap).toMatchSnapshot();
    } finally {
      db.close();
    }
  });

  test("state.db: runMigrations is idempotent (second run is a no-op)", () => {
    const dbPath = path.join(tmpDir, "state.db");
    const db = openStateDatabase(dbPath);
    try {
      const first = snapshotSchema(db);
      runStateMigrations(db);
      const second = snapshotSchema(db);
      expect(second).toEqual(first);
    } finally {
      db.close();
    }
  });

  test("workflow.db: fresh-DB migration replay produces a stable schema + ledger", () => {
    const db = openLegacyWorkflowDb(path.join(tmpDir, "workflow.db"));
    try {
      const snap = snapshotSchema(db);

      // Every workflow migration applied, in order.
      expect(snap.migrations).toEqual([
        "001-add-scope-key",
        "002-add-agent-identity",
        "003-checkin-and-step-summary",
        "004-workflow-run-units",
        "005-unit-session-id",
        "006-frozen-plan-and-lease",
        "007-unit-last-checkin",
        "008-unit-attempts",
        "009-unit-claim",
        "010-ir-v3-engine",
      ]);

      const names = snap.schema.map((o) => `${o.type}:${o.name}`);
      expect(names).toContain("table:workflow_runs");
      expect(names).toContain("table:workflow_run_steps");
      expect(names).toContain("table:workflow_run_units");
      expect(names).toContain("table:schema_migrations");

      expect(snap).toMatchSnapshot();
    } finally {
      db.close();
    }
  });

  test("workflow.db: runMigrations is idempotent (second run is a no-op)", () => {
    const dbPath = path.join(tmpDir, "workflow.db");
    const db = openLegacyWorkflowDb(dbPath);
    try {
      const first = snapshotSchema(db);
      runSqliteMigrations(db, FROZEN_WORKFLOW_MIGRATIONS);
      const second = snapshotSchema(db);
      expect(second).toEqual(first);
    } finally {
      db.close();
    }
  });

  test("workflow.db: pre-versioning DB (scope_key already present) is rejected — bootstrap retired", () => {
    // Simulate a database created before schema_migrations existed: the base
    // tables plus the scope_key column added ad-hoc, but NO schema_migrations
    // ledger. WI-8.3 retired the bootstrap back-fill (0.7-era DBs are out of the
    // migrator FROM-state), so the frozen roll re-runs migration 001's ALTER and
    // fails closed with "duplicate column name".
    const dbPath = path.join(tmpDir, "workflow-preversioning.db");
    const seed = new Database(dbPath);
    seed.exec(`
      CREATE TABLE workflow_runs (
        id                TEXT PRIMARY KEY,
        workflow_ref      TEXT NOT NULL,
        workflow_entry_id INTEGER,
        workflow_title    TEXT NOT NULL,
        status            TEXT NOT NULL,
        params_json       TEXT NOT NULL DEFAULT '{}',
        current_step_id   TEXT,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL,
        completed_at      TEXT,
        scope_key         TEXT
      );
    `);
    seed.close();

    expect(() => openLegacyWorkflowDb(dbPath)).toThrow(/duplicate column|scope_key/i);
  });

  test("rejects an unknown future migration before applying local migrations", () => {
    const db = new Database(path.join(tmpDir, "future.db"));
    try {
      db.exec(`
        CREATE TABLE schema_migrations(id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
        INSERT INTO schema_migrations(id) VALUES ('001-known'), ('999-future');
      `);
      expect(() =>
        runSqliteMigrations(db as never, [{ id: "001-known", up: "CREATE TABLE known(value TEXT)" }]),
      ).toThrow(/newer|unknown|prefix/i);
      expect(db.query("SELECT name FROM sqlite_master WHERE name='known'").get()).toBeNull();
    } finally {
      db.close();
    }
  });

  test("rejects holey and out-of-order ledgers", () => {
    const migrations = [
      { id: "001-one", up: "CREATE TABLE one(value TEXT)" },
      { id: "002-two", up: "CREATE TABLE two(value TEXT)" },
      { id: "003-three", up: "CREATE TABLE three(value TEXT)" },
    ];
    for (const ids of [
      ["001-one", "003-three"],
      ["002-two", "001-one"],
    ]) {
      const db = new Database(path.join(tmpDir, `${ids.join("-")}.db`));
      try {
        db.exec(
          "CREATE TABLE schema_migrations(id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now'))) ",
        );
        const insert = db.prepare("INSERT INTO schema_migrations(id) VALUES (?)");
        for (const id of ids) insert.run(id);
        expect(() => runSqliteMigrations(db as never, migrations)).toThrow(/ordered prefix/i);
      } finally {
        db.close();
      }
    }
  });

  test("seals legacy ledger rows with checksums and rejects changed released SQL", () => {
    const db = new Database(path.join(tmpDir, "checksum.db"));
    const released = { id: "001-released", up: "CREATE TABLE released(value TEXT)" };
    try {
      db.exec(`
        CREATE TABLE released(value TEXT);
        CREATE TABLE schema_migrations(id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
        INSERT INTO schema_migrations(id) VALUES ('001-released');
      `);
      runSqliteMigrations(db as never, [released]);
      expect(
        (db.query("SELECT checksum FROM schema_migrations WHERE id='001-released'").get() as { checksum: string })
          .checksum,
      ).toBe(migrationChecksum(released));
      expect(() =>
        runSqliteMigrations(db as never, [{ ...released, up: "CREATE TABLE released(value INTEGER)" }]),
      ).toThrow(/checksum/i);
    } finally {
      db.close();
    }
  });
});
