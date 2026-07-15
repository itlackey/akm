/**
 * Tests for `purgeOldEvents()` — the events-table retention helper wired into
 * the improve post-loop maintenance pass (Fix #2 in the 0.8.0 observability
 * sweep). Without this trim, `state.db` grows forever — `akm health` writes a
 * `health_probe` row on every invocation, and every command surface emits at
 * least one event besides.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openStateDatabase } from "../../src/core/state-db";
import { insertEvent, purgeOldEvents } from "../../src/storage/repositories/events-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

describe("purgeOldEvents", () => {
  test("removes events older than retentionDays and keeps recent ones", () => {
    const db = openStateDatabase();
    try {
      const now = Date.now();
      const day = 86_400_000;

      // Older than 90 days — should be purged at retention=90.
      const oldTs = new Date(now - 120 * day).toISOString();
      insertEvent(db, { eventType: "health_probe", ts: oldTs, ref: "health:probe" });
      insertEvent(db, { eventType: "health_probe", ts: oldTs, ref: "health:probe" });
      // Within retention window — must survive.
      const recentTs = new Date(now - 3 * day).toISOString();
      insertEvent(db, { eventType: "reflect_invoked", ts: recentTs, ref: "lesson:fresh" });

      const before = db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number };
      expect(before.c).toBe(3);

      const purged = purgeOldEvents(db, 90);
      expect(purged).toBe(2);

      const after = db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number };
      expect(after.c).toBe(1);

      const survivors = db.prepare("SELECT event_type, ref FROM events").all() as Array<{
        event_type: string;
        ref: string | null;
      }>;
      expect(survivors).toEqual([{ event_type: "reflect_invoked", ref: "lesson:fresh" }]);
    } finally {
      db.close();
    }
  });

  test("returns 0 and is a no-op when retentionDays is 0 (disabled)", () => {
    const db = openStateDatabase();
    try {
      const oldTs = new Date(Date.now() - 365 * 86_400_000).toISOString();
      insertEvent(db, { eventType: "health_probe", ts: oldTs, ref: "health:probe" });

      const purged = purgeOldEvents(db, 0);
      expect(purged).toBe(0);

      const after = db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number };
      expect(after.c).toBe(1);
    } finally {
      db.close();
    }
  });

  test("returns 0 when there are no events older than the window", () => {
    const db = openStateDatabase();
    try {
      const recentTs = new Date(Date.now() - 1 * 86_400_000).toISOString();
      insertEvent(db, { eventType: "reflect_invoked", ts: recentTs, ref: "lesson:x" });

      const purged = purgeOldEvents(db, 90);
      expect(purged).toBe(0);

      const after = db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number };
      expect(after.c).toBe(1);
    } finally {
      db.close();
    }
  });

  test("ignores non-finite retentionDays (treated as disabled)", () => {
    const db = openStateDatabase();
    try {
      const oldTs = new Date(Date.now() - 365 * 86_400_000).toISOString();
      insertEvent(db, { eventType: "health_probe", ts: oldTs, ref: "health:probe" });

      expect(purgeOldEvents(db, Number.NaN)).toBe(0);
      expect(purgeOldEvents(db, Number.POSITIVE_INFINITY)).toBe(0);

      const after = db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number };
      expect(after.c).toBe(1);
    } finally {
      db.close();
    }
  });
});
