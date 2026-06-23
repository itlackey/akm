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

// ── #658 — cap-aware decay ──────────────────────────────────────────────────────
//
// A hypothesis whose cluster genuinely re-formed this run but was displaced out
// of the processed top-`maxClustersPerRun` slice (so its ref is NOT in seenRefs)
// must NOT have its streak reset — that is a scheduling miss, not a substance
// miss. The recombine pass passes EVERY cluster that formed this run (the full
// pre-cap set) as `presentClusters`; decay spares any non-promoted row that
// Jaccard-matches a present cluster under the same overlap rule.
describe("decayUnseenRecombineHypotheses — #658 cap-aware sparing", () => {
  // The member_key that `induct()` writes for every row.
  const MEMBERS = "memory:auth-a|memory:auth-b|memory:auth-c";

  test("a cap-displaced row (cluster present this run, not in seenRefs) is SPARED", () => {
    // The row accumulated to count=1 in run-1 and was NOT processed in run-2
    // (outside the top-N cap), so it is absent from seenRefs. Its cluster still
    // formed this run → it is in presentClusters → must NOT decay.
    induct("lesson:recombined/displaced", "run-1");
    const before = getRecombineHypothesis(db, "lesson:recombined/displaced")?.consecutive_count;
    expect(before).toBe(1);

    const affected = decayUnseenRecombineHypotheses(db, "run-2", [], {
      presentClusters: [{ signature: "tag:auth", memberKey: MEMBERS }],
      minOverlap: 0.7,
    });

    expect(affected).toBe(0);
    // Streak preserved (NOT advanced — sparing only avoids reset).
    expect(getRecombineHypothesis(db, "lesson:recombined/displaced")?.consecutive_count).toBe(1);
  });

  test("a row whose cluster genuinely has NO matching present cluster DOES decay", () => {
    induct("lesson:recombined/gone", "run-1");
    expect(getRecombineHypothesis(db, "lesson:recombined/gone")?.consecutive_count).toBe(1);

    // presentClusters contains an unrelated signature → no match → decays.
    const affected = decayUnseenRecombineHypotheses(db, "run-2", [], {
      presentClusters: [{ signature: "tag:unrelated", memberKey: "memory:x|memory:y|memory:z" }],
      minOverlap: 0.7,
    });

    expect(affected).toBe(1);
    expect(getRecombineHypothesis(db, "lesson:recombined/gone")?.consecutive_count).toBe(0);
  });

  test("a present cluster below the overlap floor does NOT spare the row (it decays)", () => {
    induct("lesson:recombined/drifted", "run-1");
    // Same signature but membership has fully drifted (0 overlap) → below the
    // 0.7 floor → treated as a different cluster → row decays.
    const affected = decayUnseenRecombineHypotheses(db, "run-2", [], {
      presentClusters: [{ signature: "tag:auth", memberKey: "memory:auth-x|memory:auth-y|memory:auth-z" }],
      minOverlap: 0.7,
    });

    expect(affected).toBe(1);
    expect(getRecombineHypothesis(db, "lesson:recombined/drifted")?.consecutive_count).toBe(0);
  });

  test("confirmation still requires reaching the threshold via genuine re-induction (sparing never advances the streak)", () => {
    const CONFIRM_THRESHOLD = 2;
    // run-1: first induction → count 1.
    expect(induct("lesson:recombined/streak", "run-1")).toBe(1);
    // run-2: the cluster is present but cap-displaced (spared, NOT re-inducted).
    decayUnseenRecombineHypotheses(db, "run-2", [], {
      presentClusters: [{ signature: "tag:auth", memberKey: MEMBERS }],
      minOverlap: 0.7,
    });
    // Still count 1 — sparing alone never reaches the threshold.
    expect(getRecombineHypothesis(db, "lesson:recombined/streak")?.consecutive_count).toBe(1);
    expect(getRecombineHypothesis(db, "lesson:recombined/streak")?.consecutive_count).toBeLessThan(CONFIRM_THRESHOLD);
    // run-3: the cluster finally wins a processed slot → genuine re-induction →
    // count reaches the threshold (this is what authorizes promotion).
    expect(induct("lesson:recombined/streak", "run-3")).toBe(CONFIRM_THRESHOLD);
  });

  test("a genuinely non-recurring hypothesis never confirms (decays every run it is absent)", () => {
    expect(induct("lesson:recombined/oneoff", "run-1")).toBe(1);
    // It never re-forms: every subsequent run has no matching present cluster.
    for (const run of ["run-2", "run-3", "run-4"]) {
      decayUnseenRecombineHypotheses(db, run, [], {
        presentClusters: [{ signature: "tag:other", memberKey: "memory:p|memory:q|memory:r" }],
        minOverlap: 0.7,
      });
      expect(getRecombineHypothesis(db, "lesson:recombined/oneoff")?.consecutive_count).toBe(0);
    }
  });

  test("omitting presentClusters preserves the pre-#658 hard-reset behaviour", () => {
    induct("lesson:recombined/legacy", "run-1");
    // No opts → unconditional reset of every unseen prior-run row.
    const affected = decayUnseenRecombineHypotheses(db, "run-2", []);
    expect(affected).toBe(1);
    expect(getRecombineHypothesis(db, "lesson:recombined/legacy")?.consecutive_count).toBe(0);
  });

  test("a re-inducted row is untouched even when also present (seenRefs wins)", () => {
    induct("lesson:recombined/seen2", "run-1");
    induct("lesson:recombined/seen2", "run-2");
    const affected = decayUnseenRecombineHypotheses(db, "run-2", ["lesson:recombined/seen2"], {
      presentClusters: [{ signature: "tag:auth", memberKey: MEMBERS }],
      minOverlap: 0.7,
    });
    expect(affected).toBe(0);
    expect(getRecombineHypothesis(db, "lesson:recombined/seen2")?.consecutive_count).toBe(2);
  });
});
