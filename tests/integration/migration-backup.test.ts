// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { acquireMaintenanceActivity, acquireMaintenanceBarrier } from "../../src/core/maintenance-barrier";
import {
  createMigrationBackup,
  getMigrationBackupDir,
  restoreMigrationBackup,
  verifyMigrationBackup,
} from "../../src/core/migration-backup";
import {
  getConfigPath,
  getDataDir,
  getDbPath,
  getLockfileLockPath,
  getStateDbPathInDataDir,
} from "../../src/core/paths";
import { runMigrations as runStateMigrations } from "../../src/core/state/migrations";
import { openStateDatabase } from "../../src/core/state-db";
import { acquireIndexWriterLease } from "../../src/indexer/index-writer-lock";
import { getLegacyWorkflowDbPath } from "../../src/migrate/legacy/legacy-paths";
import { openLegacyWorkflowDb } from "../_helpers/legacy-workflow-db";
import { type Cleanup, sandboxXdgCacheHome, sandboxXdgConfigHome, sandboxXdgDataHome } from "../_helpers/sandbox";

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
    expect(createMigrationBackup().created).toBe(true);
    const manifest = verifyMigrationBackup(result.path);
    expect(manifest.artifacts["config.json"].present).toBe(true);
    expect(manifest.artifacts["state.db"].present).toBe(true);
    expect(manifest.artifacts["workflow.db"].present).toBe(false);
    expect(manifest.artifacts["state.db"].sha256).toHaveLength(64);
    if (process.platform !== "win32") {
      expect(fs.statSync(result.path).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(result.path, "state.db")).mode & 0o777).toBe(0o600);
    }

    state.exec("UPDATE durable SET value='after'");
    state.close();
    fs.writeFileSync(getConfigPath(), '{"configVersion":"0.9.0"}\n');
    const workflow = new Database(getLegacyWorkflowDbPath());
    workflow.exec("CREATE TABLE should_be_removed(value TEXT)");
    workflow.close();

    expect(() => restoreMigrationBackup(false)).toThrow(/--confirm/);
    restoreMigrationBackup(true, result.manifest.runId);
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(configBefore);
    expect(fs.existsSync(getLegacyWorkflowDbPath())).toBe(false);
    const restored = new Database(getStateDbPathInDataDir(), { readonly: true });
    expect((restored.query("SELECT value FROM durable").get() as { value: string }).value).toBe("before");
    restored.close();
    expect(fs.existsSync(result.path)).toBe(true);
  });

  test("can snapshot an existing current config when databases require independent classification", () => {
    fs.writeFileSync(getConfigPath(), '{"configVersion":"0.9.0"}\n');
    expect(createMigrationBackup().manifest.artifacts["config.json"].status).toBe("current");
  });

  test("fails closed on an incomplete existing bundle", () => {
    const incomplete = getMigrationBackupDir("incomplete");
    fs.mkdirSync(incomplete, { recursive: true, mode: 0o700 });
    expect(() => verifyMigrationBackup(incomplete)).toThrow(/incomplete or unreadable/);
    expect(createMigrationBackup().created).toBe(true);
  });

  test("fails closed when an immutable bundle artifact is checksum-corrupted", () => {
    seedLegacyConfig();
    const corrupted = createMigrationBackup();
    fs.appendFileSync(path.join(corrupted.path, "config.json"), "corruption");
    expect(() => verifyMigrationBackup(corrupted.path)).toThrow(/checksum verification/);
    expect(createMigrationBackup().created).toBe(true);
  });

  test("fresh canonical database opens do not manufacture a historical bundle", () => {
    const state = openStateDatabase(getStateDbPathInDataDir());
    state.close();
    expect(fs.existsSync(getStateDbPathInDataDir())).toBe(true);
    expect(fs.existsSync(getMigrationBackupDir())).toBe(false);
  });

  test("refuses restore for active improve and extract locks", () => {
    createMigrationBackup();
    for (const lockPath of [
      path.join(getDataDir(), "consolidate.lock"),
      path.join(getDataDir(), "extract-locks", "extract-opencode-session.lock"),
    ]) {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, String(process.pid));
      expect(() => restoreMigrationBackup(true)).toThrow(/locks, activities, or workflow leases are active/);
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
    fs.mkdirSync(path.dirname(getLegacyWorkflowDbPath()), { recursive: true });
    const workflow = new Database(getLegacyWorkflowDbPath());
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
    const update = new Database(getLegacyWorkflowDbPath());
    update.prepare("UPDATE workflow_runs SET engine_lease_until = ?").run(new Date(now - 60_000).toISOString());
    update.close();
    restoreMigrationBackup(true);
    expect(fs.existsSync(getLegacyWorkflowDbPath())).toBe(false);
  });

  test("refuses restore while an external workflow unit claim is live", () => {
    createMigrationBackup();
    fs.mkdirSync(path.dirname(getLegacyWorkflowDbPath()), { recursive: true });
    const workflow = new Database(getLegacyWorkflowDbPath());
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

  test("workflow blocker reporting samples at most 100 active rows", () => {
    createMigrationBackup();
    fs.mkdirSync(path.dirname(getLegacyWorkflowDbPath()), { recursive: true });
    const workflow = new Database(getLegacyWorkflowDbPath());
    workflow.exec(`
      CREATE TABLE workflow_runs(
        id TEXT PRIMARY KEY,
        engine_lease_holder TEXT,
        engine_lease_until TEXT
      );
    `);
    const insert = workflow.prepare("INSERT INTO workflow_runs VALUES (?, ?, ?)");
    const expires = new Date(Date.now() + 60_000).toISOString();
    for (let index = 0; index < 150; index += 1) insert.run(`run-${index}`, `holder-${index}`, expires);
    workflow.close();

    let message = "";
    try {
      restoreMigrationBackup(true);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("additional-active-workflow-blockers");
    expect((message.match(/#run=/g) ?? []).length).toBe(100);
    expect(message.length).toBeLessThan(20_000);
  });

  test("workflow blocker diagnostics truncate oversized fields and control characters by bytes", () => {
    createMigrationBackup();
    fs.mkdirSync(path.dirname(getLegacyWorkflowDbPath()), { recursive: true });
    const workflow = new Database(getLegacyWorkflowDbPath());
    workflow.exec(`
      CREATE TABLE workflow_runs(
        id TEXT PRIMARY KEY,
        engine_lease_holder TEXT,
        engine_lease_until TEXT
      );
    `);
    const oversized = `${"x".repeat(100_000)}\n\tforged-line`;
    workflow
      .prepare("INSERT INTO workflow_runs VALUES (?, ?, ?)")
      .run(oversized, oversized, new Date(Date.now() + 60_000).toISOString());
    workflow.close();

    let message = "";
    try {
      restoreMigrationBackup(true);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("Refusing artifact replacement");
    expect(Buffer.byteLength(message, "utf8")).toBeLessThanOrEqual(16 * 1024);
    expect(message).not.toContain("\n\tforged-line");
    expect(message.length).toBeLessThan(2_000);
  });

  test("large blocker directories are sampled and still fail closed with a bounded diagnostic", () => {
    createMigrationBackup();
    const lockDir = path.join(getDataDir(), "extract-locks");
    fs.mkdirSync(lockDir, { recursive: true });
    for (let index = 0; index < 500; index += 1) {
      fs.writeFileSync(path.join(lockDir, `oversized-directory-${index}.lock`), String(process.pid));
    }

    let message = "";
    try {
      restoreMigrationBackup(true);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("Refusing artifact replacement");
    expect(message).toMatch(/additional|omitted|directory/i);
    expect(Buffer.byteLength(message, "utf8")).toBeLessThanOrEqual(16 * 1024);
    expect((message.match(/oversized-directory-/g) ?? []).length).toBeLessThanOrEqual(100);
  });

  test("operation mutex databases do not count toward the lock sample cap", () => {
    createMigrationBackup();
    const lockDir = path.join(getDataDir(), "extract-locks");
    fs.mkdirSync(lockDir, { recursive: true });
    for (let index = 0; index < 500; index += 1) {
      fs.writeFileSync(path.join(lockDir, `.extract-${index}.lock.operations.sensitive`), "mutex");
    }

    expect(() => restoreMigrationBackup(true)).not.toThrow();
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

  // Chunk-8 WI-8.3: workflow.db no longer has a runtime opener (openWorkflowDatabase
  // is deleted; the workflow tables live in state.db). The canonical-handle
  // maintenance-activity blocking that these two tests pinned is now the "state-db"
  // activity, covered by the state.db handle test above and by
  // workflow-db-maintenance.test.ts.

  test("canonical database opens capture both historical databases before migrations 017 and 010", () => {
    seedLegacyConfig();
    fs.mkdirSync(path.dirname(getStateDbPathInDataDir()), { recursive: true });
    const state = new Database(getStateDbPathInDataDir());
    // This fixture marks 010-asset-outcome applied, so it must materialize the
    // table migration 010 creates — migration 018's DROP COLUMN needs it to exist.
    state.exec(`
      CREATE TABLE improve_runs(id TEXT PRIMARY KEY, profile TEXT, started_at TEXT);
      CREATE TABLE schema_migrations(id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
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

    const workflow = new Database(getLegacyWorkflowDbPath());
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

    const backup = createMigrationBackup();
    const stateToMigrate = new Database(getStateDbPathInDataDir());
    runStateMigrations(stateToMigrate as never);
    stateToMigrate.close();
    // Roll the pre-cutover workflow.db to its final ledger (010) via the frozen
    // bodies — the way config-migrate.ts#runFrozenWorkflowRoll does it now that
    // src/workflows/db.ts is deleted.
    openLegacyWorkflowDb(getLegacyWorkflowDbPath()).close();

    const stateBackup = new Database(path.join(backup.path, "state.db"), { readonly: true });
    const workflowBackup = new Database(path.join(backup.path, "workflow.db"), { readonly: true });
    expect(hasColumn(stateBackup, "improve_runs", "strategy")).toBe(false);
    expect(hasColumn(workflowBackup, "workflow_runs", "plan_ir_version")).toBe(false);
    expect(hasColumn(workflowBackup, "workflow_run_units", "engine")).toBe(false);
    stateBackup.close();
    workflowBackup.close();

    const migratedState = new Database(getStateDbPathInDataDir(), { readonly: true });
    const migratedWorkflow = new Database(getLegacyWorkflowDbPath(), { readonly: true });
    expect(hasColumn(migratedState, "improve_runs", "strategy")).toBe(true);
    expect(hasColumn(migratedWorkflow, "workflow_runs", "plan_ir_version")).toBe(true);
    expect(hasColumn(migratedWorkflow, "workflow_run_units", "engine")).toBe(true);
    migratedState.close();
    migratedWorkflow.close();
  });

  // ── chunk-8 WI-8.1: manifest v3 (pre-rescue index.db) + v2 backward-read ──

  test("v3 round-trip: a present index.db is captured, sha-pinned, and restored", () => {
    seedLegacyConfig();
    fs.mkdirSync(path.dirname(getStateDbPathInDataDir()), { recursive: true });
    const state = new Database(getStateDbPathInDataDir());
    state.exec("CREATE TABLE durable(value TEXT); INSERT INTO durable VALUES ('before')");
    state.close();
    fs.mkdirSync(path.dirname(getDbPath()), { recursive: true });
    const index = new Database(getDbPath());
    index.exec("CREATE TABLE usage_events(entry_ref TEXT); INSERT INTO usage_events VALUES ('stash//memories/x')");
    index.close();

    const result = createMigrationBackup();
    const manifest = verifyMigrationBackup(result.path);
    expect(manifest.formatVersion).toBe(3);
    expect(manifest.artifacts["index.db"]?.present).toBe(true);
    expect(manifest.artifacts["index.db"]?.status).toBe("current");
    expect(manifest.artifacts["index.db"]?.sha256).toHaveLength(64);
    expect(fs.existsSync(path.join(result.path, "index.db"))).toBe(true);

    fs.rmSync(getDbPath());
    restoreMigrationBackup(true, result.manifest.runId);
    const restored = new Database(getDbPath(), { readonly: true });
    expect(restored.prepare("SELECT entry_ref FROM usage_events").all()).toEqual([{ entry_ref: "stash//memories/x" }]);
    restored.close();
  });

  test("a pre-cutover v2 three-artifact backup still verifies and restores under the v3 binary", () => {
    const configBefore = seedLegacyConfig();
    fs.mkdirSync(path.dirname(getStateDbPathInDataDir()), { recursive: true });
    const state = new Database(getStateDbPathInDataDir());
    state.exec("CREATE TABLE durable(value TEXT); INSERT INTO durable VALUES ('before')");
    state.close();

    // Rewrite the freshly created v3 bundle into the exact pre-cutover v2
    // shape: formatVersion 2, no index.db artifact entry, no index.db file.
    const result = createMigrationBackup();
    const manifestPath = path.join(result.path, "manifest.json");
    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    expect(raw.formatVersion).toBe(3);
    raw.formatVersion = 2;
    delete raw.artifacts["index.db"];
    fs.writeFileSync(manifestPath, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
    fs.rmSync(path.join(result.path, "index.db"), { force: true });

    const manifest = verifyMigrationBackup(result.path);
    expect(manifest.formatVersion).toBe(2);
    expect(manifest.artifacts["index.db"]).toBeUndefined();

    const live = new Database(getStateDbPathInDataDir());
    live.exec("UPDATE durable SET value='after'");
    live.close();
    fs.writeFileSync(getConfigPath(), '{"configVersion":"0.9.0"}\n');
    restoreMigrationBackup(true, result.manifest.runId);
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(configBefore);
    const restored = new Database(getStateDbPathInDataDir(), { readonly: true });
    expect(restored.prepare("SELECT value FROM durable").all()).toEqual([{ value: "before" }]);
    restored.close();
  });

  test("an absent index is recorded absent and a corrupt index blocks backup", () => {
    seedLegacyConfig();
    fs.mkdirSync(path.dirname(getStateDbPathInDataDir()), { recursive: true });
    const state = new Database(getStateDbPathInDataDir());
    state.exec("CREATE TABLE durable(value TEXT)");
    state.close();

    // Absent index.db → present:false, status "missing".
    const absent = createMigrationBackup();
    expect(absent.manifest.formatVersion).toBe(3);
    expect(absent.manifest.artifacts["index.db"]?.present).toBe(false);
    expect(absent.manifest.artifacts["index.db"]?.status).toBe("missing");
    expect(fs.existsSync(path.join(absent.path, "index.db"))).toBe(false);

    // index.db contains usage_events that are durable until cutover rescue, so a
    // physically present but corrupt file must not be represented as absent.
    fs.mkdirSync(path.dirname(getDbPath()), { recursive: true });
    fs.writeFileSync(getDbPath(), "this is not a sqlite database");
    expect(() => createMigrationBackup()).toThrow(/index\.db=corrupt/i);
    expect(fs.readFileSync(getDbPath(), "utf8")).toBe("this is not a sqlite database");
  });

  test("restore preserves a corrupt live index in its verified rescue run", () => {
    seedLegacyConfig();
    fs.mkdirSync(path.dirname(getStateDbPathInDataDir()), { recursive: true });
    const state = new Database(getStateDbPathInDataDir());
    state.exec("CREATE TABLE durable(value TEXT); INSERT INTO durable VALUES ('before')");
    state.close();
    const index = new Database(getDbPath());
    index.exec("CREATE TABLE usage_events(entry_ref TEXT); INSERT INTO usage_events VALUES ('memories/before')");
    index.close();
    const good = createMigrationBackup();

    const corruptBytes = Buffer.from("corrupt live index that must survive rescue");
    fs.writeFileSync(getDbPath(), corruptBytes);
    const restored = restoreMigrationBackup(true, good.manifest.runId);

    const live = new Database(getDbPath(), { readonly: true });
    expect(live.prepare("SELECT entry_ref FROM usage_events").get()).toEqual({ entry_ref: "memories/before" });
    live.close();
    expect(restored.rescuePath).toBeDefined();
    const rescuePath = restored.rescuePath;
    if (!rescuePath) throw new Error("restore did not create its rescue backup");
    const rescue = verifyMigrationBackup(rescuePath);
    expect(rescue.artifacts["index.db"]?.status).toBe("corrupt");
    expect(fs.readFileSync(path.join(rescuePath, "index.db"))).toEqual(corruptBytes);
  });
});
