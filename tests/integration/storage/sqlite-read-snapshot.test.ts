// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { openStateDatabase } from "../../../src/core/state-db";
import {
  closeDatabase,
  openIndexDatabase,
  openReadonlyExistingDatabase,
} from "../../../src/storage/repositories/index-connection";
import { openSqliteReadSnapshot, SqliteReadSnapshotUnavailableError } from "../../../src/storage/sqlite-read-snapshot";
import { makeSandboxDir } from "../../_helpers/sandbox";

describe("SQLite read snapshot lifecycle", () => {
  test("normal close is idempotent and removes its process-exit cleanup listener", () => {
    const fixture = makeSandboxDir("akm-sqlite-read-lifecycle");
    const sourcePath = path.join(fixture.dir, "source.db");
    const source = new Database(sourcePath);
    source.exec("CREATE TABLE held(value TEXT); INSERT INTO held VALUES ('preserve')");
    source.close();

    const listenersBefore = process.listenerCount("exit");
    const snapshot = openSqliteReadSnapshot(sourcePath);
    try {
      expect(snapshot).toBeDefined();
      expect(process.listenerCount("exit")).toBe(listenersBefore + 1);
      snapshot?.close();
      expect(process.listenerCount("exit")).toBe(listenersBefore);
      expect(() => snapshot?.close()).not.toThrow();
    } finally {
      snapshot?.close();
      fixture.cleanup();
    }
  });

  test("a permanently held rollback journal retries with backoff before failing closed", () => {
    const fixture = makeSandboxDir("akm-sqlite-read-held-journal");
    const sourcePath = path.join(fixture.dir, "source.db");
    const holder = new Database(sourcePath);
    try {
      holder.exec("CREATE TABLE held(value TEXT)");
      holder.exec("BEGIN IMMEDIATE");
      holder.exec("INSERT INTO held VALUES ('uncommitted')");
      expect(fs.existsSync(`${sourcePath}-journal`)).toBe(true);

      const startedAt = performance.now();
      let caught: unknown;
      try {
        openSqliteReadSnapshot(sourcePath);
      } catch (error) {
        caught = error;
      }
      const elapsedMs = performance.now() - startedAt;

      expect(caught).toBeInstanceOf(SqliteReadSnapshotUnavailableError);
      expect(elapsedMs).toBeGreaterThanOrEqual(300);
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
      fixture.cleanup();
    }
  });

  test("openReadonlyExistingDatabase falls back to a plain read-only open when the snapshot is unavailable", () => {
    const fixture = makeSandboxDir("akm-sqlite-read-fallback");
    const sourcePath = path.join(fixture.dir, "source.db");
    // The fallback path is an index reader and therefore needs a canonical
    // index fixture. A bare SQLite table is correctly rejected at the #934
    // boundary before the test can exercise its snapshot fallback.
    const seeded = openIndexDatabase(sourcePath, {
      beforeSchema: (db) => db.exec("PRAGMA journal_mode=DELETE"),
    });
    closeDatabase(seeded);
    const holder = new Database(sourcePath);
    try {
      // The canonical fixture is initialized in rollback-journal mode, so
      // BEGIN IMMEDIATE leaves the journal that makes the disposable-copy
      // snapshot unavailable.
      holder.exec("CREATE TABLE held(value TEXT)");
      holder.exec("BEGIN IMMEDIATE");
      holder.exec("INSERT INTO held VALUES ('uncommitted')");
      expect(fs.existsSync(`${sourcePath}-journal`)).toBe(true);

      const db = openReadonlyExistingDatabase(sourcePath, { isolatedSnapshot: true });
      expect(db).toBeDefined();
      db?.close();
    } finally {
      // On some SQLite builds the plain read-only fallback resolves this
      // same-process held rollback journal as it opens. Only roll back when
      // the writer still owns the transaction.
      if (holder.inTransaction) holder.exec("ROLLBACK");
      holder.close();
      fixture.cleanup();
    }
  });
});

/**
 * What another process sees when it asks for exclusive access to `dbPath`
 * right now: `"acquired"`, or `"blocked: <SQLite error>"`.
 *
 * `PRAGMA locking_mode=EXCLUSIVE` makes a WAL-mode connection take the
 * database file's EXCLUSIVE lock on its first read, which fails with
 * SQLITE_BUSY for as long as any other process holds that file's SHARED lock.
 * Deliberately not `PRAGMA journal_mode=DELETE`: SQLite 3.51+ also consults the
 * `-shm` dead-man-switch lock there, which hides a lost SHARED lock.
 */
function exclusiveAccessFromAnotherProcess(dbPath: string): string {
  const script = `
    import { Database } from "bun:sqlite";
    const db = new Database(process.env.PROBE_DB);
    db.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE");
    try {
      db.prepare("SELECT count(*) FROM sqlite_master").get();
      console.log("acquired");
    } catch (error) {
      console.log("blocked: " + error.message);
    }
  `;
  const result = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: { ...process.env, PROBE_DB: dbPath },
  });
  return result.stdout.trim() || `probe produced no output (status ${result.status}): ${result.stderr.trim()}`;
}

const SNAPSHOT_MODULE = path.resolve(import.meta.dir, "../../../src/storage/sqlite-read-snapshot");

/**
 * What `openSqliteReadSnapshot(dbPath)` does in a child process that STARTS
 * with a `PATH` holding no `cp`: `"no-throw"`, or `"<error name>: <message>"`.
 *
 * The child is the point. On Bun 1.3.14 (the version CI pins) `spawnSync("cp")`
 * finds `cp` through the PATH the process started with and ignores later edits
 * to `process.env.PATH`; Bun 1.4 honors them. A test that changes PATH inside
 * its own process therefore only simulates a missing `cp` on newer Bun.
 */
function snapshotOutcomeWithoutCp(dbPath: string, scratchDir: string): string {
  const emptyBin = path.join(scratchDir, "empty-bin");
  fs.mkdirSync(emptyBin, { recursive: true });
  const script = `
    import { openSqliteReadSnapshot } from ${JSON.stringify(SNAPSHOT_MODULE)};
    try {
      openSqliteReadSnapshot(process.env.PROBE_DB)?.close();
      console.log("no-throw");
    } catch (error) {
      console.log(error.name + ": " + error.message);
    }
  `;
  const result = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: {
      PATH: emptyBin,
      HOME: scratchDir,
      TMPDIR: scratchDir,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      PROBE_DB: dbPath,
    },
  });
  return result.stdout.trim() || `probe produced no output (status ${result.status}): ${result.stderr.trim()}`;
}

// POSIX advisory locks belong to the process: closing ANY descriptor for a file
// drops every lock the process holds on it. Windows locks belong to the handle,
// so there is nothing to lose there.
const posixLockTest = process.platform === "win32" ? test.skip : test;

describe("SQLite read snapshot keeps the process's own SQLite locks", () => {
  posixLockTest("control: a raw open/close of a live database in this process drops its SQLite lock", () => {
    const fixture = makeSandboxDir("akm-sqlite-read-lock-control");
    const dbPath = path.join(fixture.dir, "state.db");
    const live = openStateDatabase(dbPath);
    try {
      expect(exclusiveAccessFromAnotherProcess(dbPath)).toStartWith("blocked:");
      fs.closeSync(fs.openSync(dbPath, "r"));
      expect(exclusiveAccessFromAnotherProcess(dbPath)).toBe("acquired");
    } finally {
      try {
        live.close();
      } catch {
        // The lock this test deliberately dropped can make the close complain.
      }
      fixture.cleanup();
    }
  });

  posixLockTest("openSqliteReadSnapshot does not drop the lock of a connection in the same process", () => {
    const fixture = makeSandboxDir("akm-sqlite-read-lock-snapshot");
    const dbPath = path.join(fixture.dir, "state.db");
    // Stands in for `akm improve`'s long-lived `eventsDb`.
    const live = openStateDatabase(dbPath);
    try {
      live.exec("CREATE TABLE lock_probe(v TEXT); INSERT INTO lock_probe VALUES ('x')");
      expect(exclusiveAccessFromAnotherProcess(dbPath)).toStartWith("blocked:");
      for (let i = 0; i < 3; i++) openSqliteReadSnapshot(dbPath)?.close();
      expect(exclusiveAccessFromAnotherProcess(dbPath)).toStartWith("blocked:");
    } finally {
      try {
        live.close();
      } catch {
        // Diagnostics for a lost lock are the assertion above; do not mask it.
      }
      fixture.cleanup();
    }
  });

  posixLockTest("a second openStateDatabase in the same process does not drop the first one's lock", () => {
    const fixture = makeSandboxDir("akm-sqlite-read-lock-open");
    const dbPath = path.join(fixture.dir, "state.db");
    const live = openStateDatabase(dbPath);
    try {
      openStateDatabase(dbPath).close();
      expect(exclusiveAccessFromAnotherProcess(dbPath)).toStartWith("blocked:");
    } finally {
      try {
        live.close();
      } catch {
        // Diagnostics for a lost lock are the assertion above; do not mask it.
      }
      fixture.cleanup();
    }
  });

  posixLockTest("a missing cp fails closed rather than copying inside this process", () => {
    const fixture = makeSandboxDir("akm-sqlite-read-no-cp");
    const dbPath = path.join(fixture.dir, "source.db");
    const source = new Database(dbPath);
    source.exec("CREATE TABLE t(v TEXT); INSERT INTO t VALUES ('x')");
    source.close();
    try {
      expect(snapshotOutcomeWithoutCp(dbPath, fixture.dir)).toStartWith("SqliteReadSnapshotUnavailableError:");
    } finally {
      fixture.cleanup();
    }
  });

  test("a snapshot carries committed WAL frames, not just the main file", () => {
    const fixture = makeSandboxDir("akm-sqlite-read-wal-frames");
    const dbPath = path.join(fixture.dir, "wal.db");
    const live = new Database(dbPath);
    try {
      live.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(v TEXT); INSERT INTO t VALUES ('committed-in-wal')");
      // Not yet checkpointed: the row exists only in the WAL.
      expect(fs.statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);
      const snapshot = openSqliteReadSnapshot(dbPath);
      try {
        expect(snapshot?.prepare("SELECT v FROM t").all()).toEqual([{ v: "committed-in-wal" }]);
      } finally {
        snapshot?.close();
      }
    } finally {
      live.close();
      fixture.cleanup();
    }
  });
});
