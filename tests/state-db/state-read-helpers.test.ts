/**
 * Characterization tests for the state.db read helpers that absorb the
 * remaining raw-SQL leaks out of `src/commands/health.ts` (WS5 slice 5).
 *
 * health.ts hand-rolled three reads against state.db tables it does not own:
 *   1. improve_runs   — `loadImproveRunRows` (since-only and since+until windows).
 *   2. task_history   — `loadTaskIntervals` (widened window, completed runs only).
 *   3. sqlite_master  — required-table presence check.
 *
 * These tests seed a real isolated state.db, capture the exact result of the
 * pre-existing inline SQL, and assert the new owner-module helpers
 * (`queryImproveRuns`, `queryCompletedTaskIntervals`, `listExistingTableNames`)
 * return byte-identical results — so the verbatim SQL move is behaviour-neutral.
 *
 * Connection-lifetime rule (WS5): every helper fully materializes its result
 * set (arrays / plain objects) before returning. The final assertion closes the
 * DB and confirms the returned values remain usable after close.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { listExistingTableNames, openStateDatabase } from "../../src/core/state-db";
import type { Database } from "../../src/storage/database";
import { queryImproveRuns, recordImproveRun } from "../../src/storage/repositories/improve-runs-repository";
import { queryCompletedTaskIntervals, upsertTaskHistory } from "../../src/storage/repositories/task-history-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let db: Database;

// ── Inline SQL copied verbatim from health.ts at HEAD (the baseline). ─────────

function baselineImproveRunRows(database: Database, since: string, until?: string): unknown[] {
  const sql = until
    ? "SELECT id, started_at, completed_at, ok, scope_mode, scope_value, result_json FROM improve_runs WHERE started_at >= ? AND started_at < ? AND dry_run = 0 ORDER BY started_at DESC"
    : "SELECT id, started_at, completed_at, ok, scope_mode, scope_value, result_json FROM improve_runs WHERE started_at >= ? AND dry_run = 0 ORDER BY started_at DESC";
  return until ? database.prepare(sql).all(since, until) : database.prepare(sql).all(since);
}

function baselineTaskRows(database: Database, widenedSince: string, widenedUntil?: string): unknown[] {
  const sql = widenedUntil
    ? "SELECT started_at, completed_at FROM task_history WHERE task_id = 'akm-improve' AND started_at >= ? AND started_at < ? AND completed_at IS NOT NULL ORDER BY started_at"
    : "SELECT started_at, completed_at FROM task_history WHERE task_id = 'akm-improve' AND started_at >= ? AND completed_at IS NOT NULL ORDER BY started_at";
  return widenedUntil ? database.prepare(sql).all(widenedSince, widenedUntil) : database.prepare(sql).all(widenedSince);
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
    profile: null,
    scopeMode: "all",
    scopeValue: null,
    guidance: null,
    ok: true,
    result: {
      schemaVersion: 1,
      ok: true,
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

  // task_history: completed + still-running akm-improve runs + a noise task.
  upsertTaskHistory(db, {
    task_id: "akm-improve",
    status: "completed",
    started_at: "2026-01-01T00:05:00.000Z",
    completed_at: "2026-01-01T00:06:00.000Z",
    failed_at: null,
    log_path: null,
    target_kind: null,
    target_ref: null,
    metadata_json: "{}",
  });
  upsertTaskHistory(db, {
    task_id: "akm-improve",
    status: "active",
    started_at: "2026-01-03T00:05:00.000Z",
    completed_at: null, // still running — excluded by completed_at IS NOT NULL
    failed_at: null,
    log_path: null,
    target_kind: null,
    target_ref: null,
    metadata_json: "{}",
  });
  upsertTaskHistory(db, {
    task_id: "some-other-task",
    status: "completed",
    started_at: "2026-01-02T00:05:00.000Z",
    completed_at: "2026-01-02T00:06:00.000Z",
    failed_at: null,
    log_path: null,
    target_kind: null,
    target_ref: null,
    metadata_json: "{}",
  });
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

describe("queryCompletedTaskIntervals", () => {
  test("matches inline SQL for a since-only window", () => {
    const since = "2026-01-01T00:00:00.000Z";
    expect(queryCompletedTaskIntervals(db, since)).toEqual(baselineTaskRows(db, since) as never);
  });

  test("matches inline SQL for a since+until window", () => {
    const since = "2026-01-01T00:00:00.000Z";
    const until = "2026-01-31T00:00:00.000Z";
    expect(queryCompletedTaskIntervals(db, since, until)).toEqual(baselineTaskRows(db, since, until) as never);
  });

  test("includes only completed akm-improve runs", () => {
    const rows = queryCompletedTaskIntervals(db, "2026-01-01T00:00:00.000Z");
    expect(rows).toEqual([{ started_at: "2026-01-01T00:05:00.000Z", completed_at: "2026-01-01T00:06:00.000Z" }]);
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
    const intervals = queryCompletedTaskIntervals(db, since);
    const tables = listExistingTableNames(db, ["events", "task_history", "proposals", "schema_migrations"]);

    db.close();

    // No live cursor: arrays and their members survive the close.
    expect(runs.length).toBeGreaterThan(0);
    // since-only window, newest-first: run-d is the most recent real run.
    expect(runs[0].id).toBe("run-d");
    expect(intervals.length).toBe(1);
    expect(tables.length).toBe(4);
  });
});
