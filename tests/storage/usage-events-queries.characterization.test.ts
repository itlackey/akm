// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  countFeedbackSignals,
  countUsageEventsByType,
  ensureUsageEventsSchema,
  getUsageEvents,
  type UsageEventRow,
} from "../../src/indexer/usage/usage-events";

/**
 * Characterization tests for the `usage_events` read queries that WS5 lifted
 * out of command code (feedback-cli.ts, improve.ts, history.ts) into
 * src/indexer/usage-events.ts.
 *
 * Each `expected*` block is the EXACT raw SQL that lived inline in the command
 * before extraction. The test asserts the new repository helper returns
 * byte-identical results against a directly-seeded in-memory usage_events table,
 * proving zero behaviour change.
 */
describe("usage_events query characterization (WS5)", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    ensureUsageEventsSchema(db);
    // Seed a representative spread of events. created_at is set explicitly so
    // the `since` filter is deterministic.
    const insert = db.prepare(
      `INSERT INTO usage_events (event_type, query, entry_id, entry_ref, signal, metadata, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const rows: Array<
      [string, string | null, number | null, string | null, string | null, string | null, string, string]
    > = [
      ["search", "alpha", 1, "lesson:a", null, null, "user", "2026-01-01 10:00:00"],
      ["show", null, 1, "lesson:a", null, null, "user", "2026-01-02 10:00:00"],
      ["show", null, 2, "lesson:b", null, null, "user", "2026-01-03 10:00:00"],
      ["feedback", null, 1, "lesson:a", "positive", "{}", "user", "2026-01-04 10:00:00"],
      ["feedback", null, 1, "lesson:a", "positive", "{}", "user", "2026-01-05 10:00:00"],
      ["feedback", null, 1, "lesson:a", "negative", "{}", "user", "2026-01-06 10:00:00"],
      ["feedback", null, 2, "lesson:b", "negative", "{}", "improve", "2026-01-07 10:00:00"],
      ["search", "beta", 2, "lesson:b", null, null, "improve", "2026-01-08 10:00:00"],
    ];
    for (const r of rows) insert.run(...r);
  });

  afterEach(() => {
    db.close();
  });

  test("countFeedbackSignals matches the inline feedback-cli SUM query", () => {
    const entryId = 1;
    const expected = db
      .prepare(
        `SELECT
           SUM(CASE WHEN signal = 'positive' THEN 1 ELSE 0 END) AS pos,
           SUM(CASE WHEN signal = 'negative' THEN 1 ELSE 0 END) AS neg
         FROM usage_events
         WHERE event_type = 'feedback' AND entry_id = ?`,
      )
      .get(entryId) as { pos: number | null; neg: number | null } | undefined;

    expect(countFeedbackSignals(db, entryId)).toEqual({
      pos: expected?.pos ?? 0,
      neg: expected?.neg ?? 0,
    });
    // entry 1: 2 positive, 1 negative.
    expect(countFeedbackSignals(db, 1)).toEqual({ pos: 2, neg: 1 });
    // entry 2: 0 positive, 1 negative.
    expect(countFeedbackSignals(db, 2)).toEqual({ pos: 0, neg: 1 });
    // unknown entry: zeroes (SUM over empty set is NULL -> coalesced to 0).
    expect(countFeedbackSignals(db, 999)).toEqual({ pos: 0, neg: 0 });
  });

  test("countUsageEventsByType matches the inline improve.ts COUNT query", () => {
    const expected = (
      db.prepare("SELECT COUNT(*) AS cnt FROM usage_events WHERE event_type = ?").get("show") as { cnt: number }
    ).cnt;
    expect(countUsageEventsByType(db, "show")).toBe(expected);
    expect(countUsageEventsByType(db, "show")).toBe(2);
    expect(countUsageEventsByType(db, "feedback")).toBe(4);
    expect(countUsageEventsByType(db, "nonexistent")).toBe(0);
  });

  test("getUsageEvents with `since` matches the inline history.ts query", () => {
    // Reproduce history.ts: filter by entry_ref + created_at >= since + source.
    const buildExpected = (conds: string[], params: unknown[]) => {
      const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
      const sql = `SELECT id, event_type, query, entry_id, entry_ref, signal, metadata, source, created_at
                   FROM usage_events ${where}
                   ORDER BY id ASC`;
      return db.prepare(sql).all(...(params as import("bun:sqlite").SQLQueryBindings[])) as UsageEventRow[];
    };

    // since only.
    expect(getUsageEvents(db, { since: "2026-01-05 00:00:00" })).toEqual(
      buildExpected(["created_at >= ?"], ["2026-01-05 00:00:00"]),
    );
    // since + entry_ref.
    expect(getUsageEvents(db, { since: "2026-01-04 00:00:00", entry_ref: "lesson:a" })).toEqual(
      buildExpected(["entry_ref = ?", "created_at >= ?"], ["lesson:a", "2026-01-04 00:00:00"]),
    );
    // since + source.
    expect(getUsageEvents(db, { since: "2026-01-01 00:00:00", source: "improve" })).toEqual(
      buildExpected(["created_at >= ?", "source = ?"], ["2026-01-01 00:00:00", "improve"]),
    );
    // no since (existing behaviour unchanged).
    expect(getUsageEvents(db, { entry_ref: "lesson:a" })).toEqual(buildExpected(["entry_ref = ?"], ["lesson:a"]));
  });

  test("getUsageEvents fully materialises results (survive db.close)", () => {
    const local = new Database(":memory:");
    ensureUsageEventsSchema(local);
    local
      .prepare("INSERT INTO usage_events (event_type, entry_ref, source) VALUES (?, ?, ?)")
      .run("search", "lesson:x", "user");
    const rows = getUsageEvents(local, {});
    local.close();
    // Array is a plain materialised copy — readable after the connection closes.
    expect(rows.length).toBe(1);
    expect(rows[0]?.entry_ref).toBe("lesson:x");
  });
});
