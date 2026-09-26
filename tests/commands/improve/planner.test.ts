// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { memoryIdentityRef } from "../../../src/commands/improve/memory/derived-ref";
import {
  buildImproveExecutionPlan,
  projectMemoryCleanup,
  selectEffectiveImproveRefs,
} from "../../../src/commands/improve/planner";
import type { ImproveEligibleRef } from "../../../src/core/improve-types";

function ref(name: string, eligibilitySource: ImproveEligibleRef["eligibilitySource"]): ImproveEligibleRef {
  return { ref: `memories/${name}`, reason: "scope-type", eligibilitySource };
}

describe("selectEffectiveImproveRefs", () => {
  test("applies the ranked limit, reflect-path refs first, without mutating the snapshot", () => {
    const ordinary = ref("ordinary", "signal-delta");
    const distillOnly = ref("distill-only", "signal-delta");
    const proactive = ref("proactive", "proactive");
    const ranked = [ordinary, distillOnly, proactive];
    const before = structuredClone(ranked);

    const selection = selectEffectiveImproveRefs({
      rankedRefs: ranked,
      distillOnlyRefs: [distillOnly],
      limit: 2,
    });

    expect(selection.loopRefs.map((entry) => entry.ref)).toEqual([ordinary.ref, proactive.ref]);
    expect(selection.distillOnlyRefs.map((entry) => entry.ref)).toEqual([distillOnly.ref]);
    expect(selection.limitRemoved).toBe(1);
    expect(ranked).toEqual(before);
  });

  test("distinguishes an omitted cap from an explicit zero", () => {
    const ranked = [ref("a", "proactive"), ref("b", "proactive")];
    expect(selectEffectiveImproveRefs({ rankedRefs: ranked, distillOnlyRefs: [] }).loopRefs).toHaveLength(2);
    expect(selectEffectiveImproveRefs({ rankedRefs: ranked, distillOnlyRefs: [], limit: 0 }).loopRefs).toEqual([]);
  });

  test("reports a zero replay allowance and the ordinary cap as the total ceiling", () => {
    const ordinary = ref("ordinary", "proactive");
    const plan = buildImproveExecutionPlan({
      dryRun: true,
      snapshot: { status: "ready", reason: "test snapshot" },
      rawInScope: 1,
      selectedRefs: [ordinary],
      effectiveRefs: [ordinary],
      distillOnlyRefs: new Set(),
      configuredLimits: { cli: 1 },
      effectiveLimit: 1,
      gates: [],
      processes: [],
      consolidation: {
        configured: {},
        effective: { enabled: false, minPoolSize: 2, chunkSize: 2 },
        poolSize: 0,
        candidatePoolSize: 0,
        gates: {
          profile: { passed: false, reason: "disabled" },
          minimumPool: { passed: false, reason: "disabled" },
          delta: { passed: false, reason: "disabled" },
        },
        wouldRun: false,
        reason: "disabled",
        estimatedChunks: 0,
      },
      stageConfig: {
        extract: { enabled: false, reason: "disabled" },
        graphExtraction: { enabled: false, reason: "disabled" },
        memoryInference: { enabled: false, reason: "disabled" },
      },
      triage: { enabled: false, configuredMode: "queue", mode: "queue", maxAcceptsPerRun: 0 },
    });

    expect(plan.limits).toEqual({
      configured: { cli: 1 },
      effective: 1,
      additiveReplayAllowance: 0,
      totalCeiling: 1,
    });
  });

  test("passes the resolved process routing rows through unchanged (#947)", () => {
    const processes = [
      { process: "reflect" as const, enabled: true, engine: "default", model: "base", notices: [], eligibleRefs: 3 },
      { process: "distill" as const, enabled: false, notices: [] },
    ];
    const plan = buildImproveExecutionPlan({
      dryRun: true,
      snapshot: { status: "ready", reason: "test snapshot" },
      rawInScope: 0,
      selectedRefs: [],
      effectiveRefs: [],
      distillOnlyRefs: new Set(),
      configuredLimits: {},
      gates: [],
      processes,
      consolidation: {
        configured: {},
        effective: { enabled: false, minPoolSize: 2, chunkSize: 2 },
        poolSize: 0,
        candidatePoolSize: 0,
        gates: {
          profile: { passed: false, reason: "disabled" },
          minimumPool: { passed: false, reason: "disabled" },
          delta: { passed: false, reason: "disabled" },
        },
        wouldRun: false,
        reason: "disabled",
        estimatedChunks: 0,
      },
      stageConfig: {
        extract: { enabled: false, reason: "disabled" },
        graphExtraction: { enabled: false, reason: "disabled" },
        memoryInference: { enabled: false, reason: "disabled" },
      },
      triage: { enabled: false, configuredMode: "queue", mode: "queue", maxAcceptsPerRun: 0 },
    });

    expect(plan.processes).toEqual(processes);
  });
});

describe("projectMemoryCleanup", () => {
  test("normalizes legacy cleanup identities for both estimates and executions", () => {
    const prunable = ref("deploy-copy.derived", "scope");
    const retained = ref("keep", "scope");
    const plannedRefs = [prunable, retained];

    const estimate = projectMemoryCleanup({
      mode: "estimate",
      plannedRefs,
      candidateRefs: [memoryIdentityRef("deploy-copy.derived")],
      allowApply: true,
    });
    const execution = projectMemoryCleanup({
      mode: "execution",
      plannedRefs,
      archivedRefs: [memoryIdentityRef("deploy-copy.derived")],
      allowApply: true,
    });

    expect(estimate.postCleanupRefs).toEqual([retained]);
    expect(execution.postCleanupRefs).toEqual(estimate.postCleanupRefs);
    expect(estimate.gate).toEqual({
      name: "cleanup",
      removed: 1,
      reason: "would be archived by memory cleanup",
    });
    expect(execution.gate).toEqual({
      name: "cleanup",
      removed: 1,
      reason: "archived by memory cleanup",
    });
  });

  test("retains planned refs when cleanup application is autonomy-gated", () => {
    const plannedRefs = [ref("deploy-copy.derived", "scope")];
    const projection = projectMemoryCleanup({
      mode: "estimate",
      plannedRefs,
      candidateRefs: [memoryIdentityRef("deploy-copy.derived")],
      allowApply: false,
    });

    expect(projection.postCleanupRefs).toEqual(plannedRefs);
    expect(projection.gate).toEqual({
      name: "cleanup",
      removed: 0,
      reason: "memory cleanup archive application is autonomy-gated",
    });
  });
});
