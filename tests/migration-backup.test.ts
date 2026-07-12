// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  acquireMaintenanceActivity,
  acquireMaintenanceBarrier,
  withMaintenanceStartBarrier,
} from "../src/core/maintenance-barrier";
import {
  createMigrationBackup,
  getMigrationBackupDir,
  restoreMigrationBackup,
  verifyMigrationBackup,
} from "../src/core/migration-backup";
import {
  getConfigPath,
  getDataDir,
  getLockfileLockPath,
  getStateDbPathInDataDir,
  getWorkflowDbPath,
} from "../src/core/paths";
import { openStateDatabase } from "../src/core/state-db";
import { acquireIndexWriterLease } from "../src/indexer/index-writer-lock";
import { openWorkflowDatabase } from "../src/workflows/db";
import { type Cleanup, sandboxXdgCacheHome, sandboxXdgConfigHome, sandboxXdgDataHome } from "./_helpers/sandbox";

let cleanup: Cleanup | undefined;

beforeEach(() => {
  const config = sandboxXdgConfigHome();
  const cache = sandboxXdgCacheHome(config.cleanup);
  cleanup = sandboxXdgDataHome(cache.cleanup).cleanup;
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function seedLegacyConfig(): string {
  const value = `${JSON.stringify({ configVersion: "0.8.0", profiles: { llm: { old: {} } } }, null, 2)}\n`;
  fs.writeFileSync(getConfigPath(), value, { mode: 0o600 });
  return value;
}

function hasColumn(db: Database, table: string, column: string): boolean {
  return db
    .prepare<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => row.name === column);
}

describe("0.9 migration backup", () => {
  test("captures live WAL databases, verifies checksums/modes, and restores exact presence", () => {
    const configBefore = seedLegacyConfig();
    fs.mkdirSync(path.dirname(getStateDbPathInDataDir()), { recursive: true });
    const state = new Database(getStateDbPathInDataDir());
    state.exec("PRAGMA journal_mode=WAL; CREATE TABLE durable(value TEXT); INSERT INTO durable VALUES ('before')");

    const result = createMigrationBackup();
    expect(result.created).toBe(true);
    expect(createMigrationBackup().created).toBe(false);
    const manifest = verifyMigrationBackup();
    expect(manifest.artifacts["config.json"].present).toBe(true);
    expect(manifest.artifacts["state.db"].present).toBe(true);
    expect(manifest.artifacts["workflow.db"].present).toBe(false);
    expect(manifest.artifacts["state.db"].sha256).toHaveLength(64);
    if (process.platform !== "win32") {
      expect(fs.statSync(getMigrationBackupDir()).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(getMigrationBackupDir(), "state.db")).mode & 0o777).toBe(0o600);
    }

    state.exec("UPDATE durable SET value='after'");
    state.close();
    fs.writeFileSync(getConfigPath(), '{"configVersion":"0.9.0"}\n');
    const workflow = new Database(getWorkflowDbPath());
    workflow.exec("CREATE TABLE should_be_removed(value TEXT)");
    workflow.close();

    expect(() => restoreMigrationBackup(false)).toThrow(/--confirm/);
    restoreMigrationBackup(true);
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(configBefore);
    expect(fs.existsSync(getWorkflowDbPath())).toBe(false);
    const restored = new Database(getStateDbPathInDataDir(), { readonly: true });
    expect((restored.query("SELECT value FROM durable").get() as { value: string }).value).toBe("before");
    restored.close();
    expect(fs.existsSync(getMigrationBackupDir())).toBe(true);
  });

  test("refuses to bless an existing current config when the pre-cutover bundle is missing", () => {
    fs.writeFileSync(getConfigPath(), '{"configVersion":"0.9.0"}\n');
    expect(() => createMigrationBackup()).toThrow(/Refusing to create a pre-0.9 migration backup/);
  });

  test("fails closed on an incomplete existing bundle", () => {
    fs.mkdirSync(getMigrationBackupDir(), { recursive: true, mode: 0o700 });
    expect(() => createMigrationBackup()).toThrow(/incomplete or unreadable/);
  });

  test("fails closed when an immutable bundle artifact is checksum-corrupted", () => {
    seedLegacyConfig();
    createMigrationBackup();
    fs.appendFileSync(path.join(getMigrationBackupDir(), "config.json"), "corruption");
    expect(() => verifyMigrationBackup()).toThrow(/checksum verification/);
    expect(() => createMigrationBackup()).toThrow(/checksum verification/);
  });

  test("records fresh canonical databases absent before their first open", () => {
    const state = openStateDatabase(getStateDbPathInDataDir());
    state.close();
    const manifest = verifyMigrationBackup();
    expect(manifest.artifacts["config.json"].present).toBe(false);
    expect(manifest.artifacts["state.db"].present).toBe(false);
    expect(manifest.artifacts["workflow.db"].present).toBe(false);
    expect(fs.existsSync(getStateDbPathInDataDir())).toBe(true);

    restoreMigrationBackup(true);
    expect(fs.existsSync(getStateDbPathInDataDir())).toBe(false);
  });

  test("refuses restore for active improve and extract locks", () => {
    createMigrationBackup();
    for (const lockPath of [
      path.join(getDataDir(), "consolidate.lock"),
      path.join(getDataDir(), "extract-locks", "extract-opencode-session.lock"),
    ]) {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, String(process.pid));
      expect(() => restoreMigrationBackup(true)).toThrow(/locks or workflow leases are active/);
      fs.rmSync(lockPath);
    }
  });

  test("refuses restore while a lockfile writer owns its sentinel", () => {
    createMigrationBackup();
    fs.mkdirSync(path.dirname(getLockfileLockPath()), { recursive: true });
    fs.writeFileSync(getLockfileLockPath(), String(process.pid), { flag: "wx" });
    try {
      expect(() => restoreMigrationBackup(true)).toThrow(/akm\.lock\.lck/);
    } finally {
      fs.rmSync(getLockfileLockPath(), { force: true });
    }
  });

  test("refuses restore while a workflow engine lease is live", () => {
    createMigrationBackup();
    fs.mkdirSync(path.dirname(getWorkflowDbPath()), { recursive: true });
    const workflow = new Database(getWorkflowDbPath());
    workflow.exec(`
      CREATE TABLE workflow_runs(
        id TEXT PRIMARY KEY,
        engine_lease_holder TEXT,
        engine_lease_until TEXT
      );
    `);
    const now = Date.now();
    workflow
      .prepare("INSERT INTO workflow_runs VALUES (?, ?, ?)")
      .run("run-live", "holder-live", new Date(now + 60_000).toISOString());
    workflow.close();

    expect(() => restoreMigrationBackup(true)).toThrow(/run=run-live/);
    const update = new Database(getWorkflowDbPath());
    update.prepare("UPDATE workflow_runs SET engine_lease_until = ?").run(new Date(now - 60_000).toISOString());
    update.close();
    restoreMigrationBackup(true);
    expect(fs.existsSync(getWorkflowDbPath())).toBe(false);
  });

  test("refuses restore while an external workflow unit claim is live", () => {
    createMigrationBackup();
    fs.mkdirSync(path.dirname(getWorkflowDbPath()), { recursive: true });
    const workflow = new Database(getWorkflowDbPath());
    workflow.exec(`
      CREATE TABLE workflow_run_units(
        run_id TEXT,
        unit_id TEXT,
        status TEXT,
        claim_holder TEXT,
        claim_expires_at TEXT
      );
    `);
    workflow
      .prepare("INSERT INTO workflow_run_units VALUES (?, ?, 'running', ?, ?)")
      .run("run-external", "unit-live", "driver-live", new Date(Date.now() + 60_000).toISOString());
    workflow.close();

    expect(() => restoreMigrationBackup(true)).toThrow(/run=run-external,unit=unit-live,holder=driver-live/);
  });

  test("maintenance barrier excludes new lock starts and restore contenders", async () => {
    createMigrationBackup();
    const release = acquireMaintenanceBarrier();
    try {
      expect(
        await acquireIndexWriterLease({ mode: "try", purpose: "restore-barrier-test", maxWaitMs: 0 }),
      ).toBeUndefined();
      expect(() => restoreMigrationBackup(true)).toThrow(/maintenance is in progress/);
    } finally {
      release();
    }
    restoreMigrationBackup(true);
  });

  test("restore refuses while an external report path is registered", async () => {
    createMigrationBackup();
    const release = await acquireMaintenanceActivity("workflow-report-test");
    try {
      expect(() => restoreMigrationBackup(true)).toThrow(/maintenance-activities.*workflow-report-test/);
    } finally {
      release();
    }
  });

  test("restore refuses for the full lifetime of a state.db handle", () => {
    createMigrationBackup();
    const state = openStateDatabase();
    try {
      state
        .prepare("INSERT INTO events(event_type, ts, metadata_json) VALUES (?, ?, ?)")
        .run("test_event", new Date().toISOString(), "{}");
      expect(() => restoreMigrationBackup(true)).toThrow(/maintenance-activities.*state-db/);
    } finally {
      state.close();
    }
    restoreMigrationBackup(true);
  });

  test("restore refuses for the full lifetime of a workflow.db handle", () => {
    createMigrationBackup();
    const workflow = openWorkflowDatabase();
    try {
      workflow.prepare("SELECT COUNT(*) AS count FROM workflow_runs").get();
      expect(() => restoreMigrationBackup(true)).toThrow(/maintenance-activities.*workflow-db/);
    } finally {
      workflow.close();
    }
    restoreMigrationBackup(true);
  });

  test("a canonical workflow.db handle can register inside its owning maintenance barrier", () => {
    createMigrationBackup();
    withMaintenanceStartBarrier(() => {
      const workflow = openWorkflowDatabase();
      workflow.close();
    });
  });

  test("canonical database opens capture both historical databases before migrations 017 and 010", () => {
    seedLegacyConfig();
    fs.mkdirSync(path.dirname(getStateDbPathInDataDir()), { recursive: true });
    const state = new Database(getStateDbPathInDataDir());
    state.exec(`
      CREATE TABLE improve_runs(id TEXT PRIMARY KEY, profile TEXT, started_at TEXT);
      CREATE TABLE schema_migrations(id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
    `);
    const stateInsert = state.prepare("INSERT INTO schema_migrations(id) VALUES (?)");
    for (const id of [
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
    ]) {
      stateInsert.run(id);
    }
    state.close();

    const workflow = new Database(getWorkflowDbPath());
    workflow.exec(`
      CREATE TABLE workflow_runs(id TEXT PRIMARY KEY, workflow_ref TEXT, status TEXT, scope_key TEXT);
      CREATE TABLE workflow_run_steps(run_id TEXT, step_id TEXT, sequence_index INTEGER);
      CREATE TABLE workflow_run_units(run_id TEXT, unit_id TEXT);
      CREATE TABLE schema_migrations(id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
    `);
    const workflowInsert = workflow.prepare("INSERT INTO schema_migrations(id) VALUES (?)");
    for (const id of [
      "001-add-scope-key",
      "002-add-agent-identity",
      "003-checkin-and-step-summary",
      "004-workflow-run-units",
      "005-unit-session-id",
      "006-frozen-plan-and-lease",
      "007-unit-last-checkin",
      "008-unit-attempts",
      "009-unit-claim",
    ]) {
      workflowInsert.run(id);
    }
    workflow.close();

    openStateDatabase(getStateDbPathInDataDir()).close();
    openWorkflowDatabase(getWorkflowDbPath()).close();

    const stateBackup = new Database(path.join(getMigrationBackupDir(), "state.db"), { readonly: true });
    const workflowBackup = new Database(path.join(getMigrationBackupDir(), "workflow.db"), { readonly: true });
    expect(hasColumn(stateBackup, "improve_runs", "strategy")).toBe(false);
    expect(hasColumn(workflowBackup, "workflow_runs", "plan_ir_version")).toBe(false);
    expect(hasColumn(workflowBackup, "workflow_run_units", "engine")).toBe(false);
    stateBackup.close();
    workflowBackup.close();

    const migratedState = new Database(getStateDbPathInDataDir(), { readonly: true });
    const migratedWorkflow = new Database(getWorkflowDbPath(), { readonly: true });
    expect(hasColumn(migratedState, "improve_runs", "strategy")).toBe(true);
    expect(hasColumn(migratedWorkflow, "workflow_runs", "plan_ir_version")).toBe(true);
    expect(hasColumn(migratedWorkflow, "workflow_run_units", "engine")).toBe(true);
    migratedState.close();
    migratedWorkflow.close();
  });
});
