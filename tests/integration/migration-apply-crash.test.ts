// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { canonicalStateGenerationSha256 } from "../../src/cli/config-migrate";
import {
  fingerprintMigrationGeneration,
  getMigrationApplyJournalPath,
  inspectMigrationState,
} from "../../src/core/migration-backup";
import { getConfigPath, getDbPath, getStateDbPathInDataDir } from "../../src/core/paths";
import { openStateDatabase } from "../../src/core/state-db";
import { getLegacyWorkflowDbPath } from "../../src/migrate/legacy/legacy-paths";
import {
  FROZEN_WORKFLOW_BASE_SCHEMA_DDL,
  FROZEN_WORKFLOW_MIGRATIONS,
} from "../../src/migrate/legacy/workflow-migrations-bodies";
import { type Database as AkmDatabase, openDatabaseFinalizing } from "../../src/storage/database";
import { runMigrations as runSqliteMigrations } from "../../src/storage/engines/sqlite-migrations";
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
  const workflow = new Database(getLegacyWorkflowDbPath());
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

async function commitExternalWal(
  statePath: string,
  holdOpen: boolean,
): Promise<ReturnType<typeof Bun.spawn> | undefined> {
  const writerPath = path.join(path.dirname(getConfigPath()), `external-wal-${holdOpen ? "open" : "closed"}.ts`);
  const readyPath = `${writerPath}.ready`;
  fs.writeFileSync(
    writerPath,
    [
      'import { Database } from "bun:sqlite";',
      'import fs from "node:fs";',
      "const db = new Database(process.argv[2]);",
      'db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");',
      'db.exec("CREATE TABLE IF NOT EXISTS external_commits(value TEXT PRIMARY KEY)");',
      'db.prepare("INSERT INTO external_commits(value) VALUES (?)").run(process.argv[4]);',
      'fs.writeFileSync(process.argv[3], "ready\\n");',
      'if (process.argv[5] === "open") {',
      '  process.on("SIGTERM", () => { db.close(); process.exit(0); });',
      "  setInterval(() => {}, 1000);",
      "} else {",
      "  db.close();",
      "}",
      "",
    ].join("\n"),
  );
  const writer = Bun.spawn(
    ["bun", writerPath, statePath, readyPath, holdOpen ? "open-writer" : "closed-writer", holdOpen ? "open" : "closed"],
    { stdout: "pipe", stderr: "pipe" },
  );
  for (let attempt = 0; attempt < 200 && !fs.existsSync(readyPath); attempt += 1) await Bun.sleep(10);
  expect(fs.existsSync(readyPath)).toBe(true);
  if (holdOpen) return writer;
  const [code, , stderr] = await Promise.all([
    writer.exited,
    new Response(writer.stdout).text(),
    new Response(writer.stderr).text(),
  ]);
  expect(code, stderr).toBe(0);
  return undefined;
}

function createCurrentWorkflowWithRun(runId: string): void {
  const workflow = openDatabaseFinalizing(getLegacyWorkflowDbPath());
  try {
    workflow.exec(FROZEN_WORKFLOW_BASE_SCHEMA_DDL);
    runSqliteMigrations(workflow, FROZEN_WORKFLOW_MIGRATIONS);
    workflow.run(
      "INSERT INTO workflow_runs(id, workflow_ref, workflow_title, status, params_json, created_at, updated_at) VALUES (?, ?, ?, 'active', '{}', ?, ?)",
      runId,
      "workflows/external",
      "External workflow",
      "2026-07-22T12:00:00.000Z",
      "2026-07-22T12:00:00.000Z",
    );
  } finally {
    workflow.close();
  }
}

describe("cross-artifact migration apply crash recovery", () => {
  test("canonical state generations stream rows and distinguish exact 64-bit integers", () => {
    const db = openDatabaseFinalizing(":memory:");
    try {
      db.exec(`
        CREATE TABLE exact_values(generation INTEGER NOT NULL, payload BLOB NOT NULL);
        INSERT INTO exact_values VALUES (9007199254740992, zeroblob(1048576));
      `);
      const streamingDb = {
        prepare<Row>(sql: string) {
          const statement = db.prepare<Row>(sql);
          return {
            get: statement.get.bind(statement),
            all: () => {
              throw new Error("canonical state digest must not materialize result sets");
            },
            iterate: statement.iterate.bind(statement),
            run: statement.run.bind(statement),
          };
        },
      } as unknown as AkmDatabase;

      const first = canonicalStateGenerationSha256(streamingDb);
      db.exec("UPDATE exact_values SET generation=9007199254740993");
      const second = canonicalStateGenerationSha256(streamingDb);
      expect(first).not.toBe(second);
    } finally {
      db.close();
    }
  });

  test("canonical state generations distinguish invalid UTF-8 TEXT bytes", () => {
    const db = openDatabaseFinalizing(":memory:");
    try {
      db.exec("CREATE TABLE invalid_text(value TEXT NOT NULL); INSERT INTO invalid_text VALUES (CAST(x'80' AS TEXT))");
      const first = canonicalStateGenerationSha256(db);
      db.exec("UPDATE invalid_text SET value=CAST(x'81' AS TEXT)");
      const second = canonicalStateGenerationSha256(db);
      expect(first).not.toBe(second);
    } finally {
      db.close();
    }
  });

  test("canonical state generations include one exact implicit rowid", () => {
    const db = openDatabaseFinalizing(":memory:");
    try {
      db.exec(`
        CREATE TABLE rowid_values(value TEXT NOT NULL);
        INSERT INTO rowid_values(rowid, value) VALUES (9007199254740992, 'same');
        CREATE TABLE integer_primary_key(id INTEGER PRIMARY KEY, value TEXT);
        INSERT INTO integer_primary_key VALUES (7, 'ipk');
        CREATE TABLE without_rowid(id TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;
        INSERT INTO without_rowid VALUES ('id', 'wr');
      `);
      const first = canonicalStateGenerationSha256(db);
      db.exec("UPDATE rowid_values SET rowid=9007199254740993");
      const second = canonicalStateGenerationSha256(db);
      expect(first).not.toBe(second);
    } finally {
      db.close();
    }
  });

  test("canonical state generation fails closed when every implicit rowid alias is shadowed", () => {
    const db = openDatabaseFinalizing(":memory:");
    try {
      db.exec('CREATE TABLE shadowed_rowid("rowid" TEXT, "_rowid_" TEXT, "oid" TEXT)');
      expect(() => canonicalStateGenerationSha256(db)).toThrow(/all implicit rowid aliases are shadowed/i);
    } finally {
      db.close();
    }
  });

  // Chunk 8, WI-8.2: "cutover" is the three-DB merge phase, inserted after
  // workflow-applied. A SIGKILL right after it advances resumes cleanly through
  // config → tasks → pilot → committed. After the cutover, workflow.db is DELETED
  // (its rows are merged into state.db), so the post-apply workflow artifact status is
  // "missing" — the intended terminal state, not a failure.
  //
  // WI-8.3 backward-read: the `workflow` phase now rolls the pre-cutover
  // workflow.db to 010 via the FROZEN migration bodies (src/workflows/db.ts is
  // deleted), NOT the live array. The CRASH_AFTER="workflow" case pins that a
  // journal at phase "workflow-applied" resumes forward into cutover-applied →
  // committed (workflow ends "missing") — the required journal backward-read.
  for (const phase of ["state", "workflow", "cutover", "config", "tasks", "pilot"] as const) {
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
        workflow: { status: "missing" }, // deleted by the three-DB cutover
      });
      expect(fs.existsSync(getMigrationApplyJournalPath())).toBe(false);
    }, 20_000);
  }

  for (const boundary of ["after-marker", "after-conversion"] as const) {
    test(`resumes after SIGKILL ${boundary} in the state conversion phase`, async () => {
      const prepared = seed();
      const child = Bun.spawn(["bun", "src/cli.ts", "migrate", "apply", "--config", prepared], {
        cwd: path.resolve(import.meta.dir, "../.."),
        env: {
          ...process.env,
          ...(boundary === "after-marker"
            ? { AKM_TEST_MIGRATION_CRASH_AFTER: "state-converting" }
            : { AKM_TEST_MIGRATION_CRASH_GAP: "state-converting" }),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(JSON.parse(fs.readFileSync(getMigrationApplyJournalPath(), "utf8")).phase).toBe(
        boundary === "after-marker" ? "state-converting" : "state-collapsing",
      );

      const resumed = await runCliCapture(["migrate", "apply"]);
      expect(resumed.code, resumed.stderr).toBe(0);
      expect(inspectMigrationState()).toMatchObject({
        config: { status: "current" },
        state: { status: "current" },
        workflow: { status: "missing" },
      });
      expect(fs.existsSync(getMigrationApplyJournalPath())).toBe(false);
    }, 20_000);
  }

  test("recovers when the bound conversion marker commits before its journal generation update", async () => {
    const prepared = seed();
    const child = Bun.spawn(["bun", "src/cli.ts", "migrate", "apply", "--config", prepared], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: { ...process.env, AKM_TEST_MIGRATION_CRASH_GAP: "state-marker" },
      stdout: "pipe",
      stderr: "pipe",
    });
    await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);

    const journalPath = getMigrationApplyJournalPath();
    expect(JSON.parse(fs.readFileSync(journalPath, "utf8")).phase).toBe("state-converting");
    const state = new Database(getStateDbPathInDataDir(), { readonly: true });
    try {
      expect(
        state.query("SELECT operation_id, phase, generation_sha256 FROM akm_migration_generation").get(),
      ).toMatchObject({ phase: "state-converting", generation_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    } finally {
      state.close();
    }

    const resumed = await runCliCapture(["migrate", "apply"]);
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(fs.existsSync(journalPath)).toBe(false);
  }, 20_000);

  test("resumes an exact marker-bound generation before conversion starts", async () => {
    const prepared = seed();
    const child = Bun.spawn(["bun", "src/cli.ts", "migrate", "apply", "--config", prepared], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: { ...process.env, AKM_TEST_MIGRATION_CRASH_AFTER: "state-marker" },
      stdout: "pipe",
      stderr: "pipe",
    });
    await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);

    const journalPath = getMigrationApplyJournalPath();
    expect(JSON.parse(fs.readFileSync(journalPath, "utf8")).phase).toBe("state-collapsing");
    const generationBefore = fs.readFileSync(journalPath);
    const resumed = await runCliCapture(["migrate", "apply"]);
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(generationBefore.byteLength).toBeGreaterThan(0);
    expect(fs.existsSync(journalPath)).toBe(false);
  }, 20_000);

  test("migrate status authenticates committed WAL state without creating source sidecars", async () => {
    const prepared = seed();
    const statePath = getStateDbPathInDataDir();
    const keeper = new Database(statePath);
    try {
      keeper.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA wal_checkpoint(TRUNCATE)");
      const child = Bun.spawn(["bun", "src/cli.ts", "migrate", "apply", "--config", prepared], {
        cwd: path.resolve(import.meta.dir, "../.."),
        env: { ...process.env, AKM_TEST_MIGRATION_CRASH_GAP: "state-marker" },
        stdout: "pipe",
        stderr: "pipe",
      });
      await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);

      const journal = JSON.parse(fs.readFileSync(getMigrationApplyJournalPath(), "utf8")) as { phase: string };
      expect(journal.phase).toBe("state-converting");
      const walPath = `${statePath}-wal`;
      const shmPath = `${statePath}-shm`;
      expect(fs.existsSync(walPath)).toBe(true);
      fs.rmSync(shmPath, { force: true });
      const mainBefore = fs.readFileSync(statePath);
      const walBefore = fs.readFileSync(walPath);

      const status = await runCliCapture(["migrate", "status"]);
      expect(status.code, status.stderr).toBe(0);
      expect(status.stdout).toContain('"phase":"state-converting"');
      expect(fs.existsSync(shmPath)).toBe(false);
      expect(fs.readFileSync(statePath)).toEqual(mainBefore);
      expect(fs.readFileSync(walPath)).toEqual(walBefore);
    } finally {
      keeper.close();
    }
  }, 20_000);

  test("post-cutover status inspects committed WAL through private artifact snapshots", async () => {
    const prepared = seed();
    const child = Bun.spawn(["bun", "src/cli.ts", "migrate", "apply", "--config", prepared], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: { ...process.env, AKM_TEST_MIGRATION_CRASH_AFTER: "cutover" },
      stdout: "pipe",
      stderr: "pipe",
    });
    await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);

    const statePath = getStateDbPathInDataDir();
    const mainState = new Database(statePath);
    const lastMigration = mainState
      .query("SELECT id, applied_at, checksum FROM schema_migrations ORDER BY rowid DESC LIMIT 1")
      .get() as { id: string; applied_at: string; checksum: string };
    mainState.run("DELETE FROM schema_migrations WHERE id=?", [lastMigration.id]);
    mainState.close();

    const stateWriter = new Database(statePath);
    const indexWriter = new Database(getDbPath());
    try {
      stateWriter.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
      stateWriter.run("INSERT INTO schema_migrations(id, applied_at, checksum) VALUES (?, ?, ?)", [
        lastMigration.id,
        lastMigration.applied_at,
        lastMigration.checksum,
      ]);
      indexWriter.exec(`
        PRAGMA journal_mode=WAL;
        PRAGMA wal_autocheckpoint=0;
        PRAGMA wal_checkpoint(TRUNCATE);
        CREATE TABLE status_wal_probe(value TEXT);
        INSERT INTO status_wal_probe VALUES ('committed');
      `);
      for (const dbPath of [statePath, getDbPath()]) fs.rmSync(`${dbPath}-shm`, { force: true });
      const sourceFiles = (dbPath: string): Map<string, Buffer> =>
        new Map(
          [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]
            .filter((filePath) => fs.existsSync(filePath))
            .map((filePath) => [filePath, fs.readFileSync(filePath)]),
        );
      const stateBefore = sourceFiles(statePath);
      const indexBefore = sourceFiles(getDbPath());
      expect(fs.existsSync(`${statePath}-wal`)).toBe(true);
      expect(fs.existsSync(`${getDbPath()}-wal`)).toBe(true);

      const status = await runCliCapture(["migrate", "status"]);
      expect(status.code, status.stderr).toBe(0);
      expect(status.stdout).toContain('"phase":"cutover-applied"');
      expect(sourceFiles(statePath)).toEqual(stateBefore);
      expect(sourceFiles(getDbPath())).toEqual(indexBefore);
      expect(fs.existsSync(`${statePath}-shm`)).toBe(false);
      expect(fs.existsSync(`${getDbPath()}-shm`)).toBe(false);
    } finally {
      stateWriter.close();
      indexWriter.close();
    }
  }, 20_000);

  for (const externalWrite of [false, true]) {
    test(externalWrite
      ? "rejects a logical write after the checkpointed WAL intermediate"
      : "resumes a checkpointed WAL intermediate", async () => {
      const prepared = seed();
      const statePath = getStateDbPathInDataDir();
      const keeper = new Database(statePath);
      expect(keeper.query("PRAGMA journal_mode=WAL").get()).toEqual({ journal_mode: "wal" });
      keeper.exec("PRAGMA wal_autocheckpoint=0");

      const child = Bun.spawn(["bun", "src/cli.ts", "migrate", "apply", "--config", prepared], {
        cwd: path.resolve(import.meta.dir, "../.."),
        env: { ...process.env, AKM_TEST_MIGRATION_CRASH_GAP: "state-checkpoint" },
        stdout: "pipe",
        stderr: "pipe",
      });
      await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      keeper.close();

      const journalPath = getMigrationApplyJournalPath();
      const journalBefore = fs.readFileSync(journalPath);
      const journal = JSON.parse(journalBefore.toString()) as {
        backupPath: string;
        phase: string;
        generation: ReturnType<typeof fingerprintMigrationGeneration>;
      };
      expect(journal.phase).toBe("state-collapsing");
      expect(journal.generation.state).not.toEqual(fingerprintMigrationGeneration().state);
      const header = fs.readFileSync(statePath).subarray(0, 20);
      expect(header[18] === 2 || header[19] === 2).toBe(true);

      if (externalWrite) {
        const external = new Database(statePath);
        external.exec(
          "CREATE TABLE post_checkpoint_external(value TEXT); INSERT INTO post_checkpoint_external VALUES ('preserve-me')",
        );
        external.close();
      }

      const resumed = await runCliCapture(["migrate", "apply"]);
      if (externalWrite) {
        expect(resumed.code).not.toBe(0);
        expect(resumed.stderr).toMatch(/exact (marker-bound|logical generation bound)/i);
        expect(fs.readFileSync(journalPath)).toEqual(journalBefore);
        expect(fs.existsSync(journal.backupPath)).toBe(true);
        const preserved = new Database(statePath, { readonly: true });
        try {
          expect(preserved.query("SELECT value FROM post_checkpoint_external").get()).toEqual({
            value: "preserve-me",
          });
        } finally {
          preserved.close();
        }
      } else {
        expect(resumed.code, resumed.stderr).toBe(0);
        expect(fs.existsSync(journalPath)).toBe(false);
        expect(inspectMigrationState()).toMatchObject({
          config: { status: "current" },
          state: { status: "current" },
          workflow: { status: "missing" },
        });
      }
    }, 20_000);
  }

  test("rejects an external mutation between distinct unsafe 64-bit integers", async () => {
    const prepared = seed();
    const state = new Database(getStateDbPathInDataDir());
    state.exec(`
      CREATE TABLE exact_generation(value INTEGER NOT NULL);
      INSERT INTO exact_generation VALUES (9007199254740992);
    `);
    state.close();

    const child = Bun.spawn(["bun", "src/cli.ts", "migrate", "apply", "--config", prepared], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: { ...process.env, AKM_TEST_MIGRATION_CRASH_AFTER: "state-marker" },
      stdout: "pipe",
      stderr: "pipe",
    });
    await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const journalPath = getMigrationApplyJournalPath();
    const journalBefore = fs.readFileSync(journalPath);

    const external = new Database(getStateDbPathInDataDir());
    external.exec("UPDATE exact_generation SET value=9007199254740993");
    external.close();

    const resumed = await runCliCapture(["migrate", "apply"]);
    expect(resumed.code).not.toBe(0);
    expect(resumed.stderr).toMatch(/exact (marker-bound|logical generation bound)/i);
    expect(fs.readFileSync(journalPath)).toEqual(journalBefore);
  }, 20_000);

  test("rejects and preserves an external implicit-rowid-only mutation", async () => {
    const prepared = seed();
    const state = new Database(getStateDbPathInDataDir());
    state.exec(`
      CREATE TABLE rowid_generation(value TEXT NOT NULL);
      INSERT INTO rowid_generation(rowid, value) VALUES (9007199254740992, 'unchanged');
    `);
    state.close();

    const child = Bun.spawn(["bun", "src/cli.ts", "migrate", "apply", "--config", prepared], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: { ...process.env, AKM_TEST_MIGRATION_CRASH_AFTER: "state-marker" },
      stdout: "pipe",
      stderr: "pipe",
    });
    await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const journalPath = getMigrationApplyJournalPath();
    const journalBefore = fs.readFileSync(journalPath);

    const external = new Database(getStateDbPathInDataDir());
    external.exec("UPDATE rowid_generation SET rowid=9007199254740993");
    external.close();

    const resumed = await runCliCapture(["migrate", "apply"]);
    expect(resumed.code).not.toBe(0);
    expect(resumed.stderr).toMatch(/exact (marker-bound|logical generation bound)/i);
    expect(fs.readFileSync(journalPath)).toEqual(journalBefore);
    const preserved = new Database(getStateDbPathInDataDir(), { readonly: true });
    try {
      expect(preserved.query("SELECT CAST(rowid AS TEXT) AS rowid, value FROM rowid_generation").get()).toEqual({
        rowid: "9007199254740993",
        value: "unchanged",
      });
    } finally {
      preserved.close();
    }
  }, 20_000);

  test("restores the backup when a resumed state collapse is followed by a pre-cutover failure", async () => {
    const prepared = seed({ failingWorkflow: true });
    const child = Bun.spawn(["bun", "src/cli.ts", "migrate", "apply", "--config", prepared], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: { ...process.env, AKM_TEST_MIGRATION_CRASH_AFTER: "state-marker" },
      stdout: "pipe",
      stderr: "pipe",
    });
    await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(JSON.parse(fs.readFileSync(getMigrationApplyJournalPath(), "utf8")).phase).toBe("state-collapsing");

    const resumed = await runCliCapture(["migrate", "apply"]);
    expect(resumed.code).not.toBe(0);
    expect(resumed.stderr).toMatch(/migration apply failed.*restored/i);
    expect(resumed.stderr).not.toMatch(/forward recovery|rollback could not complete/i);
    expect(fs.existsSync(getMigrationApplyJournalPath())).toBe(false);
    expect(inspectMigrationState()).toMatchObject({
      config: { status: "old" },
      state: { status: "old" },
      workflow: { status: "old" },
    });
  }, 20_000);

  for (const holdOpen of [false, true]) {
    test(`rejects WAL frames committed after an authentic conversion marker with the writer ${holdOpen ? "open" : "closed"}`, async () => {
      const prepared = seed();
      const child = Bun.spawn(["bun", "src/cli.ts", "migrate", "apply", "--config", prepared], {
        cwd: path.resolve(import.meta.dir, "../.."),
        env: { ...process.env, AKM_TEST_MIGRATION_CRASH_AFTER: "state-marker" },
        stdout: "pipe",
        stderr: "pipe",
      });
      await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);

      const journalPath = getMigrationApplyJournalPath();
      const journalBefore = fs.readFileSync(journalPath);
      const journal = JSON.parse(journalBefore.toString()) as { backupPath: string; phase: string };
      expect(journal.phase).toBe("state-collapsing");
      expect(fs.existsSync(journal.backupPath)).toBe(true);
      const writer = await commitExternalWal(getStateDbPathInDataDir(), holdOpen);
      try {
        const resumed = await runCliCapture(["migrate", "apply"]);
        expect(resumed.code).not.toBe(0);
        expect(resumed.stderr).toMatch(/exact (marker-bound|logical generation bound|live artifact generation)/i);
        expect(resumed.stderr).not.toMatch(/restored from/i);
        expect(fs.readFileSync(journalPath)).toEqual(journalBefore);
        expect(fs.existsSync(journal.backupPath)).toBe(true);
      } finally {
        if (writer) {
          writer.kill("SIGTERM");
          await writer.exited;
        }
      }
      const preserved = new Database(getStateDbPathInDataDir(), { readonly: true });
      try {
        expect(preserved.query("SELECT value FROM external_commits").get()).toEqual({
          value: holdOpen ? "open-writer" : "closed-writer",
        });
      } finally {
        preserved.close();
      }
      expect(fs.readFileSync(journalPath)).toEqual(journalBefore);
      expect(fs.existsSync(journal.backupPath)).toBe(true);
    }, 20_000);
  }

  for (const phase of ["state", "workflow", "cutover", "config"] as const) {
    test(`recovers a SIGKILL after durable ${phase} mutation but before phase advancement`, async () => {
      const prepared = seed();
      const child = Bun.spawn(["bun", "src/cli.ts", "migrate", "apply", "--config", prepared], {
        cwd: path.resolve(import.meta.dir, "../.."),
        env: { ...process.env, AKM_TEST_MIGRATION_CRASH_GAP: phase },
        stdout: "pipe",
        stderr: "pipe",
      });
      await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      // Chunk 8, WI-8.2: config is written in the phase AFTER the cutover, so the
      // config mutation gap now sits at journal phase "cutover-applied".
      const previousPhase =
        phase === "state"
          ? "state-collapsing"
          : phase === "workflow"
            ? "state-applied"
            : phase === "cutover"
              ? "workflow-applied"
              : "cutover-applied";
      expect(JSON.parse(fs.readFileSync(getMigrationApplyJournalPath(), "utf8")).phase).toBe(previousPhase);

      const resumed = await runCliCapture(["migrate", "apply"]);
      expect(resumed.code, resumed.stderr).toBe(0);
      expect(inspectMigrationState()).toMatchObject({
        config: { status: "current" },
        state: { status: "current" },
        workflow: { status: "missing" }, // deleted by the three-DB cutover
      });
      expect(fs.existsSync(getMigrationApplyJournalPath())).toBe(false);
    }, 20_000);
  }

  for (const workflowModified of [false, true]) {
    test(workflowModified
      ? "rejects a modified workflow database after cutover commit but before unlink"
      : "resumes an exact workflow database after cutover commit but before unlink", async () => {
      const prepared = seed();
      const child = Bun.spawn(["bun", "src/cli.ts", "migrate", "apply", "--config", prepared], {
        cwd: path.resolve(import.meta.dir, "../.."),
        env: { ...process.env, AKM_TEST_MIGRATION_CRASH_GAP: "cutover-commit" },
        stdout: "pipe",
        stderr: "pipe",
      });
      await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);

      const journalPath = getMigrationApplyJournalPath();
      const journalBefore = fs.readFileSync(journalPath);
      const journal = JSON.parse(journalBefore.toString()) as { backupPath: string; phase: string };
      const workflowPath = getLegacyWorkflowDbPath();
      expect(journal.phase).toBe("workflow-applied");
      expect(fs.existsSync(workflowPath)).toBe(true);

      if (workflowModified) {
        const external = new Database(workflowPath);
        external.prepare("INSERT INTO workflow_runs(id) VALUES (?)").run("external-before-unlink");
        external.close();
      }
      const workflowBeforeResume = fs.readFileSync(workflowPath);

      const resumed = await runCliCapture(["migrate", "apply"]);
      if (workflowModified) {
        expect(resumed.code).not.toBe(0);
        expect(resumed.stderr).toMatch(/generation|workflow\.db/i);
        expect(fs.readFileSync(workflowPath)).toEqual(workflowBeforeResume);
        expect(fs.readFileSync(journalPath)).toEqual(journalBefore);
        expect(fs.existsSync(journal.backupPath)).toBe(true);
        const preserved = new Database(workflowPath, { readonly: true });
        try {
          expect(preserved.query("SELECT id FROM workflow_runs WHERE id='external-before-unlink'").get()).toEqual({
            id: "external-before-unlink",
          });
        } finally {
          preserved.close();
        }
      } else {
        expect(resumed.code, resumed.stderr).toBe(0);
        expect(fs.existsSync(workflowPath)).toBe(false);
        expect(fs.existsSync(journalPath)).toBe(false);
      }
    }, 20_000);
  }

  test("rejects and preserves a workflow database recreated after cutover-applied", async () => {
    const prepared = seed();
    const child = Bun.spawn(["bun", "src/cli.ts", "migrate", "apply", "--config", prepared], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: { ...process.env, AKM_TEST_MIGRATION_CRASH_AFTER: "cutover" },
      stdout: "pipe",
      stderr: "pipe",
    });
    await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);

    const journalPath = getMigrationApplyJournalPath();
    const journalBefore = fs.readFileSync(journalPath);
    const journal = JSON.parse(journalBefore.toString()) as { backupPath: string; phase: string };
    const workflowPath = getLegacyWorkflowDbPath();
    expect(journal.phase).toBe("cutover-applied");
    expect(fs.existsSync(workflowPath)).toBe(false);
    createCurrentWorkflowWithRun("externally-recreated-run");
    const workflowBeforeResume = fs.readFileSync(workflowPath);

    const resumed = await runCliCapture(["migrate", "apply"]);
    expect(resumed.code).not.toBe(0);
    expect(resumed.stderr).toMatch(/does not authorize.*workflow\.db generation/i);
    expect(fs.readFileSync(workflowPath)).toEqual(workflowBeforeResume);
    expect(fs.readFileSync(journalPath)).toEqual(journalBefore);
    expect(fs.existsSync(journal.backupPath)).toBe(true);
    const preserved = new Database(workflowPath, { readonly: true });
    try {
      expect(preserved.query("SELECT id FROM workflow_runs WHERE id='externally-recreated-run'").get()).toEqual({
        id: "externally-recreated-run",
      });
    } finally {
      preserved.close();
    }
  }, 20_000);

  for (const scenario of ["missing-main", "missing-sidecars", "altered-retained"] as const) {
    test(`${scenario === "altered-retained" ? "rejects" : "resumes"} workflow partial unlink: ${scenario}`, async () => {
      const prepared = seed();
      const child = Bun.spawn(["bun", "src/cli.ts", "migrate", "apply", "--config", prepared], {
        cwd: path.resolve(import.meta.dir, "../.."),
        env: { ...process.env, AKM_TEST_MIGRATION_CRASH_GAP: "cutover-commit" },
        stdout: "pipe",
        stderr: "pipe",
      });
      await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);

      const journalPath = getMigrationApplyJournalPath();
      const workflowPath = getLegacyWorkflowDbPath();
      const walPath = `${workflowPath}-wal`;
      const shmPath = `${workflowPath}-shm`;
      fs.writeFileSync(walPath, "journal-authorized-wal");
      fs.writeFileSync(shmPath, "journal-authorized-shm");
      const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
        backupPath: string;
        generation: ReturnType<typeof fingerprintMigrationGeneration>;
      };
      journal.generation.workflow = fingerprintMigrationGeneration().workflow;
      fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

      if (scenario === "missing-main" || scenario === "altered-retained") fs.rmSync(workflowPath);
      if (scenario === "missing-sidecars") {
        fs.rmSync(walPath);
        fs.rmSync(shmPath);
      }
      if (scenario === "altered-retained") fs.writeFileSync(walPath, "externally-altered-wal");
      const journalBefore = fs.readFileSync(journalPath);
      const retainedBefore = new Map(
        [workflowPath, walPath, shmPath]
          .filter((filePath) => fs.existsSync(filePath))
          .map((filePath) => [filePath, fs.readFileSync(filePath)]),
      );

      const resumed = await runCliCapture(["migrate", "apply"]);
      if (scenario === "altered-retained") {
        expect(resumed.code).not.toBe(0);
        expect(resumed.stderr).toMatch(/generation|workflow\.db/i);
        expect(fs.readFileSync(journalPath)).toEqual(journalBefore);
        expect(fs.existsSync(journal.backupPath)).toBe(true);
        for (const [filePath, bytes] of retainedBefore) expect(fs.readFileSync(filePath)).toEqual(bytes);
      } else {
        expect(resumed.code, resumed.stderr).toBe(0);
        expect(fs.existsSync(journalPath)).toBe(false);
        for (const filePath of [workflowPath, walPath, shmPath]) expect(fs.existsSync(filePath)).toBe(false);
      }
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

  test("does not adopt an external committed WAL generation while state conversion has no marker", async () => {
    const prepared = seed();
    const statePath = getStateDbPathInDataDir();
    const walSetup = new Database(statePath);
    walSetup.exec("PRAGMA journal_mode=WAL");
    walSetup.close();

    const child = Bun.spawn(["bun", "src/cli.ts", "migrate", "apply", "--config", prepared], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: { ...process.env, AKM_TEST_MIGRATION_CRASH_AFTER: "state-converting" },
      stdout: "pipe",
      stderr: "pipe",
    });
    await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);

    const journalPath = getMigrationApplyJournalPath();
    const journalBefore = fs.readFileSync(journalPath);
    const journal = JSON.parse(journalBefore.toString()) as { backupPath: string; phase: string };
    expect(journal.phase).toBe("state-converting");
    expect(fs.existsSync(journal.backupPath)).toBe(true);

    const mainBefore = fs.readFileSync(statePath);
    const guard = new Database(statePath, { readonly: true });
    guard.exec("BEGIN");
    guard.query("SELECT COUNT(*) AS count FROM sqlite_master").get();
    const writerPath = path.join(path.dirname(getConfigPath()), "external-wal-writer.ts");
    fs.writeFileSync(
      writerPath,
      [
        'import { Database } from "bun:sqlite";',
        "const db = new Database(process.argv[2]);",
        'db.exec("PRAGMA wal_autocheckpoint=0");',
        "db.exec(\"CREATE TABLE external_commits(value TEXT); INSERT INTO external_commits VALUES ('preserve-me')\");",
        "db.close();",
        "",
      ].join("\n"),
    );
    const writer = Bun.spawn(["bun", writerPath, statePath], { stdout: "pipe", stderr: "pipe" });
    const [writerCode, , writerError] = await Promise.all([
      writer.exited,
      new Response(writer.stdout).text(),
      new Response(writer.stderr).text(),
    ]);
    expect(writerCode, writerError).toBe(0);
    expect(fs.readFileSync(statePath)).toEqual(mainBefore);
    expect(fs.existsSync(`${statePath}-wal`)).toBe(true);

    let resumed: Awaited<ReturnType<typeof runCliCapture>>;
    try {
      resumed = await runCliCapture(["migrate", "apply"]);
    } finally {
      guard.close();
    }

    expect(resumed.code).not.toBe(0);
    expect(resumed.stderr).toMatch(/exact live artifact generation|exact marker-bound generation/i);
    expect(fs.readFileSync(journalPath)).toEqual(journalBefore);
    expect(fs.existsSync(journal.backupPath)).toBe(true);
    const preserved = new Database(statePath, { readonly: true });
    try {
      expect(preserved.query("SELECT value FROM external_commits").get()).toEqual({ value: "preserve-me" });
    } finally {
      preserved.close();
    }
  }, 20_000);

  test("fails closed when the persisted cutover ref map is missing on resume", async () => {
    const prepared = seed();
    const child = Bun.spawn(["bun", "src/cli.ts", "migrate", "apply", "--config", prepared], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: { ...process.env, AKM_TEST_MIGRATION_CRASH_AFTER: "cutover" },
      stdout: "pipe",
      stderr: "pipe",
    });
    await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const journal = JSON.parse(fs.readFileSync(getMigrationApplyJournalPath(), "utf8")) as { operationId: string };
    const mapPath = path.join(
      path.dirname(getMigrationApplyJournalPath()),
      `cutover-refmap-${journal.operationId}.json`,
    );
    expect(fs.existsSync(mapPath)).toBe(true);
    fs.rmSync(mapPath);

    const resumed = await runCliCapture(["migrate", "apply"]);
    expect(resumed.code).not.toBe(0);
    expect(resumed.stderr).toMatch(/cutover ref map|ref map|recovery/i);
    expect(fs.existsSync(getMigrationApplyJournalPath())).toBe(true);
  }, 20_000);
});
