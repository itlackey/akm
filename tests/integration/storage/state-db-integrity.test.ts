// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * R0 (tier0-0917): real on-disk `PRAGMA quick_check` / freelist / VACUUM
 * coverage for src/storage/state-db-integrity.ts. The pure check-registry
 * projection is covered by tests/health-state-db-integrity-check.test.ts;
 * this file proves the probes themselves — which open a real state.db —
 * actually detect real corruption and real reclaimable space.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { getStateDbPath, openStateDatabase } from "../../../src/core/state-db";
import { openDatabase } from "../../../src/storage/database";
import { insertEventStrict } from "../../../src/storage/repositories/events-repository";
import {
  getStateDbFreelistInfo,
  runStateDbQuickCheck,
  STATE_DB_FREELIST_WARN_RATIO,
  STATE_DB_VACUUMED_EVENT,
  vacuumStateDbIfReclaimable,
} from "../../../src/storage/state-db-integrity";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

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
 * matching what quick_check is meant to catch.
 */
function corruptDatabaseFile(dbPath: string): void {
  const buf = fs.readFileSync(dbPath);
  for (let i = 100; i < buf.length; i++) buf[i] = 0xff;
  fs.writeFileSync(dbPath, buf);
}

describe("runStateDbQuickCheck (R0)", () => {
  test("reports ok on a freshly created, healthy state.db", () => {
    const dbPath = getStateDbPath();
    openStateDatabase(dbPath).close();

    const result = runStateDbQuickCheck(dbPath);
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

    const result = runStateDbQuickCheck(dbPath);
    expect(result.ok).toBe(false);
    // Real corruption surfaces either as quick_check's own diagnostic lines
    // or as a thrown SQLITE_CORRUPT the probe converts to `error` — both are
    // "not ok", which is what the check registry keys off of.
    expect(result.lines.length > 0 || Boolean(result.error)).toBe(true);
    expect(result.lines).not.toEqual(["ok"]);
  });

  test("reports an error (not a throw) when the file cannot be opened at all", () => {
    const dbPath = getStateDbPath();
    // No file at this path — never created.
    const result = runStateDbQuickCheck(dbPath);
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

describe("vacuumStateDbIfReclaimable (R0)", () => {
  test("does not VACUUM and reports below-threshold when the freelist ratio is low", () => {
    const dbPath = getStateDbPath();
    const db = openStateDatabase(dbPath);
    try {
      const outcome = vacuumStateDbIfReclaimable(db, { freelistCount: 1, pageCount: 1000, ratio: 0.001 });
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

      const outcome = vacuumStateDbIfReclaimable(db, before);
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

      const outcome = vacuumStateDbIfReclaimable(db, { freelistCount: 900, pageCount: 1000, ratio: 0.9 });
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
