// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Unit tests for the Layer-2 proactive-maintenance selector (pure scoring +
 * selection). Covers: due-gating, priority ordering, top-N bound, rotation
 * cooldown, importance weights, and the dueTotal/neverReflected telemetry.
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DUE_DAYS,
  DEFAULT_IMPORTANCE_WEIGHTS,
  DEFAULT_MAX_PER_RUN,
  selectProactiveMaintenanceRefs,
} from "../../../src/commands/improve/proactive-maintenance";
import type { ImproveEligibleRef } from "../../../src/core/improve-types";

const NOW = Date.parse("2026-06-14T00:00:00.000Z");
const DAY = 86_400_000;

/** ISO timestamp `days` before NOW. */
function isoDaysAgo(days: number): string {
  return new Date(NOW - days * DAY).toISOString();
}

function ref(r: string, filePath = `/stash/${r}.md`): ImproveEligibleRef {
  return { ref: r, reason: "scope-type", filePath };
}

describe("selectProactiveMaintenanceRefs — due gating", () => {
  test("never-reflected assets are always due", () => {
    const candidates = [ref("skill:never")];
    const res = selectProactiveMaintenanceRefs({
      candidates,
      lastReflectTs: new Map(),
      lastDistillTs: new Map(),
      retrievalCounts: new Map([["skill:never", 10]]),
      now: NOW,
    });
    expect(res.dueTotal).toBe(1);
    expect(res.neverReflected).toBe(1);
    expect(res.selected.map((s) => s.ref)).toEqual(["skill:never"]);
  });

  test("assets reflected within dueDays are NOT due (rotation cooldown)", () => {
    const candidates = [ref("skill:fresh")];
    const res = selectProactiveMaintenanceRefs({
      candidates,
      lastReflectTs: new Map([["skill:fresh", isoDaysAgo(5)]]), // 5 < 30
      lastDistillTs: new Map(),
      retrievalCounts: new Map([["skill:fresh", 50]]),
      now: NOW,
    });
    expect(res.dueTotal).toBe(0);
    expect(res.selected).toEqual([]);
  });

  test("assets reflected longer ago than dueDays ARE due", () => {
    const candidates = [ref("skill:stale")];
    const res = selectProactiveMaintenanceRefs({
      candidates,
      lastReflectTs: new Map([["skill:stale", isoDaysAgo(45)]]), // 45 > 30
      lastDistillTs: new Map(),
      retrievalCounts: new Map([["skill:stale", 3]]),
      now: NOW,
    });
    expect(res.dueTotal).toBe(1);
    expect(res.neverReflected).toBe(0);
    expect(res.selected.map((s) => s.ref)).toEqual(["skill:stale"]);
  });

  test("a recent DISTILL also resets the maintenance clock", () => {
    const candidates = [ref("memory:m1")];
    const res = selectProactiveMaintenanceRefs({
      candidates,
      lastReflectTs: new Map([["memory:m1", isoDaysAgo(90)]]), // reflect stale
      lastDistillTs: new Map([["memory:m1", isoDaysAgo(2)]]), // but distilled recently
      retrievalCounts: new Map([["memory:m1", 5]]),
      now: NOW,
    });
    expect(res.dueTotal).toBe(0);
  });

  test("custom dueDays widens/narrows the gate", () => {
    const candidates = [ref("skill:s")];
    const args = {
      candidates,
      lastReflectTs: new Map([["skill:s", isoDaysAgo(10)]]),
      lastDistillTs: new Map(),
      retrievalCounts: new Map([["skill:s", 5]]),
      now: NOW,
    };
    expect(selectProactiveMaintenanceRefs({ ...args, dueDays: 30 }).dueTotal).toBe(0);
    expect(selectProactiveMaintenanceRefs({ ...args, dueDays: 7 }).dueTotal).toBe(1);
  });
});

describe("selectProactiveMaintenanceRefs — priority ordering", () => {
  test("higher importance type outranks lower for equal freq/size", () => {
    const candidates = [ref("memory:lo"), ref("skill:hi")];
    const res = selectProactiveMaintenanceRefs({
      candidates,
      lastReflectTs: new Map(), // both never reflected => due
      lastDistillTs: new Map(),
      retrievalCounts: new Map([
        ["memory:lo", 10],
        ["skill:hi", 10],
      ]),
      sizeBytesOf: () => 1000,
      now: NOW,
    });
    // skill weight 1.5 > memory 0.7 => skill ranks first
    expect(res.selected.map((s) => s.ref)).toEqual(["skill:hi", "memory:lo"]);
  });

  test("higher retrieval frequency ranks higher for same type", () => {
    const candidates = [ref("skill:cold"), ref("skill:hot")];
    const res = selectProactiveMaintenanceRefs({
      candidates,
      lastReflectTs: new Map(),
      lastDistillTs: new Map(),
      retrievalCounts: new Map([
        ["skill:cold", 1],
        ["skill:hot", 100],
      ]),
      sizeBytesOf: () => 1000,
      now: NOW,
    });
    expect(res.selected.map((s) => s.ref)).toEqual(["skill:hot", "skill:cold"]);
  });

  test("importanceWeights override flips ordering", () => {
    const candidates = [ref("memory:m"), ref("skill:s")];
    const res = selectProactiveMaintenanceRefs({
      candidates,
      lastReflectTs: new Map(),
      lastDistillTs: new Map(),
      retrievalCounts: new Map([
        ["memory:m", 10],
        ["skill:s", 10],
      ]),
      sizeBytesOf: () => 1000,
      importanceWeights: { memory: 5.0, skill: 0.1 }, // invert defaults
      now: NOW,
    });
    expect(res.selected.map((s) => s.ref)).toEqual(["memory:m", "skill:s"]);
  });

  test("defaults are exported with the documented values", () => {
    expect(DEFAULT_IMPORTANCE_WEIGHTS.skill).toBe(1.5);
    expect(DEFAULT_IMPORTANCE_WEIGHTS.memory).toBe(0.7);
    expect(DEFAULT_DUE_DAYS).toBe(30);
    expect(DEFAULT_MAX_PER_RUN).toBe(25);
  });
});

describe("selectProactiveMaintenanceRefs — top-N bound", () => {
  test("selection is bounded to maxPerRun even when more are due", () => {
    const candidates = Array.from({ length: 50 }, (_, i) => ref(`skill:s${i}`));
    const retrievalCounts = new Map(candidates.map((c, i) => [c.ref, i + 1]));
    const res = selectProactiveMaintenanceRefs({
      candidates,
      lastReflectTs: new Map(), // all never reflected => all due
      lastDistillTs: new Map(),
      retrievalCounts,
      sizeBytesOf: () => 1000,
      maxPerRun: 25,
      now: NOW,
    });
    expect(res.dueTotal).toBe(50);
    expect(res.selected.length).toBe(25);
    // The 25 highest-frequency refs (s49..s25) should win.
    expect(res.selected[0].ref).toBe("skill:s49");
    expect(res.selected.some((s) => s.ref === "skill:s0")).toBe(false);
  });

  test("maxPerRun of 0 selects nothing but still reports dueTotal", () => {
    const candidates = [ref("skill:a"), ref("skill:b")];
    const res = selectProactiveMaintenanceRefs({
      candidates,
      lastReflectTs: new Map(),
      lastDistillTs: new Map(),
      retrievalCounts: new Map(),
      maxPerRun: 0,
      now: NOW,
    });
    expect(res.dueTotal).toBe(2);
    expect(res.selected.length).toBe(0);
  });
});

describe("selectProactiveMaintenanceRefs — rotation", () => {
  test("a ref reflected on the previous run is skipped until it ages past dueDays", () => {
    const candidates = [ref("skill:rotA"), ref("skill:rotB")];
    // rotA was just reflected (last run); rotB has gone stale.
    const res = selectProactiveMaintenanceRefs({
      candidates,
      lastReflectTs: new Map([
        ["skill:rotA", isoDaysAgo(1)],
        ["skill:rotB", isoDaysAgo(60)],
      ]),
      lastDistillTs: new Map(),
      retrievalCounts: new Map([
        ["skill:rotA", 100],
        ["skill:rotB", 1],
      ]),
      sizeBytesOf: () => 1000,
      now: NOW,
    });
    // Even though rotA is far hotter, it is NOT due (cooldown) — only rotB rotates in.
    expect(res.selected.map((s) => s.ref)).toEqual(["skill:rotB"]);
  });
});
