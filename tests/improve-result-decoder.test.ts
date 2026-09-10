// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { decodeImproveResult } from "../src/core/improve-result";
import type { ImproveExecutionPlan } from "../src/core/improve-types";
import type { LoweringNotice } from "../src/execution/resolved-request";

const common = {
  ok: true,
  scope: { mode: "all" },
  dryRun: false,
  memorySummary: { eligible: 1, derived: 0 },
  plannedRefs: [],
  actions: [],
};

const plannedRef = {
  ref: "skills/a",
  filePath: "/tmp/skills/a/SKILL.md",
  eligibilitySource: "proactive",
};

describe("decodeImproveResult", () => {
  const plan = {
    mode: "estimate",
    dispatch: false,
    snapshot: { status: "ready", reason: "loaded the existing index read-only" },
    candidates: { rawInScope: 2, selected: 2, effective: 1 },
    limits: {
      configured: { cli: 1, reflect: 25 },
      effective: 1,
      additiveReplayAllowance: 0,
      totalCeiling: 1,
    },
    gates: [
      { name: "profile", removed: 0, reason: "profile" },
      { name: "cleanup", removed: 0, reason: "cleanup" },
      { name: "validation", removed: 0, reason: "validation" },
      { name: "signal", removed: 0, reason: "signal" },
      { name: "disk", removed: 0, reason: "disk" },
      { name: "limit", removed: 1, reason: "deferred" },
    ],
    effectiveRefs: [{ ref: "skills/a", lane: "proactive", reason: "scope-type" }],
    processes: [
      { process: "reflect", enabled: true, engine: "default", model: "base", engineKind: "llm", notices: [] },
      { process: "distill", enabled: false, notices: [] },
      { process: "consolidate", enabled: false, notices: [] },
      { process: "memoryInference", enabled: false, notices: [] },
      { process: "graphExtraction", enabled: false, notices: [] },
      { process: "extract", enabled: false, notices: [] },
      { process: "validation", enabled: false, notices: [] },
      { process: "triage", enabled: false, notices: [] },
      { process: "proactiveMaintenance", enabled: false, notices: [] },
    ],
    proactive: {
      configured: { dueDays: 30, maxPerRun: 10 },
      effective: { dueDays: 30, maxPerRun: 10 },
      candidatePool: 2,
      dueTotal: 2,
      neverReflected: 2,
      selected: 1,
      selectedRefs: ["skills/a"],
    },
    consolidation: {
      configured: { enabled: true, minPoolSize: 3, limit: 4, maxChunkSize: 2 },
      effective: { enabled: true, minPoolSize: 3, limit: 4, chunkSize: 2 },
      poolSize: 5,
      candidatePoolSize: 4,
      gates: {
        profile: { passed: true, reason: "enabled" },
        minimumPool: { passed: true, reason: "large enough" },
        delta: { passed: true, reason: "changed" },
      },
      wouldRun: true,
      reason: "all gates pass",
      estimatedChunks: 2,
    },
    stages: [
      { name: "consolidation", wouldRun: true, reason: "all gates pass" },
      { name: "extract", wouldRun: false, reason: "disabled" },
      { name: "graph-extraction", wouldRun: false, reason: "disabled" },
      { name: "memory-inference", wouldRun: false, reason: "disabled" },
    ],
    triage: {
      enabled: true,
      configuredMode: "promote",
      mode: "queue",
      maxAcceptsPerRun: 7,
      maxDiffLines: 20,
    },
  } satisfies ImproveExecutionPlan;

  test("decodes the v2 strategy envelope", () => {
    const notices: readonly Readonly<LoweringNotice>[] = [
      {
        code: "untranslated-field",
        severity: "warning",
        adapter: "fixture",
        field: "outputSchema",
        message: "The fixture adapter will attempt dispatch without native schema translation.",
      },
    ];
    const decoded = decodeImproveResult({ schemaVersion: 2, strategy: "thorough", ...common, notices });
    expect(decoded.strategy).toBe("thorough");
    expect(decoded.envelope.strategy).toBe("thorough");
    expect(decoded.envelope.notices).toEqual(notices);
    expect(() =>
      decodeImproveResult({
        schemaVersion: 2,
        strategy: "thorough",
        ...common,
        notices: [{ ...notices[0], providerBody: "must not be accepted" }],
      }),
    ).toThrow(/unknown field/);
  });

  test("strictly decodes the additive improve plan", () => {
    const envelope = {
      schemaVersion: 2,
      strategy: "default",
      ...common,
      dryRun: true,
      plannedRefs: [plannedRef],
      plan,
    };
    const decoded = decodeImproveResult(envelope);
    expect(decoded.envelope.plan).toEqual(plan);
    expect(() =>
      decodeImproveResult({
        ...envelope,
        plan: { ...plan, candidates: { ...plan.candidates, invented: 1 } },
      }),
    ).toThrow(/unknown field/);
    expect(() =>
      decodeImproveResult({
        ...envelope,
        plan: { ...plan, effectiveRefs: [{ ...plan.effectiveRefs[0], lane: "invented" }] },
      }),
    ).toThrow(/lane/);
    expect(() =>
      decodeImproveResult({
        ...envelope,
        plan: { ...plan, snapshot: { status: "invented", reason: "not real" } },
      }),
    ).toThrow(/snapshot.status/);
    expect(() =>
      decodeImproveResult({
        ...envelope,
        plan: { ...plan, dispatch: true },
      }),
    ).toThrow(/dispatch/);
    expect(() =>
      decodeImproveResult({
        ...envelope,
        plan: { ...plan, candidates: { ...plan.candidates, effective: 2 } },
      }),
    ).toThrow(/limit removal.*selected.*effective|effectiveRefs.length/);
  });

  test("rejects contradictory modes, counts, ordered refs, and replay caps", () => {
    const envelope = {
      schemaVersion: 2,
      strategy: "default",
      ...common,
      dryRun: true,
      plannedRefs: [plannedRef],
      plan,
    };
    const contradictions = [
      {
        value: { ...envelope, dryRun: false },
        message: /dryRun=false.*execution mode/,
      },
      {
        value: { ...envelope, plan: { ...plan, candidates: { rawInScope: 0, selected: 1, effective: 1 } } },
        message: /rawInScope cannot be less than.*selected/,
      },
      {
        value: {
          ...envelope,
          plan: {
            ...plan,
            gates: plan.gates.map((gate) => (gate.name === "signal" ? { ...gate, removed: 1 } : gate)),
          },
        },
        message: /pre-limit gate removals.*rawInScope.*selected/,
      },
      {
        value: {
          ...envelope,
          plan: {
            ...plan,
            candidates: { ...plan.candidates, selected: 1 },
            gates: plan.gates.map((gate) => (gate.name === "signal" ? { ...gate, removed: 1 } : gate)),
          },
        },
        message: /limit removal.*selected.*effective/,
      },
      {
        value: {
          ...envelope,
          plan: {
            ...plan,
            gates: plan.gates.filter((gate) => gate.name !== "disk"),
          },
        },
        message: /exactly one.*disk/,
      },
      {
        value: { ...envelope, plannedRefs: [{ ...plannedRef, ref: "skills/other" }] },
        message: /plannedRefs.*same refs in the same order/,
      },
      {
        value: {
          ...envelope,
          plan: { ...plan, limits: { ...plan.limits, effective: -1, totalCeiling: -1 } },
        },
        message: /limits.effective must be a non-negative integer/,
      },
      {
        value: {
          ...envelope,
          plan: {
            ...plan,
            limits: { ...plan.limits, additiveReplayAllowance: 1, totalCeiling: 3 },
          },
        },
        message: /totalCeiling must equal.*effective.*additiveReplayAllowance/,
      },
      {
        value: {
          ...envelope,
          plannedRefs: [{ ...plannedRef, eligibilitySource: "replay" }],
          plan: {
            ...plan,
            effectiveRefs: [{ ...plan.effectiveRefs[0], lane: "replay" }],
          },
        },
        message: /replay refs cannot exceed.*additiveReplayAllowance/,
      },
      {
        value: {
          ...envelope,
          plannedRefs: [plannedRef, { ...plannedRef, ref: "skills/b" }],
          plan: {
            ...plan,
            candidates: { rawInScope: 2, selected: 2, effective: 2 },
            effectiveRefs: [plan.effectiveRefs[0], { ...plan.effectiveRefs[0], ref: "skills/b" }],
            limits: { ...plan.limits, additiveReplayAllowance: 1, totalCeiling: 2 },
            gates: plan.gates.map((gate) => (gate.name === "limit" ? { ...gate, removed: 0 } : gate)),
          },
        },
        message: /ordinary refs cannot exceed.*limits.effective/,
      },
    ];

    for (const contradiction of contradictions) {
      expect(() => decodeImproveResult(contradiction.value)).toThrow(contradiction.message);
    }
  });

  test("rejects complete and interrupted v1 envelopes", () => {
    const { memorySummary: _memorySummary, ...withoutSummary } = common;
    for (const v1 of [
      { schemaVersion: 1, profile: "nightly", ...common },
      {
        schemaVersion: 1,
        profile: "nightly",
        ...withoutSummary,
        ok: false,
        terminated: { reason: "signal", at: "2026-07-01T00:00:00Z" },
      },
    ]) {
      expect(() => decodeImproveResult(v1)).toThrow(/unsupported schemaVersion: 1/);
    }
  });

  test("rejects retired v1 fields and result aliases", () => {
    for (const retired of [
      { profile: "old" },
      { profileFilteredRefs: [] },
      { stalenessDetection: {} },
      { executionLogCandidates: [] },
      { recombination: {} },
      { proceduralCompilation: {} },
    ]) {
      expect(() => decodeImproveResult({ schemaVersion: 2, strategy: "default", ...common, ...retired })).toThrow(
        /unknown field/,
      );
    }
  });

  test("rejects unknown versions, unknown fields, and malformed required fields", () => {
    expect(() => decodeImproveResult({ schemaVersion: 3, ...common })).toThrow(/unsupported schemaVersion/);
    expect(() => decodeImproveResult({ schemaVersion: 2, strategy: "default", extra: true, ...common })).toThrow(
      /unknown field/,
    );
    expect(() => decodeImproveResult({ schemaVersion: 2, strategy: "", ...common })).toThrow(/non-empty/);
    expect(() =>
      decodeImproveResult({ schemaVersion: 2, strategy: "default", ...common, strategyFilteredRefs: {} }),
    ).toThrow(/strategyFilteredRefs/);
    const { memorySummary: _memorySummary, ...withoutSummary } = common;
    expect(() => decodeImproveResult({ schemaVersion: 2, strategy: "default", ...withoutSummary })).toThrow(
      /memorySummary/,
    );
    expect(() => decodeImproveResult("not json")).toThrow(/not valid JSON/);
  });

  test("decodes skippedProcesses (#957) and still decodes old envelopes without it", () => {
    const skippedProcesses = [
      {
        process: "reflect" as const,
        configKey: "improve.strategies.default.processes.reflect.engine",
        reason:
          'requires a credential that is not available in this process\'s environment (engine "default": $LAB_API_KEY is not set in this environment)',
      },
    ];
    const decoded = decodeImproveResult({
      schemaVersion: 2,
      strategy: "default",
      ...common,
      skippedProcesses,
    });
    expect(decoded.envelope.skippedProcesses).toEqual(skippedProcesses);

    // Old envelopes (persisted before #957) have no skippedProcesses field at all.
    const withoutIt = decodeImproveResult({ schemaVersion: 2, strategy: "default", ...common });
    expect(withoutIt.envelope.skippedProcesses).toBeUndefined();

    expect(() =>
      decodeImproveResult({ schemaVersion: 2, strategy: "default", ...common, skippedProcesses: {} }),
    ).toThrow(/skippedProcesses/);
  });

  test("decodes usageReport (#944) and still decodes old envelopes without it", () => {
    const usageReport = {
      byProcessEngineModel: [
        {
          process: "reflect",
          engine: "default",
          model: "gpt",
          calls: 3,
          failures: 1,
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
          reasoningTokens: 0,
          totalDurationMs: 900,
        },
      ],
      noCalls: [{ process: "consolidate", engine: "default", reason: "no_signal" }],
    };
    const decoded = decodeImproveResult({
      schemaVersion: 2,
      strategy: "default",
      ...common,
      usageReport,
    });
    expect(decoded.envelope.usageReport).toEqual(usageReport);

    // Runs recorded before #944 have no usageReport field at all.
    const withoutIt = decodeImproveResult({ schemaVersion: 2, strategy: "default", ...common });
    expect(withoutIt.envelope.usageReport).toBeUndefined();

    // The exact-field gate only shallow-validates usageReport is an object;
    // reject a wrong-typed value outright.
    expect(() =>
      decodeImproveResult({ schemaVersion: 2, strategy: "default", ...common, usageReport: "not an object" }),
    ).toThrow(/usageReport/);
  });

  test("accepts deadUrlCoverage with exact non-negative integer fields, rejects malformed ones (#892)", () => {
    const decoded = decodeImproveResult({
      schemaVersion: 2,
      strategy: "default",
      ...common,
      deadUrlCoverage: { checked: 3, total: 3, skipped: 0 },
    });
    expect(decoded.envelope.deadUrlCoverage).toEqual({ checked: 3, total: 3, skipped: 0 });

    expect(() =>
      decodeImproveResult({
        schemaVersion: 2,
        strategy: "default",
        ...common,
        deadUrlCoverage: { checked: 3, total: 3, skipped: 0, extra: 1 },
      }),
    ).toThrow(/unknown field/);
    expect(() =>
      decodeImproveResult({
        schemaVersion: 2,
        strategy: "default",
        ...common,
        deadUrlCoverage: { checked: -1, total: 3, skipped: 0 },
      }),
    ).toThrow(/deadUrlCoverage.checked/);
    expect(() =>
      decodeImproveResult({ schemaVersion: 2, strategy: "default", ...common, deadUrlCoverage: [] }),
    ).toThrow(/deadUrlCoverage must be an object/);
  });
});
