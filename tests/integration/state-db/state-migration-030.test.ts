// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * TESTS for state migration `030-usage-events-created-at-index`: an index on
 * `datetime(created_at)` so the time-window reads of `usage_events`
 * (`activity.events`, `akm metrics`, the retention DELETE) stop scanning the
 * table. No data is rewritten, so results must not change.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { STATE_MIGRATIONS } from "../../../src/core/state/migrations";
import { openStateDatabase } from "../../../src/core/state-db";
import { openDatabase } from "../../../src/storage/database";
import { listUsageEventRows } from "../../../src/storage/repositories/metrics-repository";
import { runMigrations } from "../../../src/storage/sqlite-migrations";

const MIGRATION_ID = "030-usage-events-created-at-index";
const roots: string[] = [];

function statePath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-state-migration-030-"));
  roots.push(root);
  return path.join(root, "state.db");
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function plan(db: ReturnType<typeof openDatabase>, sql: string, ...params: string[]): string {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
    .map((row) => row.detail)
    .join("\n");
}

describe("migration 030-usage-events-created-at-index", () => {
  test("is the last registered migration, after the 29 baseline ids", () => {
    expect(STATE_MIGRATIONS[STATE_MIGRATIONS.length - 1]?.id).toBe(MIGRATION_ID);
    expect(STATE_MIGRATIONS).toHaveLength(30);
  });

  test("upgrades a pre-030 database, keeps its rows, and is idempotent", () => {
    const file = statePath();
    const seeded = openDatabase(file);
    runMigrations(seeded, STATE_MIGRATIONS.slice(0, -1));
    seeded.exec("INSERT INTO usage_events (event_type, created_at) VALUES ('search', '2026-11-01 10:00:00')");
    seeded.close();

    const db = openStateDatabase(file);
    try {
      expect(db.prepare("SELECT COUNT(*) AS n FROM usage_events").get()).toEqual({ n: 1 });
      expect(db.prepare("SELECT id FROM schema_migrations WHERE id = ?").get(MIGRATION_ID)).toEqual({
        id: MIGRATION_ID,
      });
      // CREATE INDEX IF NOT EXISTS: re-running the body on a database that has the index is a no-op.
      db.exec(STATE_MIGRATIONS[STATE_MIGRATIONS.length - 1]?.up ?? "");
    } finally {
      db.close();
    }
  });

  test("a database written by 0.10.261120 (030 already recorded) opens unchanged", () => {
    const file = statePath();
    const seeded = openDatabase(file);
    runMigrations(seeded, STATE_MIGRATIONS);
    seeded.close();

    const db = openStateDatabase(file);
    try {
      expect(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual({ n: 30 });
    } finally {
      db.close();
    }
  });

  test("the activity.events window query and the retention DELETE use the index, results unchanged", () => {
    const db = openStateDatabase(statePath());
    try {
      const insert = db.prepare(
        "INSERT INTO usage_events (event_type, source, created_at) VALUES ('search', 'user', ?)",
      );
      // The stored format is `YYYY-MM-DD HH:MM:SS`; an ISO row must still compare exactly.
      for (const at of [
        "2026-11-01 09:59:59",
        "2026-11-01 10:00:00",
        "2026-11-01T10:30:00.000Z",
        "2026-11-01 11:00:00",
      ])
        insert.run(at);

      const rows = listUsageEventRows(db, {
        sinceIso: "2026-11-01T10:00:00.000Z",
        untilIso: "2026-11-01T11:00:00.000Z",
      });
      expect(rows.map((row) => row.created_at)).toEqual(["2026-11-01 10:00:00", "2026-11-01T10:30:00.000Z"]);

      const window = plan(
        db,
        `SELECT id FROM usage_events WHERE datetime(created_at) >= datetime(?) AND datetime(created_at) < datetime(?)
         ORDER BY datetime(created_at) DESC, id DESC LIMIT 10`,
        "2026-11-01T10:00:00.000Z",
        "2026-11-01T11:00:00.000Z",
      );
      expect(window).toContain("idx_usage_events_created_at");
      expect(window).not.toContain("SCAN usage_events");

      const retention = plan(db, "DELETE FROM usage_events WHERE datetime(created_at) < datetime(?)", "2026-11-01");
      expect(retention).toContain("idx_usage_events_created_at");
    } finally {
      db.close();
    }
  });
});
