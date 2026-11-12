// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The `metrics-db` health check: integrity, size, fold range and the fold's lag behind state.db. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { akmHealth } from "../../../src/commands/health";
import { FOLD_LAG_WARN_DAYS, metricsDbCheck, readMetricsDbState } from "../../../src/commands/health/metrics-db-check";
import { getMetricsDbPath, openMetricsDatabase } from "../../../src/core/metrics-db";
import { getStateDbPath, openStateDatabase } from "../../../src/core/state-db";
import { foldClosedDays } from "../../../src/indexer/metrics/fold";
import type { Database } from "../../../src/storage/database";
import { openDatabase } from "../../../src/storage/database";
import { insertEvent } from "../../../src/storage/repositories/events-repository";
import { withMetricsHistory } from "../../../src/storage/repositories/metrics-rollup-repository";
import { insertUsage } from "../../_helpers/metrics-fixtures";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");
let storage: IsolatedAkmStorage;
let state: Database;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  state = openStateDatabase();
});
afterEach(() => {
  state.close();
  storage.cleanup();
});

function seedDay(day: string): void {
  insertEvent(state, { eventType: "health_probe", ts: `${day}T01:00:00.000Z` });
  insertUsage(state, { day, type: "show", ref: "akm//knowledge/a" });
}

function check() {
  return metricsDbCheck(readMetricsDbState(state, getStateDbPath(), NOW));
}

describe("metrics-db check", () => {
  test("a fresh install with nothing closed yet passes and says metrics.db is not created", () => {
    const result = check();
    expect(result.status).toBe("pass");
    expect(result.message).toContain("not created yet");
  });

  test("closed days nobody folded for more than a week warn, naming the oldest and what it costs", () => {
    seedDay("2026-11-08"); // yesterday: within the grace
    expect(check().status).toBe("pass");
    seedDay("2026-10-01");
    const result = check();
    expect(result.status).toBe("warn");
    expect(result.message).toContain("2026-10-01");
    expect(result.message).toContain("not folded");
    expect(result.evidence).toMatchObject({ unfoldedDays: 2, oldestUnfoldedDay: "2026-10-01" });
    expect(FOLD_LAG_WARN_DAYS).toBe(7);
  });

  test("after a fold it passes with the size and the folded range", () => {
    seedDay("2026-10-01");
    seedDay("2026-10-03");
    const metrics = openMetricsDatabase();
    foldClosedDays(state, metrics, { nowMs: NOW });
    metrics.close();
    const result = check();
    expect(result.status).toBe("pass");
    expect(result.message).toContain("2 day(s) folded, 2026-10-01 to 2026-10-03");
    expect(result.evidence).toMatchObject({ foldedDays: 2, lastFoldedDay: "2026-10-03" });
    expect(result.evidence?.sizeBytes).toBeGreaterThan(0);
  });

  test("a metrics.db written by 0.10.261119 (CLI usage tables, no ledger, no folded_day) reads as no day folded yet", () => {
    const file = getMetricsDbPath();
    const legacy = openDatabase(file);
    legacy.exec("CREATE TABLE cli_usage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    legacy.close();
    seedDay("2026-10-01");
    const result = check();
    expect(result.status).toBe("warn");
    expect(result.message).not.toContain("could not be read");
    expect(result.evidence).toMatchObject({ foldedDays: 0, unfoldedDays: 1, oldestUnfoldedDay: "2026-10-01" });
    // The history reader has nothing to add either, and says nothing about it.
    expect(withMetricsHistory(state, getStateDbPath(), () => "read")).toBeUndefined();
    // The first fold migrates the file and keeps the usage table.
    const metrics = openMetricsDatabase();
    foldClosedDays(state, metrics, { nowMs: NOW });
    expect(metrics.prepare("SELECT COUNT(*) AS n FROM folded_day").get()).toEqual({ n: 1 });
    expect(metrics.prepare("SELECT COUNT(*) AS n FROM cli_usage_meta").get()).toEqual({ n: 0 });
    metrics.close();
    expect(check().status).toBe("pass");
  });

  test("a day that gained rows after its fold counts as not folded", () => {
    seedDay("2026-10-01");
    const metrics = openMetricsDatabase();
    foldClosedDays(state, metrics, { nowMs: NOW });
    metrics.close();
    insertEvent(state, { eventType: "health_probe", ts: "2026-10-01T23:00:00.000Z" });
    expect(check().evidence).toMatchObject({ unfoldedDays: 1 });
  });

  test("a damaged metrics.db fails, with the repair", () => {
    seedDay("2026-10-01");
    const metrics = openMetricsDatabase();
    foldClosedDays(state, metrics, { nowMs: NOW });
    metrics.close();
    for (const sidecar of ["-wal", "-shm"]) fs.rmSync(`${getMetricsDbPath()}${sidecar}`, { force: true });
    fs.writeFileSync(getMetricsDbPath(), "this is not a sqlite database".repeat(200));
    const result = check();
    expect(result.status).toBe("fail");
    expect(result.message).toContain("metrics.db");
    expect(result.message).toContain("restore");
  });

  test("akm health carries the check among the hard checks, in a read-only run too", async () => {
    seedDay("2026-10-01");
    const metrics = openMetricsDatabase();
    foldClosedDays(state, metrics, { nowMs: Date.now() });
    metrics.close();
    for (const readOnly of [false, true]) {
      const report = await akmHealth({ stateDbPath: getStateDbPath(), readOnly, probe: false });
      const found = report.hardChecks.find((c) => c.name === "metrics-db");
      expect(found?.status).toBe("pass");
      expect(found?.message).toContain("1 day(s) folded");
    }
  });
});
