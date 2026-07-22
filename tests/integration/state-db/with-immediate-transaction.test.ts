// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests for `withImmediateTransaction` concurrency hardening.
 *
 * Issue #686: a nested/re-entrant withImmediateTransaction call used to hit
 * "cannot start a transaction within a transaction" at BEGIN, which the retry
 * path classified as retryable and answered with an unconditional ROLLBACK —
 * destroying the OUTER transaction, so the outer COMMIT threw
 * "cannot commit - no transaction is active" (the CI-only proposal-queue
 * flake). The helper is now re-entrant: if a transaction is already open on
 * the connection at entry, fn joins it (no BEGIN/COMMIT/ROLLBACK of its own).
 * "database is locked" at BEGIN remains a transient, retried failure. Errors
 * thrown by the transaction BODY are real and never retried.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { openStateDatabase, withImmediateTransaction } from "../../../src/core/state-db";
import type { Database } from "../../../src/storage/database";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

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

  test("re-entrancy at entry: joins an already-open transaction instead of BEGIN/COMMIT of its own", () => {
    // A transaction is already open on the connection when the helper runs.
    db.exec("BEGIN");
    db.exec("CREATE TABLE IF NOT EXISTS t (x INTEGER)");
    db.prepare("INSERT INTO t (x) VALUES (1)").run();

    const result = withImmediateTransaction(db, () => {
      db.prepare("INSERT INTO t (x) VALUES (2)").run();
      return "joined";
    });
    expect(result).toBe("joined");

    // The helper neither rolled back nor committed the caller's transaction:
    // it is still open, with BOTH writes intact.
    expect(db.inTransaction).toBe(true);
    expect((db.prepare("SELECT count(*) AS c FROM t").get() as { c: number }).c).toBe(2);

    // The caller's own COMMIT still works and persists both writes.
    db.exec("COMMIT");
    expect(db.inTransaction).toBe(false);
    expect((db.prepare("SELECT count(*) AS c FROM t").get() as { c: number }).c).toBe(2);
  });

  test("nested call inside fn joins the outer transaction; the outer COMMIT still succeeds (#686)", () => {
    // The exact issue #686 shape: an outer withImmediateTransaction whose body
    // calls withImmediateTransaction again on the same connection. The nested
    // frame must NOT roll back the outer transaction, and the outer frame's
    // COMMIT must not throw "cannot commit - no transaction is active".
    const outcome = withImmediateTransaction(db, () => {
      db.exec("CREATE TABLE IF NOT EXISTS t (x INTEGER)");
      db.prepare("INSERT INTO t (x) VALUES (1)").run();

      const nested = withImmediateTransaction(db, () => {
        db.prepare("INSERT INTO t (x) VALUES (2)").run();
        return "nested-ok";
      });

      // The outer transaction survived the nested call with its write intact.
      expect(db.inTransaction).toBe(true);
      db.prepare("INSERT INTO t (x) VALUES (3)").run();
      return nested;
    });

    expect(outcome).toBe("nested-ok");
    expect(db.inTransaction).toBe(false);
    // All three writes (outer-before, nested, outer-after) committed atomically.
    expect((db.prepare("SELECT count(*) AS c FROM t").get() as { c: number }).c).toBe(3);
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
