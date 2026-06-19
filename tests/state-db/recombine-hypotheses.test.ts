// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #625 — recombine_hypotheses state.db table + accessors (RED — not yet built).
 *
 * Direct table-level tests for the confirmation-count store that backs the
 * recombine second-pass promotion. These exercise the migration (014) and the
 * accessor helpers in isolation, separate from the end-to-end promotion flow in
 * tests/commands/improve-recombine-promote.test.ts.
 *
 * Contract under test (none of these exist yet — the RED imports are
 * intentional):
 *   - Migration `014-recombine-hypotheses` is applied by openStateDatabase().
 *   - recordRecombineInduction(db, {...}) → INSERT…ON CONFLICT increment,
 *     returns the new consecutive_count; same-run re-call is idempotent.
 *   - getRecombineHypothesis(db, ref) → row | undefined (bun:sqlite null→undefined).
 *   - markRecombineHypothesisPromoted(db, ref, ts) → sets promoted_at, resets count.
 *   - decayUnseenRecombineHypotheses(db, currentRun, seenRefs[]) → resets rows
 *     NOT in seenRefs and whose last_run != currentRun; seen rows untouched.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
// NOTE: these symbols do not exist yet — the RED imports are intentional.
import {
  type Database,
  decayUnseenRecombineHypotheses,
  getRecombineHypothesis,
  markRecombineHypothesisPromoted,
  openStateDatabase,
  recordRecombineInduction,
} from "../../src/core/state-db";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

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

function induct(ref: string, run: string, seenAt = "2026-06-18T00:00:00.000Z"): number {
  return recordRecombineInduction(db, {
    hypothesisRef: ref,
    signature: "tag:auth",
    memberKey: "memory:auth-a|memory:auth-b|memory:auth-c",
    seenAt,
    run,
  });
}

describe("migration 014 — recombine_hypotheses", () => {
  test("openStateDatabase applies the 014-recombine-hypotheses migration", () => {
    const applied = db
      .prepare("SELECT id FROM schema_migrations WHERE id = ?")
      .all("014-recombine-hypotheses") as Array<{ id: string }>;
    expect(applied.length).toBe(1);
  });

  test("the recombine_hypotheses table exists", () => {
    const tbl = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='recombine_hypotheses'")
      .all() as Array<{ name: string }>;
    expect(tbl.length).toBe(1);
  });
});

describe("recordRecombineInduction", () => {
  test("first induction inserts the row with consecutive_count=1", () => {
    const count = induct("lesson:recombined/auth-deadbeef", "run-1");
    expect(count).toBe(1);
    const row = getRecombineHypothesis(db, "lesson:recombined/auth-deadbeef");
    expect(row?.consecutive_count).toBe(1);
    expect(row?.signature).toBe("tag:auth");
    expect(row?.last_run).toBe("run-1");
    expect(row?.promoted_at ?? null).toBeNull();
  });

  test("a subsequent induction in a DIFFERENT run increments to 2", () => {
    induct("lesson:recombined/auth-deadbeef", "run-1");
    const count = induct("lesson:recombined/auth-deadbeef", "run-2");
    expect(count).toBe(2);
    expect(getRecombineHypothesis(db, "lesson:recombined/auth-deadbeef")?.consecutive_count).toBe(2);
  });

  test("a same-run re-call is idempotent (does NOT double-increment)", () => {
    induct("lesson:recombined/auth-deadbeef", "run-1");
    const count = induct("lesson:recombined/auth-deadbeef", "run-1");
    expect(count).toBe(1);
    expect(getRecombineHypothesis(db, "lesson:recombined/auth-deadbeef")?.consecutive_count).toBe(1);
  });
});

describe("getRecombineHypothesis", () => {
  test("returns the row when present", () => {
    induct("lesson:recombined/x-1", "run-1");
    expect(getRecombineHypothesis(db, "lesson:recombined/x-1")).toBeDefined();
  });

  test("returns undefined for an unknown ref", () => {
    expect(getRecombineHypothesis(db, "lesson:recombined/nope")).toBeUndefined();
  });
});

describe("markRecombineHypothesisPromoted", () => {
  test("sets promoted_at and resets consecutive_count to 0", () => {
    induct("lesson:recombined/auth-deadbeef", "run-1");
    induct("lesson:recombined/auth-deadbeef", "run-2");
    markRecombineHypothesisPromoted(db, "lesson:recombined/auth-deadbeef", "2026-06-18T01:00:00.000Z");
    const row = getRecombineHypothesis(db, "lesson:recombined/auth-deadbeef");
    expect(row?.promoted_at).toBe("2026-06-18T01:00:00.000Z");
    expect(row?.consecutive_count).toBe(0);
  });
});

describe("decayUnseenRecombineHypotheses", () => {
  test("resets rows NOT in seenRefs whose last_run != currentRun; seen rows untouched", () => {
    // Two hypotheses each accumulated to count=1 in run-1.
    induct("lesson:recombined/seen", "run-1");
    induct("lesson:recombined/unseen", "run-1");

    // run-2 re-induces only `seen`.
    induct("lesson:recombined/seen", "run-2");
    const affected = decayUnseenRecombineHypotheses(db, "run-2", ["lesson:recombined/seen"]);

    expect(affected).toBeGreaterThanOrEqual(1);
    // `unseen` was not re-induced this run → decayed to 0.
    expect(getRecombineHypothesis(db, "lesson:recombined/unseen")?.consecutive_count ?? 0).toBe(0);
    // `seen` was re-induced this run (last_run == run-2) → untouched at count=2.
    expect(getRecombineHypothesis(db, "lesson:recombined/seen")?.consecutive_count).toBe(2);
  });

  test("a row already promoted is left alone by the sweep", () => {
    induct("lesson:recombined/promoted", "run-1");
    markRecombineHypothesisPromoted(db, "lesson:recombined/promoted", "2026-06-18T01:00:00.000Z");
    decayUnseenRecombineHypotheses(db, "run-2", []);
    const row = getRecombineHypothesis(db, "lesson:recombined/promoted");
    expect(row?.promoted_at).toBe("2026-06-18T01:00:00.000Z");
  });
});
