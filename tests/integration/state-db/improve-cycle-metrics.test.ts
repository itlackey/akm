// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * R5 — collapse/churn detector persistence (migration 016 + accessors).
 *
 * Direct table-level tests for `canary_queries` + `improve_cycle_metrics`,
 * separate from the detector's end-to-end flow in
 * tests/commands/improve/collapse-detector.test.ts.
 * Contract under test:
 *   - Migration `016-collapse-churn-detector` is applied by openStateDatabase()
 *     on both fresh and already-migrated databases.
 *   - insertCanaries / getActiveCanaries / deactivateCanarySet — a re-mint
 *     deactivates (never deletes) the prior set.
 *   - insertCycleMetrics / queryRecentCycleMetrics — oldest-first window,
 *     scoped by canary_set_id.
 *   - purgeOldCycleMetrics deletes only rows past retention, returns the count,
 *     and never touches canary_queries.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { openStateDatabase } from "../../../src/core/state-db";
import type { Database } from "../../../src/storage/database";
import {
  type CycleMetricsRow,
  deactivateCanarySet,
  getActiveCanaries,
  insertCanaries,
  insertCycleMetrics,
  purgeOldCycleMetrics,
  queryRecentCycleMetrics,
} from "../../../src/storage/repositories/canaries-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

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

function makeRow(overrides: Partial<CycleMetricsRow> = {}): CycleMetricsRow {
  return {
    run_id: "run-1",
    ts: "2026-07-02T00:00:00.000Z",
    pass: "consolidate",
    canary_set_id: "set-a",
    mean_recall: 0.9,
    mean_ndcg: 0.85,
    mean_mrr: 0.8,
    canary_ranks_json: "[[1,0],[2,3]]",
    store_total: 100,
    store_by_type_json: '{"memory":80,"lesson":15,"knowledge":5}',
    distinct_content_ratio: 0.97,
    mean_bigram_diversity: 0.88,
    over_generation_count: 0,
    accepted_actions: 3,
    merge_floor_violations: 0,
    alerts_json: "[]",
    ...overrides,
  };
}

describe("migration 016 — collapse/churn detector tables", () => {
  test("both tables exist after openStateDatabase on a fresh DB", () => {
    const names = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table'
         AND name IN ('canary_queries','improve_cycle_metrics') ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    expect(names.map((n) => n.name)).toEqual(["canary_queries", "improve_cycle_metrics"]);
  });

  test("re-opening an existing DB is a no-op (idempotent migration)", () => {
    insertCycleMetrics(db, makeRow());
    db.close();
    db = openStateDatabase(path.join(storage.dataDir, "state.db"));
    expect(queryRecentCycleMetrics(db, "set-a", 10)).toHaveLength(1);
  });
});

describe("canary set CRUD", () => {
  test("insert + read back the active set in insertion order", () => {
    insertCanaries(db, "set-a", [
      { anchorRef: "memories/alpha", query: "alpha topic" },
      { anchorRef: "lessons/beta", query: "beta lesson", source: "manual" },
    ]);
    const active = getActiveCanaries(db);
    expect(active).toHaveLength(2);
    expect(active[0].anchor_ref).toBe("memories/alpha");
    expect(active[0].source).toBe("auto");
    expect(active[1].source).toBe("manual");
    expect(active.every((c) => c.canary_set_id === "set-a")).toBe(true);
  });

  test("two active sets (interrupted refresh): only the NEWEST set is returned", () => {
    // Simulate a bug/interruption that leaves two sets active — mixing them
    // would corrupt trend baselines, so getActiveCanaries scopes to the newest.
    insertCanaries(db, "set-old", [{ anchorRef: "memories/old", query: "old" }], "2026-01-01T00:00:00.000Z");
    insertCanaries(db, "set-new", [{ anchorRef: "memories/new", query: "new" }], "2026-06-01T00:00:00.000Z");
    const active = getActiveCanaries(db);
    expect(active).toHaveLength(1);
    expect(active[0].canary_set_id).toBe("set-new");
  });

  test("re-mint deactivates the old set but retains its rows", () => {
    insertCanaries(db, "set-a", [{ anchorRef: "memories/alpha", query: "alpha" }]);
    const deactivated = deactivateCanarySet(db, "set-a");
    expect(deactivated).toBe(1);
    insertCanaries(db, "set-b", [{ anchorRef: "memories/beta", query: "beta" }]);

    const active = getActiveCanaries(db);
    expect(active).toHaveLength(1);
    expect(active[0].canary_set_id).toBe("set-b");
    // Old rows retained for history interpretation.
    const total = db.prepare("SELECT COUNT(*) AS n FROM canary_queries").get() as { n: number };
    expect(total.n).toBe(2);
  });
});

describe("cycle metrics insert/query/purge", () => {
  test("queryRecentCycleMetrics returns oldest-first, scoped by canary_set_id, bounded by limit", () => {
    for (let i = 0; i < 4; i++) {
      insertCycleMetrics(db, makeRow({ run_id: `run-${i}`, ts: `2026-07-0${i + 1}T00:00:00.000Z` }));
    }
    insertCycleMetrics(db, makeRow({ run_id: "other-set", canary_set_id: "set-b" }));

    const window = queryRecentCycleMetrics(db, "set-a", 3);
    expect(window.map((r) => r.run_id)).toEqual(["run-1", "run-2", "run-3"]); // last 3, oldest first
    expect(window.every((r) => r.canary_set_id === "set-a")).toBe(true);
  });

  test("purgeOldCycleMetrics deletes only rows past retention and returns the count", () => {
    const oldTs = new Date(Date.now() - 400 * 86_400_000).toISOString();
    const freshTs = new Date().toISOString();
    insertCycleMetrics(db, makeRow({ run_id: "old", ts: oldTs }));
    insertCycleMetrics(db, makeRow({ run_id: "fresh", ts: freshTs }));
    insertCanaries(db, "set-a", [{ anchorRef: "memories/alpha", query: "alpha" }]);

    const purged = purgeOldCycleMetrics(db, 365);
    expect(purged).toBe(1);
    const remaining = queryRecentCycleMetrics(db, "set-a", 10);
    expect(remaining.map((r) => r.run_id)).toEqual(["fresh"]);
    // canary_queries rows are never purged.
    expect(getActiveCanaries(db)).toHaveLength(1);
  });

  test("purgeOldCycleMetrics with non-positive retention is a no-op", () => {
    insertCycleMetrics(db, makeRow({ ts: "2020-01-01T00:00:00.000Z" }));
    expect(purgeOldCycleMetrics(db, 0)).toBe(0);
    expect(queryRecentCycleMetrics(db, "set-a", 10)).toHaveLength(1);
  });
});
