// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Regression coverage for `snapshotTree`: a byte-for-byte directory snapshot
 * flaked whenever a WAL checkpoint landed between a "before" and an "after"
 * call with no logical write in between — see snapshot-tree.ts's module doc
 * for the full mechanism. These tests pin the fix against the exact shape of
 * the original bug (a zombie bun:sqlite connection's checkpoint deferred to
 * GC, per `tests/storage/finalize-on-close.test.ts`, issue #720) and prove
 * the helper still catches a real write, in a plain table and a `WITHOUT
 * ROWID` one.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requestGc } from "../../src/runtime";
import { openDatabase } from "../../src/storage/database";
import { snapshotTree } from "./snapshot-tree";

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-snapshot-tree-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("snapshotTree", () => {
  test("a zombie connection's deferred WAL checkpoint does not change the snapshot", () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, "state.db");

    // The exact shape of the real bug (see tests/storage/finalize-on-close.test.ts,
    // issue #720): close() with an unfinalized prepared statement leaves the
    // connection a zombie — its WAL checkpoint is deferred until GC finalizes
    // the statement.
    const seed = openDatabase(dbPath);
    seed.exec("PRAGMA journal_mode = WAL");
    seed.exec("CREATE TABLE t(x)");
    seed.exec("INSERT INTO t VALUES (1)");
    seed.prepare("SELECT x FROM t").get();
    seed.close();

    const before = snapshotTree(dir);
    requestGc(); // finalizes the zombie statement, completing the deferred checkpoint
    const after = snapshotTree(dir);

    expect(after).toEqual(before);
  });

  test("a real write between snapshots is still detected", () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, "state.db");
    const db = new Database(dbPath);
    try {
      db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, val TEXT)");
      db.exec("INSERT INTO t(val) VALUES ('a')");
      const before = snapshotTree(dir);

      db.exec("INSERT INTO t(val) VALUES ('b')");
      const after = snapshotTree(dir);

      expect(after).not.toEqual(before);
    } finally {
      db.close();
    }
  });

  test("a real write to a WITHOUT ROWID table is still detected", () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, "t.db");
    const db = new Database(dbPath);
    try {
      db.exec("CREATE TABLE kv(k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID");
      db.exec("INSERT INTO kv VALUES ('a', '1')");
      const before = snapshotTree(dir);

      db.exec("INSERT INTO kv VALUES ('b', '2')");
      const after = snapshotTree(dir);

      expect(after).not.toEqual(before);
    } finally {
      db.close();
    }
  });

  test("-wal and -shm sidecars never appear as snapshot keys", () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, "state.db");
    const db = new Database(dbPath);
    try {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("CREATE TABLE t(x)");
      db.exec("INSERT INTO t VALUES (1)");
      expect(fs.existsSync(`${dbPath}-wal`)).toBe(true);
      expect(fs.existsSync(`${dbPath}-shm`)).toBe(true);

      const snapshot = snapshotTree(dir);

      expect(snapshot.has("state.db")).toBe(true);
      for (const key of snapshot.keys()) {
        expect(key.endsWith("-wal")).toBe(false);
        expect(key.endsWith("-shm")).toBe(false);
      }
    } finally {
      db.close();
    }
  });

  test("an ordinary file is still hashed by raw bytes", () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "note.txt");
    fs.writeFileSync(filePath, "hello");
    const before = snapshotTree(dir);
    expect(before.get("note.txt")).toBe(`5:${createHash("sha256").update("hello").digest("hex")}`);

    fs.writeFileSync(filePath, "hello world");
    const after = snapshotTree(dir);

    expect(after).not.toEqual(before);
  });

  test("directories are recorded, and a missing root snapshots empty", () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, "sub"));

    expect(snapshotTree(dir).get("sub/")).toBe("directory");
    expect(snapshotTree(path.join(dir, "does-not-exist")).size).toBe(0);
  });
});
