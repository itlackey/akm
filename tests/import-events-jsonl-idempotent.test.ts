/**
 * Tests for `importEventsJsonl` idempotency (release-blocker fix for 0.8.0).
 *
 * Background: the v0.7→v0.8 migration script (`scripts/migrate-storage.ts`)
 * imports the legacy `events.jsonl` into the `events` table in `state.db`.
 * The migration guide explicitly recommends re-running the script as a
 * recovery path. Before this fix, the import had no dedup, so every re-run
 * double-imported the entire event log.
 *
 * The fix: pre-check each row against the table using the full tuple
 * `(event_type, ts, ref, metadata_json)`. Re-running the import is now a
 * no-op for already-present rows and only inserts rows that are missing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openStateDatabase } from "../src/core/state-db";
import { importEventsJsonl } from "../src/storage/repositories/events-repository";

let tmpDir: string;
let dbPath: string;
let jsonlPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-events-import-"));
  dbPath = path.join(tmpDir, "state.db");
  jsonlPath = path.join(tmpDir, "events.jsonl");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeJsonl(lines: Array<Record<string, unknown>>): void {
  fs.writeFileSync(jsonlPath, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
}

function countEvents(): number {
  const db = openStateDatabase(dbPath);
  try {
    const row = db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number };
    return row.c;
  } finally {
    db.close();
  }
}

describe("importEventsJsonl idempotency", () => {
  test("re-running the import does not double-insert rows", async () => {
    writeJsonl([
      { eventType: "show", ts: "2024-01-01T00:00:00.000Z", ref: "lesson:a", metadata: { hit: 1 } },
      { eventType: "search", ts: "2024-01-01T00:00:01.000Z", ref: null, metadata: { query: "foo" } },
      { eventType: "show", ts: "2024-01-01T00:00:02.000Z", ref: "lesson:b", metadata: { hit: 2 } },
    ]);

    // First import — inserts all three.
    {
      const db = openStateDatabase(dbPath);
      try {
        const result = await importEventsJsonl(db, jsonlPath);
        expect(result.imported).toBe(3);
        expect(result.skipped).toBe(0);
      } finally {
        db.close();
      }
    }
    expect(countEvents()).toBe(3);

    // Second import of the same file — must skip every row.
    {
      const db = openStateDatabase(dbPath);
      try {
        const result = await importEventsJsonl(db, jsonlPath);
        expect(result.imported).toBe(0);
        expect(result.skipped).toBe(3);
      } finally {
        db.close();
      }
    }
    // Row count must not double.
    expect(countEvents()).toBe(3);

    // Third import to confirm steady state.
    {
      const db = openStateDatabase(dbPath);
      try {
        const result = await importEventsJsonl(db, jsonlPath);
        expect(result.imported).toBe(0);
        expect(result.skipped).toBe(3);
      } finally {
        db.close();
      }
    }
    expect(countEvents()).toBe(3);
  });

  test("imports only the new rows when the JSONL file gains additional events between runs", async () => {
    writeJsonl([{ eventType: "show", ts: "2024-01-01T00:00:00.000Z", ref: "lesson:a", metadata: { hit: 1 } }]);

    {
      const db = openStateDatabase(dbPath);
      try {
        const r = await importEventsJsonl(db, jsonlPath);
        expect(r.imported).toBe(1);
        expect(r.skipped).toBe(0);
      } finally {
        db.close();
      }
    }
    expect(countEvents()).toBe(1);

    // Append a new event with a distinct ts; the existing row must not be
    // re-imported, the new row must be imported.
    writeJsonl([
      { eventType: "show", ts: "2024-01-01T00:00:00.000Z", ref: "lesson:a", metadata: { hit: 1 } },
      { eventType: "show", ts: "2024-01-01T00:00:01.000Z", ref: "lesson:b", metadata: { hit: 2 } },
    ]);

    {
      const db = openStateDatabase(dbPath);
      try {
        const r = await importEventsJsonl(db, jsonlPath);
        expect(r.imported).toBe(1);
        expect(r.skipped).toBe(1);
      } finally {
        db.close();
      }
    }
    expect(countEvents()).toBe(2);
  });

  test("rows with null ref are deduplicated correctly (IS-NULL semantics)", async () => {
    writeJsonl([
      { eventType: "search", ts: "2024-01-01T00:00:00.000Z", ref: null, metadata: { query: "a" } },
      { eventType: "search", ts: "2024-01-01T00:00:01.000Z", ref: null, metadata: { query: "b" } },
    ]);

    {
      const db = openStateDatabase(dbPath);
      try {
        const r = await importEventsJsonl(db, jsonlPath);
        expect(r.imported).toBe(2);
        expect(r.skipped).toBe(0);
      } finally {
        db.close();
      }
    }
    {
      const db = openStateDatabase(dbPath);
      try {
        const r = await importEventsJsonl(db, jsonlPath);
        // If the dedup query used `=` for ref, both NULLs would compare NULL
        // (i.e. unknown) and the rows would be re-imported. With IS, they are
        // skipped.
        expect(r.imported).toBe(0);
        expect(r.skipped).toBe(2);
      } finally {
        db.close();
      }
    }
    expect(countEvents()).toBe(2);
  });
});
