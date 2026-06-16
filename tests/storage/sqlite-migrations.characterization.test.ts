// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStateDatabase, runMigrations as runStateMigrations } from "../../src/core/state-db";
import type { Database as AkmDatabase } from "../../src/storage/database";
import { openWorkflowDatabase, runMigrations as runWorkflowMigrations } from "../../src/workflows/db";

/**
 * Characterization test for the two SQLite migration runners (state.db and
 * workflow.db). Written BEFORE the WS3a shared-runner extraction so the
 * observable contract is locked: applying each module's MIGRATIONS array to a
 * fresh DB must produce a byte-identical set of `schema_migrations` rows AND a
 * byte-identical final schema (the DDL in sqlite_master).
 *
 * This holds the runners' behaviour invariant through the extract-and-delegate
 * refactor — the shared runner with an optional bootstrap hook must reproduce
 * these exact snapshots.
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
      ]);

      // The set of durable objects the migrations create.
      const names = snap.schema.map((o) => `${o.type}:${o.name}`);
      expect(names).toContain("table:events");
      expect(names).toContain("table:proposals");
      expect(names).toContain("table:task_history");
      expect(names).toContain("table:schema_migrations");
      expect(names).toContain("table:consolidation_judged");
      expect(names).toContain("table:body_embeddings");

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
    const db = openWorkflowDatabase(path.join(tmpDir, "workflow.db"));
    try {
      const snap = snapshotSchema(db);

      // Every workflow migration applied, in order.
      expect(snap.migrations).toEqual(["001-add-scope-key", "002-add-agent-identity", "003-checkin-and-step-summary"]);

      const names = snap.schema.map((o) => `${o.type}:${o.name}`);
      expect(names).toContain("table:workflow_runs");
      expect(names).toContain("table:workflow_run_steps");
      expect(names).toContain("table:schema_migrations");

      expect(snap).toMatchSnapshot();
    } finally {
      db.close();
    }
  });

  test("workflow.db: runMigrations is idempotent (second run is a no-op)", () => {
    const dbPath = path.join(tmpDir, "workflow.db");
    const db = openWorkflowDatabase(dbPath);
    try {
      const first = snapshotSchema(db);
      runWorkflowMigrations(db);
      const second = snapshotSchema(db);
      expect(second).toEqual(first);
    } finally {
      db.close();
    }
  });

  test("workflow.db: pre-versioning DB (scope_key already present) is bootstrapped, not re-applied", () => {
    // Simulate a database created before schema_migrations existed: the base
    // tables plus the scope_key column added ad-hoc, but NO schema_migrations
    // ledger. The bootstrap hook must back-fill the 001 row instead of
    // re-running the ALTER (which would fail with "duplicate column name").
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

    // Opening must not throw, and must record 001 as applied via bootstrap.
    const db = openWorkflowDatabase(dbPath);
    try {
      const snap = snapshotSchema(db);
      expect(snap.migrations).toEqual(["001-add-scope-key", "002-add-agent-identity", "003-checkin-and-step-summary"]);
      // The scope_key column must exist exactly once (bootstrap did not re-ALTER).
      const cols = db.prepare<{ name: string }>("PRAGMA table_info(workflow_runs)").all();
      expect(cols.filter((c) => c.name === "scope_key").length).toBe(1);
    } finally {
      db.close();
    }
  });
});
