// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runMigrations as runStateMigrations } from "../../src/core/state/migrations";
import { runMigrations as runWorkflowMigrations } from "../../src/workflows/db";
import { makeSandboxDir } from "../_helpers/sandbox";

function seedLedger(db: Database, ids: string[]): void {
  db.exec("CREATE TABLE schema_migrations(id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
  const insert = db.prepare("INSERT INTO schema_migrations(id) VALUES (?)");
  for (const id of ids) insert.run(id);
}

describe("engine cutover historical migrations", () => {
  test("state migration 017 preserves historical profile and leaves strategy null", () => {
    const sandbox = makeSandboxDir("akm-state-pre017");
    try {
      const db = new Database(`${sandbox.dir}/state.db`);
      db.exec("CREATE TABLE improve_runs(id TEXT PRIMARY KEY, profile TEXT, started_at TEXT)");
      db.exec("INSERT INTO improve_runs VALUES ('old', 'thorough', '2026-01-01T00:00:00Z')");
      // Migration 018 (Chunk 7, WI-7.3) ALTERs asset_outcome to drop
      // review_pressure — this pre-017 historical DB must carry the real
      // migration-010 shape (incl. review_pressure) so applying every pending
      // migration through 018 in one call succeeds, matching a genuine upgrade.
      db.exec(`
        CREATE TABLE asset_outcome (
          asset_ref                TEXT    PRIMARY KEY,
          last_retrieved_at        INTEGER NOT NULL DEFAULT 0,
          retrieval_count          INTEGER NOT NULL DEFAULT 0,
          expected_retrieval_rate  REAL    NOT NULL DEFAULT 0.0,
          negative_feedback_count  INTEGER NOT NULL DEFAULT 0,
          accepted_change_count    INTEGER NOT NULL DEFAULT 0,
          review_pressure          INTEGER NOT NULL DEFAULT 0,
          outcome_score            REAL    NOT NULL DEFAULT 0.0,
          updated_at               INTEGER NOT NULL DEFAULT 0
        )
      `);
      seedLedger(db, [
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
      ]);
      runStateMigrations(db as never);
      expect(db.query("SELECT profile, strategy FROM improve_runs").get()).toEqual({
        profile: "thorough",
        strategy: null,
      });
      db.close();
    } finally {
      sandbox.cleanup();
    }
  });

  test("workflow migration 010 preserves historical runner and leaves engine null", () => {
    const sandbox = makeSandboxDir("akm-workflow-pre010");
    try {
      const db = new Database(`${sandbox.dir}/workflow.db`);
      db.exec("CREATE TABLE workflow_runs(id TEXT PRIMARY KEY)");
      db.exec("CREATE TABLE workflow_run_units(run_id TEXT, unit_id TEXT, runner TEXT)");
      db.exec(
        "INSERT INTO workflow_runs VALUES ('run'); INSERT INTO workflow_run_units VALUES ('run','unit','inherit')",
      );
      seedLedger(db, [
        "001-add-scope-key",
        "002-add-agent-identity",
        "003-checkin-and-step-summary",
        "004-workflow-run-units",
        "005-unit-session-id",
        "006-frozen-plan-and-lease",
        "007-unit-last-checkin",
        "008-unit-attempts",
        "009-unit-claim",
      ]);
      runWorkflowMigrations(db as never);
      expect(db.query("SELECT runner, engine FROM workflow_run_units").get()).toEqual({
        runner: "inherit",
        engine: null,
      });
      expect(db.query("SELECT plan_ir_version FROM workflow_runs").get()).toEqual({ plan_ir_version: null });
      db.close();
    } finally {
      sandbox.cleanup();
    }
  });
});
