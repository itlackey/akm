// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Coverage-hardening: feedback→utility DB write + usage_events retention/query.
 *
 * `applyFeedbackToUtilityScore` (the DB read/apply/write wrapper around the pure
 * MemRL policy) and `purgeOldUsageEvents` (retention cutoff) had NO tests — the
 * policy math was tested in isolation, but the wrapper's write/no-write and
 * threshold-crossing branches, and the retention boundary + guard branches,
 * were untested. `getUsageEvents({ since })` and the delete cascade into
 * `utility_scores`/`usage_events` were also unexercised. This fills those gaps.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyFeedbackToUtilityScore,
  closeDatabase,
  deleteEntriesByIds,
  getUtilityScore,
  openIndexDatabase,
  upsertEntry,
} from "../../src/indexer/db/db";
import { FEEDBACK_LR } from "../../src/indexer/feedback/utility-policy";
import type { StashEntry } from "../../src/indexer/passes/metadata";
import { getUsageEvents, insertUsageEvent, purgeOldUsageEvents } from "../../src/indexer/usage/usage-events";
import type { Database } from "../../src/storage/database";
import { type Cleanup, sandboxXdgCacheHome, sandboxXdgConfigHome } from "../_helpers/sandbox";

const createdTmpDirs: string[] = [];
function tmpDb(): Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-covuu-"));
  createdTmpDirs.push(dir);
  return openIndexDatabase(path.join(dir, "test.db"));
}
afterAll(() => {
  for (const dir of createdTmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

let envCleanup: Cleanup = () => {};
beforeEach(() => {
  const cache = sandboxXdgCacheHome();
  envCleanup = sandboxXdgConfigHome(cache.cleanup).cleanup;
});
afterEach(() => {
  envCleanup();
  envCleanup = () => {};
});

function seedEntry(db: Database, name: string, type: StashEntry["type"] = "skill"): number {
  const key = `/s:${type}:${name}`;
  return upsertEntry(db, key, "/s/d", `/s/d/${name}.md`, "/s", { name, type, description: "d" } as StashEntry, name);
}

// ── applyFeedbackToUtilityScore ─────────────────────────────────────────────
describe("applyFeedbackToUtilityScore — read/apply/write wrapper", () => {
  test("zero feedback writes NO row and leaves utility untouched", () => {
    const db = tmpDb();
    try {
      const id = seedEntry(db, "z");
      const r = applyFeedbackToUtilityScore(db, id, 0, 0);
      expect(r.previousUtility).toBe(0.5);
      expect(r.nextUtility).toBe(0.5);
      expect(r.crossedReviewThreshold).toBe(false);
      // Critical: the no-feedback branch must not touch the DB.
      expect(getUtilityScore(db, id)).toBeUndefined();
    } finally {
      closeDatabase(db);
    }
  });

  test("a new entry starts at the 0.5 midpoint and steps up on positive feedback", () => {
    const db = tmpDb();
    try {
      const id = seedEntry(db, "p");
      const r = applyFeedbackToUtilityScore(db, id, 1, 0);
      // next = 0.5 + lr·(1 − 0.5)
      expect(r.nextUtility).toBeCloseTo(0.5 + FEEDBACK_LR * 0.5, 10);
      const persisted = getUtilityScore(db, id);
      expect(persisted?.utility).toBeCloseTo(r.nextUtility, 10);
    } finally {
      closeDatabase(db);
    }
  });

  test("persists across calls: a second negative step reads the stored value, not 0.5", () => {
    const db = tmpDb();
    try {
      const id = seedEntry(db, "seq");
      const up = applyFeedbackToUtilityScore(db, id, 1, 0); // 0.5 → 0.55
      const down = applyFeedbackToUtilityScore(db, id, 0, 1); // previous must be 0.55, not 0.5
      expect(down.previousUtility).toBeCloseTo(up.nextUtility, 10);
      expect(down.nextUtility).toBeCloseTo(up.nextUtility + FEEDBACK_LR * (0 - up.nextUtility), 10);
    } finally {
      closeDatabase(db);
    }
  });

  test("flags a high-utility asset crossing below the review threshold", () => {
    const db = tmpDb();
    try {
      const id = seedEntry(db, "cross");
      // Seed utility just above 0.5 so a single negative step lands below it.
      applyFeedbackToUtilityScore(db, id, 1, 0); // 0.5 → 0.55 (>= HIGH threshold)
      const r = applyFeedbackToUtilityScore(db, id, 0, 1); // 0.55 → ~0.495 (< REVIEW threshold)
      expect(r.previousUtility).toBeGreaterThanOrEqual(0.5);
      expect(r.nextUtility).toBeLessThan(0.5);
      expect(r.crossedReviewThreshold).toBe(true);
    } finally {
      closeDatabase(db);
    }
  });
});

// ── purgeOldUsageEvents — retention cutoff + guard branches ──────────────────
describe("purgeOldUsageEvents — retention boundary", () => {
  function seedAt(db: Database, daysAgo: number): void {
    const ts = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
    db.prepare("INSERT INTO usage_events (event_type, created_at) VALUES ('search', ?)").run(ts);
  }

  test("deletes rows strictly older than the cutoff, keeps recent rows", () => {
    const db = tmpDb();
    try {
      seedAt(db, 100); // older than 90d → purged
      seedAt(db, 200); // older → purged
      seedAt(db, 1); // recent → kept
      seedAt(db, 89); // just inside window → kept
      purgeOldUsageEvents(db, 90);
      const remaining = getUsageEvents(db);
      expect(remaining).toHaveLength(2);
    } finally {
      closeDatabase(db);
    }
  });

  test("is a no-op for non-positive / non-finite retention (never wipes the table)", () => {
    const db = tmpDb();
    try {
      seedAt(db, 500); // ancient row that a bad cutoff must NOT delete
      for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
        purgeOldUsageEvents(db, bad);
        expect(getUsageEvents(db)).toHaveLength(1);
      }
    } finally {
      closeDatabase(db);
    }
  });
});

// ── getUsageEvents({ since }) — inclusive lower bound ───────────────────────
describe("getUsageEvents — since filter (inclusive)", () => {
  test("returns only events at or after the since timestamp", () => {
    const db = tmpDb();
    try {
      db.prepare(
        "INSERT INTO usage_events (event_type, entry_ref, created_at) VALUES ('search','skill:a','2026-01-01 00:00:00')",
      ).run();
      db.prepare(
        "INSERT INTO usage_events (event_type, entry_ref, created_at) VALUES ('search','skill:b','2026-06-15 12:00:00')",
      ).run();
      db.prepare(
        "INSERT INTO usage_events (event_type, entry_ref, created_at) VALUES ('search','skill:c','2026-06-15 12:00:01')",
      ).run();

      const since = getUsageEvents(db, { since: "2026-06-15 12:00:00" });
      const refs = since.map((r) => r.entry_ref).sort();
      // Boundary row (exactly == since) is INCLUDED; the earlier row is excluded.
      expect(refs).toEqual(["skill:b", "skill:c"]);
    } finally {
      closeDatabase(db);
    }
  });

  test("combines since with an event_type filter (AND semantics)", () => {
    const db = tmpDb();
    try {
      db.prepare(
        "INSERT INTO usage_events (event_type, entry_ref, created_at) VALUES ('search','skill:old','2026-01-01 00:00:00')",
      ).run();
      db.prepare(
        "INSERT INTO usage_events (event_type, entry_ref, created_at) VALUES ('search','skill:new','2026-06-15 00:00:00')",
      ).run();
      db.prepare(
        "INSERT INTO usage_events (event_type, entry_ref, created_at) VALUES ('show','skill:new','2026-06-16 00:00:00')",
      ).run();

      const rows = getUsageEvents(db, { since: "2026-06-01 00:00:00", event_type: "search" });
      expect(rows).toHaveLength(1);
      expect(rows[0].entry_ref).toBe("skill:new");
    } finally {
      closeDatabase(db);
    }
  });
});

// ── deleteEntriesByIds — cascade into utility_scores + usage_events ──────────
describe("deleteEntriesByIds — related-row cascade", () => {
  test("removes the deleted entry's utility + usage rows, leaves siblings intact", () => {
    const db = tmpDb();
    try {
      const doomed = seedEntry(db, "doomed");
      const survivor = seedEntry(db, "survivor");
      applyFeedbackToUtilityScore(db, doomed, 1, 0);
      applyFeedbackToUtilityScore(db, survivor, 1, 0);
      insertUsageEvent(db, { event_type: "search", entry_ref: "skill:doomed", entry_id: doomed });
      insertUsageEvent(db, { event_type: "search", entry_ref: "skill:survivor", entry_id: survivor });

      deleteEntriesByIds(db, [doomed]);

      // The deleted entry's related rows are gone…
      expect(getUtilityScore(db, doomed)).toBeUndefined();
      expect(getUsageEvents(db, { entry_ref: "skill:doomed" })).toHaveLength(0);
      // …but the survivor's rows are untouched.
      expect(getUtilityScore(db, survivor)).toBeDefined();
      expect(getUsageEvents(db, { entry_ref: "skill:survivor" })).toHaveLength(1);
    } finally {
      closeDatabase(db);
    }
  });

  test("empty id list is a safe no-op", () => {
    const db = tmpDb();
    try {
      const id = seedEntry(db, "keep");
      applyFeedbackToUtilityScore(db, id, 1, 0);
      expect(() => deleteEntriesByIds(db, [])).not.toThrow();
      expect(getUtilityScore(db, id)).toBeDefined();
    } finally {
      closeDatabase(db);
    }
  });
});
