import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDatabase, openDatabase } from "../src/indexer/db";
import { getUsageEvents, insertUsageEvent } from "../src/indexer/usage-events";

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

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv.XDG_CACHE_HOME = process.env.XDG_CACHE_HOME;
  savedEnv.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CACHE_HOME = tmpDir("cache");
  process.env.XDG_CONFIG_HOME = tmpDir("config");
});

afterEach(() => {
  for (const [key, val] of Object.entries(savedEnv)) {
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }
});

// ── Test 1: usage_events table is created by ensureSchema ────────────────

describe("Usage Telemetry", () => {
  test("usage_events table is created by ensureSchema", () => {
    const dbPath = tmpDbPath();
    const db = openDatabase(dbPath);
    try {
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='usage_events'").get() as
        | { name: string }
        | undefined;
      expect(row).toBeDefined();
      expect(row?.name).toBe("usage_events");
    } finally {
      closeDatabase(db);
    }
  });

  // ── Test 2: insertUsageEvent writes a search event ──────────────────────

  test("insertUsageEvent writes a search event", () => {
    const dbPath = tmpDbPath();
    const db = openDatabase(dbPath);
    try {
      insertUsageEvent(db, {
        event_type: "search",
        query: "deploy tool",
        metadata: JSON.stringify({ entry_refs: ["skill:deploy", "command:rollback"] }),
      });

      const events = getUsageEvents(db);
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe("search");
      expect(events[0].query).toBe("deploy tool");
    } finally {
      closeDatabase(db);
    }
  });

  // ── Test 3: insertUsageEvent writes a show event ────────────────────────

  test("insertUsageEvent writes a show event", () => {
    const dbPath = tmpDbPath();
    const db = openDatabase(dbPath);
    try {
      insertUsageEvent(db, {
        event_type: "show",
        entry_ref: "skill:deploy",
      });

      const events = getUsageEvents(db);
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe("show");
      expect(events[0].entry_ref).toBe("skill:deploy");
    } finally {
      closeDatabase(db);
    }
  });

  // ── Test 4: insertUsageEvent writes a feedback event ────────────────────

  test("insertUsageEvent writes a feedback event with positive signal", () => {
    const dbPath = tmpDbPath();
    const db = openDatabase(dbPath);
    try {
      insertUsageEvent(db, {
        event_type: "feedback",
        entry_ref: "skill:deploy",
        signal: "positive",
        metadata: JSON.stringify({ note: "Very useful skill" }),
      });

      const events = getUsageEvents(db);
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe("feedback");
      expect(events[0].signal).toBe("positive");
      expect(events[0].entry_ref).toBe("skill:deploy");
    } finally {
      closeDatabase(db);
    }
  });

  test("insertUsageEvent writes a feedback event with negative signal", () => {
    const dbPath = tmpDbPath();
    const db = openDatabase(dbPath);
    try {
      insertUsageEvent(db, {
        event_type: "feedback",
        entry_ref: "command:broken-cmd",
        signal: "negative",
      });

      const events = getUsageEvents(db);
      expect(events).toHaveLength(1);
      expect(events[0].signal).toBe("negative");
    } finally {
      closeDatabase(db);
    }
  });

  // ── Test 5: getUsageEvents filters by event_type ────────────────────────

  test("getUsageEvents filters by event_type", () => {
    const dbPath = tmpDbPath();
    const db = openDatabase(dbPath);
    try {
      insertUsageEvent(db, { event_type: "search", query: "test query" });
      insertUsageEvent(db, { event_type: "show", entry_ref: "skill:a" });
      insertUsageEvent(db, { event_type: "feedback", entry_ref: "skill:b", signal: "positive" });
      insertUsageEvent(db, { event_type: "search", query: "another query" });

      const searchEvents = getUsageEvents(db, { event_type: "search" });
      expect(searchEvents).toHaveLength(2);
      for (const e of searchEvents) {
        expect(e.event_type).toBe("search");
      }

      const showEvents = getUsageEvents(db, { event_type: "show" });
      expect(showEvents).toHaveLength(1);
      expect(showEvents[0].event_type).toBe("show");

      const feedbackEvents = getUsageEvents(db, { event_type: "feedback" });
      expect(feedbackEvents).toHaveLength(1);
      expect(feedbackEvents[0].event_type).toBe("feedback");
    } finally {
      closeDatabase(db);
    }
  });

  // ── Test 6: getUsageEvents filters by entry_ref ─────────────────────────

  test("getUsageEvents filters by entry_ref", () => {
    const dbPath = tmpDbPath();
    const db = openDatabase(dbPath);
    try {
      insertUsageEvent(db, { event_type: "show", entry_ref: "skill:deploy" });
      insertUsageEvent(db, { event_type: "show", entry_ref: "skill:test" });
      insertUsageEvent(db, { event_type: "feedback", entry_ref: "skill:deploy", signal: "positive" });

      const deployEvents = getUsageEvents(db, { entry_ref: "skill:deploy" });
      expect(deployEvents).toHaveLength(2);
      for (const e of deployEvents) {
        expect(e.entry_ref).toBe("skill:deploy");
      }

      const testEvents = getUsageEvents(db, { entry_ref: "skill:test" });
      expect(testEvents).toHaveLength(1);
    } finally {
      closeDatabase(db);
    }
  });

  // ── Test 7: Event insertion does not throw on DB errors ─────────────────

  test("insertUsageEvent does not throw on DB errors (fire-and-forget)", () => {
    const dbPath = tmpDbPath();
    const db = openDatabase(dbPath);
    try {
      // Drop the usage_events table to force an error
      db.exec("DROP TABLE IF EXISTS usage_events");

      // Should not throw even though the table doesn't exist
      expect(() => {
        insertUsageEvent(db, { event_type: "search", query: "should not throw" });
      }).not.toThrow();
    } finally {
      closeDatabase(db);
    }
  });

  // ── Test 8: created_at is auto-populated ────────────────────────────────

  test("created_at is auto-populated", () => {
    const dbPath = tmpDbPath();
    const db = openDatabase(dbPath);
    try {
      insertUsageEvent(db, { event_type: "search", query: "auto timestamp" });

      const events = getUsageEvents(db);
      expect(events).toHaveLength(1);
      expect(events[0].created_at).toBeDefined();
      expect(typeof events[0].created_at).toBe("string");
      // Verify it looks like a datetime string (YYYY-MM-DD HH:MM:SS)
      expect(events[0].created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    } finally {
      closeDatabase(db);
    }
  });

  // ── Test 9: metadata field stores JSON ──────────────────────────────────

  test("metadata field stores JSON and is retrievable and parseable", () => {
    const dbPath = tmpDbPath();
    const db = openDatabase(dbPath);
    try {
      const meta = { entry_refs: ["skill:deploy", "command:rollback"], resultCount: 5 };
      insertUsageEvent(db, {
        event_type: "search",
        query: "deploy",
        metadata: JSON.stringify(meta),
      });

      const events = getUsageEvents(db);
      expect(events).toHaveLength(1);
      expect(events[0].metadata).toBeDefined();
      const parsed = JSON.parse(events[0].metadata ?? "");
      expect(parsed.entry_refs).toEqual(["skill:deploy", "command:rollback"]);
      expect(parsed.resultCount).toBe(5);
    } finally {
      closeDatabase(db);
    }
  });

  // ── Test 10: getUsageEvents supports combined filters ───────────────────

  test("getUsageEvents supports combined event_type and entry_ref filters", () => {
    const dbPath = tmpDbPath();
    const db = openDatabase(dbPath);
    try {
      insertUsageEvent(db, { event_type: "show", entry_ref: "skill:deploy" });
      insertUsageEvent(db, { event_type: "feedback", entry_ref: "skill:deploy", signal: "positive" });
      insertUsageEvent(db, { event_type: "show", entry_ref: "skill:test" });

      const filtered = getUsageEvents(db, { event_type: "show", entry_ref: "skill:deploy" });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].event_type).toBe("show");
      expect(filtered[0].entry_ref).toBe("skill:deploy");
    } finally {
      closeDatabase(db);
    }
  });

  // ── Test 11: entry_id field is stored correctly ─────────────────────────

  test("entry_id field is stored correctly", () => {
    const dbPath = tmpDbPath();
    const db = openDatabase(dbPath);
    try {
      insertUsageEvent(db, {
        event_type: "show",
        entry_id: 42,
        entry_ref: "skill:deploy",
      });

      const events = getUsageEvents(db);
      expect(events).toHaveLength(1);
      expect(events[0].entry_id).toBe(42);
    } finally {
      closeDatabase(db);
    }
  });
});
