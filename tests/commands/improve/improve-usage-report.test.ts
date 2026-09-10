// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure, in-memory tests for #944's per-run usage report: the no-call reason
 * priority order, the routing x cross-tab merge, and the shared fixed-width
 * table formatter. No I/O — `ResolvedImprovePlan` and event fixtures are
 * built by hand.
 */

import { describe, expect, test } from "bun:test";
import type { LlmUsageCrossTabRow } from "../../../src/commands/health/types";
import type { ImproveProcessName, ResolvedImprovePlan } from "../../../src/commands/improve/improve-strategies";
import {
  buildImproveUsageReport,
  deriveNoCallReason,
  formatUsageReportTable,
} from "../../../src/commands/improve/improve-usage-report";
import { IMPROVE_PROCESS_ENGINE_CAPABILITIES } from "../../../src/core/config/engine-semantics";
import type { ImproveActionResult, ImproveEligibleRef } from "../../../src/core/improve-types";

const ALL_PROCESS_NAMES = Object.keys(IMPROVE_PROCESS_ENGINE_CAPABILITIES) as ImproveProcessName[];

function llmRunner(engine: string, model: string) {
  return { kind: "llm" as const, engine, connection: { endpoint: "https://x.test", model } };
}

/** Minimal ResolvedImprovePlan fixture. Every process defaults to disabled/no-runner; pass `overrides` to change specific ones. */
function buildPlan(args: {
  overrides?: Partial<Record<ImproveProcessName, { enabled: boolean; runner?: ReturnType<typeof llmRunner> | null }>>;
  autonomyGated?: ResolvedImprovePlan["autonomyGated"];
  engineUnavailable?: ResolvedImprovePlan["engineUnavailable"];
  allowedTypes?: Partial<Record<"reflect" | "distill" | "consolidate", string[]>>;
}): ResolvedImprovePlan {
  const processes: Record<string, { enabled: boolean; config: Record<string, never>; runner: unknown }> = {};
  for (const name of ALL_PROCESS_NAMES) {
    const override = args.overrides?.[name];
    processes[name] = {
      enabled: override?.enabled ?? false,
      config: {},
      runner: override?.runner ?? null,
    };
  }
  return {
    config: {},
    strategy: {
      name: "test",
      config: {
        processes: {
          reflect: { enabled: true, allowedTypes: args.allowedTypes?.reflect },
          distill: { enabled: true, allowedTypes: args.allowedTypes?.distill },
          consolidate: { enabled: true, allowedTypes: args.allowedTypes?.consolidate },
        },
      },
    },
    processes,
    triageJudgment: null,
    autonomyGated: args.autonomyGated ?? [],
    engineUnavailable: args.engineUnavailable ?? [],
  } as unknown as ResolvedImprovePlan;
}

function crossTabRow(
  overrides: Partial<LlmUsageCrossTabRow> & Pick<LlmUsageCrossTabRow, "process">,
): LlmUsageCrossTabRow {
  return {
    engine: "fast",
    model: "m1",
    calls: 0,
    failures: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
    totalDurationMs: 0,
    ...overrides,
  };
}

function eligibleRef(ref: string): ImproveEligibleRef {
  return { ref, reason: "scope-type" };
}

describe("deriveNoCallReason (#944, single decision point per #953/#957/#947/#944 batch review)", () => {
  test("engine_unavailable wins outright, even over an also-gated lane", () => {
    const reason = deriveNoCallReason({
      row: {
        process: "memoryInference",
        enabled: false,
        unavailable: { configKey: "improve.strategies.default.processes.memoryInference.engine", reason: "no engine" },
      },
      autonomyGated: [{ lane: "memoryInference", configKey: "experimental.improveAutonomy", reason: "writes memory" }],
      strategyFilteredRefsCount: 5,
      eligibleRefs: 0,
    });
    expect(reason).toBe("engine_unavailable");
  });

  test("autonomy_gated wins for a disabled, resolvable process whose lane was downgraded", () => {
    const reason = deriveNoCallReason({
      row: { process: "memoryInference", enabled: false, unavailable: undefined },
      autonomyGated: [{ lane: "memoryInference", configKey: "experimental.improveAutonomy", reason: "writes memory" }],
      strategyFilteredRefsCount: 5,
      eligibleRefs: 0,
    });
    expect(reason).toBe("autonomy_gated");
  });

  test("a disabled, resolvable process with no gated lane returns undefined — never fabricated", () => {
    const reason = deriveNoCallReason({
      row: { process: "extract", enabled: false, unavailable: undefined },
      autonomyGated: [],
      strategyFilteredRefsCount: 0,
    });
    expect(reason).toBeUndefined();
  });

  test("strategy_filtered_all_passes when the process has zero eligible refs and the strategy filtered some", () => {
    const reason = deriveNoCallReason({
      row: { process: "reflect", enabled: true, unavailable: undefined },
      autonomyGated: [],
      strategyFilteredRefsCount: 3,
      eligibleRefs: 0,
    });
    expect(reason).toBe("strategy_filtered_all_passes");
  });

  test("zero eligible refs but nothing strategy-filtered falls through to no_signal", () => {
    const reason = deriveNoCallReason({
      row: { process: "reflect", enabled: true, unavailable: undefined },
      autonomyGated: [],
      strategyFilteredRefsCount: 0,
      eligibleRefs: 0,
    });
    expect(reason).toBe("no_signal");
  });

  test("the dominant skip-reason count wins over no_signal", () => {
    const reason = deriveNoCallReason({
      row: { process: "reflect", enabled: true, unavailable: undefined },
      autonomyGated: [],
      strategyFilteredRefsCount: 0,
      eligibleRefs: 4,
      skipReasonCounts: { cooldown: 2, no_new_signal: 5 },
    });
    expect(reason).toBe("no_new_signal");
  });

  test("no signal at all falls back to no_signal — never a fabricated category like limit_reached", () => {
    const reason = deriveNoCallReason({
      row: { process: "consolidate", enabled: true, unavailable: undefined },
      autonomyGated: [],
      strategyFilteredRefsCount: 0,
    });
    expect(reason).toBe("no_signal");
  });
});

describe("buildImproveUsageReport (#944)", () => {
  test("a called process never appears in noCalls", () => {
    const plan = buildPlan({ overrides: { reflect: { enabled: true, runner: llmRunner("fast", "m1") } } });
    const report = buildImproveUsageReport({
      resolvedPlan: plan,
      byProcessEngineModel: [crossTabRow({ process: "reflect", calls: 3 })],
      strategyFilteredRefsCount: 0,
      loopRefs: [],
      persistedActions: [],
    });
    expect(report?.noCalls).toEqual([]);
    expect(report?.byProcessEngineModel).toHaveLength(1);
  });

  test("engine_unavailable reaches noCalls through the single deriveNoCallReason decision point", () => {
    const plan = buildPlan({
      overrides: { validation: { enabled: false, runner: null } },
      engineUnavailable: [
        {
          process: "validation",
          configKey: "improve.strategies.test.processes.validation.engine",
          reason: "no engine",
        },
      ],
    });
    const report = buildImproveUsageReport({
      resolvedPlan: plan,
      byProcessEngineModel: [],
      strategyFilteredRefsCount: 0,
      loopRefs: [],
      persistedActions: [],
    });
    expect(report?.noCalls).toEqual([{ process: "validation", reason: "engine_unavailable" }]);
  });

  test("an autonomy-gated disabled process (memoryInference) reports autonomy_gated", () => {
    const plan = buildPlan({
      overrides: { memoryInference: { enabled: false, runner: null } },
      autonomyGated: [{ lane: "memoryInference", configKey: "experimental.improveAutonomy", reason: "writes memory" }],
    });
    const report = buildImproveUsageReport({
      resolvedPlan: plan,
      byProcessEngineModel: [],
      strategyFilteredRefsCount: 0,
      loopRefs: [],
      persistedActions: [],
    });
    expect(report?.noCalls).toEqual([{ process: "memoryInference", reason: "autonomy_gated" }]);
  });

  test("a structurally disabled process with neither unavailable nor autonomy reason is silently omitted (never fabricated)", () => {
    const plan = buildPlan({ overrides: { extract: { enabled: false, runner: null } } });
    const report = buildImproveUsageReport({
      resolvedPlan: plan,
      byProcessEngineModel: [],
      strategyFilteredRefsCount: 0,
      loopRefs: [],
      persistedActions: [],
    });
    expect(report).toBeUndefined();
  });

  test("reflect's dominant skip reason is read off persisted reflect-skipped/reflect-cooldown actions", () => {
    const plan = buildPlan({
      overrides: { reflect: { enabled: true, runner: llmRunner("fast", "m1") } },
      allowedTypes: { reflect: ["agent"] },
    });
    // Cast: AgentFailureReason is a closed literal union that doesn't include
    // these skip-reason strings — the fixture only needs to satisfy
    // buildImproveUsageReport's runtime read of `.reason`, not the full
    // AkmReflectFailure type.
    const actions = [
      {
        ref: "agents/a",
        mode: "reflect-skipped",
        result: { schemaVersion: 2, ok: false, reason: "no_new_signal", error: "x", exitCode: 0 },
      },
      {
        ref: "agents/b",
        mode: "reflect-skipped",
        result: { schemaVersion: 2, ok: false, reason: "no_new_signal", error: "x", exitCode: 0 },
      },
      {
        ref: "agents/c",
        mode: "reflect-cooldown",
        result: { schemaVersion: 2, ok: false, reason: "cooldown", error: "x", exitCode: 0 },
      },
    ] as unknown as ImproveActionResult[];
    const report = buildImproveUsageReport({
      resolvedPlan: plan,
      byProcessEngineModel: [],
      strategyFilteredRefsCount: 0,
      loopRefs: [eligibleRef("agents/a")],
      persistedActions: actions,
    });
    expect(report?.noCalls).toEqual([{ process: "reflect", engine: "fast", reason: "no_new_signal" }]);
  });

  test("distill's dominant skip reason is read off distillSkipped.byReason", () => {
    const plan = buildPlan({
      overrides: { distill: { enabled: true, runner: llmRunner("fast", "m1") } },
      allowedTypes: { distill: ["memory"] },
    });
    const report = buildImproveUsageReport({
      resolvedPlan: plan,
      byProcessEngineModel: [],
      strategyFilteredRefsCount: 0,
      loopRefs: [eligibleRef("memories/a")],
      persistedActions: [],
      distillSkippedAggregate: { total: 4, byReason: { cooldown: 1, pool_delta: 3 }, samples: [] },
    });
    expect(report?.noCalls).toEqual([{ process: "distill", engine: "fast", reason: "pool_delta" }]);
  });

  test("triage (runner-kind) and proactiveMaintenance (no engine) are never reported, even when enabled and call-less", () => {
    const plan = buildPlan({
      overrides: {
        triage: { enabled: true, runner: null },
        proactiveMaintenance: { enabled: true, runner: null },
      },
    });
    const report = buildImproveUsageReport({
      resolvedPlan: plan,
      byProcessEngineModel: [],
      strategyFilteredRefsCount: 0,
      loopRefs: [],
      persistedActions: [],
    });
    expect(report).toBeUndefined();
  });

  test("strategy_filtered_all_passes: distill has zero eligible refs because every loop ref is a non-memory type", () => {
    const plan = buildPlan({
      overrides: { distill: { enabled: true, runner: llmRunner("fast", "m1") } },
      allowedTypes: { distill: ["memory"] },
    });
    const report = buildImproveUsageReport({
      resolvedPlan: plan,
      byProcessEngineModel: [],
      strategyFilteredRefsCount: 2,
      loopRefs: [eligibleRef("skills/a")],
      persistedActions: [],
    });
    expect(report?.noCalls).toEqual([{ process: "distill", engine: "fast", reason: "strategy_filtered_all_passes" }]);
  });
});

describe("formatUsageReportTable (#944)", () => {
  test("renders a fixed-width table for both sections plus notes", () => {
    const text = formatUsageReportTable(
      {
        byProcessEngineModel: [
          crossTabRow({ process: "reflect", engine: "fast", model: "m1", calls: 12, failures: 1, promptTokens: 100 }),
        ],
        noCalls: [{ process: "consolidate", engine: "fast", reason: "no_signal" }],
      },
      ["a note"],
    );
    expect(text).toContain("reflect");
    expect(text).toContain("fast");
    expect(text).toContain("12");
    expect(text).toContain("consolidate");
    expect(text).toContain("no_signal");
    expect(text).toContain("note: a note");
  });

  test("an empty cross-tab still renders a readable message instead of an empty table", () => {
    const text = formatUsageReportTable({ byProcessEngineModel: [], noCalls: [] });
    expect(text).toContain("no LLM calls recorded");
  });
});
