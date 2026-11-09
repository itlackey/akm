// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Readers across the raw/rollup boundary. The same data is read twice, once with every raw row in
 * state.db and once after the fold and the purge moved the old days into metrics.db; where a section is
 * exactly derivable from the rollups the two reports must be equal: no day counted twice, none dropped.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { readLlmUsageAggregate } from "../../src/commands/health/llm-usage";
import { buildImproveWindowSummary } from "../../src/commands/health/windows";
import {
  foldBeforePurge,
  foldClosedDays,
  purgeFoldedEvents,
  purgeFoldedImproveRuns,
  purgeFoldedUsageEvents,
} from "../../src/commands/metrics/fold";
import { akmMetrics, readLlmRows } from "../../src/commands/metrics/metrics";
import { openMetricsDatabase } from "../../src/core/metrics-db";
import { getStateDbPath, openStateDatabase } from "../../src/core/state-db";
import type { Database } from "../../src/storage/database";
import { insertEvent } from "../../src/storage/repositories/events-repository";
import { queryImproveRuns } from "../../src/storage/repositories/improve-runs-repository";
import { rollupDayRange } from "../../src/storage/repositories/metrics-rollup-repository";
import { count, dayPlus, insertLlm, insertRun, insertUsage } from "../_helpers/metrics-fixtures";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const SINCE = "2026-06-01T00:00:00.000Z";
const FIRST_DAY = "2026-06-20";
let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});
afterEach(() => storage.cleanup());

/** Every fifth day from FIRST_DAY to the day before NOW: some before the 90-day cutoff (2026-08-11), some after. */
function seed(db: Database): string[] {
  const days: string[] = [];
  for (let day = FIRST_DAY; day < "2026-11-09"; day = dayPlus(day, 5)) days.push(day);
  days.forEach((day, i) => {
    insertUsage(db, { day, type: "search", query: "docker", metadata: { resultCount: 0, totalMs: 40 + i } });
    insertUsage(db, { day, type: "search", query: "git hooks", metadata: { resultCount: 3, totalMs: 9 + i } });
    insertUsage(db, { day, type: "search", ref: "akm//knowledge/a", metadata: {} });
    insertUsage(db, { day, type: "show", ref: "akm//knowledge/a" });
    insertUsage(db, { day, type: "show", ref: `akm//knowledge/b${i % 3}` });
    insertUsage(db, { day, type: "curate", query: "ci" });
    insertUsage(db, {
      day,
      type: "feedback",
      ref: "akm//knowledge/a",
      signal: i % 2 ? "positive" : "negative",
      metadata: { reason: "r", tags: ["stale", "wrong"] },
    });
    insertUsage(db, { day, type: "show", ref: "akm//knowledge/a", source: "improve" });
    insertLlm(db, day, { durationMs: 200 + i, stage: "reflect", model: "m1", promptTokens: 10 + i });
    insertLlm(db, day, { durationMs: 90, stage: "distill", model: "m2", outcome: "error" });
    insertEvent(db, {
      eventType: "select",
      ts: `${day}T10:00:00.000Z`,
      ref: "knowledge/a",
      metadata: { searchId: `s${i}`, source: "user" },
    });
    insertEvent(db, {
      eventType: "select",
      ts: `${day}T10:00:01.000Z`,
      ref: "knowledge/a",
      metadata: { searchId: `s${i}`, source: "user" },
    });
    insertEvent(db, {
      eventType: "index_completed",
      ts: `${day}T11:00:00.000Z`,
      metadata: { totalMs: 300 + i, mode: "incremental" },
    });
    insertEvent(db, { eventType: "improve_invoked", ts: `${day}T08:00:00.000Z` });
    insertEvent(db, { eventType: "improve_completed", ts: `${day}T08:30:00.000Z` });
    insertEvent(db, { eventType: "improve_skipped", ts: `${day}T08:10:00.000Z`, metadata: { reason: "cooldown" } });
    insertEvent(db, {
      eventType: "improve_skipped",
      ts: `${day}T08:11:00.000Z`,
      metadata: { reason: "no_new_signal", count: 10 + i },
    });
    insertRun(db, `run-${day}`, day);
  });
  return days;
}

/** The report without what only raw rows can give (feedback reasons, recent index runs, the estimated medians) and the notes. */
function comparable(result: Awaited<ReturnType<typeof akmMetrics>>) {
  const { notes: _notes, rows: _rows, feedback, index, usage, ...rest } = result;
  const { recentNegative: _recent, ...feedbackRest } = feedback;
  const { recent: _recentIndex, medianMs: _median, ...indexRest } = index;
  const { searchMedianMs: _searchMedian, ...usageRest } = usage;
  return { ...rest, feedback: feedbackRest, index: indexRest, usage: usageRest };
}

function foldAndPurge(db: Database): void {
  const folded = foldBeforePurge(db, { nowMs: NOW });
  expect(folded).toBeDefined();
  if (!folded) return;
  purgeFoldedEvents(db, 90, folded, NOW);
  purgeFoldedUsageEvents(db, 90, folded, NOW);
  purgeFoldedImproveRuns(db, 90, folded, NOW);
}

const metricsOptions = { since: SINCE, now: () => NOW, indexSnapshot: false };

describe("akm metrics across the 90-day boundary", () => {
  test("a window spanning both stores equals the same window over all raw rows", async () => {
    const db = openStateDatabase();
    seed(db);
    db.close();
    const before = await akmMetrics(metricsOptions);
    expect(before.usage.totals.searches).toBeGreaterThan(20);

    const purging = openStateDatabase();
    const rawBefore = count(purging, "usage_events");
    foldAndPurge(purging);
    expect(count(purging, "usage_events")).toBeLessThan(rawBefore); // the old days really left state.db
    expect(count(purging, "usage_events", "created_at < '2026-08-11'")).toBe(0);
    expect(count(purging, "events", "ts < '2026-08-11'")).toBe(0);
    purging.close();

    const after = await akmMetrics(metricsOptions);
    expect(comparable(after)).toEqual(comparable(before));
    expect(after.notes.some((note) => note.includes("metrics.db's daily rollups"))).toBe(true);
    // Estimated medians land in the right neighbourhood of the exact ones.
    expect(after.usage.searchMedianMs).not.toBeNull();
    expect(Math.abs((after.usage.searchMedianMs ?? 0) - (before.usage.searchMedianMs ?? 0))).toBeLessThanOrEqual(15);
  });

  test("folded but not yet purged (a crash between the two): nothing is counted twice", async () => {
    const db = openStateDatabase();
    seed(db);
    db.close();
    const before = await akmMetrics(metricsOptions);

    const folding = openStateDatabase();
    const metrics = openMetricsDatabase();
    foldClosedDays(folding, metrics, { nowMs: NOW });
    metrics.close();
    folding.close();

    const after = await akmMetrics(metricsOptions);
    expect(comparable(after)).toEqual(comparable(before));
    expect(after.notes.some((note) => note.includes("daily rollups"))).toBe(false);
  });

  test("a window inside the raw rows never opens metrics.db's rollups", async () => {
    const db = openStateDatabase();
    seed(db);
    foldAndPurge(db);
    db.close();
    const recent = await akmMetrics({ since: "2026-09-01T00:00:00.000Z", now: () => NOW, indexSnapshot: false });
    expect(recent.notes.some((note) => note.includes("daily rollups"))).toBe(false);
    expect(recent.usage.totals.searches).toBeGreaterThan(0);
  });

  test("days a backup holds and state.db lost before any fold are served from the fold of the backup", async () => {
    const backupPath = path.join(storage.dataDir, "backup-state.db");
    const backup = openStateDatabase(backupPath);
    seed(backup);
    const full = await (async () => {
      backup.close();
      const live = openStateDatabase();
      seed(live);
      live.close();
      return akmMetrics(metricsOptions);
    })();

    // Live state.db: only the raw days that survived a purge that did not fold (the old days are gone).
    const live = openStateDatabase();
    live.exec(
      "DELETE FROM usage_events WHERE created_at < '2026-08-11'; DELETE FROM events WHERE ts < '2026-08-11'; DELETE FROM improve_runs WHERE started_at < '2026-08-11'",
    );
    const metrics = openMetricsDatabase();
    foldClosedDays(live, metrics, { nowMs: NOW }); // folds only what live still holds
    expect(foldClosedDays(backupPath, metrics, { nowMs: NOW }).failed).toEqual([]); // the one-off import: same days, no double count
    foldClosedDays(live, metrics, { nowMs: NOW });
    metrics.close();
    live.close();

    const recovered = await akmMetrics(metricsOptions);
    expect(comparable(recovered)).toEqual(comparable(full));
  });
});

describe("health readers across the boundary", () => {
  test("improve runs, improve event counts and LLM usage match before and after the purge", () => {
    const db = openStateDatabase();
    seed(db);
    const until = new Date(NOW).toISOString();
    const summarize = () => {
      const window = buildImproveWindowSummary(db, getStateDbPath(), SINCE, until);
      const { perRunSummaries: _runs, ...rest } = window;
      return {
        window: { ...rest, runIds: queryImproveRuns(db, SINCE, until).map((row) => row.id) },
        llm: readLlmUsageAggregate(getStateDbPath(), SINCE, until),
        llmRows: readLlmRows(db, { since: SINCE, until })
          .map((row) => JSON.stringify(row))
          .sort(),
      };
    };
    const before = summarize();
    expect(before.window.runIds.length).toBeGreaterThan(20);
    expect(before.window.improve.skipped).toBeGreaterThan(0);

    foldAndPurge(db);
    expect(count(db, "improve_runs", "started_at < '2026-08-11'")).toBe(0);
    const after = summarize();
    db.close();
    expect(after).toEqual(before);
  });
});

describe("rollupDayRange", () => {
  test("adjacent windows share no day and leave none out, whatever the instant between them", () => {
    const a = "2026-07-01T05:30:00.000Z";
    const c = "2026-07-20T00:00:00.000Z";
    for (const b of ["2026-07-10T00:00:00.000Z", "2026-07-10T13:45:00.000Z", "2026-07-11T00:00:00.000Z"]) {
      const first = rollupDayRange(a, b, undefined);
      const second = rollupDayRange(b, c, undefined);
      const whole = rollupDayRange(a, c, undefined);
      expect(first?.to).toBe(second?.from);
      expect(first?.from).toBe(whole?.from);
      expect(second?.to).toBe(whole?.to);
    }
  });

  test("only the days before the oldest raw row are rollup days", () => {
    expect(rollupDayRange("2026-07-01T00:00:00.000Z", "2026-11-09T12:00:00.000Z", "2026-08-11 09:00:00")).toEqual({
      from: "2026-07-01",
      to: "2026-08-11",
    });
    expect(
      rollupDayRange("2026-09-01T00:00:00.000Z", "2026-11-09T12:00:00.000Z", "2026-08-11T09:00:00.000Z"),
    ).toBeUndefined();
    expect(rollupDayRange("2026-07-01T00:00:00.000Z", "2026-07-05T00:00:00.000Z", undefined)).toEqual({
      from: "2026-07-01",
      to: "2026-07-05",
    });
  });
});
