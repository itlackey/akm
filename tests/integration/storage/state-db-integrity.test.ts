// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * R0: real on-disk `PRAGMA integrity_check` / freelist / VACUUM
 * coverage for src/storage/state-db-integrity.ts. The pure check-registry
 * projection is covered by tests/health-state-db-integrity-check.test.ts;
 * this file proves the probes themselves — which open a real state.db —
 * actually detect real corruption and real reclaimable space.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getStateDbPath, openStateDatabase } from "../../../src/core/state-db";
import { openDatabase } from "../../../src/storage/database";
import { insertEventStrict } from "../../../src/storage/repositories/events-repository";
import {
  getStateDbFreelistInfo,
  runStateDbIntegrityCheck,
  STATE_DB_FREELIST_WARN_RATIO,
  STATE_DB_VACUUMED_EVENT,
  vacuumIfReclaimable,
} from "../../../src/storage/state-db-integrity";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

const STATE_DB = { eventType: STATE_DB_VACUUMED_EVENT };

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

/**
 * Garbles page bytes past the SQLite header (first 100 bytes), same recipe
 * as tests/index-corruption-recovery.test.ts: `openDatabase()` still succeeds
 * (the header is intact), but any real page read trips SQLITE_CORRUPT —
 * matching what integrity_check is meant to catch.
 */
function corruptDatabaseFile(dbPath: string): void {
  const buf = fs.readFileSync(dbPath);
  for (let i = 100; i < buf.length; i++) buf[i] = 0xff;
  fs.writeFileSync(dbPath, buf);
}

describe("runStateDbIntegrityCheck (R0)", () => {
  test("reports ok on a freshly created, healthy state.db", () => {
    const dbPath = getStateDbPath();
    openStateDatabase(dbPath).close();

    const result = runStateDbIntegrityCheck(dbPath);
    expect(result.ok).toBe(true);
    expect(result.lines).toEqual(["ok"]);
    expect(result.error).toBeUndefined();
  });

  test("detects real on-disk corruption", () => {
    const dbPath = getStateDbPath();
    openStateDatabase(dbPath).close();

    // WAL mode leaves real data in the `-wal` file, not state.db itself —
    // garbling only the main file would corrupt bytes SQLite never reads.
    // Checkpoint first, matching tests/index-corruption-recovery.test.ts.
    const checkpointDb = openDatabase(dbPath);
    checkpointDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    checkpointDb.close();

    corruptDatabaseFile(dbPath);

    const result = runStateDbIntegrityCheck(dbPath);
    expect(result.ok).toBe(false);
    // Real corruption surfaces either as integrity_check's own diagnostic lines
    // or as a thrown SQLITE_CORRUPT the probe converts to `error` — both are
    // "not ok", which is what the check registry keys off of.
    expect(result.lines.length > 0 || Boolean(result.error)).toBe(true);
    expect(result.lines).not.toEqual(["ok"]);
  });

  test("detects an index that no longer matches its table, which quick_check calls ok", () => {
    // What a WAL deleted under a live connection leaves behind: the table's
    // page holds one value and the index entry another. quick_check never
    // compares the two; integrity_check does.
    const dbPath = path.join(storage.root, "index-mismatch.db");
    const seed = openDatabase(dbPath);
    seed.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT); CREATE INDEX t_v ON t(v)");
    seed.exec("INSERT INTO t(v) VALUES ('needle-aaaaaaaa'), ('hay-1'), ('hay-2')");
    seed.close();
    // The table's leaf page precedes the index's, so the first copy of the
    // value is the table row's: change only that one.
    const bytes = fs.readFileSync(dbPath);
    const needle = Buffer.from("needle-aaaaaaaa");
    const at = bytes.indexOf(needle);
    expect(at).toBeGreaterThan(0);
    bytes[at + needle.length - 1] = "b".charCodeAt(0);
    fs.writeFileSync(dbPath, bytes);

    const raw = openDatabase(dbPath, { readonly: true, create: false });
    try {
      expect(raw.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    } finally {
      raw.close();
    }

    const result = runStateDbIntegrityCheck(dbPath);
    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("row 1 missing from index t_v");
  });

  test("reports an error (not a throw) when the file cannot be opened at all", () => {
    const dbPath = getStateDbPath();
    // No file at this path — never created.
    const result = runStateDbIntegrityCheck(dbPath);
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe("getStateDbFreelistInfo (R0)", () => {
  test("ratio is 0 on a freshly created state.db", () => {
    const dbPath = getStateDbPath();
    openStateDatabase(dbPath).close();

    const info = getStateDbFreelistInfo(dbPath);
    expect(info.pageCount).toBeGreaterThan(0);
    expect(info.freelistCount).toBe(0);
    expect(info.ratio).toBe(0);
  });

  test("freelist grows (without VACUUM) after bulk delete, ratio > 0", () => {
    const dbPath = getStateDbPath();
    const db = openStateDatabase(dbPath);
    try {
      const ts = new Date().toISOString();
      const ids: number[] = [];
      // A big-enough, later-deleted payload so the freed pages dominate the
      // fixed schema/index overhead of a fresh state.db.
      const bigMetadata = { blob: "x".repeat(2000) };
      for (let i = 0; i < 3000; i++) {
        ids.push(
          insertEventStrict(db, { eventType: "reflect_invoked", ts, ref: `lessons/note-${i}`, metadata: bigMetadata }),
        );
      }
      for (const id of ids) {
        db.prepare("DELETE FROM events WHERE id = ?").run(id);
      }
    } finally {
      db.close();
    }

    const info = getStateDbFreelistInfo(dbPath);
    expect(info.freelistCount).toBeGreaterThan(0);
    expect(info.ratio).toBeGreaterThan(0);
  });

  test("A3: reports a zeroed info with error (not a throw) when the file cannot be opened at all", () => {
    const dbPath = getStateDbPath();
    // No file at this path — never created.
    const info = getStateDbFreelistInfo(dbPath);
    expect(info.freelistCount).toBe(0);
    expect(info.pageCount).toBe(0);
    expect(info.ratio).toBe(0);
    expect(info.error).toBeDefined();
  });
});

describe("vacuumIfReclaimable on state.db (R0)", () => {
  test("does not VACUUM and reports below-threshold when the freelist ratio is low", () => {
    const dbPath = getStateDbPath();
    const db = openStateDatabase(dbPath);
    try {
      const outcome = vacuumIfReclaimable(db, { freelistCount: 1, pageCount: 1000, ratio: 0.001 }, STATE_DB);
      expect(outcome.ran).toBe(false);
      expect(outcome.reason).toBe("below-threshold");
    } finally {
      db.close();
    }
  });

  test("VACUUMs and records an event when the freelist ratio is above threshold", () => {
    const dbPath = getStateDbPath();
    const db = openStateDatabase(dbPath);
    try {
      const ts = new Date().toISOString();
      const ids: number[] = [];
      // A big-enough, later-deleted payload so the freed pages dominate the
      // fixed schema/index overhead of a fresh state.db.
      const bigMetadata = { blob: "x".repeat(2000) };
      for (let i = 0; i < 3000; i++) {
        ids.push(
          insertEventStrict(db, { eventType: "reflect_invoked", ts, ref: `lessons/note-${i}`, metadata: bigMetadata }),
        );
      }
      for (const id of ids) {
        db.prepare("DELETE FROM events WHERE id = ?").run(id);
      }
      const before = getStateDbFreelistInfo(dbPath);
      expect(before.ratio).toBeGreaterThan(STATE_DB_FREELIST_WARN_RATIO);

      const outcome = vacuumIfReclaimable(db, before, STATE_DB);
      expect(outcome.ran).toBe(true);
      expect(outcome.pagesBefore).toBe(before.pageCount);
      expect(outcome.pagesAfter).toBeDefined();
      const pagesAfter = outcome.pagesAfter as number;
      expect(pagesAfter).toBeLessThan(before.pageCount);

      const after = getStateDbFreelistInfo(dbPath);
      expect(after.freelistCount).toBe(0);

      const event = db
        .prepare("SELECT metadata_json FROM events WHERE event_type = ? ORDER BY id DESC LIMIT 1")
        .get(STATE_DB_VACUUMED_EVENT) as { metadata_json: string } | undefined;
      expect(event).toBeDefined();
      const metadata = JSON.parse(event?.metadata_json ?? "{}") as { pagesBefore: number; pagesAfter: number };
      expect(metadata.pagesBefore).toBe(before.pageCount);
      expect(metadata.pagesAfter).toBe(pagesAfter);
    } finally {
      db.close();
    }
  });

  test("A3: honors a readOnly EventsContext — VACUUMs but does not append the event", () => {
    const dbPath = getStateDbPath();
    const db = openStateDatabase(dbPath);
    try {
      const ts = new Date().toISOString();
      const ids: number[] = [];
      const bigMetadata = { blob: "x".repeat(2000) };
      for (let i = 0; i < 3000; i++) {
        ids.push(
          insertEventStrict(db, { eventType: "reflect_invoked", ts, ref: `lessons/note-${i}`, metadata: bigMetadata }),
        );
      }
      for (const id of ids) {
        db.prepare("DELETE FROM events WHERE id = ?").run(id);
      }
      const before = getStateDbFreelistInfo(dbPath);
      expect(before.ratio).toBeGreaterThan(STATE_DB_FREELIST_WARN_RATIO);

      const outcome = vacuumIfReclaimable(db, before, STATE_DB, { readOnly: true, db });
      expect(outcome.ran).toBe(true);

      const event = db
        .prepare("SELECT metadata_json FROM events WHERE event_type = ? ORDER BY id DESC LIMIT 1")
        .get(STATE_DB_VACUUMED_EVENT) as { metadata_json: string } | null;
      expect(event).toBeNull();
    } finally {
      db.close();
    }
  });

  test("A3: uses the injected clock from EventsContext for the event's ts", () => {
    const dbPath = getStateDbPath();
    const db = openStateDatabase(dbPath);
    try {
      const ts = new Date().toISOString();
      const ids: number[] = [];
      const bigMetadata = { blob: "x".repeat(2000) };
      for (let i = 0; i < 3000; i++) {
        ids.push(
          insertEventStrict(db, { eventType: "reflect_invoked", ts, ref: `lessons/note-${i}`, metadata: bigMetadata }),
        );
      }
      for (const id of ids) {
        db.prepare("DELETE FROM events WHERE id = ?").run(id);
      }
      const before = getStateDbFreelistInfo(dbPath);
      expect(before.ratio).toBeGreaterThan(STATE_DB_FREELIST_WARN_RATIO);

      const injectedMs = new Date("2020-01-02T03:04:05.000Z").getTime();
      const outcome = vacuumIfReclaimable(db, before, STATE_DB, { db, now: () => injectedMs });
      expect(outcome.ran).toBe(true);

      const event = db
        .prepare("SELECT ts FROM events WHERE event_type = ? ORDER BY id DESC LIMIT 1")
        .get(STATE_DB_VACUUMED_EVENT) as { ts: string } | undefined;
      expect(event?.ts).toBe("2020-01-02T03:04:05.000Z");
    } finally {
      db.close();
    }
  });

  test("is skipped cleanly, never thrown, when the database is locked by another writer", () => {
    const dbPath = getStateDbPath();
    const db = openStateDatabase(dbPath);
    const blocker = openStateDatabase(dbPath);
    try {
      // Hold a write lock on a second connection so VACUUM (which needs
      // exclusive access) fails with SQLITE_BUSY/locked instead of blocking
      // for the full busy_timeout.
      blocker.exec("PRAGMA busy_timeout = 0");
      blocker.exec("BEGIN IMMEDIATE");
      db.exec("PRAGMA busy_timeout = 0");

      const outcome = vacuumIfReclaimable(db, { freelistCount: 900, pageCount: 1000, ratio: 0.9 }, STATE_DB);
      expect(outcome.ran).toBe(false);
      expect(outcome.reason).toBe("busy");
      expect(outcome.error).toBeDefined();
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
      db.close();
    }
  });
});
