import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { listExistingTableNames, openStateDatabase } from "../../../src/core/state-db";
import { foldBeforePurge } from "../../../src/indexer/metrics/fold";
import type { Database } from "../../../src/storage/database";
import {
  blobToEmbedding,
  embeddingToBlob,
  getBodyEmbeddings,
  upsertBodyEmbeddings,
} from "../../../src/storage/repositories/embeddings-repository";
import { insertEvent } from "../../../src/storage/repositories/events-repository";
import { queryImproveRuns, recordImproveRun } from "../../../src/storage/repositories/improve-runs-repository";
import { purgeFoldedEvents } from "../../../src/storage/repositories/metrics-rollup-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

/**
 * Characterization tests for the state.db read helpers that absorb the
 * remaining raw-SQL leaks out of `src/commands/health.ts` (WS5 slice 5).
 *
 * health.ts hand-rolled two reads against state.db tables it does not own:
 *   1. improve_runs   — `loadImproveRunRows` (since-only and since+until windows).
 *   2. sqlite_master  — required-table presence check.
 *
 * These tests seed a real isolated state.db, capture the exact result of the
 * pre-existing inline SQL, and assert the new owner-module helpers
 * (`queryImproveRuns`, `listExistingTableNames`)
 * return byte-identical results — so the verbatim SQL move is behaviour-neutral.
 *
 * Connection-lifetime rule (WS5): every helper fully materializes its result
 * set (arrays / plain objects) before returning. The final assertion closes the
 * DB and confirms the returned values remain usable after close.
 */

let storage: IsolatedAkmStorage;
let db: Database;

// ── Inline SQL copied verbatim from health.ts at HEAD (the baseline). ─────────

function baselineImproveRunRows(database: Database, since: string, until?: string): unknown[] {
  const sql = until
    ? "SELECT id, started_at, completed_at, ok, scope_mode, scope_value, strategy, result_json FROM improve_runs WHERE started_at >= ? AND started_at < ? AND dry_run = 0 ORDER BY started_at DESC"
    : "SELECT id, started_at, completed_at, ok, scope_mode, scope_value, strategy, result_json FROM improve_runs WHERE started_at >= ? AND dry_run = 0 ORDER BY started_at DESC";
  return until ? database.prepare(sql).all(since, until) : database.prepare(sql).all(since);
}

function baselineTableNames(database: Database): unknown[] {
  return database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('events', 'task_history', 'proposals', 'schema_migrations') ORDER BY name",
    )
    .all();
}

function seedImproveRun(id: string, startedAt: string, dryRun: boolean): void {
  recordImproveRun(db, {
    id,
    startedAt,
    completedAt: startedAt,
    stashDir: "/tmp/stash",
    dryRun,
    strategy: "default",
    scopeMode: "all",
    scopeValue: null,
    guidance: null,
    ok: true,
    result: {
      schemaVersion: 2,
      ok: true,
      strategy: "default",
      scope: { mode: "all" },
      dryRun,
      memorySummary: { eligible: 0, derived: 0 },
      plannedRefs: [],
      actions: [],
    },
  });
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  db = openStateDatabase();

  // improve_runs: a mix of dry-run and real-run rows across the window.
  seedImproveRun("run-a", "2026-01-01T00:00:00.000Z", false);
  seedImproveRun("run-b", "2026-01-02T00:00:00.000Z", true); // dry-run — excluded
  seedImproveRun("run-c", "2026-01-03T00:00:00.000Z", false);
  seedImproveRun("run-d", "2026-02-01T00:00:00.000Z", false); // outside until window
});

afterEach(() => {
  storage.cleanup();
});

describe("queryImproveRuns", () => {
  test("matches inline SQL for a since-only window", () => {
    const since = "2026-01-01T00:00:00.000Z";
    expect(queryImproveRuns(db, since)).toEqual(baselineImproveRunRows(db, since) as never);
  });

  test("matches inline SQL for a since+until window", () => {
    const since = "2026-01-01T00:00:00.000Z";
    const until = "2026-01-31T00:00:00.000Z";
    expect(queryImproveRuns(db, since, until)).toEqual(baselineImproveRunRows(db, since, until) as never);
  });

  test("excludes dry-run rows and respects DESC ordering", () => {
    const rows = queryImproveRuns(db, "2026-01-01T00:00:00.000Z", "2026-01-31T00:00:00.000Z");
    expect(rows.map((r) => r.id)).toEqual(["run-c", "run-a"]);
  });
});

describe("listExistingTableNames", () => {
  test("matches inline SQL and returns the present required tables", () => {
    const names = listExistingTableNames(db, ["events", "task_history", "proposals", "schema_migrations"]);
    expect(names).toEqual(baselineTableNames(db) as never);
    expect(names).toEqual([
      { name: "events" },
      { name: "proposals" },
      { name: "schema_migrations" },
      { name: "task_history" },
    ]);
  });
});

describe("connection lifetime", () => {
  test("results remain usable after the connection closes (fully materialized)", () => {
    const since = "2026-01-01T00:00:00.000Z";
    const runs = queryImproveRuns(db, since);
    const tables = listExistingTableNames(db, ["events", "task_history", "proposals", "schema_migrations"]);

    db.close();

    // No live cursor: arrays and their members survive the close.
    expect(runs.length).toBeGreaterThan(0);
    // since-only window, newest-first: run-d is the most recent real run.
    expect(runs[0]!.id).toBe("run-d");
    expect(tables.length).toBe(4);
  });
});

describe("state-db-events-purge", () => {
  /**
   * Tests for `purgeFoldedEvents()` — the events-table retention helper wired into
   * the improve post-loop maintenance pass: events of whole UTC days older than
   * the retention are deleted once metrics.db has folded the day. Without this
   * trim, `state.db` grows forever — `akm health` writes a `health_probe` row on
   * every invocation, and every command surface emits at least one event besides.
   * The guard itself (unfolded days, crash windows) is tested in
   * tests/commands/metrics/fold.test.ts.
   */

  let storage: IsolatedAkmStorage;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
  });

  afterEach(() => {
    storage.cleanup();
  });

  describe("purgeFoldedEvents", () => {
    test("removes events older than retentionDays and keeps recent ones", () => {
      const db = openStateDatabase();
      try {
        const now = Date.now();
        const day = 86_400_000;

        // Older than 90 days — should be purged at retention=90.
        const oldTs = new Date(now - 120 * day).toISOString();
        insertEvent(db, { eventType: "health_probe", ts: oldTs, ref: "health/_probe" });
        insertEvent(db, { eventType: "health_probe", ts: oldTs, ref: "health/_probe" });
        // Within retention window — must survive.
        const recentTs = new Date(now - 3 * day).toISOString();
        insertEvent(db, { eventType: "reflect_invoked", ts: recentTs, ref: "lessons/fresh" });

        const before = db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number };
        expect(before.c).toBe(3);

        const purged = purgeFoldedEvents(db, 90, foldBeforePurge(db) ?? new Map());
        expect(purged).toBe(2);

        const survivors = db.prepare("SELECT event_type, ref FROM events").all() as Array<{
          event_type: string;
          ref: string | null;
        }>;
        expect(survivors).toEqual([{ event_type: "reflect_invoked", ref: "lessons/fresh" }]);
      } finally {
        db.close();
      }
    });

    test("returns 0 and is a no-op when retentionDays is 0 (disabled) or not finite", () => {
      const db = openStateDatabase();
      try {
        const oldTs = new Date(Date.now() - 365 * 86_400_000).toISOString();
        insertEvent(db, { eventType: "health_probe", ts: oldTs, ref: "health/_probe" });
        const folded = foldBeforePurge(db) ?? new Map();

        expect(purgeFoldedEvents(db, 0, folded)).toBe(0);
        expect(purgeFoldedEvents(db, Number.NaN, folded)).toBe(0);
        expect(purgeFoldedEvents(db, Number.POSITIVE_INFINITY, folded)).toBe(0);

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
        insertEvent(db, { eventType: "reflect_invoked", ts: recentTs, ref: "lessons/x" });

        expect(purgeFoldedEvents(db, 90, foldBeforePurge(db) ?? new Map())).toBe(0);

        const after = db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number };
        expect(after.c).toBe(1);
      } finally {
        db.close();
      }
    });
  });
});

describe("body-embeddings", () => {
  /**
   * Tests for the body_embeddings state.db table helpers (WS-3a).
   *
   * Verifies:
   *   - BLOB round-trip (Float32 stored and retrieved correctly).
   *   - Bulk cache lookup (hits, misses, partial).
   *   - Model-id mismatch triggers drop-all and returns empty map.
   *   - Upsert replaces existing rows (INSERT OR REPLACE).
   */

  let storage: IsolatedAkmStorage;
  let db: Database;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    db = openStateDatabase(path.join(storage.dataDir, "state.db"));
  });

  afterEach(() => {
    db.close();
    storage.cleanup();
  });

  describe("embeddingToBlob / blobToEmbedding (WS-3a)", () => {
    test("round-trips a Float32 embedding vector through BLOB bytes", () => {
      const vec = [0.1, 0.2, 0.3, -0.5, 1.0];
      const blob = embeddingToBlob(vec);
      const recovered = blobToEmbedding(blob);
      expect(recovered).toHaveLength(vec.length);
      // Float32 precision: values within 1e-6 of the original.
      for (let i = 0; i < vec.length; i++) {
        expect(Math.abs((recovered[i] as number) - (vec[i] as number))).toBeLessThan(1e-6);
      }
    });

    test("round-trips a 384-dimension vector (bge-small-en-v1.5 size)", () => {
      const vec = Array.from({ length: 384 }, (_, i) => Math.sin(i * 0.01));
      const blob = embeddingToBlob(vec);
      const recovered = blobToEmbedding(blob);
      expect(recovered).toHaveLength(384);
      expect(Math.abs((recovered[0] as number) - (vec[0] as number))).toBeLessThan(1e-6);
    });
  });

  describe("upsertBodyEmbeddings + getBodyEmbeddings (WS-3a)", () => {
    const MODEL_ID = "Xenova/bge-small-en-v1.5";

    test("upsert then retrieve returns the stored embedding", () => {
      const hash = "abc123";
      const vec = [0.1, 0.5, -0.3];
      upsertBodyEmbeddings(db, [{ contentHash: hash, embedding: vec, modelId: MODEL_ID }]);
      const result = getBodyEmbeddings(db, [hash], MODEL_ID);
      expect(result.has(hash)).toBe(true);
      const retrieved = result.get(hash) as number[];
      expect(retrieved).toHaveLength(3);
      expect(Math.abs(retrieved[0]! - 0.1)).toBeLessThan(1e-6);
    });

    test("bulk lookup returns only existing hashes (misses → absent)", () => {
      const hash1 = "hash-1";
      const hash2 = "hash-2";
      const vec = [1.0, 0.0];
      upsertBodyEmbeddings(db, [{ contentHash: hash1, embedding: vec, modelId: MODEL_ID }]);
      const result = getBodyEmbeddings(db, [hash1, hash2], MODEL_ID);
      expect(result.has(hash1)).toBe(true);
      expect(result.has(hash2)).toBe(false);
    });

    test("empty contentHashes input returns empty map without query", () => {
      const result = getBodyEmbeddings(db, [], MODEL_ID);
      expect(result.size).toBe(0);
    });

    test("model-id mismatch drops all rows and returns empty map", () => {
      const hash = "xyz";
      upsertBodyEmbeddings(db, [{ contentHash: hash, embedding: [0.5], modelId: "model-a" }]);
      // Now query with a different model_id — rows should be dropped.
      const result = getBodyEmbeddings(db, [hash], "model-b");
      expect(result.size).toBe(0);
      // Confirm the table was cleared.
      const after = getBodyEmbeddings(db, [hash], "model-b");
      expect(after.size).toBe(0);
    });

    test("upsert is idempotent — re-inserting the same hash replaces the row", () => {
      const hash = "dup";
      upsertBodyEmbeddings(db, [{ contentHash: hash, embedding: [1.0, 0.0], modelId: MODEL_ID }]);
      upsertBodyEmbeddings(db, [{ contentHash: hash, embedding: [0.0, 1.0], modelId: MODEL_ID }]);
      const result = getBodyEmbeddings(db, [hash], MODEL_ID);
      const vec = result.get(hash) as number[];
      expect(vec).toHaveLength(2);
      // Should have the second write's values.
      expect(Math.abs(vec[0]! - 0.0)).toBeLessThan(1e-6);
      expect(Math.abs(vec[1]! - 1.0)).toBeLessThan(1e-6);
    });
  });
});
