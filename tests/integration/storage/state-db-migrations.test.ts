// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Database as BunSqliteDatabase } from "bun:sqlite";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import {
  getStateMigrationSafety,
  STATE_MIGRATION_SAFETY_BY_ID,
  STATE_MIGRATIONS,
} from "../../../src/core/state/migrations";
import { openStateDatabase, upgradeHistoricalStateDatabase } from "../../../src/core/state-db";
import { type Database, openDatabase } from "../../../src/storage/database";
import { runMigrations } from "../../../src/storage/engines/sqlite-migrations";

const roots: string[] = [];
const VERIFIED_SAFETY_COPY_PREFIX = "Verified safety copy: ";

function statePath(prefix = "akm-state-migrations-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return path.join(root, "state.db");
}

function verifiedSafetyCopyPath(message: string): string | undefined {
  const lines = message.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] as string;
    const prefixIndex = line.lastIndexOf(VERIFIED_SAFETY_COPY_PREFIX);
    if (prefixIndex < 0) continue;
    const reportedPath = line.slice(prefixIndex + VERIFIED_SAFETY_COPY_PREFIX.length);
    return reportedPath.endsWith(".bak.") ? reportedPath.slice(0, -1) : undefined;
  }
  return undefined;
}

function migrationIndex(id: string): number {
  const index = STATE_MIGRATIONS.findIndex((migration) => migration.id === id);
  if (index < 0) throw new Error(`Missing state migration fixture ${id}`);
  return index;
}

function seedBefore018(file: string, marker = "seeded-before-018"): void {
  const before018 = STATE_MIGRATIONS.slice(0, migrationIndex("018-drop-dead-lane-schema"));
  const seeded = openDatabase(file);
  runMigrations(seeded, before018);
  seeded
    .prepare("INSERT INTO consolidation_judged (entry_key, content_hash, judged_at, outcome) VALUES (?, ?, ?, ?)")
    .run("memories/hostile", marker, "2026-08-24T03:00:00.000Z", "actioned");
  seeded.close();
}

function seedEmptyLedgerWithOperatorField(file: string, marker: string): void {
  const seeded = openDatabase(file);
  seeded.exec(`
    CREATE TABLE schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE task_history (
      task_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      failed_at TEXT,
      log_path TEXT,
      target_kind TEXT,
      target_ref TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      operator_secret TEXT NOT NULL
    );
    INSERT INTO task_history (
      task_id,
      status,
      started_at,
      metadata_json,
      operator_secret
    ) VALUES (
      'operator-task',
      'pending',
      '2026-08-24T03:00:00.000Z',
      '{}',
      '${marker}'
    );
  `);
  seeded.close();
}

function moveDatabaseFamily(from: string, to: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const source = `${from}${suffix}`;
    if (fs.existsSync(source)) fs.renameSync(source, `${to}${suffix}`);
  }
}

function waitForFile(file: string, timeoutMs = 2_000): void {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  if (!fs.existsSync(file)) throw new Error(`Timed out waiting for ${file}`);
}

afterEach(() => {
  mock.restore();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("state.db automatic migration boundary", () => {
  test("a managed open advances an exact older prefix and preserves unrelated durable rows", () => {
    const file = statePath();
    const prior = STATE_MIGRATIONS.slice(0, -1);
    const seeded = openDatabase(file);
    runMigrations(seeded, prior);
    seeded.exec("CREATE TABLE operator_probe (value TEXT NOT NULL); INSERT INTO operator_probe VALUES ('kept')");
    seeded.close();

    const upgraded = openStateDatabase(file);
    expect((upgraded.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number }).count).toBe(
      STATE_MIGRATIONS.length,
    );
    expect((upgraded.prepare("SELECT value FROM operator_probe").get() as { value: string }).value).toBe("kept");
    upgraded.close();
  });

  test("a fresh managed open installs the complete current ledger", () => {
    const db = openStateDatabase(statePath());
    const ids = db.prepare("SELECT id FROM schema_migrations ORDER BY rowid").all() as Array<{ id: string }>;
    expect(ids.map((row) => row.id)).toEqual(STATE_MIGRATIONS.map((migration) => migration.id));
    db.close();
  });

  test("SQLite in-memory opens never create or reuse a filesystem state.db", () => {
    const literalMemoryPath = path.resolve(":memory:");
    expect(fs.existsSync(literalMemoryPath)).toBe(false);

    const first = openStateDatabase(":memory:");
    first.exec("CREATE TABLE memory_probe (value TEXT NOT NULL); INSERT INTO memory_probe VALUES ('first')");
    first.close();

    expect(fs.existsSync(literalMemoryPath)).toBe(false);

    const second = openStateDatabase(":memory:");
    expect(second.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({
      count: STATE_MIGRATIONS.length,
    });
    expect(() => second.prepare("SELECT value FROM memory_probe").get()).toThrow(/no such table/i);
    second.close();

    expect(fs.existsSync(literalMemoryPath)).toBe(false);
  });

  test("an existing but genuinely empty database (no tables at all) migrates like a fresh file", () => {
    const file = statePath();
    openDatabase(file).close(); // creates an empty SQLite file, zero tables

    const db = openStateDatabase(file);
    const ids = db.prepare("SELECT id FROM schema_migrations ORDER BY rowid").all() as Array<{ id: string }>;
    expect(ids.map((row) => row.id)).toEqual(STATE_MIGRATIONS.map((migration) => migration.id));
    db.close();
  });

  test("an existing database with an empty akm table (present but zero rows) still requires an explicit upgrade", () => {
    const file = statePath();
    const seeded = openDatabase(file);
    seeded.exec("CREATE TABLE task_history (task_id TEXT PRIMARY KEY, status TEXT NOT NULL, started_at TEXT NOT NULL)");
    seeded.close();
    const before = createHash("sha256").update(fs.readFileSync(file)).digest("hex");

    let error: unknown;
    try {
      openStateDatabase(file).close();
    } catch (caught) {
      error = caught;
    }

    expect(error instanceof Error ? error.message : "").toMatch(/existing unversioned state\.db.*akm upgrade/i);
    expect(createHash("sha256").update(fs.readFileSync(file)).digest("hex")).toBe(before);
  });

  test("an existing database without a migration ledger is rejected without writing a byte", () => {
    const file = statePath();
    const seeded = openDatabase(file);
    seeded.exec("CREATE TABLE operator_probe (value TEXT NOT NULL); INSERT INTO operator_probe VALUES ('untouched')");
    seeded.close();
    const before = createHash("sha256").update(fs.readFileSync(file)).digest("hex");

    let error: unknown;
    try {
      openStateDatabase(file).close();
    } catch (caught) {
      error = caught;
    }

    expect(createHash("sha256").update(fs.readFileSync(file)).digest("hex")).toBe(before);
    expect(fs.existsSync(`${file}-wal`)).toBe(false);
    expect(fs.existsSync(`${file}-shm`)).toBe(false);
    const inspected = openDatabase(file, { readonly: true });
    expect(
      inspected
        .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
        .get(),
    ).toEqual({ count: 0 });
    expect(inspected.prepare("SELECT value FROM operator_probe").get()).toEqual({ value: "untouched" });
    inspected.close();
    expect(error instanceof Error ? error.message : "").toMatch(/existing unversioned state\.db.*akm upgrade/i);
  });

  test("explicit upgrade snapshots an existing unversioned database before migration 001", () => {
    const file = statePath();
    const seeded = openDatabase(file);
    seeded.exec("CREATE TABLE operator_probe (value TEXT NOT NULL); INSERT INTO operator_probe VALUES ('pre-ledger')");
    seeded.close();

    const result = upgradeHistoricalStateDatabase(file);

    expect(result.upgraded).toBe(true);
    expect(result.safetyCopyPath).toBeDefined();
    const safetyCopy = openDatabase(result.safetyCopyPath as string, { readonly: true });
    expect(safetyCopy.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    expect(
      safetyCopy
        .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
        .get(),
    ).toEqual({ count: 0 });
    expect(safetyCopy.prepare("SELECT value FROM operator_probe").get()).toEqual({ value: "pre-ledger" });
    safetyCopy.close();

    const current = openDatabase(file, { readonly: true });
    expect((current.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number }).count).toBe(
      STATE_MIGRATIONS.length,
    );
    expect(current.prepare("SELECT value FROM operator_probe").get()).toEqual({ value: "pre-ledger" });
    current.close();
  });

  test("an existing empty migration ledger is rejected as unversioned without writing a byte", () => {
    const file = statePath();
    seedEmptyLedgerWithOperatorField(file, "ordinary-empty-ledger");
    const before = createHash("sha256").update(fs.readFileSync(file)).digest("hex");

    let error: unknown;
    try {
      openStateDatabase(file).close();
    } catch (caught) {
      error = caught;
    }

    expect(error instanceof Error ? error.message : "").toMatch(/existing unversioned state\.db.*akm upgrade/i);
    expect(createHash("sha256").update(fs.readFileSync(file)).digest("hex")).toBe(before);
    expect(fs.existsSync(`${file}-wal`)).toBe(false);
    expect(fs.existsSync(`${file}-shm`)).toBe(false);
    const inspected = openDatabase(file, { readonly: true });
    expect(inspected.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 0 });
    expect(inspected.prepare("SELECT operator_secret FROM task_history").get()).toEqual({
      operator_secret: "ordinary-empty-ledger",
    });
    inspected.close();
  });

  test("explicit upgrade snapshots an existing empty ledger before migration 001", () => {
    const file = statePath();
    seedEmptyLedgerWithOperatorField(file, "upgrade-empty-ledger");

    const result = upgradeHistoricalStateDatabase(file);

    expect(result.upgraded).toBe(true);
    expect(result.safetyCopyPath).toStartWith(`${file}.pre-001-initial-schema.`);
    const safetyCopy = openDatabase(result.safetyCopyPath as string, { readonly: true });
    expect(safetyCopy.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    expect(safetyCopy.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 0 });
    expect(safetyCopy.prepare("SELECT operator_secret FROM task_history").get()).toEqual({
      operator_secret: "upgrade-empty-ledger",
    });
    safetyCopy.close();
  });

  test("an unversioned snapshot and migrations 001-002 share one writer-exclusion window", async () => {
    const file = statePath();
    const writerDoneFile = path.join(path.dirname(file), "pre-002-writer-done");
    seedEmptyLedgerWithOperatorField(file, "locked-through-002");
    const seeded = openDatabase(file);
    seeded.exec(`
      CREATE TABLE migration_002_race_probe (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL
      );
      INSERT INTO migration_002_race_probe(kind) VALUES ('seed');
      CREATE TRIGGER mark_migration_002
        AFTER INSERT ON schema_migrations
        WHEN NEW.id = '002-task-history-per-run'
      BEGIN
        INSERT INTO migration_002_race_probe(kind) VALUES ('migration-002');
      END;
    `);
    seeded.close();

    const writerScript = path.join(path.dirname(file), "pre-002-writer.mts");
    fs.writeFileSync(
      writerScript,
      `
      import { Database } from "bun:sqlite";
      import { writeFileSync } from "node:fs";
      const db = new Database(${JSON.stringify(file)});
      db.exec("PRAGMA busy_timeout = 5000");
      db.query("INSERT INTO migration_002_race_probe(kind) VALUES ('concurrent-writer')").run();
      db.close();
      writeFileSync(${JSON.stringify(writerDoneFile)}, "done");
    `,
      "utf8",
    );

    const originalExec = BunSqliteDatabase.prototype.exec;
    let writer: Worker | undefined;
    let writerExit: Promise<{ code: number; error: string }> | undefined;
    const exec = spyOn(BunSqliteDatabase.prototype, "exec").mockImplementation(function (
      this: BunSqliteDatabase,
      sql: string,
    ) {
      const result = originalExec.call(this, sql);
      if (sql === "COMMIT" && !writer) {
        writer = new Worker(pathToFileURL(writerScript));
        let workerError = "";
        writer.once("error", (error) => {
          workerError = error.message;
        });
        writerExit = new Promise((resolve) => {
          writer?.once("exit", (code) => resolve({ code, error: workerError }));
        });
        waitForFile(writerDoneFile, 7_000);
      }
      return result;
    });

    let result: ReturnType<typeof upgradeHistoricalStateDatabase>;
    try {
      result = upgradeHistoricalStateDatabase(file);
    } finally {
      exec.mockRestore();
    }
    const writerResult = await Promise.race([
      writerExit ?? Promise.reject(new Error("Concurrent pre-002 writer was not started.")),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Concurrent pre-002 writer timed out.")), 7_000),
      ),
    ]);
    expect(writerResult).toEqual({ code: 0, error: "" });

    const safetyCopy = openDatabase(result.safetyCopyPath as string, { readonly: true });
    const backupMax = safetyCopy.prepare("SELECT MAX(id) AS id FROM migration_002_race_probe").get() as { id: number };
    expect(safetyCopy.prepare("SELECT operator_secret FROM task_history").get()).toEqual({
      operator_secret: "locked-through-002",
    });
    safetyCopy.close();

    const current = openDatabase(file, { readonly: true });
    const rows = current.prepare("SELECT id, kind FROM migration_002_race_probe ORDER BY id").all() as Array<{
      id: number;
      kind: string;
    }>;
    current.close();
    const migrationMarker = rows.find((row) => row.kind === "migration-002");
    const concurrentWriter = rows.find((row) => row.kind === "concurrent-writer");
    expect(migrationMarker?.id).toBe(backupMax.id + 1);
    expect(concurrentWriter?.id).toBeGreaterThan(migrationMarker?.id ?? Number.POSITIVE_INFINITY);
  });

  test("the migration writer lock retries a phantom BEGIN before running destructive SQL", () => {
    const file = statePath();
    const migrations = [
      {
        id: "001-lock-probe",
        up: "CREATE TABLE lock_probe (value TEXT NOT NULL, operator_secret TEXT NOT NULL);",
      },
      {
        id: "018-lock-probe",
        up: "ALTER TABLE lock_probe DROP COLUMN operator_secret;",
      },
    ] as const;
    const db = openDatabase(file);
    runMigrations(db, migrations.slice(0, 1));
    db.prepare("INSERT INTO lock_probe (value, operator_secret) VALUES (?, ?)").run("kept", "sensitive");

    let beginCount = 0;
    const fake = {
      prepare: db.prepare.bind(db),
      exec(sql: string) {
        if (sql === "BEGIN IMMEDIATE" && ++beginCount === 1) return;
        db.exec(sql);
      },
      get inTransaction() {
        return db.inTransaction;
      },
    } as unknown as Database;

    let error: unknown;
    try {
      runMigrations(fake, migrations);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeUndefined();
    expect(beginCount).toBe(2);
    expect(db.prepare("SELECT value FROM lock_probe").get()).toEqual({ value: "kept" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = '018-lock-probe'").get()).toEqual({
      count: 1,
    });
    db.close();
  });

  test("the migration writer lock reports a vanished post-body transaction without retrying", () => {
    const file = statePath();
    const migrationSql = "CREATE TABLE escaped_migration_probe (value TEXT NOT NULL);";
    const migrations = [
      { id: "001-lock-probe", up: "CREATE TABLE initial_lock_probe (value TEXT NOT NULL);" },
      { id: "002-lock-probe", up: migrationSql },
    ] as const;
    const db = openDatabase(file);
    runMigrations(db, migrations.slice(0, 1));

    let bodyCalls = 0;
    const fake = {
      prepare: db.prepare.bind(db),
      exec(sql: string) {
        if (sql === migrationSql) {
          bodyCalls += 1;
          db.exec("COMMIT");
        }
        db.exec(sql);
      },
      get inTransaction() {
        return db.inTransaction;
      },
    } as unknown as Database;

    let error: unknown;
    try {
      runMigrations(fake, migrations);
    } catch (caught) {
      error = caught;
    }

    expect(error instanceof Error ? error.message : "").toMatch(/migration write lock invariant.*no longer active/i);
    expect(bodyCalls).toBe(1);
    expect(db.inTransaction).toBe(false);
    db.close();
  });

  test("a pre-018 database appearing at the fresh-open boundary is never treated as fresh", () => {
    const file = statePath();
    const resolvedFile = path.resolve(file);
    const originalExists = fs.existsSync.bind(fs);
    const originalOpen = fs.openSync.bind(fs);
    let injected = false;

    const inject = () => {
      if (injected) return;
      injected = true;
      seedBefore018(file, "appeared-during-open");
    };
    const exists = spyOn(fs, "existsSync").mockImplementation(((candidate: fs.PathLike) => {
      if (!injected && path.resolve(String(candidate)) === resolvedFile) {
        inject();
        return false;
      }
      return originalExists(candidate);
    }) as typeof fs.existsSync);
    const open = spyOn(fs, "openSync").mockImplementation(((
      candidate: fs.PathLike,
      flags: string | number,
      mode?: fs.Mode,
    ) => {
      if (!injected && path.resolve(String(candidate)) === resolvedFile) inject();
      return originalOpen(candidate, flags, mode);
    }) as typeof fs.openSync);

    let opened: ReturnType<typeof openStateDatabase> | undefined;
    let error: unknown;
    try {
      opened = openStateDatabase(file);
    } catch (caught) {
      error = caught;
    } finally {
      opened?.close();
      open.mockRestore();
      exists.mockRestore();
    }

    expect(injected).toBe(true);
    expect(error instanceof Error ? error.message : "").toMatch(/018-drop-dead-lane-schema.*akm upgrade/i);
    const inspected = openDatabase(file, { readonly: true });
    expect(inspected.prepare("SELECT content_hash FROM consolidation_judged").get()).toEqual({
      content_hash: "appeared-during-open",
    });
    inspected.close();
  });

  test("a prefix before 002 automatically runs the verified data-preserving rebuild, then stops before 018", () => {
    const file = statePath();
    const before002 = STATE_MIGRATIONS.slice(0, migrationIndex("002-task-history-per-run"));
    const before018 = STATE_MIGRATIONS.slice(0, migrationIndex("018-drop-dead-lane-schema"));
    const seeded = openDatabase(file);
    runMigrations(seeded, before002);
    seeded
      .prepare(
        `INSERT INTO task_history
          (task_id, status, started_at, metadata_json)
         VALUES (?, ?, ?, ?)`,
      )
      .run("daily", "completed", "2026-08-24T00:00:00.000Z", '{"marker":"kept"}');
    seeded.close();

    expect(() => openStateDatabase(file)).toThrow(/018-drop-dead-lane-schema.*akm upgrade/i);

    const inspected = openDatabase(file, { readonly: true });
    const ids = inspected.prepare("SELECT id FROM schema_migrations ORDER BY rowid").all() as Array<{ id: string }>;
    expect(ids.map((row) => row.id)).toEqual(before018.map((migration) => migration.id));
    expect(
      inspected.prepare("SELECT id, task_id, metadata_json FROM task_history").get() as {
        id: number;
        task_id: string;
        metadata_json: string;
      },
    ).toEqual({ id: 1, task_id: "daily", metadata_json: '{"marker":"kept"}' });
    inspected.close();
  });

  test("a prefix before 018 is rejected before the historical destructive DDL changes durable state", () => {
    const file = statePath();
    const before018 = STATE_MIGRATIONS.slice(0, migrationIndex("018-drop-dead-lane-schema"));
    const seeded = openDatabase(file);
    seeded.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
    runMigrations(seeded, before018);
    seeded
      .prepare("INSERT INTO consolidation_judged (entry_key, content_hash, judged_at, outcome) VALUES (?, ?, ?, ?)")
      .run("memories/keep", "keep-me", "2026-08-24T00:00:00.000Z", "no_action");
    seeded.close();

    expect(() => openStateDatabase(file)).toThrow(/018-drop-dead-lane-schema.*akm upgrade/i);

    const inspected = openDatabase(file, { readonly: true });
    expect(
      (inspected.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number }).count,
    ).toBe(before018.length);
    expect(
      inspected.prepare("SELECT entry_key, content_hash, judged_at, outcome FROM consolidation_judged").get() as {
        entry_key: string;
        content_hash: string;
        judged_at: string;
        outcome: string;
      },
    ).toEqual({
      entry_key: "memories/keep",
      content_hash: "keep-me",
      judged_at: "2026-08-24T00:00:00.000Z",
      outcome: "no_action",
    });
    inspected.close();
    expect(fs.readdirSync(path.dirname(file)).filter((name) => name.includes("pre-018"))).toEqual([]);
  });

  test("the explicit state upgrade creates and verifies a sibling pre-018 safety copy before applying 018", () => {
    const file = statePath();
    const before018 = STATE_MIGRATIONS.slice(0, migrationIndex("018-drop-dead-lane-schema"));
    const seeded = openDatabase(file);
    seeded.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
    runMigrations(seeded, before018);
    seeded
      .prepare("INSERT INTO consolidation_judged (entry_key, content_hash, judged_at, outcome) VALUES (?, ?, ?, ?)")
      .run("memories/recoverable", "recover-me", "2026-08-24T01:00:00.000Z", "actioned");
    expect(fs.existsSync(`${file}-wal`)).toBe(true);

    const result = upgradeHistoricalStateDatabase(file);
    seeded.close();

    expect(result.upgraded).toBe(true);
    expect(result.safetyCopyPath).toStartWith(`${file}.pre-018-drop-dead-lane-schema.`);
    expect(result.safetyCopyPath).toEndWith(".bak");

    const current = openDatabase(file, { readonly: true });
    expect((current.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number }).count).toBe(
      STATE_MIGRATIONS.length,
    );
    expect(
      (
        current
          .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'consolidation_judged'")
          .get() as { count: number }
      ).count,
    ).toBe(0);
    current.close();

    const safetyCopy = openDatabase(result.safetyCopyPath as string, { readonly: true });
    expect(safetyCopy.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    expect(
      safetyCopy.prepare("SELECT entry_key, content_hash FROM consolidation_judged").get() as {
        entry_key: string;
        content_hash: string;
      },
    ).toEqual({ entry_key: "memories/recoverable", content_hash: "recover-me" });
    expect(
      (safetyCopy.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number }).count,
    ).toBe(before018.length);
    safetyCopy.close();

    expect(upgradeHistoricalStateDatabase(file)).toEqual({ upgraded: false, applied: [] });
  });

  test("snapshot and migration 018 share one writer-exclusion window", async () => {
    const file = statePath();
    const startedFile = path.join(path.dirname(file), "writer-started");
    const before018 = STATE_MIGRATIONS.slice(0, migrationIndex("018-drop-dead-lane-schema"));
    const seeded = openDatabase(file);
    seeded.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
    runMigrations(seeded, before018);
    seeded.exec(`
      CREATE TABLE migration_race_probe (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL
      );
      INSERT INTO migration_race_probe(kind) VALUES ('seed');
      CREATE TRIGGER mark_migration_018
        AFTER INSERT ON schema_migrations
        WHEN NEW.id = '018-drop-dead-lane-schema'
      BEGIN
        INSERT INTO migration_race_probe(kind) VALUES ('migration-018');
      END;
    `);
    seeded.close();

    const writerScript = path.join(path.dirname(file), "concurrent-writer.mts");
    fs.writeFileSync(
      writerScript,
      `
      import { Database } from "bun:sqlite";
      import { writeFileSync } from "node:fs";
      const db = new Database(${JSON.stringify(file)});
      db.exec("PRAGMA busy_timeout = 5000");
      writeFileSync(${JSON.stringify(startedFile)}, "started");
      db.query("INSERT INTO migration_race_probe(kind) VALUES ('concurrent-writer')").run();
      db.close();
    `,
      "utf8",
    );
    const originalFsync = fs.fsyncSync.bind(fs);
    let writer: Worker | undefined;
    let writerExit: Promise<{ code: number; error: string }> | undefined;
    const fsync = spyOn(fs, "fsyncSync").mockImplementation(((fd: number) => {
      if (!writer) {
        writer = new Worker(pathToFileURL(writerScript));
        let workerError = "";
        writer.once("error", (error) => {
          workerError = error.message;
        });
        writerExit = new Promise((resolve) => {
          writer?.once("exit", (code) => resolve({ code, error: workerError }));
        });
        waitForFile(startedFile);
        // Without a writer lock spanning snapshot -> migration, this writer
        // commits during this deterministic post-snapshot pause.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
      }
      return originalFsync(fd);
    }) as typeof fs.fsyncSync);

    let result: ReturnType<typeof upgradeHistoricalStateDatabase>;
    try {
      result = upgradeHistoricalStateDatabase(file);
    } finally {
      fsync.mockRestore();
    }
    const writerResult = await Promise.race([
      writerExit ?? Promise.reject(new Error("Concurrent writer was not started.")),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Concurrent writer timed out.")), 7_000)),
    ]);
    expect(writerResult).toEqual({ code: 0, error: "" });

    const safetyCopy = openDatabase(result.safetyCopyPath as string, { readonly: true });
    const backupMax = safetyCopy.prepare("SELECT MAX(id) AS id FROM migration_race_probe").get() as { id: number };
    safetyCopy.close();

    const current = openDatabase(file, { readonly: true });
    const rows = current.prepare("SELECT id, kind FROM migration_race_probe ORDER BY id").all() as Array<{
      id: number;
      kind: string;
    }>;
    current.close();
    const migrationMarker = rows.find((row) => row.kind === "migration-018");
    const concurrentWriter = rows.find((row) => row.kind === "concurrent-writer");
    expect(migrationMarker?.id).toBe(backupMax.id + 1);
    expect(concurrentWriter?.id).toBeGreaterThan(migrationMarker?.id ?? Number.POSITIVE_INFINITY);
  });

  test.skipIf(process.platform === "win32")(
    "a source-path swap and restore cannot upgrade the original from a decoy snapshot",
    () => {
      const file = statePath();
      const decoy = path.join(path.dirname(file), "decoy.db");
      const parkedOriginal = path.join(path.dirname(file), "parked-original.db");
      seedBefore018(file, "original-source");
      seedBefore018(decoy, "decoy-source");

      const originalOpen = fs.openSync.bind(fs);
      const originalFstat = fs.fstatSync.bind(fs);
      let safetyCopyPath: string | undefined;
      let safetyFd: number | undefined;
      let swapped = false;
      let restored = false;
      const restoreSource = () => {
        if (!swapped || restored) return;
        moveDatabaseFamily(file, decoy);
        moveDatabaseFamily(parkedOriginal, file);
        restored = true;
      };

      const open = spyOn(fs, "openSync").mockImplementation(((
        candidate: fs.PathLike,
        flags: string | number,
        mode?: fs.Mode,
      ) => {
        const fd = originalOpen(candidate, flags, mode);
        if (!swapped && String(candidate).includes(".pre-018-drop-dead-lane-schema.")) {
          safetyCopyPath = String(candidate);
          safetyFd = fd;
          moveDatabaseFamily(file, parkedOriginal);
          moveDatabaseFamily(decoy, file);
          swapped = true;
        }
        return fd;
      }) as typeof fs.openSync);
      const fstat = spyOn(fs, "fstatSync").mockImplementation(((descriptor: number, options?: fs.StatSyncOptions) => {
        const stat = originalFstat(descriptor, options as never) as fs.Stats | fs.BigIntStats;
        if (descriptor === safetyFd && (typeof stat.size === "bigint" ? stat.size > 0n : stat.size > 0) && !restored) {
          restoreSource();
        }
        return stat;
      }) as typeof fs.fstatSync);

      let result: ReturnType<typeof upgradeHistoricalStateDatabase> | undefined;
      let error: unknown;
      try {
        result = upgradeHistoricalStateDatabase(file);
      } catch (caught) {
        error = caught;
      } finally {
        restoreSource();
        fstat.mockRestore();
        open.mockRestore();
      }

      expect(swapped).toBe(true);
      expect(restored).toBe(true);
      const current = openDatabase(file, { readonly: true });
      const applied018 = current
        .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = '018-drop-dead-lane-schema'")
        .get() as { count: number };
      const originalTable = current
        .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'consolidation_judged'")
        .get() as { count: number };
      if (applied018.count === 1) {
        expect(error).toBeUndefined();
        expect(result?.safetyCopyPath).toBe(safetyCopyPath);
        const safetyCopy = openDatabase(result?.safetyCopyPath as string, { readonly: true });
        expect(safetyCopy.prepare("SELECT content_hash FROM consolidation_judged").get()).toEqual({
          content_hash: "original-source",
        });
        safetyCopy.close();
      } else {
        expect(originalTable.count).toBe(1);
        expect(current.prepare("SELECT content_hash FROM consolidation_judged").get()).toEqual({
          content_hash: "original-source",
        });
      }
      current.close();
    },
  );

  test("a failed 018 transaction retains its verified safety copy and reports the recovery path", () => {
    const file = statePath("akm state migrations ");
    const before018 = STATE_MIGRATIONS.slice(0, migrationIndex("018-drop-dead-lane-schema"));
    const seeded = openDatabase(file);
    runMigrations(seeded, before018);
    seeded
      .prepare("INSERT INTO consolidation_judged (entry_key, content_hash, judged_at, outcome) VALUES (?, ?, ?, ?)")
      .run("memories/recoverable", "recover-after-failure", "2026-08-24T02:00:00.000Z", "actioned");
    // Exact ledger, deliberately divergent physical schema: 018 will fail at
    // its final DROP COLUMN after the verified copy has been created.
    seeded.exec(`
      DROP INDEX idx_asset_outcome_review_pressure;
      ALTER TABLE asset_outcome DROP COLUMN review_pressure;
    `);
    seeded.close();

    let message = "";
    try {
      upgradeHistoricalStateDatabase(file);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/Verified safety copy: .*pre-018-drop-dead-lane-schema.*\.bak/i);
    const safetyCopyPath = verifiedSafetyCopyPath(message);
    expect(safetyCopyPath).toBeDefined();
    if (!safetyCopyPath) throw new Error("Missing verified safety-copy path in migration failure");
    expect(fs.existsSync(safetyCopyPath)).toBe(true);
    expect(
      fs
        .readdirSync(path.dirname(file), { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isFile() &&
            entry.name.startsWith(`${path.basename(file)}.pre-018-drop-dead-lane-schema.`) &&
            entry.name.endsWith(".bak"),
        )
        .map((entry) => path.join(path.dirname(file), entry.name)),
    ).toEqual([safetyCopyPath]);

    const current = openDatabase(file, { readonly: true });
    expect((current.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number }).count).toBe(
      before018.length,
    );
    expect(current.prepare("SELECT content_hash FROM consolidation_judged").get() as { content_hash: string }).toEqual({
      content_hash: "recover-after-failure",
    });
    current.close();

    const safetyCopy = openDatabase(safetyCopyPath, { readonly: true });
    expect(safetyCopy.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    expect(
      safetyCopy.prepare("SELECT content_hash FROM consolidation_judged").get() as { content_hash: string },
    ).toEqual({ content_hash: "recover-after-failure" });
    safetyCopy.close();
  });

  test.skipIf(process.platform === "win32")(
    "backup reservation is randomized, O_EXCL, symlink-safe, and no broader than the source mode",
    () => {
      const file = statePath();
      seedBefore018(file, "exclusive-reservation");
      fs.chmodSync(file, 0o640);
      const sentinel = path.join(path.dirname(file), "attacker-target");
      fs.writeFileSync(sentinel, "untouched");
      const originalOpen = fs.openSync.bind(fs);
      let collisionPath: string | undefined;
      let observedFlags: string | number | undefined;
      let observedMode: fs.Mode | undefined;

      const open = spyOn(fs, "openSync").mockImplementation(((
        candidate: fs.PathLike,
        flags: string | number,
        mode?: fs.Mode,
      ) => {
        const candidatePath = String(candidate);
        const isSafetyCopy = candidatePath.includes(".pre-018-drop-dead-lane-schema.");
        const isExclusive =
          (typeof flags === "number" && (flags & fs.constants.O_EXCL) !== 0) ||
          (typeof flags === "string" && flags.includes("x"));
        if (isSafetyCopy && !collisionPath) {
          collisionPath = candidatePath;
          observedFlags = flags;
          observedMode = mode;
          if (isExclusive) fs.symlinkSync(sentinel, candidatePath);
        }
        return originalOpen(candidate, flags, mode);
      }) as typeof fs.openSync);

      let result: ReturnType<typeof upgradeHistoricalStateDatabase>;
      try {
        result = upgradeHistoricalStateDatabase(file);
      } finally {
        open.mockRestore();
      }

      expect(typeof observedFlags).toBe("number");
      expect(((observedFlags as number) & fs.constants.O_EXCL) !== 0).toBe(true);
      expect(((observedFlags as number) & fs.constants.O_CREAT) !== 0).toBe(true);
      expect(observedMode).toBe(0o600);
      expect(collisionPath).toBeDefined();
      expect(fs.lstatSync(collisionPath as string).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(sentinel, "utf8")).toBe("untouched");
      expect(result.safetyCopyPath).not.toBe(collisionPath);
      expect(path.basename(result.safetyCopyPath as string)).toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.bak$/i,
      );
      const backupStat = fs.lstatSync(result.safetyCopyPath as string);
      expect(backupStat.isFile()).toBe(true);
      expect(backupStat.isSymbolicLink()).toBe(false);
      expect(backupStat.mode & 0o777).toBe(0o600);
      if (typeof process.geteuid === "function") expect(backupStat.uid).toBe(process.geteuid());
    },
  );

  test.skipIf(process.platform === "win32")(
    "failed backup cleanup never unlinks a pathname replacement raced after its identity check",
    () => {
      const file = statePath();
      seedBefore018(file, "cleanup-race");
      const originalOpen = fs.openSync.bind(fs);
      const originalFsync = fs.fsyncSync.bind(fs);
      const originalLstat = fs.lstatSync.bind(fs);
      let safetyCopyPath: string | undefined;
      let safetyFd: number | undefined;
      let cleanupPhase = false;
      let replacementInstalled = false;

      const open = spyOn(fs, "openSync").mockImplementation(((
        candidate: fs.PathLike,
        flags: string | number,
        mode?: fs.Mode,
      ) => {
        const fd = originalOpen(candidate, flags, mode);
        if (!safetyCopyPath && String(candidate).includes(".pre-018-drop-dead-lane-schema.")) {
          safetyCopyPath = String(candidate);
          safetyFd = fd;
        }
        return fd;
      }) as typeof fs.openSync);
      const fsync = spyOn(fs, "fsyncSync").mockImplementation(((fd: number) => {
        if (fd === safetyFd && !cleanupPhase) {
          cleanupPhase = true;
          throw new Error("forced safety-copy fsync failure");
        }
        return originalFsync(fd);
      }) as typeof fs.fsyncSync);
      const lstat = spyOn(fs, "lstatSync").mockImplementation(((
        candidate: fs.PathLike,
        options?: fs.StatSyncOptions,
      ) => {
        const stat = originalLstat(candidate, options as never) as fs.Stats | fs.BigIntStats;
        if (cleanupPhase && !replacementInstalled && String(candidate) === safetyCopyPath) {
          fs.unlinkSync(safetyCopyPath);
          fs.writeFileSync(safetyCopyPath, "replacement-must-survive");
          replacementInstalled = true;
        }
        return stat;
      }) as typeof fs.lstatSync);

      let error: unknown;
      try {
        upgradeHistoricalStateDatabase(file);
      } catch (caught) {
        error = caught;
      } finally {
        lstat.mockRestore();
        fsync.mockRestore();
        open.mockRestore();
      }

      expect(safetyCopyPath).toBeDefined();
      if (replacementInstalled) {
        expect(fs.readFileSync(safetyCopyPath as string, "utf8")).toBe("replacement-must-survive");
      } else {
        expect(fs.existsSync(safetyCopyPath as string)).toBe(true);
      }
      expect(error instanceof Error ? error.message : "").toContain(safetyCopyPath as string);
      const current = openDatabase(file, { readonly: true });
      expect(current.prepare("SELECT content_hash FROM consolidation_judged").get()).toEqual({
        content_hash: "cleanup-race",
      });
      current.close();
    },
  );

  test.skipIf(process.platform === "win32")(
    "an inode/symlink swap after reservation is rejected without unlinking the replacement",
    () => {
      const file = statePath();
      seedBefore018(file, "inode-swap-backup");
      const sentinel = path.join(path.dirname(file), "replacement-target");
      fs.writeFileSync(sentinel, "attacker-owned");
      const originalOpen = fs.openSync.bind(fs);
      const originalFsync = fs.fsyncSync.bind(fs);
      let safetyCopyPath: string | undefined;
      let swapped = false;

      const open = spyOn(fs, "openSync").mockImplementation(((
        candidate: fs.PathLike,
        flags: string | number,
        mode?: fs.Mode,
      ) => {
        if (!safetyCopyPath && String(candidate).includes(".pre-018-drop-dead-lane-schema.")) {
          safetyCopyPath = String(candidate);
        }
        return originalOpen(candidate, flags, mode);
      }) as typeof fs.openSync);
      const fsync = spyOn(fs, "fsyncSync").mockImplementation(((fd: number) => {
        if (!swapped && safetyCopyPath) {
          swapped = true;
          fs.unlinkSync(safetyCopyPath);
          fs.symlinkSync(sentinel, safetyCopyPath);
        }
        return originalFsync(fd);
      }) as typeof fs.fsyncSync);

      let error: unknown;
      try {
        upgradeHistoricalStateDatabase(file);
      } catch (caught) {
        error = caught;
      } finally {
        fsync.mockRestore();
        open.mockRestore();
      }

      expect(swapped).toBe(true);
      expect(error instanceof Error ? error.message : "").toMatch(/inode|ownership|symlink|replaced/i);
      expect(safetyCopyPath).toBeDefined();
      expect(fs.lstatSync(safetyCopyPath as string).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(sentinel, "utf8")).toBe("attacker-owned");
      const current = openDatabase(file, { readonly: true });
      expect(current.prepare("SELECT content_hash FROM consolidation_judged").get()).toEqual({
        content_hash: "inode-swap-backup",
      });
      current.close();
    },
  );

  test("released 002 and 018 migration SQL remains byte-for-byte immutable", () => {
    const expected = new Map([
      ["002-task-history-per-run", "58aa34d3cd8726180de7b8691f14d40ee6729bf1541a9b81305c3ab66346cecc"],
      ["018-drop-dead-lane-schema", "e7123d4efe86f66768fd15d905aefa95a7011961de9de8e806702e1fe70cc7c5"],
    ]);

    for (const [id, sha256] of expected) {
      const migration = STATE_MIGRATIONS.find((candidate) => candidate.id === id);
      expect(migration).toBeDefined();
      expect(
        createHash("sha256")
          .update(migration?.up ?? "")
          .digest("hex"),
      ).toBe(sha256);
    }
  });

  test("every ordered migration ID has an explicit safety classification", () => {
    expect(Object.keys(STATE_MIGRATION_SAFETY_BY_ID)).toEqual(STATE_MIGRATIONS.map((migration) => migration.id));
    expect(getStateMigrationSafety("002-task-history-per-run")).toBe("data-preserving-rebuild");
    expect(getStateMigrationSafety("018-drop-dead-lane-schema")).toBe("historical-destructive");

    for (const migration of STATE_MIGRATIONS) {
      const executableSql = migration.up.replaceAll(/--.*$/gm, "");
      if (/\bDROP\b|\bRENAME\s+TO\b/i.test(executableSql)) {
        expect(getStateMigrationSafety(migration.id)).not.toBe("additive");
      }
    }
  });

  // #915-adjacent: two akm versions sharing one data directory is a supported
  // deployment (a bundled CLI beside a newer global install). A database the
  // newer akm migrated must not brick the older one — its whole registry is
  // already applied, so it has nothing to run and everything to read.
  test("a ledger ahead of this akm opens, applies nothing, and leaves the extra rows alone", () => {
    const file = statePath();
    const seeded = openDatabase(file);
    runMigrations(seeded, STATE_MIGRATIONS);
    seeded.exec(`
      INSERT INTO schema_migrations (id) VALUES ('999-from-a-newer-akm');
      CREATE TABLE operator_probe (value TEXT NOT NULL);
      INSERT INTO operator_probe VALUES ('unchanged');
    `);
    seeded.close();

    const db = openStateDatabase(file);
    try {
      const ids = (db.prepare("SELECT id FROM schema_migrations ORDER BY rowid").all() as Array<{ id: string }>).map(
        (row) => row.id,
      );
      expect(ids).toEqual([...STATE_MIGRATIONS.map((migration) => migration.id), "999-from-a-newer-akm"]);
      expect((db.prepare("SELECT value FROM operator_probe").get() as { value: string }).value).toBe("unchanged");
    } finally {
      db.close();
    }
  });

  test("a ledger that diverges from this akm's registry is still rejected", () => {
    const file = statePath();
    const seeded = openDatabase(file);
    const [first, second] = STATE_MIGRATIONS;
    if (!first || !second) throw new Error("expected at least two state migrations");
    seeded.exec(`
      CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES ('${first.id}', datetime('now'));
      INSERT INTO schema_migrations VALUES ('someone-elses-migration', datetime('now'));
    `);
    seeded.close();

    // This akm's own second migration was never applied and something else was
    // in its place: running the pending set could conflict with schema it
    // cannot see, so this one refuses. Applying the missing migration blind
    // could still land on a schema a later, unrecognized migration already
    // changed — a real corruption risk, not a "conceivable" one — so the
    // refusal stays; only its message gained the unexpected id, the full
    // expected order, and a remedy, so an operator has something to act on.
    let caught: unknown;
    try {
      openStateDatabase(file);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/not an exact ordered prefix/i);
    expect(message).toContain("someone-elses-migration");
    expect(message).toContain(first.id);
    expect(message).toContain(second.id);
    expect(message.toLowerCase()).toMatch(/backup|restore/);
    expect(message.toLowerCase()).toContain("delete it and let akm rebuild");
  });

  test("a ledger whose very first entry is foreign is rejected before current schema writes", () => {
    const file = statePath();
    const seeded = openDatabase(file);
    seeded.exec(`
      CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES ('unknown-runtime', datetime('now'));
      CREATE TABLE operator_probe (value TEXT NOT NULL);
      INSERT INTO operator_probe VALUES ('unchanged');
    `);
    seeded.close();

    expect(() => openStateDatabase(file)).toThrow(/not an exact ordered prefix/i);

    const inspected = openDatabase(file, { readonly: true });
    expect((inspected.prepare("SELECT value FROM operator_probe").get() as { value: string }).value).toBe("unchanged");
    expect(
      (inspected.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'").get() as { count: number })
        .count,
    ).toBe(2);
    inspected.close();
  });
});

/**
 * Field follow-up: two concurrent `akm index` runs against a sandbox with no
 * pre-existing state.db intermittently exited 70 (internal/unclassified).
 * Measured root cause: `openStateDatabase`'s fresh-vs-existing reservation
 * only decides who CREATES the file first (`reserveFreshStateDatabase`'s
 * `O_CREAT|O_EXCL`) -- with the old one-transaction-per-migration bootstrap,
 * the LOSER could open its own connection between two of the winner's
 * commits and observe a real, committed, but still-incomplete ledger. Seeing
 * a non-empty ledger it correctly (from its own point of view) treated the
 * database as pre-existing and tried to help finish applying migrations --
 * which, on reaching historical-destructive migration 018, hit exactly the
 * same refusal a genuine legacy database gets: "Refusing to apply
 * historical destructive state migration 018-drop-dead-lane-schema during
 * an ordinary managed open." A narrower timing (catching the ledger table
 * freshly created but still empty, with an application table already
 * visible) instead threw the sibling "Refusing to migrate an existing
 * unversioned state.db" message. Both are symptoms of the same
 * non-atomic-bootstrap race, reproduced directly against unfixed code by
 * racing two real processes against an absent path (no synthetic load
 * needed, ~3% of pairs in local runs).
 *
 * The fix makes a fresh bootstrap atomic (`runMigrations`'s `freshDatabase`
 * case now locks the entire registry through the final migration, the same
 * `lockInitialMigrationPrefixThrough` mechanism already used for the
 * existing-unversioned-ledger case): a concurrent opener can now only ever
 * observe "nothing committed yet" (correctly treated as fresh) or "fully
 * current" (nothing left to apply) -- the partially-migrated window this
 * bug depended on no longer exists. `openStateDatabase`'s catch also now
 * reclassifies any still-contention-shaped failure from deeper in the
 * open/migrate sequence into `STATE_DB_CONTENDED` (exit 75) rather than
 * letting a raw driver message escape as exit 70, matching the documented
 * retry-shortly contract.
 */
describe("state.db first open — concurrent creation never misjudges an in-progress bootstrap (field follow-up)", () => {
  const repoRoot = path.resolve(import.meta.dir, "../../../");

  interface OpenAttemptResult {
    ok: boolean;
    count?: number;
    message?: string;
    code?: string;
  }

  function writeOpenAttemptScript(dir: string): string {
    const scriptPath = path.join(dir, "open-state-db-attempt.mts");
    const stateDbModuleUrl = pathToFileURL(path.join(repoRoot, "src/core/state-db.ts")).href;
    fs.writeFileSync(
      scriptPath,
      `
      const mod = await import(${JSON.stringify(stateDbModuleUrl)});
      const file = process.argv[2];
      try {
        const db = mod.openStateDatabase(file);
        const ids = db.prepare("SELECT id FROM schema_migrations ORDER BY rowid").all();
        db.close();
        console.log(JSON.stringify({ ok: true, count: ids.length }));
      } catch (error) {
        console.log(
          JSON.stringify({
            ok: false,
            message: error instanceof Error ? error.message : String(error),
            code: error && typeof error === "object" && "code" in error ? error.code : undefined,
          }),
        );
        process.exitCode = 1;
      }
      `,
      "utf8",
    );
    return scriptPath;
  }

  async function attemptOpen(scriptPath: string, file: string): Promise<OpenAttemptResult> {
    const child = Bun.spawn(["bun", scriptPath, file], {
      cwd: repoRoot,
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const trimmed = stdout.trim();
    if (!trimmed) throw new Error(`open attempt produced no output on stdout. stderr:\n${stderr}`);
    return JSON.parse(trimmed) as OpenAttemptResult;
  }

  // Empirically the smallest trial count that reliably reproduces the race
  // against unfixed code without synthetic CPU load (~3% of pairs hit it
  // locally; 120 trials keeps the odds of missing it entirely well under 2%
  // while keeping this test's own runtime reasonable).
  const CONCURRENT_TRIALS = 120;

  test("two processes racing an absent state.db never see the legacy-unversioned or historical-destructive refusal", async () => {
    for (let trial = 0; trial < CONCURRENT_TRIALS; trial += 1) {
      const file = statePath(`akm-state-first-open-${trial}-`);
      const scriptPath = writeOpenAttemptScript(path.dirname(file));

      const [a, b] = await Promise.all([attemptOpen(scriptPath, file), attemptOpen(scriptPath, file)]);

      for (const result of [a, b]) {
        if (result.ok) {
          expect(result.count).toBe(STATE_MIGRATIONS.length);
        } else {
          // The only acceptable failure is the documented transient-contention
          // contract -- never the legacy-unversioned/historical-destructive
          // refusal (the field bug) and never an unclassified raw driver error.
          expect(result.code).toBe("STATE_DB_CONTENDED");
          expect(result.message ?? "").not.toMatch(/refusing/i);
        }
      }
      // At least one side must actually finish the bootstrap -- two
      // processes racing a first open may not BOTH be told to retry.
      expect(a.ok || b.ok).toBe(true);
    }
  }, 120_000);

  test("a genuine legacy unversioned state.db is still refused after the fresh-bootstrap atomicity fix", () => {
    const file = statePath();
    const before018 = STATE_MIGRATIONS.slice(0, migrationIndex("018-drop-dead-lane-schema"));
    const seeded = openDatabase(file);
    runMigrations(seeded, before018);
    seeded.close();

    // A real, fully-committed, single-process legacy database (not racing
    // anyone) must still be refused with today's message and still require
    // the deliberate `akm upgrade` path -- the atomicity fix only changes how
    // a database THIS SAME open is creating gets bootstrapped, never how an
    // already-existing on-disk ledger is judged.
    expect(() => openStateDatabase(file)).toThrow(/018-drop-dead-lane-schema.*akm upgrade/i);

    const inspected = openDatabase(file, { readonly: true });
    const ids = inspected.prepare("SELECT id FROM schema_migrations ORDER BY rowid").all() as Array<{ id: string }>;
    expect(ids.map((row) => row.id)).toEqual(before018.map((migration) => migration.id));
    inspected.close();
  });
});
