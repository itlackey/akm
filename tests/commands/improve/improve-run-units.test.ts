// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-7.7 — focused unit coverage for the pure run units extracted from
 * `akmImprove` (R31 decomposition, testability requirement).
 *
 * The P2/P3 envelope builders and the post-lock proactive cooldown re-filter
 * are driven directly — no lock, no LLM, no stage sequencing. The exit-path
 * topology itself (P1–P8) stays pinned by the akmImprove characterization
 * suites (improve-skip-if-locked, improve-dry-run-side-effects,
 * improve-lock-invariants, improve-budget-watchdog, ...).
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  type AkmImproveOptions,
  buildDryRunResult,
  buildLockSkippedResult,
  refilterProactiveLoopRefs,
} from "../../../src/commands/improve/improve";
import type { AkmConfig } from "../../../src/core/config/config";
import type { ImproveEligibleRef } from "../../../src/core/improve-types";
import { makeStashDir, sandboxXdgDataHome } from "../../_helpers/sandbox";

const disposers: Array<{ cleanup: () => void }> = [];

afterEach(() => {
  for (const d of disposers.splice(0)) d.cleanup();
});

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

    const withoutRunId = buildLockSkippedResult("quick", { mode: "ref", value: "memory:a" }, undefined);
    expect("runId" in withoutRunId).toBe(false);
    expect(withoutRunId.skipped).toEqual({ reason: "lock-held" });
  });
});

describe("buildDryRunResult — the P3 envelope", () => {
  test("plan-only envelope with conditional guidance/cleanup/filtered spreads", () => {
    const run = {
      selectedStrategy: { name: "default" },
      scope: { mode: "all" as const },
    } as Parameters<typeof buildDryRunResult>[0];
    const collected = {
      plannedRefs: [{ ref: "memory:a", reason: "scope-type" }] as ImproveEligibleRef[],
      memorySummary: { eligible: 1, derived: 0 },
      strategyFilteredRefs: [],
      memoryCleanupPlan: undefined,
      guidance: undefined,
      warnings: [],
    } as unknown as Parameters<typeof buildDryRunResult>[1];

    const result = buildDryRunResult(run, collected);

    expect(result.dryRun).toBe(true);
    expect(result.strategy).toBe("default");
    expect(result.plannedRefs.map((r) => r.ref)).toEqual(["memory:a"]);
    expect("guidance" in result).toBe(false);
    expect("memoryCleanup" in result).toBe(false);
    expect("strategyFilteredRefs" in result).toBe(false);
  });
});

describe("refilterProactiveLoopRefs — post-lock cooldown re-filter", () => {
  const options: AkmImproveOptions = { config: {} as AkmConfig };

  test("no proactive refs → the SAME array instance passes through", () => {
    disposers.push(sandboxXdgDataHome(), makeStashDir());
    const loopRefs: ImproveEligibleRef[] = [
      { ref: "memory:a", reason: "scope-type", eligibilitySource: "signal-delta" },
    ];

    const out = refilterProactiveLoopRefs(loopRefs, options, {});

    expect(out).toBe(loopRefs);
  });

  test("proactive refs with no fresher proposals stay due (nothing dropped)", () => {
    disposers.push(sandboxXdgDataHome(), makeStashDir());
    const loopRefs: ImproveEligibleRef[] = [
      { ref: "memory:a", reason: "scope-type", eligibilitySource: "signal-delta" },
      { ref: "memory:b", reason: "scope-type", eligibilitySource: "proactive" },
    ];

    // Empty sandboxed event store → no proposal timestamps → the proactive
    // ref is still due → the original loopRefs array passes through unchanged.
    const out = refilterProactiveLoopRefs(loopRefs, options, {});

    expect(out).toBe(loopRefs);
    expect(out.map((r) => r.ref)).toEqual(["memory:a", "memory:b"]);
  });
});
