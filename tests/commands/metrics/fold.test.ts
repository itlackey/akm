// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The fold into metrics.db and the folded-day purge guard (`commands/metrics/fold.ts`). */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  foldBeforePurge,
  foldClosedDays,
  purgeFoldedEvents,
  purgeFoldedImproveRuns,
  purgeFoldedUsageEvents,
  readFoldedDays,
  slimImproveResultJson,
} from "../../../src/commands/metrics/fold";
import { openMetricsDatabase } from "../../../src/core/metrics-db";
import { openStateDatabase } from "../../../src/core/state-db";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../../src/core/warn";
import type { Database } from "../../../src/storage/database";
import { insertEvent } from "../../../src/storage/repositories/events-repository";
import { count, insertLlm, insertRun, insertUsage } from "../../_helpers/metrics-fixtures";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");
let storage: IsolatedAkmStorage;
let state: Database;
let metrics: Database;
const warnings: string[] = [];

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  state = openStateDatabase();
  metrics = openMetricsDatabase();
  warnings.length = 0;
  _resetWarnOnceForTests();
  _setWarnSinkForTests((level, args) => {
    if (level === "warn") warnings.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  _setWarnSinkForTests(undefined);
  state.close();
  metrics.close();
  storage.cleanup();
});

/** Rows on two closed days, one more on today (never folded). */
function seedDays(db: Database): void {
  for (const day of ["2026-07-12", "2026-07-13"]) {
    insertEvent(db, { eventType: "health_probe", ts: `${day}T01:00:00.000Z` });
    insertEvent(db, { eventType: "health_probe", ts: `${day}T02:00:00.000Z` });
    insertUsage(db, { day, type: "search", query: "docker", metadata: { resultCount: 0, totalMs: 40 } });
    insertUsage(db, { day, type: "search", query: "git", metadata: { resultCount: 3, totalMs: 9 } });
    insertUsage(db, { day, type: "show", ref: "akm//knowledge/a" });
    insertRun(db, `run-${day}`, day);
  }
  insertEvent(db, { eventType: "health_probe", ts: "2026-11-09T01:00:00.000Z" });
  insertUsage(db, { day: "2026-11-09", type: "show", ref: "akm//knowledge/a" });
}

describe("foldClosedDays", () => {
  test("folds every closed day, never today, and writes each table's rollup", () => {
    seedDays(state);
    insertLlm(state, "2026-07-12", { durationMs: 1200, stage: "reflect", model: "m1", promptTokens: 10 });
    insertLlm(state, "2026-07-12", {
      durationMs: 80,
      stage: "reflect",
      model: "m1",
      promptTokens: 5,
      outcome: "error",
    });
    insertEvent(state, {
      eventType: "select",
      ts: "2026-07-12T03:00:00.000Z",
      ref: "knowledge/a",
      metadata: { searchId: "s1", source: "user" },
    });
    insertEvent(state, {
      eventType: "select",
      ts: "2026-07-12T03:00:01.000Z",
      ref: "knowledge/a",
      metadata: { searchId: "s1", source: "user" },
    });
    insertEvent(state, { eventType: "index_completed", ts: "2026-07-12T04:00:00.000Z", metadata: { totalMs: 300 } });

    const report = foldClosedDays(state, metrics, { nowMs: NOW });

    expect(report.folded).toEqual(["2026-07-12", "2026-07-13"]);
    expect(report.failed).toEqual([]);
    expect([...readFoldedDays(metrics).keys()]).toEqual(["2026-07-12", "2026-07-13"]);
    expect(count(metrics, "event_daily", "day = '2026-11-09'")).toBe(0);
    expect(
      metrics.prepare("SELECT n FROM event_daily WHERE day = '2026-07-12' AND event_type = 'health_probe'").get(),
    ).toEqual({
      n: 2,
    });
    const llm = metrics
      .prepare("SELECT outcome, calls, prompt_tokens FROM llm_daily WHERE day = '2026-07-12' ORDER BY outcome")
      .all();
    expect(llm).toEqual([
      { outcome: "error", calls: 1, prompt_tokens: 5 },
      { outcome: "success", calls: 1, prompt_tokens: 10 },
    ]);
    // Two selects of one (searchId, ref) are one select.
    expect(metrics.prepare("SELECT n FROM select_daily WHERE day = '2026-07-12'").get()).toEqual({ n: 1 });
    const search = metrics
      .prepare("SELECT n, hits, zero FROM usage_daily WHERE day = '2026-07-12' AND event_type = 'search' AND ref = ''")
      .get();
    expect(search).toEqual({ n: 2, hits: 1, zero: 1 });
    expect(
      metrics.prepare("SELECT zero_n FROM query_daily WHERE day = '2026-07-12' AND query = 'docker'").get(),
    ).toEqual({ zero_n: 1 });
    expect(count(metrics, "latency_daily", "day = '2026-07-12' AND kind = 'search'")).toBe(1);
    expect(count(metrics, "latency_daily", "day = '2026-07-12' AND kind = 'index'")).toBe(1);
    expect(count(metrics, "improve_runs")).toBe(2);
  });

  test("is idempotent: a second fold changes nothing", () => {
    seedDays(state);
    foldClosedDays(state, metrics, { nowMs: NOW });
    const before = JSON.stringify([
      metrics.prepare("SELECT * FROM folded_day ORDER BY day").all(),
      metrics.prepare("SELECT * FROM usage_daily ORDER BY day, event_type, ref").all(),
    ]);
    const again = foldClosedDays(state, metrics, { nowMs: NOW });
    expect(again.folded).toEqual([]);
    const after = JSON.stringify([
      metrics.prepare("SELECT * FROM folded_day ORDER BY day").all(),
      metrics.prepare("SELECT * FROM usage_daily ORDER BY day, event_type, ref").all(),
    ]);
    expect(after).toBe(before);
  });

  test("the first fold covers every closed day already in state.db", () => {
    for (let i = 0; i < 100; i++) {
      const day = new Date(Date.parse("2026-08-01T00:00:00.000Z") + i * 86_400_000).toISOString().slice(0, 10);
      insertEvent(state, { eventType: "health_probe", ts: `${day}T05:00:00.000Z` });
      insertUsage(state, { day, type: "show", ref: "akm//knowledge/a" });
    }
    const report = foldClosedDays(state, metrics, { nowMs: Date.parse("2026-12-01T00:00:00.000Z") });
    expect(report.folded.length).toBe(100);
    expect((metrics.prepare("SELECT SUM(n) AS n FROM event_daily").get() as { n: number }).n).toBe(100);
    expect((metrics.prepare("SELECT SUM(n) AS n FROM usage_daily").get() as { n: number }).n).toBe(100);
  });

  test("a late row in a folded day is picked up by the next fold, replacing the day (no double count)", () => {
    seedDays(state);
    foldClosedDays(state, metrics, { nowMs: NOW });
    insertEvent(state, { eventType: "health_probe", ts: "2026-07-12T23:59:00.000Z" });
    const again = foldClosedDays(state, metrics, { nowMs: NOW });
    expect(again.folded).toEqual(["2026-07-12"]);
    expect(metrics.prepare("SELECT n FROM event_daily WHERE day = '2026-07-12'").get()).toEqual({ n: 3 });
  });

  test("slims a run's result: the ref list becomes its count", () => {
    seedDays(state);
    foldClosedDays(state, metrics, { nowMs: NOW });
    const row = metrics.prepare("SELECT result_json FROM improve_runs WHERE id = 'run-2026-07-12'").get() as {
      result_json: string;
    };
    const result = JSON.parse(row.result_json) as Record<string, unknown>;
    expect(result.strategyFilteredRefs).toBeUndefined();
    expect(result.strategyFilteredCount).toBe(3);
    expect(slimImproveResultJson("not json")).toBe("not json");
    expect(slimImproveResultJson('{"a":1}')).toBe('{"a":1}');
  });
});

describe("a second source for the same days (a state.db backup)", () => {
  function backupWith(fill: (db: Database) => void): string {
    const file = path.join(storage.dataDir, "backup-state.db");
    const db = openStateDatabase(file);
    try {
      fill(db);
    } finally {
      db.close();
    }
    return file;
  }

  test("folding the live database then a copy of it does not double count", () => {
    seedDays(state);
    const backup = backupWith(seedDays);
    foldClosedDays(state, metrics, { nowMs: NOW });
    const before = (metrics.prepare("SELECT SUM(n) AS n FROM usage_daily").get() as { n: number }).n;
    const report = foldClosedDays(backup, metrics, { nowMs: NOW });
    expect(report.folded).toEqual([]);
    expect((metrics.prepare("SELECT SUM(n) AS n FROM usage_daily").get() as { n: number }).n).toBe(before);
    expect(count(metrics, "improve_runs")).toBe(2);
  });

  test("a copy folded first, then the live database that still holds the day: same totals", () => {
    const backup = backupWith(seedDays);
    seedDays(state);
    foldClosedDays(backup, metrics, { nowMs: NOW });
    const after = foldClosedDays(state, metrics, { nowMs: NOW });
    expect(after.folded).toEqual([]);
    expect((metrics.prepare("SELECT SUM(n) AS n FROM event_daily").get() as { n: number }).n).toBe(4);
    expect(count(metrics, "improve_runs")).toBe(2);
  });

  test("a fuller copy replaces a day the live database holds only part of; a poorer one never does", () => {
    insertUsage(state, { day: "2026-07-12", type: "show", ref: "akm//knowledge/a" });
    foldClosedDays(state, metrics, { nowMs: NOW });
    const full = backupWith((db) => {
      insertUsage(db, { day: "2026-07-12", type: "show", ref: "akm//knowledge/a" });
      insertUsage(db, { day: "2026-07-12", type: "show", ref: "akm//knowledge/b" });
      insertUsage(db, { day: "2026-07-12", type: "show", ref: "akm//knowledge/b", time: "11:00:00" });
    });
    foldClosedDays(full, metrics, { nowMs: NOW });
    expect(
      (metrics.prepare("SELECT SUM(n) AS n FROM usage_daily WHERE day = '2026-07-12'").get() as { n: number }).n,
    ).toBe(3);
    // The live database now holds fewer rows of that day than the fold covers: it leaves the fold alone.
    foldClosedDays(state, metrics, { nowMs: NOW });
    expect(
      (metrics.prepare("SELECT SUM(n) AS n FROM usage_daily WHERE day = '2026-07-12'").get() as { n: number }).n,
    ).toBe(3);
  });

  test("a copy that lacks a table folds the tables it has", () => {
    const file = path.join(storage.dataDir, "bare.db");
    fs.writeFileSync(file, "");
    const bare = openStateDatabase(path.join(storage.dataDir, "bare2.db"));
    bare.exec("DROP TABLE improve_runs");
    insertEvent(bare, { eventType: "health_probe", ts: "2026-07-12T01:00:00.000Z" });
    bare.close();
    const report = foldClosedDays(path.join(storage.dataDir, "bare2.db"), metrics, { nowMs: NOW });
    expect(report.folded).toEqual(["2026-07-12"]);
  });
});

describe("the purge guard", () => {
  test("deletes only folded days older than the cutoff, whole days, and not today", () => {
    seedDays(state);
    insertEvent(state, { eventType: "health_probe", ts: "2026-07-14T01:00:00.000Z" }); // closed, never folded below
    foldClosedDays(state, metrics, { nowMs: Date.parse("2026-07-14T12:00:00.000Z") }); // folds 08-12, 08-13 only
    const folded = readFoldedDays(metrics);
    expect([...folded.keys()]).toEqual(["2026-07-12", "2026-07-13"]);

    // 08-14 is old enough to purge at NOW (90d) but has no marker: kept.
    const purged = purgeFoldedEvents(state, 90, folded, NOW);
    expect(purged).toBe(4);
    expect(count(state, "events", "event_type = 'health_probe' AND ts LIKE '2026-07-14%'")).toBe(1);
    expect(count(state, "events", "event_type = 'health_probe' AND ts LIKE '2026-11-09%'")).toBe(1);

    expect(purgeFoldedUsageEvents(state, 90, folded, NOW)).toBe(6);
    expect(count(state, "usage_events")).toBe(1);
    expect(purgeFoldedImproveRuns(state, 90, folded, NOW)).toBe(2);
  });

  test("a folded day that gained rows since keeps them until they are folded", () => {
    seedDays(state);
    foldClosedDays(state, metrics, { nowMs: NOW });
    insertEvent(state, { eventType: "health_probe", ts: "2026-07-12T23:00:00.000Z" });
    expect(purgeFoldedEvents(state, 90, readFoldedDays(metrics), NOW)).toBe(2); // 08-13 only
    expect(count(state, "events", "ts LIKE '2026-07-12%'")).toBe(3);
  });

  test("retention 0 or less deletes nothing", () => {
    seedDays(state);
    foldClosedDays(state, metrics, { nowMs: NOW });
    expect(purgeFoldedEvents(state, 0, readFoldedDays(metrics), NOW)).toBe(0);
  });

  test("crash between fold and purge: the next fold redoes nothing and the purge then proceeds", () => {
    seedDays(state);
    foldClosedDays(state, metrics, { nowMs: NOW });
    // (the process dies here: no purge ran; the next improve/index run folds again, then purges)
    expect(foldClosedDays(state, metrics, { nowMs: NOW }).folded).toEqual([]);
    expect(purgeFoldedEvents(state, 90, readFoldedDays(metrics), NOW)).toBe(4);
  });

  test("a partial fold rolls back: no marker, no rollup rows, and the purge keeps the day's rows", () => {
    seedDays(state);
    // The day's usage rollup fails after its events rollup was already written.
    metrics.exec(`CREATE TRIGGER fail_usage BEFORE INSERT ON usage_daily
      WHEN NEW.day = '2026-07-12' BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
    const report = foldClosedDays(state, metrics, { nowMs: NOW });
    expect(report.folded).toEqual(["2026-07-13"]);
    expect(report.failed.map((f) => f.day)).toEqual(["2026-07-12"]);
    expect(count(metrics, "event_daily", "day = '2026-07-12'")).toBe(0);
    expect(count(metrics, "folded_day", "day = '2026-07-12'")).toBe(0);

    const folded = readFoldedDays(metrics);
    expect(purgeFoldedEvents(state, 90, folded, NOW)).toBe(2);
    expect(purgeFoldedUsageEvents(state, 90, folded, NOW)).toBe(3);
    expect(count(state, "events", "ts LIKE '2026-07-12%'")).toBe(2);
    expect(count(state, "usage_events", "created_at LIKE '2026-07-12%'")).toBe(3);

    metrics.exec("DROP TRIGGER fail_usage");
    expect(foldClosedDays(state, metrics, { nowMs: NOW }).folded).toEqual(["2026-07-12"]);
  });

  test("metrics.db unopenable: foldBeforePurge returns undefined with one warning, and nothing is deleted", () => {
    seedDays(state);
    const blocked = path.join(storage.dataDir, "not-a-dir");
    fs.writeFileSync(blocked, "x");
    const unopenable = path.join(blocked, "metrics.db"); // a file where its directory should be
    expect(foldBeforePurge(state, { metricsDbPath: unopenable, nowMs: NOW })).toBeUndefined();
    expect(foldBeforePurge(state, { metricsDbPath: unopenable, nowMs: NOW })).toBeUndefined();
    expect(warnings.filter((w) => w.includes("[metrics.db]")).length).toBe(1);
    expect(count(state, "events")).toBe(5);
  });

  test("foldBeforePurge folds and returns the guard", () => {
    seedDays(state);
    const folded = foldBeforePurge(state, { nowMs: NOW });
    expect([...(folded?.keys() ?? [])]).toEqual(["2026-07-12", "2026-07-13"]);
    expect(warnings).toEqual([]);
  });
});

describe("metrics.db", () => {
  test("reopening an existing file applies no migration twice and keeps its rows", () => {
    seedDays(state);
    foldClosedDays(state, metrics, { nowMs: NOW });
    metrics.close();
    metrics = openMetricsDatabase();
    expect(count(metrics, "folded_day")).toBe(2);
    expect(count(metrics, "schema_migrations")).toBe(1);
  });
});
