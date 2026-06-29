// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests for `withImmediateTransaction` concurrency hardening.
 *
 * Under heavy concurrent-writer load (e.g. the proposal-queue worker race in
 * tests/proposal-storage-sqlite.test.ts) a contended `BEGIN IMMEDIATE` could
 * leave the bun:sqlite connection reporting an open transaction, so the next
 * `BEGIN` threw `SQLiteError: cannot start a transaction within a transaction`
 * — a CI-only flake. The helper now treats that (and `database is locked`) as a
 * transient start-of-transaction failure: it rolls back the phantom state and
 * retries. Errors thrown by the transaction BODY are real and never retried.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { type Database, openStateDatabase, withImmediateTransaction } from "../../src/core/state-db";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

describe("withImmediateTransaction", () => {
  let storage: IsolatedAkmStorage;
  let db: Database;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    db = openStateDatabase(path.join(storage.dataDir, "state.db"));
  });

  afterEach(() => {
    db.close();
    storage.cleanup();
  });

  test("recovers from a phantom open transaction instead of throwing 'within a transaction'", () => {
    // Simulate the contended-BEGIN phantom: the connection already reports an
    // open transaction when withImmediateTransaction runs.
    db.exec("BEGIN");

    expect(() =>
      withImmediateTransaction(db, () => {
        db.exec("CREATE TABLE IF NOT EXISTS t (x INTEGER)");
        db.prepare("INSERT INTO t (x) VALUES (1)").run();
      }),
    ).not.toThrow();

    const count = (db.prepare("SELECT count(*) AS c FROM t").get() as { c: number }).c;
    expect(count).toBe(1);
  });

  test("retries when BEGIN IMMEDIATE returns WITHOUT opening a transaction (phantom)", () => {
    // The CI-only failure mode: bun:sqlite returns from BEGIN IMMEDIATE under
    // contention without actually opening a transaction (no throw), which used to
    // surface as "cannot commit - no transaction is active" at COMMIT — after the
    // body already ran in autocommit. The helper now detects !inTransaction BEFORE
    // the body and retries. Simulated by swallowing the FIRST BEGIN IMMEDIATE so
    // the connection reports no open transaction; the retry runs a real one.
    let beginCount = 0;
    const fake = {
      exec: (sql: string) => {
        if (sql === "BEGIN IMMEDIATE" && ++beginCount === 1) return; // phantom: no transaction opens
        db.exec(sql);
      },
      get inTransaction() {
        return db.inTransaction;
      },
    } as unknown as Database;

    let bodyCalls = 0;
    withImmediateTransaction(fake, () => {
      bodyCalls += 1;
      db.exec("CREATE TABLE IF NOT EXISTS t (x INTEGER)");
      db.prepare("INSERT INTO t (x) VALUES (7)").run();
    });

    expect(beginCount).toBe(2); // first BEGIN was phantom → retried once
    expect(bodyCalls).toBe(1); // body ran exactly once, on the real transaction
    expect((db.prepare("SELECT count(*) AS c FROM t").get() as { c: number }).c).toBe(1);
  });

  test("commits the transaction body and returns its value", () => {
    const result = withImmediateTransaction(db, () => {
      db.exec("CREATE TABLE IF NOT EXISTS t (x INTEGER)");
      db.prepare("INSERT INTO t (x) VALUES (42)").run();
      return "done";
    });
    expect(result).toBe("done");
    expect((db.prepare("SELECT x FROM t").get() as { x: number }).x).toBe(42);
  });

  test("a real error in the body is NOT retried — it rolls back and rethrows immediately", () => {
    db.exec("CREATE TABLE IF NOT EXISTS t (x INTEGER)");
    let calls = 0;
    expect(() =>
      withImmediateTransaction(db, () => {
        calls += 1;
        db.prepare("INSERT INTO t (x) VALUES (1)").run();
        throw new Error("boom from body");
      }),
    ).toThrow("boom from body");
    // Body ran exactly once (no retry), and its write was rolled back.
    expect(calls).toBe(1);
    expect((db.prepare("SELECT count(*) AS c FROM t").get() as { c: number }).c).toBe(0);
    // Connection is left usable (no lingering transaction).
    expect(() => withImmediateTransaction(db, () => db.prepare("INSERT INTO t (x) VALUES (2)").run())).not.toThrow();
    expect((db.prepare("SELECT count(*) AS c FROM t").get() as { c: number }).c).toBe(1);
  });
});
