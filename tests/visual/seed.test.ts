// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The visual dataset must never read the real clock: a row stamped "now"
 * would move the screenshots every day (plan 8.7).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { getConfigPath } from "../../src/core/paths";
import { openStateDatabase } from "../../src/core/state-db";
import { akmIndex } from "../../src/indexer/indexer";
import { git } from "../_helpers/git";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";
import { FIXED_NOW } from "./constants";
import { writeConfig } from "./environment";
import { seedStash, seedVisualState } from "./seed";

const NOW = Date.parse(FIXED_NOW);
const WINDOW_START = NOW - 100 * 24 * 60 * 60 * 1000;

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  seedStash(storage.stashDir);
  seedVisualState(storage.stashDir);
});

afterEach(() => storage.cleanup());

/** SQLite's `YYYY-MM-DD HH:MM:SS` is UTC without a zone mark. */
const toMs = (stamp: string): number => Date.parse(stamp.includes("T") ? stamp : `${stamp.replace(" ", "T")}Z`);

function expectWithinSeedWindow(label: string, stamps: Array<string | null>): void {
  expect(stamps.length, label).toBeGreaterThan(0);
  for (const stamp of stamps) {
    // A proposal with no usable creation time is seeded as "unknown" on purpose.
    if (stamp === null || stamp === "unknown") continue;
    const ms = toMs(stamp);
    expect(ms, `${label}: ${stamp}`).toBeGreaterThanOrEqual(WINDOW_START);
    expect(ms, `${label}: ${stamp}`).toBeLessThanOrEqual(NOW);
  }
}

function withStateDb<T>(fn: (query: (sql: string) => Array<Record<string, string | number | null>>) => T): T {
  const db = openStateDatabase();
  try {
    return fn((sql) => db.prepare(sql).all() as Array<Record<string, string | number | null>>);
  } finally {
    db.close();
  }
}

describe("visual seed", () => {
  test("every timestamp is explicit and relative to FIXED_NOW", () => {
    withStateDb((query) => {
      const column = (sql: string) => query(sql).map((row) => row.at as string | null);
      expectWithinSeedWindow("usage_events", column("SELECT created_at AS at FROM usage_events"));
      expectWithinSeedWindow("events", column("SELECT ts AS at FROM events"));
      expectWithinSeedWindow("proposals", [
        ...column("SELECT created_at AS at FROM proposals"),
        ...column("SELECT updated_at AS at FROM proposals"),
      ]);
      expectWithinSeedWindow("improve_runs", [
        ...column("SELECT started_at AS at FROM improve_runs"),
        ...column("SELECT completed_at AS at FROM improve_runs"),
      ]);
      expectWithinSeedWindow("task_history", column("SELECT started_at AS at FROM task_history"));
    });
    const commits = git(storage.stashDir, ["log", "--format=%aI%n%cI"]).trim().split("\n");
    expect(commits).toHaveLength(12);
    expectWithinSeedWindow("git", commits);
  });

  test("covers the cases Appendix C names", () => {
    withStateDb((query) => {
      const count = (where: string) => query(`SELECT COUNT(*) AS n FROM ${where}`)[0]?.n;
      expect(count("improve_runs")).toBe(14);
      expect(count("improve_runs WHERE ok = 0")).toBe(1);
      expect(count("improve_runs WHERE dry_run = 1")).toBe(1);
      expect(count("task_history")).toBe(2);
      expect(count("task_history WHERE status = 'active'")).toBe(1);
      expect(count("usage_events WHERE query = 'flaky test quarantine'")).toBe(8);
      expect(count("proposals WHERE status = 'pending'")).toBe(10);
    });
  });

  test("gate decisions carry the gate the product stamps", () => {
    withStateDb((query) => {
      const meta = query("SELECT status, metadata_json AS m FROM proposals").map((row) => ({
        status: row.status,
        ...JSON.parse(row.m as string),
      }));
      const judged = meta.filter((p) => p.status === "accepted" && p.gateDecision?.outcome === "auto-accepted");
      expect(judged).toHaveLength(1);
      expect(judged[0]?.gateDecision.gate).toBe("triage");
      for (const p of meta) if (p.gateDecision) expect(typeof p.gateDecision.gate).toBe("string");
    });
  });

  test("no pending proposal carries an auto decision the drain would have made terminal", () => {
    withStateDb((query) => {
      const pending = query("SELECT metadata_json AS m FROM proposals WHERE status = 'pending'").map(
        (row) => JSON.parse(row.m as string).gateDecision?.outcome,
      );
      expect(pending).toHaveLength(10);
      expect(pending).not.toContain("auto-rejected");
      expect(pending).not.toContain("auto-accepted");
    });
  });

  test("the retirement batch is three accepted retire proposals in one UTC day, with no bundle removals", () => {
    withStateDb((query) => {
      const retired = query("SELECT metadata_json AS m FROM proposals WHERE status = 'accepted'")
        .map((row) => JSON.parse(row.m as string))
        .filter((p) => p.retirement && p.changes?.[0]?.op === "delete");
      const days = new Map<string, number>();
      for (const p of retired) {
        const day = String(p.review.decidedAt).slice(0, 10);
        days.set(day, (days.get(day) ?? 0) + 1);
      }
      expect(Math.max(0, ...days.values())).toBeGreaterThanOrEqual(3);
      expect(query("SELECT COUNT(*) AS n FROM events WHERE event_type = 'remove'")[0]?.n).toBe(0);
    });
  });
});

describe("visual pipeline", () => {
  let fresh: IsolatedAkmStorage;
  beforeEach(() => {
    fresh = withIsolatedAkmStorage();
  });
  afterEach(() => fresh.cleanup());

  test("indexing under the frozen clock leaves exactly the seeded index run", async () => {
    seedStash(fresh.stashDir);
    await akmIndex({ stashDir: fresh.stashDir, full: true });
    seedVisualState(fresh.stashDir);
    withStateDb((query) => {
      const runs = query("SELECT metadata_json AS metadata FROM events WHERE event_type = 'index_completed'");
      expect(runs).toHaveLength(1);
      expect(JSON.parse(runs[0]?.metadata as string).totalMs).toBe(4200);
    });
  });
});

describe("visual environment", () => {
  test("the harness config is the file akm reads", () => {
    writeConfig(storage.stashDir);
    expect(fs.existsSync(getConfigPath())).toBe(true);
  });
});
