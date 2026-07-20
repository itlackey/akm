// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { main, shouldBypassConfigStartup } from "../../src/cli";
import { MAX_CONFIG_FILE_BYTES } from "../../src/core/common";
import { loadUserConfig, mutateConfig, saveConfig } from "../../src/core/config/config";
import { acquireMaintenanceActivity } from "../../src/core/maintenance-barrier";
import {
  _setRestoreRollbackBoundaryHookForTests,
  createMigrationBackup,
  fingerprintMigrationGeneration,
  getMigrationApplyJournalPath,
  getMigrationBackupRoot,
  getMigrationRestoreJournalPath,
  inspectMigrationState,
  restoreMigrationBackup,
  verifyMigrationBackup,
} from "../../src/core/migration-backup";
import { _setAfterPendingOperationCheckHookForTests } from "../../src/core/migration-operation";
import { getConfigPath, getDbPath, getStateDbPathInDataDir } from "../../src/core/paths";
import { STATE_MIGRATIONS } from "../../src/core/state/migrations";
import { openStateDatabase } from "../../src/core/state-db";
import { getLegacyWorkflowDbPath } from "../../src/migrate/legacy/legacy-paths";
import { runCliCapture } from "../_helpers/cli";
import { createLegacyWorkflowDb } from "../_helpers/legacy-workflow-db";
import {
  type Cleanup,
  sandboxHome,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
} from "../_helpers/sandbox";

const STATE_PRE_CUTOVER_IDS = [
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

const WORKFLOW_PRE_CUTOVER_IDS = [
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

// The physical schema migration 010 installs. Fixtures below mark
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

function writeConfig(version: string): void {
  fs.writeFileSync(getConfigPath(), `${JSON.stringify({ configVersion: version })}\n`, { mode: 0o600 });
}

function seedLedger(db: Database, ids: readonly string[]): void {
  db.exec("CREATE TABLE schema_migrations(id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
  const insert = db.prepare("INSERT INTO schema_migrations(id) VALUES (?)");
  for (const id of ids) insert.run(id);
}

function seedPreCutoverState(value = "before"): void {
  fs.mkdirSync(path.dirname(getStateDbPathInDataDir()), { recursive: true });
  const db = new Database(getStateDbPathInDataDir());
  db.exec(`
    CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, ts TEXT NOT NULL, ref TEXT, metadata_json TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE improve_runs(id TEXT PRIMARY KEY, profile TEXT, started_at TEXT);
    CREATE TABLE durable(value TEXT);
    INSERT INTO durable VALUES ('${value}');
    ${ASSET_OUTCOME_010_DDL}
  `);
  seedLedger(db, STATE_PRE_CUTOVER_IDS);
  db.close();
}

function seedPreCutoverWorkflow(): void {
  const db = new Database(getLegacyWorkflowDbPath());
  db.exec(`
    CREATE TABLE workflow_runs(id TEXT PRIMARY KEY, workflow_ref TEXT, status TEXT, scope_key TEXT);
    CREATE TABLE workflow_run_steps(run_id TEXT, step_id TEXT, sequence_index INTEGER);
    CREATE TABLE workflow_run_units(run_id TEXT, unit_id TEXT);
  `);
  seedLedger(db, WORKFLOW_PRE_CUTOVER_IDS);
  db.close();
}

function seedFailingPreCutoverWorkflow(): void {
  const db = new Database(getLegacyWorkflowDbPath());
  db.exec(`
    CREATE TABLE workflow_runs(id TEXT PRIMARY KEY, workflow_ref TEXT, status TEXT, scope_key TEXT);
    CREATE TABLE workflow_run_steps(run_id TEXT, step_id TEXT, sequence_index INTEGER);
  `);
  seedLedger(db, WORKFLOW_PRE_CUTOVER_IDS);
  db.close();
}

function removeLedgerChecksums(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`
    ALTER TABLE schema_migrations RENAME TO schema_migrations_sealed;
    CREATE TABLE schema_migrations(id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO schema_migrations(id, applied_at)
      SELECT id, applied_at FROM schema_migrations_sealed ORDER BY rowid;
    DROP TABLE schema_migrations_sealed;
  `);
  db.close();
}

function readDurable(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.query("SELECT value FROM durable").get() as { value: string }).value;
  } finally {
    db.close();
  }
}

function restoreJournalEntries(
  backup: ReturnType<typeof createMigrationBackup>,
  operationId: string,
): Array<Record<string, unknown>> {
  const destinations: Record<string, string> = {
    "config.json": getConfigPath(),
    "state.db": getStateDbPathInDataDir(),
    "workflow.db": getLegacyWorkflowDbPath(),
    // Manifest v3 (chunk-8 WI-8.1) adds the pre-rescue index.db artifact; the
    // journal's entry set must exactly match the source manifest's artifact set.
    ...(backup.manifest.artifacts["index.db"] ? { "index.db": getDbPath() } : {}),
  };
  const fingerprint = (filePath: string): { byteSize: number; sha256: string } | null => {
    if (!fs.existsSync(filePath)) return null;
    const bytes = fs.readFileSync(filePath);
    return { byteSize: bytes.byteLength, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
  };
  return Object.entries(destinations).map(([name, destination]) => ({
    destination,
    ...((backup.manifest.artifacts as Record<string, { present: boolean }>)[name].present
      ? { stage: `${destination}.restore-stage.${operationId}` }
      : {}),
    originalPresent: fs.existsSync(destination),
    originalFingerprint: fingerprint(destination),
    quarantine: `${destination}.restore-quarantine.${operationId}`,
    sidecars:
      name === "config.json"
        ? []
        : ["-wal", "-shm"].map((suffix) => ({
            destination: `${destination}${suffix}`,
            originalPresent: fs.existsSync(`${destination}${suffix}`),
            originalFingerprint: fingerprint(`${destination}${suffix}`),
            quarantine: `${destination}${suffix}.restore-quarantine.${operationId}`,
          })),
  }));
}

function writeRestoreJournal(
  backup: ReturnType<typeof createMigrationBackup>,
  operationId: string,
  overrides: Record<string, unknown> = {},
): string {
  const journalPath = path.join(getMigrationBackupRoot(), "restore-active.json");
  fs.writeFileSync(
    journalPath,
    `${JSON.stringify({
      formatVersion: 2,
      version: "0.9.0",
      operationId,
      sourceRunId: backup.manifest.runId,
      rescueRunId: "crashed-rescue",
      phase: "prepared",
      entries: restoreJournalEntries(backup, operationId),
      ...overrides,
    })}\n`,
    { mode: 0o600 },
  );
  return journalPath;
}

function materializeRestoreStages(
  backup: ReturnType<typeof createMigrationBackup>,
  entries: Array<Record<string, unknown>>,
): void {
  for (const entry of entries) {
    if (typeof entry.stage !== "string") continue;
    const name =
      entry.destination === getConfigPath()
        ? "config.json"
        : entry.destination === getStateDbPathInDataDir()
          ? "state.db"
          : entry.destination === getDbPath()
            ? "index.db"
            : "workflow.db";
    fs.copyFileSync(path.join(backup.path, name), entry.stage);
  }
}

function publishRestoreEntries(entries: Array<Record<string, unknown>>): void {
  for (const entry of entries) {
    if (entry.originalPresent === true) fs.renameSync(entry.destination as string, entry.quarantine as string);
    for (const sidecar of entry.sidecars as Array<Record<string, unknown>>) {
      if (sidecar.originalPresent === true) {
        fs.renameSync(sidecar.destination as string, sidecar.quarantine as string);
      }
    }
  }
  for (const entry of entries) {
    if (typeof entry.stage === "string") fs.renameSync(entry.stage, entry.destination as string);
  }
}

function writeApplyJournalForTest(
  backup: ReturnType<typeof createMigrationBackup>,
  overrides: Record<string, unknown> = {},
): string {
  const journalPath = getMigrationApplyJournalPath();
  fs.writeFileSync(
    journalPath,
    `${JSON.stringify({
      formatVersion: 2,
      version: "0.9.0",
      operationId: "apply-test-operation",
      installationId: path.basename(getMigrationBackupRoot()),
      backupRunId: backup.manifest.runId,
      backupPath: backup.path,
      phase: "prepared",
      targetConfig: { configVersion: "0.9.0", semanticSearchMode: "off" },
      generation: fingerprintMigrationGeneration(),
      ...overrides,
    })}\n`,
    { mode: 0o600 },
  );
  return journalPath;
}

describe("migration lifecycle regressions", () => {
  test("registers one top-level migration contract and bypasses normal config startup", async () => {
    const subCommands = main.subCommands as Record<string, unknown>;
    expect(subCommands.migrate).toBeDefined();
    expect(shouldBypassConfigStartup(["bun", "cli.ts", "migrate", "status"])).toBe(true);

    writeConfig("0.8.0");
    const prepared = path.join(path.dirname(getConfigPath()), "prepared-0.9.json");
    fs.writeFileSync(prepared, '{"configVersion":"0.9.0","semanticSearchMode":"off"}\n');

    const blocked = await runCliCapture(["migrate", "status"]);
    expect(blocked.code).not.toBe(0);
    expect(blocked.stdout).toContain('"config"');
    expect(blocked.stdout).toContain('"old"');

    const ready = await runCliCapture(["migrate", "status", "--config", prepared]);
    expect(ready.code, ready.stderr).toBe(0);
    expect(ready.stdout).toContain('"targetConfig"');
  });

  test("classifies missing, old, newer, inconsistent, and corrupt artifacts", () => {
    expect(inspectMigrationState()).toMatchObject({
      config: { status: "missing" },
      state: { status: "missing" },
      workflow: { status: "missing" },
    });

    writeConfig("0.8.0");
    expect(inspectMigrationState().config.status).toBe("old");
    writeConfig("1.0.0");
    expect(inspectMigrationState().config.status).toBe("newer");
    fs.writeFileSync(getConfigPath(), '{"configVersion":"0.9.0","sources":"not-an-array"}\n');
    expect(inspectMigrationState().config.status).toBe("corrupt");

    // WI-8.4 config-shape cutover: a version-current config still in the
    // pre-cutover source shape (stashDir/sources/installed, no bundles) is
    // migration-eligible → "old", not corrupt.
    fs.writeFileSync(getConfigPath(), '{"configVersion":"0.9.0","stashDir":"/home/u/akm"}\n');
    expect(inspectMigrationState().config.status).toBe("old");
    // The migrated new shape (bundles) is "current".
    fs.writeFileSync(
      getConfigPath(),
      '{"configVersion":"0.9.0","bundles":{"akm":{"path":"/home/u/akm","writable":true}},"defaultBundle":"akm"}\n',
    );
    expect(inspectMigrationState().config.status).toBe("current");
    // A half-migrated config (bundles + a retired source key) fails loudly.
    fs.writeFileSync(
      getConfigPath(),
      '{"configVersion":"0.9.0","bundles":{"akm":{"path":"/s"}},"defaultBundle":"akm","stashDir":"/s"}\n',
    );
    expect(inspectMigrationState().config.status).toBe("corrupt");

    fs.rmSync(getStateDbPathInDataDir(), { force: true });
    fs.mkdirSync(path.dirname(getStateDbPathInDataDir()), { recursive: true });
    const future = new Database(getStateDbPathInDataDir());
    seedLedger(future, [STATE_PRE_CUTOVER_IDS[0], "999-future"]);
    future.close();
    expect(inspectMigrationState().state.status).toBe("newer");

    fs.rmSync(getStateDbPathInDataDir(), { force: true });
    const holey = new Database(getStateDbPathInDataDir());
    seedLedger(holey, [STATE_PRE_CUTOVER_IDS[1]]);
    holey.close();
    expect(inspectMigrationState().state.status).toBe("inconsistent");

    fs.rmSync(getStateDbPathInDataDir(), { force: true });
    fs.writeFileSync(getStateDbPathInDataDir(), "not sqlite");
    expect(inspectMigrationState().state.status).toBe("corrupt");
  });

  test("current config writes and current canonical database opens do not require a historical bundle", () => {
    writeConfig("0.9.0");
    // The workflow tables live in state.db post-cutover, so a single canonical
    // state.db open covers the former state.db + workflow.db pair.
    const state = openStateDatabase();
    state.close();

    saveConfig({ configVersion: "0.9.0", semanticSearchMode: "off" });
    expect(fs.existsSync(getMigrationBackupRoot())).toBe(false);
  });

  test("canonical writable open refuses a future ledger before changing journal state", () => {
    fs.mkdirSync(path.dirname(getStateDbPathInDataDir()), { recursive: true });
    const future = new Database(getStateDbPathInDataDir());
    seedLedger(future, [STATE_PRE_CUTOVER_IDS[0], "999-future"]);
    expect((future.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("delete");
    future.close();

    expect(() => openStateDatabase()).toThrow(/newer migration ledger/i);

    const after = new Database(getStateDbPathInDataDir(), { readonly: true });
    try {
      expect((after.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("delete");
    } finally {
      after.close();
    }
  });

  test("classifies config, state, and workflow independently in a mixed cutover", () => {
    writeConfig("0.9.0");
    seedPreCutoverState();
    seedPreCutoverWorkflow();

    expect(inspectMigrationState()).toMatchObject({
      config: { status: "current" },
      state: { status: "old", migrationIds: [...STATE_PRE_CUTOVER_IDS] },
      workflow: { status: "old", migrationIds: [...WORKFLOW_PRE_CUTOVER_IDS] },
    });

    const backup = createMigrationBackup();
    expect(backup.manifest.artifacts["config.json"].status).toBe("current");
    expect(backup.manifest.artifacts["state.db"].status).toBe("old");
    expect(backup.manifest.artifacts["workflow.db"].status).toBe("old");
  });

  test("backup runs are durable, installation-scoped, and unique", () => {
    writeConfig("0.8.0");
    const first = createMigrationBackup();
    const second = createMigrationBackup();

    expect(first.path).not.toBe(second.path);
    expect(path.dirname(first.path)).toBe(getMigrationBackupRoot());
    expect(path.dirname(second.path)).toBe(getMigrationBackupRoot());
    expect(first.path.startsWith(path.dirname(getStateDbPathInDataDir()))).toBe(true);
    expect(verifyMigrationBackup(first.path).runId).toBe(first.manifest.runId);
    expect(verifyMigrationBackup(second.path).runId).toBe(second.manifest.runId);
  });

  test("canonical writable opens reject old state and workflow ledgers without applying them", () => {
    writeConfig("0.9.0");
    seedPreCutoverState();
    seedPreCutoverWorkflow();

    // The runtime durable home is state.db; its old-ledger refusal is the live
    // guard. The pre-cutover workflow.db's old ledger is classified by the
    // migrator (inspectMigrationState below / the apply flow), not a runtime
    // opener (src/workflows/db.ts is deleted).
    expect(() => openStateDatabase()).toThrow(/migration|required|old|current/i);
    expect(inspectMigrationState().workflow).toMatchObject({ status: "old" });

    expect(fs.existsSync(getMigrationBackupRoot())).toBe(false);
    const db = new Database(getStateDbPathInDataDir(), { readonly: true });
    try {
      const ids = db.query("SELECT id FROM schema_migrations ORDER BY rowid").all() as Array<{ id: string }>;
      expect(ids.map((row) => row.id)).toEqual([...STATE_PRE_CUTOVER_IDS]);
      expect(
        db
          .query("PRAGMA table_info(schema_migrations)")
          .all()
          .some((column) => (column as { name: string }).name === "checksum"),
      ).toBe(false);
      expect((db.query("SELECT COUNT(*) AS count FROM events").get() as { count: number }).count).toBe(0);
    } finally {
      db.close();
    }
  });

  test("canonical config and database access fail closed during a prepared restore crash", async () => {
    writeConfig("0.9.0");
    const state = openStateDatabase();
    state
      .prepare("INSERT INTO events(event_type, ts, metadata_json) VALUES (?, ?, ?)")
      .run("before", "2026-01-01", "{}");
    state.close();
    const backup = createMigrationBackup();

    const live = new Database(getStateDbPathInDataDir());
    live.prepare("INSERT INTO events(event_type, ts, metadata_json) VALUES (?, ?, ?)").run("after", "2026-01-02", "{}");
    live.close();

    const operationId = "accepted-write-window";
    const entries = restoreJournalEntries(backup, operationId);
    materializeRestoreStages(backup, entries);
    publishRestoreEntries(entries);
    writeRestoreJournal(backup, operationId, { entries });

    expect(() => loadUserConfig()).toThrow(/restore|replacement|journal|recovery/i);
    expect(() => {
      const opened = openStateDatabase();
      try {
        opened
          .prepare("INSERT INTO events(event_type, ts, metadata_json) VALUES (?, ?, ?)")
          .run("accepted-then-lost", "2026-01-03", "{}");
      } finally {
        opened.close();
      }
    }).toThrow(/restore|replacement|journal|recovery/i);

    const published = new Database(getStateDbPathInDataDir(), { readonly: true });
    try {
      expect(
        (
          published.query("SELECT COUNT(*) AS count FROM events WHERE event_type='accepted-then-lost'").get() as {
            count: number;
          }
        ).count,
      ).toBe(0);
    } finally {
      published.close();
    }

    const recovered = await runCliCapture(["migrate", "apply"]);
    expect(recovered.code, recovered.stderr).toBe(0);
    expect(fs.existsSync(path.join(getMigrationBackupRoot(), "restore-active.json"))).toBe(false);
    const rolledBack = new Database(getStateDbPathInDataDir(), { readonly: true });
    try {
      expect(
        (rolledBack.query("SELECT COUNT(*) AS count FROM events WHERE event_type='after'").get() as { count: number })
          .count,
      ).toBe(1);
    } finally {
      rolledBack.close();
    }
  });

  test("migrate apply refuses existing managed handles and maintenance activities before backup", async () => {
    writeConfig("0.9.0");
    const state = openStateDatabase();
    state.prepare("DELETE FROM schema_migrations WHERE id = ?").run("017-improve-run-strategy");
    try {
      const blockedByHandle = await runCliCapture(["migrate", "apply"]);
      expect(blockedByHandle.code).not.toBe(0);
      expect(blockedByHandle.stderr).toMatch(/state-db|maintenance-activities|active/i);
      expect(fs.existsSync(getMigrationBackupRoot())).toBe(false);
    } finally {
      state.close();
    }

    // (Chunk-8 WI-8.3: the former "an open canonical workflow.db handle blocks
    // migrate apply" arm is subsumed by the state.db handle arm above — the
    // workflow tables share state.db's single durable home and maintenance
    // activity; there is no separate workflow.db runtime opener to hold.)

    const release = await acquireMaintenanceActivity("migration-review-live-activity");
    try {
      const blockedByActivity = await runCliCapture(["migrate", "apply"]);
      expect(blockedByActivity.code).not.toBe(0);
      expect(blockedByActivity.stderr).toMatch(/migration-review-live-activity|maintenance-activities|active/i);
      expect(fs.existsSync(getMigrationBackupRoot())).toBe(false);
    } finally {
      release();
    }
  });

  test("canonical opens and config mutation recheck pending recovery after registering their lock", () => {
    const journalPath = getMigrationRestoreJournalPath();
    const raceJournalIntoPlace = (): void => {
      fs.mkdirSync(path.dirname(journalPath), { recursive: true });
      fs.writeFileSync(journalPath, "{}\n", { mode: 0o600 });
    };

    _setAfterPendingOperationCheckHookForTests(raceJournalIntoPlace);
    expect(() => openStateDatabase()).toThrow(/recovery is pending/i);
    expect(fs.existsSync(getStateDbPathInDataDir())).toBe(false);
    fs.rmSync(journalPath, { force: true });

    // (The workflow-tables home is state.db; the recovery-pending guard on it is
    // pinned by the openStateDatabase() case above. No separate workflow.db
    // opener exists post-cutover.)

    writeConfig("0.9.0");
    const before = fs.readFileSync(getConfigPath());
    _setAfterPendingOperationCheckHookForTests(raceJournalIntoPlace);
    expect(() =>
      mutateConfig((config) => ({
        ...config,
        semanticSearchMode: "off",
      })),
    ).toThrow(/recovery is pending/i);
    expect(fs.readFileSync(getConfigPath())).toEqual(before);
    fs.rmSync(journalPath, { force: true });
  });

  test("top-level migrate apply is idempotent and installs only an operator-prepared target", async () => {
    writeConfig("0.8.0");
    seedPreCutoverState();
    seedPreCutoverWorkflow();
    const prepared = path.join(path.dirname(getConfigPath()), "prepared-0.9.json");
    fs.writeFileSync(prepared, '{"configVersion":"0.9.0","semanticSearchMode":"off"}\n');

    const result = await runCliCapture(["migrate", "apply", "--config", prepared]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(getConfigPath(), "utf8"))).toMatchObject({
      configVersion: "0.9.0",
      semanticSearchMode: "off",
    });
    expect(inspectMigrationState()).toMatchObject({
      config: { status: "current" },
      state: { status: "current" },
      workflow: { status: "missing" }, // deleted by the three-DB cutover
    });
    expect(
      fs.readdirSync(getMigrationBackupRoot(), { withFileTypes: true }).filter((entry) => entry.isDirectory()),
    ).toHaveLength(1);

    const repeated = await runCliCapture(["migrate", "apply"]);
    expect(repeated.code, repeated.stderr).toBe(0);
    expect(inspectMigrationState()).toMatchObject({
      config: { status: "current" },
      state: { status: "current" },
      workflow: { status: "missing" }, // deleted by the three-DB cutover
    });
  });

  test("migration apply restores config and both databases when a later artifact fails", async () => {
    writeConfig("0.8.0");
    seedPreCutoverState();
    seedFailingPreCutoverWorkflow();
    const prepared = path.join(path.dirname(getConfigPath()), "prepared-0.9.json");
    fs.writeFileSync(prepared, '{"configVersion":"0.9.0"}\n');

    const result = await runCliCapture(["migrate", "apply", "--config", prepared]);
    expect(result.code).not.toBe(0);
    expect(inspectMigrationState()).toMatchObject({
      config: { status: "old" },
      state: { status: "old", migrationIds: [...STATE_PRE_CUTOVER_IDS] },
      workflow: { status: "old", migrationIds: [...WORKFLOW_PRE_CUTOVER_IDS] },
    });
    const state = new Database(getStateDbPathInDataDir(), { readonly: true });
    try {
      expect(state.query("PRAGMA table_info(improve_runs)").all()).not.toContainEqual(
        expect.objectContaining({ name: "strategy" }),
      );
    } finally {
      state.close();
    }
    expect(
      fs.readdirSync(getMigrationBackupRoot(), { withFileTypes: true }).filter((entry) => entry.isDirectory()).length,
    ).toBeGreaterThan(0);
  });

  test("current but unsealed ledgers require migration and are sealed only by backed-up apply", async () => {
    writeConfig("0.9.0");
    openStateDatabase().close();
    // A pre-cutover workflow.db at its final (unsealed) ledger, built from the
    // frozen bodies (src/workflows/db.ts is deleted). The migrate-apply cutover
    // rolls + merges + deletes it.
    createLegacyWorkflowDb(getLegacyWorkflowDbPath());
    removeLedgerChecksums(getStateDbPathInDataDir());
    removeLedgerChecksums(getLegacyWorkflowDbPath());

    expect(inspectMigrationState()).toMatchObject({ state: { status: "old" }, workflow: { status: "old" } });
    // state.db's unsealed ledger is refused by the live opener; the pre-cutover
    // workflow.db's is classified by the migrator (above), not a runtime opener.
    expect(() => openStateDatabase()).toThrow(/migration|required|checksum|current/i);

    const applied = await runCliCapture(["migrate", "apply"]);
    expect(applied.code, applied.stderr).toBe(0);
    expect(inspectMigrationState()).toMatchObject({ state: { status: "current" }, workflow: { status: "missing" } });
    // state.db seals its whole ledger (incl. the cutover migration 020); the
    // three-DB cutover then DELETES workflow.db (its rows merged into state.db),
    // so there is no longer a workflow.db ledger to seal.
    const state = new Database(getStateDbPathInDataDir(), { readonly: true });
    try {
      expect(
        (
          state.query("SELECT COUNT(*) AS count FROM schema_migrations WHERE checksum IS NOT NULL").get() as {
            count: number;
          }
        ).count,
      ).toBe(STATE_MIGRATIONS.length);
    } finally {
      state.close();
    }
    expect(fs.existsSync(getLegacyWorkflowDbPath())).toBe(false);
    expect(fs.existsSync(getMigrationBackupRoot())).toBe(true);
  });

  test("status and apply dry-run perform identical blocked eligibility checks without mutation", async () => {
    writeConfig("0.9.0");
    fs.mkdirSync(path.dirname(getStateDbPathInDataDir()), { recursive: true });
    const future = new Database(getStateDbPathInDataDir());
    seedLedger(future, [STATE_PRE_CUTOVER_IDS[0], "999-future"]);
    future.close();
    const prepared = path.join(path.dirname(getConfigPath()), "prepared-0.9.json");
    fs.writeFileSync(prepared, '{"configVersion":"0.9.0"}\n');
    const configBefore = fs.readFileSync(getConfigPath());
    const stateBefore = fs.readFileSync(getStateDbPathInDataDir());

    const status = await runCliCapture(["migrate", "status", "--config", prepared]);
    const dryRun = await runCliCapture(["migrate", "apply", "--config", prepared, "--dry-run"]);
    expect(status.code).not.toBe(0);
    expect(dryRun.code).toBe(status.code);
    for (const output of [status.stdout, dryRun.stdout]) {
      expect(output).toContain('"config"');
      expect(output).toContain('"targetConfig"');
      expect(output).toContain('"newer"');
      expect(output).toContain('"blocked"');
    }
    expect(fs.readFileSync(getConfigPath())).toEqual(configBefore);
    expect(fs.readFileSync(getStateDbPathInDataDir())).toEqual(stateBefore);
    expect(fs.existsSync(getMigrationBackupRoot())).toBe(false);
  });

  test("status reports a durable interrupted apply journal without mutating it", async () => {
    writeConfig("0.9.0");
    const backup = createMigrationBackup();
    writeApplyJournalForTest(backup, { phase: "state-applied" });
    const before = fs.readFileSync(getMigrationApplyJournalPath());

    const status = await runCliCapture(["migrate", "status"]);
    expect(status.stdout).toContain('"kind":"apply"');
    expect(status.stdout).toContain('"phase":"state-applied"');
    expect(fs.readFileSync(getMigrationApplyJournalPath())).toEqual(before);
  });

  test("apply journal rejects extra keys, foreign bundles, unsafe ids, and wrong versions", async () => {
    writeConfig("0.9.0");
    const backup = createMigrationBackup();
    const foreignParent = path.join(path.dirname(getMigrationBackupRoot()), "foreign-copy");
    const foreignBundle = path.join(foreignParent, backup.manifest.runId);
    fs.mkdirSync(foreignParent, { recursive: true, mode: 0o700 });
    fs.cpSync(backup.path, foreignBundle, { recursive: true });
    fs.chmodSync(foreignBundle, 0o700);
    for (const name of fs.readdirSync(foreignBundle)) fs.chmodSync(path.join(foreignBundle, name), 0o600);
    const configBefore = fs.readFileSync(getConfigPath());

    for (const overrides of [
      { extra: true },
      { version: "0.10.0" },
      { operationId: "../escape" },
      { backupRunId: "different-run" },
      { backupPath: foreignBundle },
      { installationId: "foreign-installation" },
    ]) {
      const journalPath = writeApplyJournalForTest(backup, overrides);
      const status = await runCliCapture(["migrate", "status"]);
      expect(status.code).not.toBe(0);
      expect(status.stdout).toMatch(/blocked|journal|foreign|invalid/i);
      expect(fs.readFileSync(getConfigPath())).toEqual(configBefore);
      expect(fs.existsSync(journalPath)).toBe(true);
    }
  });

  test("apply journal rejects a phase that is ahead of live artifacts before mutation", async () => {
    writeConfig("0.8.0");
    seedPreCutoverState("old-generation");
    const backup = createMigrationBackup();
    const configBefore = fs.readFileSync(getConfigPath());
    const stateBefore = fs.readFileSync(getStateDbPathInDataDir());
    const journalPath = writeApplyJournalForTest(backup, { phase: "committed" });

    const apply = await runCliCapture(["migrate", "apply"]);
    expect(apply.code).not.toBe(0);
    expect(apply.stderr).toMatch(/phase|stale|journal|artifact/i);
    expect(fs.readFileSync(getConfigPath())).toEqual(configBefore);
    expect(fs.readFileSync(getStateDbPathInDataDir())).toEqual(stateBefore);
    expect(fs.existsSync(journalPath)).toBe(true);
  });

  test("migration metadata and prepared config reads reject oversized local files", async () => {
    writeConfig("0.9.0");
    const backup = createMigrationBackup();
    const oversized = " ".repeat(2 * 1024 * 1024);

    const prepared = path.join(path.dirname(getConfigPath()), "oversized-prepared.json");
    fs.writeFileSync(prepared, `{"configVersion":"0.9.0"}${oversized}`);
    const status = await runCliCapture(["migrate", "status", "--config", prepared]);
    expect(status.code).not.toBe(0);
    expect(status.stdout).toMatch(/exceed|too large|limit/i);

    fs.appendFileSync(path.join(backup.path, "manifest.json"), oversized);
    expect(() => verifyMigrationBackup(backup.path)).toThrow(/exceed|too large|limit/i);

    fs.writeFileSync(getMigrationApplyJournalPath(), `{}${oversized}`, { mode: 0o600 });
    const applyStatus = await runCliCapture(["migrate", "status"]);
    expect(applyStatus.code).not.toBe(0);
    expect(applyStatus.stdout).toMatch(/exceed|too large|limit/i);
  });

  test("near-limit prepared config is rejected before writing an oversized apply journal", async () => {
    writeConfig("0.8.0");
    seedPreCutoverState("before");
    const prepared = path.join(path.dirname(getConfigPath()), "near-limit-prepared.json");
    const target = JSON.stringify({
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      stashDir: `/${"a".repeat(MAX_CONFIG_FILE_BYTES - 256)}`,
    });
    expect(Buffer.byteLength(target)).toBeLessThanOrEqual(MAX_CONFIG_FILE_BYTES);
    fs.writeFileSync(prepared, target);
    const configBefore = fs.readFileSync(getConfigPath());
    const stateBefore = fs.readFileSync(getStateDbPathInDataDir());

    const result = await runCliCapture(["migrate", "apply", "--config", prepared]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/journal.*exceed|metadata limit/i);
    expect(fs.existsSync(getMigrationApplyJournalPath())).toBe(false);
    expect(fs.readFileSync(getConfigPath())).toEqual(configBefore);
    expect(fs.readFileSync(getStateDbPathInDataDir())).toEqual(stateBefore);
  });

  test("restore first captures a verified rescue run and publishes databases without old WAL sidecars", () => {
    writeConfig("0.8.0");
    seedPreCutoverState("before");
    const original = createMigrationBackup();

    const live = new Database(getStateDbPathInDataDir());
    live.exec("PRAGMA journal_mode=WAL; UPDATE durable SET value='after'");
    live.close();
    writeConfig("0.9.0");

    const restored = restoreMigrationBackup(true, original.manifest.runId);
    expect(restored.rescuePath).toBeDefined();
    expect(verifyMigrationBackup(restored.rescuePath as string).runId).not.toBe(original.manifest.runId);
    expect(readDurable(getStateDbPathInDataDir())).toBe("before");
    expect(fs.existsSync(`${getStateDbPathInDataDir()}-wal`)).toBe(false);
    expect(fs.existsSync(`${getStateDbPathInDataDir()}-shm`)).toBe(false);

    const rescueRunId = path.basename(restored.rescuePath as string);
    restoreMigrationBackup(true, rescueRunId);
    expect(readDurable(getStateDbPathInDataDir())).toBe("after");
  });

  test("restore rolls back an interrupted journal before taking its rescue snapshot", () => {
    writeConfig("0.8.0");
    seedPreCutoverState("before");
    const original = createMigrationBackup();

    const live = new Database(getStateDbPathInDataDir());
    live.exec("UPDATE durable SET value='after'");
    live.close();

    const operationId = "interrupted";
    const entries = restoreJournalEntries(original, operationId);
    materializeRestoreStages(original, entries);
    const stateEntry = entries.find((entry) => entry.destination === getStateDbPathInDataDir()) as Record<
      string,
      unknown
    >;
    fs.renameSync(getStateDbPathInDataDir(), stateEntry.quarantine as string);
    fs.renameSync(stateEntry.stage as string, getStateDbPathInDataDir());
    writeRestoreJournal(original, operationId, { entries });

    const restored = restoreMigrationBackup(true, original.manifest.runId);
    expect(readDurable(getStateDbPathInDataDir())).toBe("before");
    expect(readDurable(path.join(restored.rescuePath as string, "state.db"))).toBe("after");
    expect(fs.existsSync(path.join(getMigrationBackupRoot(), "restore-active.json"))).toBe(false);
  });

  for (const boundary of [
    "0:destination",
    "0:stage",
    "1:destination",
    "1:stage",
    "1:sidecar:0",
    "1:sidecar:1",
    "2:destination",
    "2:stage",
    "2:sidecar:0",
    "2:sidecar:1",
    "before-journal-delete",
  ]) {
    test(`prepared restore rollback resumes idempotently after ${boundary}`, () => {
      writeConfig("0.8.0");
      seedPreCutoverState("before");
      const source = createMigrationBackup();
      const live = new Database(getStateDbPathInDataDir());
      live.exec("UPDATE durable SET value='after'");
      live.close();
      const operationId = `rollback-${boundary.replaceAll(":", "-")}`;
      const entries = restoreJournalEntries(source, operationId);
      materializeRestoreStages(source, entries);
      publishRestoreEntries(entries);
      writeRestoreJournal(source, operationId, { phase: "prepared", entries });

      _setRestoreRollbackBoundaryHookForTests((current) => {
        if (current === boundary) throw new Error(`injected rollback crash at ${boundary}`);
      });
      try {
        expect(() => restoreMigrationBackup(true, source.manifest.runId)).toThrow(/injected rollback crash/i);
      } finally {
        _setRestoreRollbackBoundaryHookForTests();
      }

      const restored = restoreMigrationBackup(true, source.manifest.runId);
      expect(readDurable(getStateDbPathInDataDir())).toBe("before");
      expect(readDurable(path.join(restored.rescuePath as string, "state.db"))).toBe("after");
      expect(fs.existsSync(getMigrationRestoreJournalPath())).toBe(false);
    });
  }

  test("prepared rollback rejects a substituted same-ledger destination after quarantine restoration", () => {
    writeConfig("0.8.0");
    seedPreCutoverState("before");
    const source = createMigrationBackup();
    const live = new Database(getStateDbPathInDataDir());
    live.exec("UPDATE durable SET value='after'");
    live.close();
    const operationId = "rollback-substitution";
    const entries = restoreJournalEntries(source, operationId);
    materializeRestoreStages(source, entries);
    publishRestoreEntries(entries);
    writeRestoreJournal(source, operationId, { phase: "prepared", entries });

    _setRestoreRollbackBoundaryHookForTests((current) => {
      if (current === "1:destination") throw new Error("injected rollback crash");
    });
    try {
      expect(() => restoreMigrationBackup(true, source.manifest.runId)).toThrow(/injected rollback crash/i);
    } finally {
      _setRestoreRollbackBoundaryHookForTests();
    }
    const substituted = new Database(getStateDbPathInDataDir());
    substituted.exec("UPDATE durable SET value='evil!' ");
    substituted.close();
    const before = fs.readFileSync(getStateDbPathInDataDir());

    expect(() => restoreMigrationBackup(true, source.manifest.runId)).toThrow(/original generation|stale|fingerprint/i);
    expect(fs.readFileSync(getStateDbPathInDataDir())).toEqual(before);
    expect(fs.existsSync(getMigrationRestoreJournalPath())).toBe(true);
  });

  test("restore completes cleanup after a crash in the durable committed phase", () => {
    writeConfig("0.8.0");
    seedPreCutoverState("before");
    const original = createMigrationBackup();

    const live = new Database(getStateDbPathInDataDir());
    live.exec("UPDATE durable SET value='after'");
    live.close();

    const operationId = "committed";
    const entries = restoreJournalEntries(original, operationId);
    materializeRestoreStages(original, entries);
    publishRestoreEntries(entries);
    const stateEntry = entries.find((entry) => entry.destination === getStateDbPathInDataDir()) as Record<
      string,
      unknown
    >;
    const quarantine = stateEntry.quarantine as string;
    writeRestoreJournal(original, operationId, { phase: "committed", entries });

    const restored = restoreMigrationBackup(true, original.manifest.runId);
    expect(readDurable(path.join(restored.rescuePath as string, "state.db"))).toBe("before");
    expect(readDurable(getStateDbPathInDataDir())).toBe("before");
    expect(fs.existsSync(quarantine)).toBe(false);
    expect(fs.existsSync(path.join(getMigrationBackupRoot(), "restore-active.json"))).toBe(false);
  });

  for (const artifact of ["config.json", "state.db", "workflow.db"] as const) {
    test(`committed restore recovery authenticates published ${artifact} before deleting rescue data`, () => {
      writeConfig("0.8.0");
      seedPreCutoverState("before");
      if (artifact === "workflow.db") seedPreCutoverWorkflow();
      const source = createMigrationBackup();

      const live = new Database(getStateDbPathInDataDir());
      live.exec("UPDATE durable SET value='after'");
      live.close();
      const rescue = createMigrationBackup();
      const operationId = `tampered-${artifact.replace(".", "-")}`;
      const entries = restoreJournalEntries(source, operationId);
      materializeRestoreStages(source, entries);
      publishRestoreEntries(entries);
      const journalPath = writeRestoreJournal(source, operationId, {
        phase: "committed",
        rescueRunId: rescue.manifest.runId,
        entries,
      });
      if (artifact === "config.json") {
        fs.appendFileSync(getConfigPath(), " \n");
      } else {
        const published = new Database(artifact === "state.db" ? getStateDbPathInDataDir() : getLegacyWorkflowDbPath());
        if (artifact === "state.db") published.exec("UPDATE durable SET value='tampered'");
        else published.exec("CREATE TABLE committed_tamper(value TEXT)");
        published.close();
      }

      expect(() => restoreMigrationBackup(true, source.manifest.runId)).toThrow(/checksum|published|tamper|verify/i);
      expect(fs.existsSync(journalPath)).toBe(true);
      const artifactDestination =
        artifact === "config.json"
          ? getConfigPath()
          : artifact === "state.db"
            ? getStateDbPathInDataDir()
            : getLegacyWorkflowDbPath();
      const artifactEntry = entries.find((entry) => entry.destination === artifactDestination) as Record<
        string,
        unknown
      >;
      expect(fs.existsSync(artifactEntry.quarantine as string)).toBe(true);
      expect(verifyMigrationBackup(rescue.path).runId).toBe(rescue.manifest.runId);
    });
  }

  test("oversized restore journal is rejected before canonical artifacts change", () => {
    writeConfig("0.8.0");
    seedPreCutoverState("live");
    const backup = createMigrationBackup();
    const configBefore = fs.readFileSync(getConfigPath());
    const stateBefore = fs.readFileSync(getStateDbPathInDataDir());
    const journalPath = writeRestoreJournal(backup, "oversized-restore");
    fs.appendFileSync(journalPath, " ".repeat(2 * 1024 * 1024));

    expect(() => restoreMigrationBackup(true, backup.manifest.runId)).toThrow(/exceed|too large|limit/i);
    expect(fs.readFileSync(getConfigPath())).toEqual(configBefore);
    expect(fs.readFileSync(getStateDbPathInDataDir())).toEqual(stateBefore);
    expect(fs.existsSync(journalPath)).toBe(true);
  });

  test("restore recovery rejects an operation-unbound quarantine path without changing any path", () => {
    writeConfig("0.8.0");
    seedPreCutoverState("live");
    const backup = createMigrationBackup();
    const operationId = "malicious-path";
    const victim = path.join(path.dirname(getConfigPath()), "arbitrary-victim.txt");
    fs.writeFileSync(victim, "do-not-move");
    const configBefore = fs.readFileSync(getConfigPath());
    const stateBefore = fs.readFileSync(getStateDbPathInDataDir());
    const entries = restoreJournalEntries(backup, operationId);
    (entries.find((entry) => entry.destination === getStateDbPathInDataDir()) as Record<string, unknown>).quarantine =
      victim;
    const journalPath = writeRestoreJournal(backup, operationId, { entries });

    expect(() => restoreMigrationBackup(true, backup.manifest.runId)).toThrow(/restore journal|quarantine|operation/i);
    expect(fs.readFileSync(getConfigPath())).toEqual(configBefore);
    expect(fs.readFileSync(getStateDbPathInDataDir())).toEqual(stateBefore);
    expect(fs.readFileSync(victim, "utf8")).toBe("do-not-move");
    expect(fs.existsSync(journalPath)).toBe(true);
  });

  test("restore recovery does not delete an arbitrary path supplied as a stage", () => {
    writeConfig("0.8.0");
    seedPreCutoverState("live");
    const backup = createMigrationBackup();
    const operationId = "malicious-stage";
    const victim = path.join(path.dirname(getConfigPath()), "arbitrary-stage-victim.txt");
    fs.writeFileSync(victim, "do-not-delete");
    const entries = restoreJournalEntries(backup, operationId);
    (entries.find((entry) => entry.destination === getStateDbPathInDataDir()) as Record<string, unknown>).stage =
      victim;
    const stateBefore = fs.readFileSync(getStateDbPathInDataDir());
    const journalPath = writeRestoreJournal(backup, operationId, { entries });

    expect(() => restoreMigrationBackup(true, backup.manifest.runId)).toThrow(/restore journal|stage|operation/i);
    expect(fs.readFileSync(getStateDbPathInDataDir())).toEqual(stateBefore);
    expect(fs.readFileSync(victim, "utf8")).toBe("do-not-delete");
    expect(fs.existsSync(journalPath)).toBe(true);
  });

  test("restore recovery rejects malformed versions, phases, entry sets, and sidecars before mutation", () => {
    writeConfig("0.8.0");
    seedPreCutoverState("live");
    const backup = createMigrationBackup();
    const configBefore = fs.readFileSync(getConfigPath());
    const stateBefore = fs.readFileSync(getStateDbPathInDataDir());
    const entries = restoreJournalEntries(backup, "malformed");
    const duplicateSidecars = structuredClone(entries);
    const stateEntry = duplicateSidecars.find((entry) => entry.destination === getStateDbPathInDataDir()) as Record<
      string,
      unknown
    >;
    (stateEntry.sidecars as unknown[])[1] = structuredClone((stateEntry.sidecars as unknown[])[0]);

    const malformed = [
      { formatVersion: 99 },
      { version: "0.8.0" },
      { phase: "rollback-everything" },
      { entries: entries.slice(0, 2) },
      { entries: duplicateSidecars },
    ];
    let journalPath = "";
    for (const overrides of malformed) {
      journalPath = writeRestoreJournal(backup, "malformed", overrides);
      expect(() => restoreMigrationBackup(true, backup.manifest.runId)).toThrow(
        /restore journal|format|version|phase/i,
      );
      expect(fs.readFileSync(getConfigPath())).toEqual(configBefore);
      expect(fs.readFileSync(getStateDbPathInDataDir())).toEqual(stateBefore);
      expect(fs.existsSync(journalPath)).toBe(true);
    }

    expect(fs.existsSync(journalPath)).toBe(true);
  });

  test("restore recovery rejects a stale prepared journal without recreating an absent database", () => {
    writeConfig("0.8.0");
    seedPreCutoverState("live");
    const backup = createMigrationBackup();
    const operationId = "stale";
    const entries = restoreJournalEntries(backup, operationId);
    materializeRestoreStages(backup, entries);
    fs.rmSync(getStateDbPathInDataDir(), { force: true });
    const configBefore = fs.readFileSync(getConfigPath());
    const journalPath = writeRestoreJournal(backup, operationId, { entries });

    expect(() => restoreMigrationBackup(true, backup.manifest.runId)).toThrow(/stale|restore journal|missing/i);
    expect(fs.readFileSync(getConfigPath())).toEqual(configBefore);
    expect(fs.existsSync(getStateDbPathInDataDir())).toBe(false);
    expect(fs.existsSync(journalPath)).toBe(true);
  });

  test("verification rejects a checksum-authenticated corrupt SQLite snapshot", () => {
    writeConfig("0.8.0");
    seedPreCutoverState();
    const backup = createMigrationBackup();
    const snapshotPath = path.join(backup.path, "state.db");
    const bytes = fs.readFileSync(snapshotPath);
    fs.writeFileSync(snapshotPath, bytes.subarray(0, Math.max(100, Math.floor(bytes.length / 2))));

    const manifestPath = path.join(backup.path, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.artifacts["state.db"].byteSize = fs.statSync(snapshotPath).size;
    manifest.artifacts["state.db"].sha256 = crypto
      .createHash("sha256")
      .update(fs.readFileSync(snapshotPath))
      .digest("hex");
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

    expect(() => verifyMigrationBackup(backup.path)).toThrow(/SQLite|quick_check|corrupt|malformed/i);
  });

  test("backup and restore implementation does not whole-file read database artifacts", () => {
    const source = fs.readFileSync(path.resolve(import.meta.dir, "../../src/core/migration-backup.ts"), "utf8");
    expect(source).not.toMatch(/readFileSync\((?:filePath|source)\)/);
    expect(source).not.toMatch(/writeFileAtomic\([^\n]+fs\.readFileSync/);
  });
});
