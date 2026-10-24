// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-7.7 — focused unit coverage for the pure run units extracted from
 * `akmImprove` (R31 decomposition, testability requirement).
 *
 * The P2/P3 envelope builders are driven directly — no lock, no LLM, no stage
 * sequencing. The exit-path topology itself (P1–P8) stays pinned by the
 * akmImprove characterization suites (improve-skip-if-locked,
 * improve-dry-run-side-effects, improve-lock-invariants,
 * improve-budget-watchdog, ...).
 */

import { describe, expect, test } from "bun:test";
import { buildDryRunResult, buildLockSkippedResult } from "../../../src/commands/improve/improve";
import type { ImproveEligibleRef } from "../../../src/core/improve-types";

describe("buildLockSkippedResult — the P2 envelope", () => {
  test("field-exact skip envelope, runId conditional", () => {
    const withRunId = buildLockSkippedResult("default", { mode: "all" }, "run-1");
    expect(withRunId).toEqual({
      schemaVersion: 2,
      ok: true,
      strategy: "default",
      scope: { mode: "all" },
      dryRun: false,
      skipped: { reason: "lock-held" },
      memorySummary: { eligible: 0, derived: 0 },
      plannedRefs: [],
      actions: [],
      runId: "run-1",
    });

    const withoutRunId = buildLockSkippedResult("quick", { mode: "ref", value: "memories/a" }, undefined);
    expect("runId" in withoutRunId).toBe(false);
    expect(withoutRunId.skipped).toEqual({ reason: "lock-held" });
  });
});

describe("buildDryRunResult — the P3 envelope", () => {
  test("plan-only envelope with conditional guidance/cleanup/filtered spreads", () => {
    const run = {
      selectedStrategy: { name: "default" },
      scope: { mode: "all" as const },
      resolvedPlan: { processes: {}, triageJudgment: null, autonomyGated: [], engineUnavailable: [] },
      options: {},
    } as unknown as Parameters<typeof buildDryRunResult>[0];
    const collected = {
      plannedRefs: [{ ref: "memories/a", reason: "scope-type" }] as ImproveEligibleRef[],
      memorySummary: { eligible: 1, derived: 0 },
      strategyFilteredRefs: [],
      memoryCleanupPlan: undefined,
      guidance: undefined,
      warnings: [],
    } as unknown as Parameters<typeof buildDryRunResult>[1];

    const result = buildDryRunResult(run, collected);

    expect(result.dryRun).toBe(true);
    expect(result.strategy).toBe("default");
    expect(result.plannedRefs.map((r) => r.ref)).toEqual(["memories/a"]);
    expect("guidance" in result).toBe(false);
    expect("memoryCleanup" in result).toBe(false);
    expect("strategyFilteredRefs" in result).toBe(false);
    expect("skippedProcesses" in result).toBe(false);
  });
});
