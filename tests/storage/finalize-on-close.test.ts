// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Zombie-close guard (issue #720): bun:sqlite's `close()` with an unfinalized
 * `prepare()` statement outstanding is a `sqlite3_close_v2` — the connection
 * and its WAL shared-memory survive until GC, and a later same-process
 * connection cannot leave WAL mode ("database is locked"). This silently
 * defeated migrate-apply's single-file conversion. The storage boundary now
 * finalizes tracked statements before the real close, so close means CLOSED.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requestGc } from "../../src/runtime";
import { openDatabaseFinalizing as openDatabase, openDatabase as openPlainDatabase } from "../../src/storage/database";

function journalMode(db: ReturnType<typeof openDatabase>): string {
  return String((db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined)?.journal_mode);
}

describe("openDatabaseFinalizing guard (#720)", () => {
  test("a connection closed with unfinalized prepares does not zombie the WAL", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-finalize-close-"));
    const p = path.join(dir, "state.db");
    try {
      // Seed a WAL-mode db and close WITH an unfinalized prepared statement —
      // the exact shape that previously left a zombie connection behind.
      const seed = openDatabase(p);
      seed.exec("PRAGMA journal_mode = WAL");
      seed.exec("CREATE TABLE t(x)");
      seed.exec("INSERT INTO t VALUES (1)");
      seed.prepare("SELECT x FROM t").get();
      seed.close();

      // A fresh connection must be able to leave WAL mode — impossible while
      // any zombie from the seed connection still maps the shared memory.
      const db = openDatabase(p);
      expect(journalMode(db)).toBe("wal");
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.exec("PRAGMA journal_mode = DELETE");
      expect(journalMode(db)).toBe("delete");
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a zombie from a PLAIN openDatabase close is healed by requestGc before conversion", () => {
    // Not every connection goes through openDatabaseFinalizing; the migrate
    // conversion's GC-retry must heal zombies from plain closes too.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-finalize-close-"));
    const p = path.join(dir, "state.db");
    try {
      const seed = openPlainDatabase(p);
      seed.exec("PRAGMA journal_mode = WAL");
      seed.exec("CREATE TABLE t(x)");
      seed.exec("INSERT INTO t VALUES (1)");
      seed.prepare("SELECT x FROM t").get();
      seed.close(); // zombie: unfinalized prepare keeps the WAL shm mapped

      const db = openDatabase(p);
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      let mode: string;
      try {
        db.exec("PRAGMA journal_mode = DELETE");
        mode = journalMode(db);
      } catch {
        mode = journalMode(db);
      }
      if (mode === "wal") {
        requestGc();
        db.exec("PRAGMA journal_mode = DELETE");
        mode = journalMode(db);
      }
      expect(mode).toBe("delete");
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("statements finalized by close still allow explicit finalize afterwards (idempotent)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-finalize-close-"));
    const p = path.join(dir, "t.db");
    try {
      const db = openDatabase(p);
      db.exec("CREATE TABLE t(x)");
      const stmt = db.prepare("SELECT x FROM t");
      stmt.all();
      db.close();
      // Double-finalize must not throw.
      expect(() => (stmt as { finalize?: () => void }).finalize?.()).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
