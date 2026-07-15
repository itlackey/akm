// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getMigrationApplyJournalPath, inspectMigrationState } from "../../src/core/migration-backup";
import { getConfigPath, getStateDbPathInDataDir, getWorkflowDbPath } from "../../src/core/paths";
import { openStateDatabase } from "../../src/core/state-db";
import { runCliCapture } from "../_helpers/cli";
import {
  type Cleanup,
  sandboxHome,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
} from "../_helpers/sandbox";

const STATE_IDS = [
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
] as const;

const WORKFLOW_IDS = [
  "001-add-scope-key",
  "002-add-agent-identity",
  "003-checkin-and-step-summary",
  "004-workflow-run-units",
  "005-unit-session-id",
  "006-frozen-plan-and-lease",
  "007-unit-last-checkin",
  "008-unit-attempts",
  "009-unit-claim",
] as const;

// The physical schema migration 010 installs. Synthetic fixtures below mark
// 010-asset-outcome as applied, so they must materialize the table it creates —
// otherwise migration 018's `ALTER TABLE asset_outcome DROP COLUMN review_pressure`
// (the first-ever DROP COLUMN migration) fails with "no such table".
const ASSET_OUTCOME_010_DDL = `
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
  );
  CREATE INDEX idx_asset_outcome_review_pressure ON asset_outcome(review_pressure DESC);
  CREATE INDEX idx_asset_outcome_score ON asset_outcome(outcome_score DESC);
`;

let cleanup: Cleanup | undefined;

beforeEach(() => {
  const home = sandboxHome();
  const config = sandboxXdgConfigHome(home.cleanup);
  const cache = sandboxXdgCacheHome(config.cleanup);
  cleanup = sandboxXdgDataHome(cache.cleanup).cleanup;
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function ledger(db: Database, ids: readonly string[]): void {
  db.exec("CREATE TABLE schema_migrations(id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
  const insert = db.prepare("INSERT INTO schema_migrations(id) VALUES (?)");
  for (const id of ids) insert.run(id);
}

function seed(options?: { failingWorkflow?: boolean }): string {
  fs.writeFileSync(getConfigPath(), '{"configVersion":"0.8.0"}\n', { mode: 0o600 });
  fs.mkdirSync(path.dirname(getStateDbPathInDataDir()), { recursive: true });
  const state = new Database(getStateDbPathInDataDir());
  state.exec(`
    CREATE TABLE improve_runs(id TEXT PRIMARY KEY, profile TEXT, started_at TEXT);
    ${ASSET_OUTCOME_010_DDL}
  `);
  ledger(state, STATE_IDS);
  state.close();
  const workflow = new Database(getWorkflowDbPath());
  workflow.exec(
    options?.failingWorkflow
      ? "CREATE TABLE workflow_runs(id TEXT PRIMARY KEY);"
      : `
        CREATE TABLE workflow_runs(id TEXT PRIMARY KEY);
        CREATE TABLE workflow_run_units(run_id TEXT, unit_id TEXT);
      `,
  );
  ledger(workflow, WORKFLOW_IDS);
  workflow.close();
  const prepared = path.join(path.dirname(getConfigPath()), "prepared-0.9.json");
  fs.writeFileSync(prepared, '{"configVersion":"0.9.0","semanticSearchMode":"off"}\n');
  return prepared;
}

describe("cross-artifact migration apply crash recovery", () => {
  for (const phase of ["state", "workflow", "config"] as const) {
    test(`resumes after SIGKILL between ${phase} and the next apply step`, async () => {
      const prepared = seed();
      const child = Bun.spawn(["bun", "src/cli.ts", "migrate", "apply", "--config", prepared], {
        cwd: path.resolve(import.meta.dir, "../.."),
        env: { ...process.env, AKM_TEST_MIGRATION_CRASH_AFTER: phase },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exitCode).not.toBe(0);
      expect(fs.existsSync(getMigrationApplyJournalPath())).toBe(true);
      expect(JSON.parse(fs.readFileSync(getMigrationApplyJournalPath(), "utf8")).phase).toBe(`${phase}-applied`);
      expect(() => openStateDatabase()).toThrow(/recovery is pending/i);

      const status = await runCliCapture(["migrate", "status"]);
      expect(status.code, status.stderr).toBe(0);
      expect(status.stdout).toContain(`"phase":"${phase}-applied"`);
      expect(fs.existsSync(getMigrationApplyJournalPath())).toBe(true);

      const resumed = await runCliCapture(["migrate", "apply"]);
      expect(resumed.code, resumed.stderr).toBe(0);
      expect(inspectMigrationState()).toMatchObject({
        config: { status: "current" },
        state: { status: "current" },
        workflow: { status: "current" },
      });
      expect(fs.existsSync(getMigrationApplyJournalPath())).toBe(false);
    }, 20_000);
  }

  for (const phase of ["state", "workflow", "config"] as const) {
    test(`recovers a SIGKILL after durable ${phase} mutation but before phase advancement`, async () => {
      const prepared = seed();
      const child = Bun.spawn(["bun", "src/cli.ts", "migrate", "apply", "--config", prepared], {
        cwd: path.resolve(import.meta.dir, "../.."),
        env: { ...process.env, AKM_TEST_MIGRATION_CRASH_GAP: phase },
        stdout: "pipe",
        stderr: "pipe",
      });
      await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      const previousPhase =
        phase === "state" ? "prepared" : phase === "workflow" ? "state-applied" : "workflow-applied";
      expect(JSON.parse(fs.readFileSync(getMigrationApplyJournalPath(), "utf8")).phase).toBe(previousPhase);

      const resumed = await runCliCapture(["migrate", "apply"]);
      expect(resumed.code, resumed.stderr).toBe(0);
      expect(inspectMigrationState()).toMatchObject({
        config: { status: "current" },
        state: { status: "current" },
        workflow: { status: "current" },
      });
      expect(fs.existsSync(getMigrationApplyJournalPath())).toBe(false);
    }, 20_000);
  }

  test("cleans an apply journal after rollback restore committed before apply cleanup", async () => {
    const prepared = seed({ failingWorkflow: true });
    const child = Bun.spawn(["bun", "src/cli.ts", "migrate", "apply", "--config", prepared], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: { ...process.env, AKM_TEST_MIGRATION_CRASH_GAP: "rollback" },
      stdout: "pipe",
      stderr: "pipe",
    });
    await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(JSON.parse(fs.readFileSync(getMigrationApplyJournalPath(), "utf8")).phase).toBe("rollback-prepared");
    expect(inspectMigrationState()).toMatchObject({
      config: { status: "old" },
      state: { status: "old" },
      workflow: { status: "old" },
    });
    const stateBefore = fs.readFileSync(getStateDbPathInDataDir());

    const recovered = await runCliCapture(["migrate", "apply"]);
    expect(recovered.code).not.toBe(0);
    expect(recovered.stderr).toMatch(/rollback was already committed|cleaned its apply journal/i);
    expect(fs.existsSync(getMigrationApplyJournalPath())).toBe(false);
    expect(fs.readFileSync(getStateDbPathInDataDir())).toEqual(stateBefore);
  }, 20_000);

  test("fails closed when state.db is substituted by a same-ledger generation before resume", async () => {
    const prepared = seed();
    const child = Bun.spawn(["bun", "src/cli.ts", "migrate", "apply", "--config", prepared], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: { ...process.env, AKM_TEST_MIGRATION_CRASH_AFTER: "state" },
      stdout: "pipe",
      stderr: "pipe",
    });
    await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(fs.existsSync(getMigrationApplyJournalPath())).toBe(true);

    const substituted = new Database(getStateDbPathInDataDir());
    substituted.exec(
      "CREATE TABLE substituted_same_ledger(payload TEXT); INSERT INTO substituted_same_ledger VALUES ('evil')",
    );
    substituted.close();
    const before = fs.readFileSync(getStateDbPathInDataDir());

    const resumed = await runCliCapture(["migrate", "apply"]);
    expect(resumed.code).not.toBe(0);
    expect(resumed.stderr).toMatch(/exact live artifact generation|generation/i);
    expect(fs.readFileSync(getStateDbPathInDataDir())).toEqual(before);
    expect(fs.existsSync(getMigrationApplyJournalPath())).toBe(true);
  });
});
