// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests for the SELECT-time cooldown leak fix (Phase 3).
 *
 * ROOT CAUSE (from diagnosis): planning can use cooldown timestamps captured
 * before execution, so refs claimed just before lock acquisition need a fresh
 * due check.
 *
 * THE FIX:
 *   `filterProactiveDue(selected, lastReflectTs, lastDistillTs, dueDays, now)`
 *   re-applies the DUE gate with freshly-read timestamp maps under the run lock.
 *
 * These tests drive `filterProactiveDue` directly.
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DUE_DAYS,
  filterProactiveDue,
  selectProactiveMaintenanceRefs,
} from "../src/commands/improve/proactive-maintenance";
import type { ImproveEligibleRef } from "../src/core/improve-types";

const NOW = Date.parse("2026-06-14T12:00:00.000Z");
const DAY = 86_400_000;

function isoDaysAgo(days: number): string {
  return new Date(NOW - days * DAY).toISOString();
}

function isoMinutesAgo(minutes: number): string {
  return new Date(NOW - minutes * 60_000).toISOString();
}

function makeRef(r: string): ImproveEligibleRef {
  return { ref: r, reason: "scope-type", filePath: `/stash/${r}.md` };
}

/** Helper that invokes the post-lock re-filter with default dueDays/now. */
function callFilter(
  selected: ImproveEligibleRef[],
  reflectTs: Map<string, string>,
  distillTs: Map<string, string>,
  dueDays: number = DEFAULT_DUE_DAYS,
  now: number = NOW,
): ImproveEligibleRef[] {
  return filterProactiveDue(selected, reflectTs, distillTs, dueDays, now);
}

// ---------------------------------------------------------------------------
// filterProactiveDue — post-lock re-filter
// ---------------------------------------------------------------------------

describe("filterProactiveDue — post-lock re-filter", () => {
  /**
   * SCENARIO A: ref selected by pre-lock planning (never reflected at that
   * time), but Run A committed reflect_invoked 3 min before Run B acquires
   * the lock.  filterProactiveDue must drop it.
   */
  test("drops ref reflected 3 min ago by concurrent run (in-flight reflect now committed)", () => {
    const r = "skill:support-investigate-ticket";
    const selected = [makeRef(r)];
    const freshReflectTs = new Map([[r, isoMinutesAgo(3)]]);

    const stillDue = callFilter(selected, freshReflectTs, new Map());

    expect(stillDue.map((s) => s.ref)).toEqual([]);
  });

  /**
   * SCENARIO B: back-to-back cron (20 min apart).  Previous run's
   * reflect_invoked is now in the store.
   */
  test("drops ref reflected 20 min ago by previous cron run", () => {
    const r = "memory:deployment-runbook";
    const selected = [makeRef(r)];
    const freshReflectTs = new Map([[r, isoMinutesAgo(20)]]);

    const stillDue = callFilter(selected, freshReflectTs, new Map());

    expect(stillDue.map((s) => s.ref)).toEqual([]);
  });

  /**
   * SCENARIO C: distill by sibling run also resets the clock.
   */
  test("drops ref distilled 10 min ago by concurrent run", () => {
    const r = "skill:incident-response";
    const selected = [makeRef(r)];
    const freshDistillTs = new Map([[r, isoMinutesAgo(10)]]);

    const stillDue = callFilter(selected, new Map(), freshDistillTs);

    expect(stillDue.map((s) => s.ref)).toEqual([]);
  });

  /**
   * SCENARIO D: mixed batch — some refs were claimed by concurrent runs, some
   * are genuinely still due.  filterProactiveDue must keep only the still-due.
   */
  test("keeps refs that are genuinely still due, drops those claimed by concurrent runs", () => {
    const claimed = makeRef("skill:claimed");
    const stillDueRef = makeRef("skill:still-due");
    const selected = [claimed, stillDueRef];

    const freshReflectTs = new Map([
      ["skill:claimed", isoMinutesAgo(5)],
      ["skill:still-due", isoDaysAgo(45)], // last reflected 45 days ago → still due
    ]);

    const stillDue = callFilter(selected, freshReflectTs, new Map());

    expect(stillDue.map((s) => s.ref)).toEqual(["skill:still-due"]);
  });

  /**
   * SCENARIO E: ref that was never reflected and no concurrent run touched it
   * — must remain in the post-lock set.
   */
  test("keeps never-reflected refs that no concurrent run touched", () => {
    const r = "skill:brand-new";
    const selected = [makeRef(r)];
    const freshReflectTs = new Map<string, string>(); // no entry — still never reflected

    const stillDue = callFilter(selected, freshReflectTs, new Map());

    expect(stillDue.map((s) => s.ref)).toEqual([r]);
  });

  /**
   * SCENARIO F: ref reflected EXACTLY dueDays ago — boundary case.
   * due = staleDays > dueDays → equal is NOT due → must be dropped.
   */
  test("drops ref reflected exactly dueDays ago (boundary: equal is not past the gate)", () => {
    const r = "skill:boundary";
    const selected = [makeRef(r)];
    const freshReflectTs = new Map([[r, isoDaysAgo(DEFAULT_DUE_DAYS)]]);

    const stillDue = callFilter(selected, freshReflectTs, new Map());

    expect(stillDue.map((s) => s.ref)).toEqual([]);
  });

  /**
   * SCENARIO G: ref reflected one ms PAST dueDays — must remain due.
   */
  test("keeps ref reflected one ms past dueDays (boundary: just past the gate)", () => {
    const r = "skill:just-past";
    const justPast = new Date(NOW - DEFAULT_DUE_DAYS * DAY - 1).toISOString();
    const selected = [makeRef(r)];
    const freshReflectTs = new Map([[r, justPast]]);

    const stillDue = callFilter(selected, freshReflectTs, new Map());

    expect(stillDue.map((s) => s.ref)).toEqual([r]);
  });

  /**
   * SCENARIO H: empty selected list — filterProactiveDue must return [].
   */
  test("returns empty array when selected list is empty", () => {
    const stillDue = callFilter([], new Map(), new Map());
    expect(stillDue).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Regression guard: the selector itself remains correct
// (these already pass and must NOT regress after the fix)
// ---------------------------------------------------------------------------

describe("cooldown-select-fix — selector purity regression guards (already GREEN)", () => {
  test("never-reflected assets are always due", () => {
    const r = "skill:never";
    const res = selectProactiveMaintenanceRefs({
      candidates: [makeRef(r)],
      lastReflectTs: new Map(),
      lastDistillTs: new Map(),
      retrievalCounts: new Map([[r, 10]]),
      now: NOW,
    });
    expect(res.dueTotal).toBe(1);
    expect(res.neverReflected).toBe(1);
    expect(res.selected.map((s) => s.ref)).toEqual([r]);
  });

  test("assets reflected within dueDays are NOT due (selector-level gate is correct)", () => {
    const r = "skill:fresh";
    const res = selectProactiveMaintenanceRefs({
      candidates: [makeRef(r)],
      lastReflectTs: new Map([[r, isoDaysAgo(5)]]),
      lastDistillTs: new Map(),
      retrievalCounts: new Map([[r, 50]]),
      now: NOW,
    });
    expect(res.dueTotal).toBe(0);
    expect(res.selected).toEqual([]);
  });

  test("selector with stale pre-lock map DOES select ref (documents the bug the fix closes)", () => {
    // This documents the broken-path behavior that the orchestrator currently
    // exhibits: planning uses a stale map → ref selected even though a
    // concurrent run reflected it moments ago.
    const r = "skill:k8s-debug";
    const stalePreLockMap = new Map<string, string>(); // empty — Run A's reflect not visible

    const brokenResult = selectProactiveMaintenanceRefs({
      candidates: [makeRef(r)],
      lastReflectTs: stalePreLockMap,
      lastDistillTs: new Map(),
      retrievalCounts: new Map([[r, 20]]),
      now: NOW,
      dueDays: DEFAULT_DUE_DAYS,
    });

    // The selector correctly uses what it was given — the bug is the caller
    // providing the stale map.  This assertion documents the symptom.
    expect(brokenResult.selected.map((s) => s.ref)).toEqual([r]);
  });
});
