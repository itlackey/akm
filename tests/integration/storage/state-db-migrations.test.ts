// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Database as BunSqliteDatabase } from "bun:sqlite";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getStateMigrationSafety,
  STATE_MIGRATION_SAFETY_BY_ID,
  STATE_MIGRATIONS,
} from "../../../src/core/state/migrations";
import { openStateDatabase, upgradeHistoricalStateDatabase } from "../../../src/core/state-db";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../../src/core/warn";
import { type Database, openDatabase } from "../../../src/storage/database";
import { runMigrations } from "../../../src/storage/sqlite-migrations";

const roots: string[] = [];

function statePath(prefix = "akm-state-migrations-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return path.join(root, "state.db");
}

function migrationIndex(id: string): number {
  const index = STATE_MIGRATIONS.findIndex((migration) => migration.id === id);
  if (index < 0) throw new Error(`Missing state migration fixture ${id}`);
  return index;
}

/** Capture `warn()` calls made inside `fn`, resetting `warnOnce` gating first so a repeat fires. */
function captureWarnings(fn: () => void): string[] {
  const warnings: string[] = [];
  _resetWarnOnceForTests();
  _setWarnSinkForTests((level, args) => {
    if (level === "warn") warnings.push(args.map(String).join(" "));
  });
  try {
    fn();
    return warnings;
  } finally {
    _setWarnSinkForTests(undefined);
  }
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

  test("an existing db with all migrations applied opens through exactly one connection and writes no .bak", () => {
    const file = statePath();
    openStateDatabase(file).close(); // fully migrated; no backup taken on the fresh open (nothing to lose)

    // `Database.prototype.close` is shared by every connection regardless of
    // which module opened it (unlike a plain named export, a prototype method
    // resolves dynamically through the instance, so the spy sees calls made
    // from inside storage/managed-db.ts too). A second, preflight connection
    // opened only to read the ledger would show up here as a close BEFORE
    // this call returns its own handle; the single managed connection is
    // closed by the caller afterward, not during the open itself.
    const closeSpy = spyOn(BunSqliteDatabase.prototype, "close");
    let db: ReturnType<typeof openStateDatabase> | undefined;
    try {
      db = openStateDatabase(file);
      expect(closeSpy).toHaveBeenCalledTimes(0);
    } finally {
      closeSpy.mockRestore();
      db?.close();
    }

    expect(fs.readdirSync(path.dirname(file)).some((name) => name.endsWith(".bak"))).toBe(false);
  });

  test("applying pending migrations retries a phantom BEGIN before running a destructive one", () => {
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

  test("a migration body that leaves the transaction inactive is reported, not silently retried", () => {
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

    expect(error instanceof Error ? error.message : "").toMatch(/invariant violated.*no longer active/i);
    expect(bodyCalls).toBe(1);
    expect(db.inTransaction).toBe(false);
    db.close();
  });

  test("applying 018 creates a sibling pre-018 safety copy first, and a second run is a no-op", () => {
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
    expect(result.safetyCopyPath).toBe(`${file}.pre-018-drop-dead-lane-schema.bak`);

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

  test("a failed 018 migration leaves the ledger and rows unchanged, with its pre-migration copy on disk", () => {
    const file = statePath();
    const before018 = STATE_MIGRATIONS.slice(0, migrationIndex("018-drop-dead-lane-schema"));
    const seeded = openDatabase(file);
    runMigrations(seeded, before018);
    seeded
      .prepare("INSERT INTO consolidation_judged (entry_key, content_hash, judged_at, outcome) VALUES (?, ?, ?, ?)")
      .run("memories/recoverable", "recover-after-failure", "2026-08-24T02:00:00.000Z", "actioned");
    // Exact ledger, deliberately divergent physical schema: 018 will fail at
    // its final DROP COLUMN, after the pre-migration copy was already made.
    seeded.exec(`
      DROP INDEX idx_asset_outcome_review_pressure;
      ALTER TABLE asset_outcome DROP COLUMN review_pressure;
    `);
    seeded.close();

    const backupPath = `${file}.pre-018-drop-dead-lane-schema.bak`;
    let error: unknown;
    try {
      openStateDatabase(file).close();
    } catch (caught) {
      error = caught;
    }

    // The raw driver failure propagates as-is — no wrapping, no fd aliases.
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/review_pressure/i);

    // The copy was made (VACUUM INTO, same connection) before the migration
    // transaction opened, so it survives the failure untouched.
    expect(fs.existsSync(backupPath)).toBe(true);
    const safetyCopy = openDatabase(backupPath, { readonly: true });
    expect(safetyCopy.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    expect(
      safetyCopy.prepare("SELECT content_hash FROM consolidation_judged").get() as { content_hash: string },
    ).toEqual({ content_hash: "recover-after-failure" });
    safetyCopy.close();

    // The original database is untouched: the failed migration transaction rolled back.
    const current = openDatabase(file, { readonly: true });
    expect((current.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number }).count).toBe(
      before018.length,
    );
    expect(current.prepare("SELECT content_hash FROM consolidation_judged").get() as { content_hash: string }).toEqual({
      content_hash: "recover-after-failure",
    });
    current.close();
  });

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
  test("a ledger ahead of this akm opens, applies nothing, leaves the extra rows alone, and warns once", () => {
    const file = statePath();
    const seeded = openDatabase(file);
    runMigrations(seeded, STATE_MIGRATIONS);
    seeded.exec(`
      INSERT INTO schema_migrations (id) VALUES ('999-from-a-newer-akm');
      CREATE TABLE operator_probe (value TEXT NOT NULL);
      INSERT INTO operator_probe VALUES ('unchanged');
    `);
    seeded.close();

    let db: ReturnType<typeof openStateDatabase> | undefined;
    const warnings = captureWarnings(() => {
      db = openStateDatabase(file);
    });
    try {
      const ids = (db?.prepare("SELECT id FROM schema_migrations ORDER BY rowid").all() as Array<{ id: string }>).map(
        (row) => row.id,
      );
      expect(ids).toEqual([...STATE_MIGRATIONS.map((migration) => migration.id), "999-from-a-newer-akm"]);
      expect((db?.prepare("SELECT value FROM operator_probe").get() as { value: string }).value).toBe("unchanged");
    } finally {
      db?.close();
    }

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/older than the state database/i);
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
