import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStateDatabase } from "../../src/core/state-db";
import { insertUsageEvent, purgeOldUsageEvents, type UsageEventRow } from "../../src/indexer/usage/usage-events";
import type { Database } from "../../src/storage/database";
import { type Cleanup, sandboxXdgCacheHome, sandboxXdgConfigHome } from "../_helpers/sandbox";

/** Read back inserted rows directly — `getUsageEvents` was dropped as dead code (no production reader). */
function readEvents(db: Database): UsageEventRow[] {
  return db.prepare("SELECT * FROM usage_events ORDER BY id ASC").all() as UsageEventRow[];
}

// ── Temp directory management ───────────────────────────────────────────────

const createdTmpDirs: string[] = [];

function tmpDir(label = "telemetry"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `akm-${label}-`));
  createdTmpDirs.push(dir);
  return dir;
}

function tmpDbPath(label = "telemetry"): string {
  const dir = tmpDir(label);
  return path.join(dir, "test.db");
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Environment isolation ───────────────────────────────────────────────────

let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const cacheResult = sandboxXdgCacheHome();
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  envCleanup = cfgResult.cleanup;
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
});

// ── Test 1: usage_events table exists in state.db (state migration 020) ───
// Chunk-8 WI-8.3: usage_events is a state.db table now (folded by migration
// 020), not an index.db one; these telemetry-function tests open state.db.

describe("Usage Telemetry", () => {
  test("usage_events table exists in state.db (state migration 020)", () => {
    const dbPath = tmpDbPath();
    const db = openStateDatabase(dbPath);
    try {
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='usage_events'").get() as
        | { name: string }
        | undefined;
      expect(row).toBeDefined();
      expect(row?.name).toBe("usage_events");
    } finally {
      db.close();
    }
  });

  // ── Test 2: insertUsageEvent writes a search event ──────────────────────

  test("insertUsageEvent writes a search event", () => {
    const dbPath = tmpDbPath();
    const db = openStateDatabase(dbPath);
    try {
      insertUsageEvent(db, {
        event_type: "search",
        query: "deploy tool",
        metadata: JSON.stringify({ entry_refs: ["stash//skills/deploy", "stash//commands/rollback"] }),
      });

      const events = readEvents(db);
      expect(events).toHaveLength(1);
      expect(events[0]!.event_type).toBe("search");
      expect(events[0]!.query).toBe("deploy tool");
    } finally {
      db.close();
    }
  });

  // ── Test 3: insertUsageEvent writes a show event ────────────────────────

  test("insertUsageEvent writes a show event", () => {
    const dbPath = tmpDbPath();
    const db = openStateDatabase(dbPath);
    try {
      insertUsageEvent(db, {
        event_type: "show",
        entry_ref: "stash//skills/deploy",
      });

      const events = readEvents(db);
      expect(events).toHaveLength(1);
      expect(events[0]!.event_type).toBe("show");
      expect(events[0]!.entry_ref).toBe("stash//skills/deploy");
    } finally {
      db.close();
    }
  });

  // ── Test 4: insertUsageEvent writes a feedback event ────────────────────

  test("insertUsageEvent writes a feedback event with positive signal", () => {
    const dbPath = tmpDbPath();
    const db = openStateDatabase(dbPath);
    try {
      insertUsageEvent(db, {
        event_type: "feedback",
        entry_ref: "stash//skills/deploy",
        signal: "positive",
        metadata: JSON.stringify({ note: "Very useful skill" }),
      });

      const events = readEvents(db);
      expect(events).toHaveLength(1);
      expect(events[0]!.event_type).toBe("feedback");
      expect(events[0]!.signal).toBe("positive");
      expect(events[0]!.entry_ref).toBe("stash//skills/deploy");
    } finally {
      db.close();
    }
  });

  test("insertUsageEvent writes a feedback event with negative signal", () => {
    const dbPath = tmpDbPath();
    const db = openStateDatabase(dbPath);
    try {
      insertUsageEvent(db, {
        event_type: "feedback",
        entry_ref: "stash//commands/broken-cmd",
        signal: "negative",
      });

      const events = readEvents(db);
      expect(events).toHaveLength(1);
      expect(events[0]!.signal).toBe("negative");
    } finally {
      db.close();
    }
  });

  // ── Test 5: Event insertion does not throw on DB errors ─────────────────

  test("insertUsageEvent does not throw on DB errors (fire-and-forget)", () => {
    const dbPath = tmpDbPath();
    const db = openStateDatabase(dbPath);
    try {
      // Drop the usage_events table to force an error
      db.exec("DROP TABLE IF EXISTS usage_events");

      // Should not throw even though the table doesn't exist
      expect(() => {
        insertUsageEvent(db, { event_type: "search", query: "should not throw" });
      }).not.toThrow();
    } finally {
      db.close();
    }
  });

  // ── Test 6: created_at is auto-populated ────────────────────────────────

  test("created_at is auto-populated", () => {
    const dbPath = tmpDbPath();
    const db = openStateDatabase(dbPath);
    try {
      insertUsageEvent(db, { event_type: "search", query: "auto timestamp" });

      const events = readEvents(db);
      expect(events).toHaveLength(1);
      expect(events[0]!.created_at).toBeDefined();
      expect(typeof events[0]!.created_at).toBe("string");
      // Verify it looks like a datetime string (YYYY-MM-DD HH:MM:SS)
      expect(events[0]!.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    } finally {
      db.close();
    }
  });

  // ── Test 7: metadata field stores JSON ──────────────────────────────────

  test("metadata field stores JSON and is retrievable and parseable", () => {
    const dbPath = tmpDbPath();
    const db = openStateDatabase(dbPath);
    try {
      const meta = { entry_refs: ["stash//skills/deploy", "stash//commands/rollback"], resultCount: 5 };
      insertUsageEvent(db, {
        event_type: "search",
        query: "deploy",
        metadata: JSON.stringify(meta),
      });

      const events = readEvents(db);
      expect(events).toHaveLength(1);
      expect(events[0]!.metadata).toBeDefined();
      const parsed = JSON.parse(events[0]!.metadata ?? "");
      expect(parsed.entry_refs).toEqual(["stash//skills/deploy", "stash//commands/rollback"]);
      expect(parsed.resultCount).toBe(5);
    } finally {
      db.close();
    }
  });

  // ── Test 8: entry_id field is stored correctly ───────────────────────────

  test("entry_id field is stored correctly", () => {
    const dbPath = tmpDbPath();
    const db = openStateDatabase(dbPath);
    try {
      insertUsageEvent(db, {
        event_type: "show",
        entry_id: 42,
        entry_ref: "stash//skills/deploy",
      });

      const events = readEvents(db);
      expect(events).toHaveLength(1);
      expect(events[0]!.entry_id).toBe(42);
    } finally {
      db.close();
    }
  });

  // ── purgeOldUsageEvents boundary ──────────────────────────────────────────

  test("purgeOldUsageEvents keeps a row 1h newer than the cutoff on the same date", () => {
    const dbPath = tmpDbPath();
    const db = openStateDatabase(dbPath);
    try {
      // Cutoff = 2026-09-08T12:00:00Z. `created_at` is `YYYY-MM-DD HH:MM:SS`, so a
      // raw string compare against the ISO cutoff (`T` sorts after a space) would
      // wrongly delete every row on the cutoff's date.
      spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-08T12:00:00.000Z"));
      const insert = db.prepare("INSERT INTO usage_events (event_type, entry_ref, created_at) VALUES ('show', ?, ?)");
      insert.run("stash//skills/older", "2026-09-08 11:00:00");
      insert.run("stash//skills/newer", "2026-09-08 13:00:00");

      purgeOldUsageEvents(db, 30);

      const refs = readEvents(db).map((e) => e.entry_ref);
      expect(refs).toEqual(["stash//skills/newer"]);
    } finally {
      db.close();
    }
  });
});
