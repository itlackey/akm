// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { renderRunsDetailMd, renderWindowCompareMd } from "../src/commands/health/md-report";
import type { DeltaEntry, ImproveHealthMetrics, ImproveRunSummary, WindowResult } from "../src/commands/health/types";
import { summarizeCalibration } from "../src/commands/improve/calibration";

/** A fully-zeroed ImproveHealthMetrics sufficient for the MD renderers. */
function zeroImprove(): ImproveHealthMetrics {
  return {
    invoked: 0,
    completed: 0,
    skipped: 0,
    skipReasons: {},
    plannedRefs: 0,
    strategyFilteredRefs: 0,
    actions: {
      reflect: { ok: 0, failed: 0, cooldown: 0, skipped: 0, guardRejected: 0, skippedByReason: {} },
      distill: {
        queued: 0,
        llmFailed: 0,
        qualityRejected: 0,
        judgeRejected: 0,
        validatorRejected: 0,
        configDisabled: 0,
        skipped: 0,
        skippedByReason: {},
        deferred: 0,
        deferredByReason: {},
      },
      memoryPrune: 0,
      memoryInference: 0,
      graphExtraction: 0,
      error: 0,
    },
    autoAccept: { promoted: 0, validationFailed: 0 },
    calibration: summarizeCalibration([]),
    reflectsWithErrorContext: 0,
    coverageGapCount: 0,
    evalCasesWritten: 0,
    deadUrlCount: 0,
    memorySummary: { eligible: 0, derived: 0 },
    memoryCleanup: {
      pruneCandidates: 0,
      contradictionCandidates: 0,
      beliefStateTransitions: 0,
      consolidationCandidates: 0,
      archived: 0,
      warnings: 0,
    },
    consolidation: {
      ran: false,
      processed: 0,
      promoted: 0,
      merged: 0,
      deleted: 0,
      contradicted: 0,
      judgedNoAction: 0,
      mergedSecondaries: 0,
      failedChunkMemories: 0,
      skipReasons: {},
      failedChunks: 0,
      totalChunks: 0,
      durationMs: 0,
    },
    memoryInference: {
      ran: false,
      considered: 0,
      cacheHits: 0,
      retryAttempts: 0,
      freshAttempts: 0,
      splitParents: 0,
      written: 0,
      skippedNoFacts: 0,
      skippedChildExists: 0,
      skippedAborted: 0,
      unaccounted: 0,
      htmlErrorCount: 0,
      yieldEligibleRuns: 0,
      yieldEligibleConsidered: 0,
      yieldEligibleWritten: 0,
      yieldRate: 0,
      durationMs: 0,
      writes: 0,
    },
    graphExtraction: {
      ran: false,
      extractedFiles: 0,
      entities: 0,
      relations: 0,
      cacheHits: 0,
      cacheMisses: 0,
      cacheHitRate: 0,
      truncations: 0,
      failures: 0,
      htmlErrors: 0,
      retryAttempts: 0,
      nonArrayBatchFailures: 0,
      durationMs: 0,
    },
    sessionExtraction: {
      ran: false,
      sessionsScanned: 0,
      sessionsExtracted: 0,
      sessionsSkipped: 0,
      proposalsCreated: 0,
      warnings: 0,
      durationMs: 0,
    },
    wallTime: {
      count: 0,
      medianMs: 0,
      p95Ms: 0,
      minMs: 0,
      maxMs: 0,
      byPhase: {
        consolidation: { count: 0, totalMs: 0, medianMs: 0, p95Ms: 0 },
        memoryInference: { count: 0, totalMs: 0, medianMs: 0, p95Ms: 0 },
        graphExtraction: { count: 0, totalMs: 0, medianMs: 0, p95Ms: 0 },
      },
    },
    perfTelemetry: {
      dedupPoolSize: 0,
      llmPoolSize: 0,
      judgedCacheSkipped: 0,
      embedMs: 0,
      embedCacheHits: 0,
      embedCacheMisses: 0,
      overBudgetRuns: 0,
      runsWithTelemetry: 0,
    },
    coverage: {
      rate: Number.NaN,
      eligibleFraction: Number.NaN,
      acceptedProposals: 0,
      distinctRefs: 0,
      churnRatio: Number.NaN,
      totalAssets: 0,
    },
  };
}

function makeRun(overrides: Partial<ImproveRunSummary> = {}): ImproveRunSummary {
  const base = zeroImprove();
  return {
    id: "run-1",
    startedAt: "2026-07-03T00:00:00.000Z",
    completedAt: "2026-07-03T00:05:00.000Z",
    wallTimeMs: 300_000,
    ok: true,
    strategy: "default",
    legacyProfile: null,
    scope: { mode: "all" },
    taskId: "manual",
    actions: base.actions,
    memorySummary: base.memorySummary,
    memoryCleanup: base.memoryCleanup,
    consolidation: base.consolidation,
    memoryInference: base.memoryInference,
    graphExtraction: base.graphExtraction,
    reflectsWithErrorContext: 0,
    evalCasesWritten: 0,
    orphansPurged: 0,
    lintFixed: 0,
    lintFlagged: 0,
    ...overrides,
  };
}

describe("renderRunsDetailMd", () => {
  test("keeps ok boolean and exposes decoder status in a separate column", () => {
    const out = renderRunsDetailMd([makeRun({ ok: false, resultStatus: "normalized" })]);
    const [header, row] = out.split("\n");
    const headers = header.trim().split(/\s{2,}/);
    const cells = row.trim().split(/\s{2,}/);

    expect(headers).toEqual([
      "ts",
      "ok",
      "strategy",
      "legacy_profile",
      "actions",
      "refl_ok/fail/cd/skip",
      "distill_q/llm-fail/qrej/cfg/skip",
      "cons_proc/promo/merge/del",
      "mem_cons/written/skip",
      "graph_f/e/r",
      "orphans",
      "lint_f/fl",
      "result_status",
    ]);
    expect(cells[1]).toBe("false");
    expect(cells[2]).toBe("default");
    expect(cells.at(-1)).toBe("normalized");
    expect(row).not.toContain("false (normalized)");
  });

  test("renders the header row and one aligned data row", () => {
    const run = makeRun({
      startedAt: "2026-07-03T00:00:00.000Z",
      ok: true,
      actions: {
        reflect: { ok: 2, failed: 1, cooldown: 0, skipped: 3, guardRejected: 0, skippedByReason: {} },
        distill: {
          queued: 4,
          llmFailed: 0,
          qualityRejected: 1,
          judgeRejected: 0,
          validatorRejected: 0,
          configDisabled: 0,
          skipped: 2,
          skippedByReason: {},
          deferred: 0,
          deferredByReason: {},
        },
        memoryPrune: 1,
        memoryInference: 1,
        graphExtraction: 1,
        error: 0,
      },
      consolidation: { ...zeroImprove().consolidation, processed: 5, promoted: 2, merged: 1, deleted: 0 },
      memoryInference: { ...zeroImprove().memoryInference, considered: 7, written: 3, skippedNoFacts: 4 },
      graphExtraction: { ...zeroImprove().graphExtraction, extractedFiles: 2, entities: 10, relations: 6 },
      orphansPurged: 1,
      lintFixed: 2,
      lintFlagged: 0,
    });
    const out = renderRunsDetailMd([run]);
    const lines = out.split("\n");
    expect(lines[0]).toContain("ts");
    expect(lines[0]).toContain("lint_f/fl");
    // actions total = 2+1+0+3 + 4+0+1+0+2 + 1+1+1+0 = 16
    const data = lines[1];
    expect(data).toContain("2026-07-03T00:00:00.000Z");
    expect(data).toContain("2/1/0/3"); // reflect
    expect(data).toContain("4/0/1/0/2"); // distill
    expect(data).toContain("5/2/1/0"); // consolidation
    expect(data).toContain("7/3/4"); // mem inference
    expect(data).toContain("2/10/6"); // graph
    // padded columns keep the header/data aligned to equal visual width
    expect(lines[0].length).toBe(lines[1].length);
  });

  test("empty runs -> header only", () => {
    const out = renderRunsDetailMd([]);
    expect(out.split("\n")).toHaveLength(1);
  });
});

describe("renderWindowCompareMd", () => {
  test("empty windows -> empty string", () => {
    expect(renderWindowCompareMd([], undefined)).toBe("");
  });

  test("marks bad-direction positive deltas with a `!` prefix", () => {
    const mkWindow = (name: string, reflectFailed: number): WindowResult => {
      const improve = zeroImprove();
      improve.actions.reflect.failed = reflectFailed;
      return {
        name,
        since: "2026-07-01T00:00:00.000Z",
        until: "2026-07-02T00:00:00.000Z",
        runs: 1,
        improve,
        metrics: {
          taskFailRate: 0,
          agentFailureRate: 0,
          stuckActiveRuns: 0,
          logBackingRate: 1,
          probeRoundTripMs: null,
          llmUsage: {
            calls: 0,
            totalDurationMs: 0,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            reasoningTokens: 0,
            byStage: {},
            byProcess: {},
            byEngine: {},
          },
        },
      };
    };
    const windows = [mkWindow("prev", 1), mkWindow("cur", 3)];
    const deltas: Record<string, DeltaEntry> = {
      "improve.actions.reflect.failed": { from: 1, to: 3, pctChange: 200 },
    };
    const out = renderWindowCompareMd(windows, deltas);
    const failedRow = out.split("\n").find((l) => l.startsWith("improve.actions.reflect.failed"));
    expect(failedRow).toBeDefined();
    expect(failedRow).toContain("!+200%");
  });

  test("renders result-row accounting without changing the runs denominator", () => {
    const improve = zeroImprove();
    improve.resultRows = { total: 5, included: 3, normalized: 1, skipped: { invalid: 2 } };
    const window: WindowResult = {
      name: "current",
      since: "2026-07-01T00:00:00.000Z",
      until: "2026-07-02T00:00:00.000Z",
      runs: 5,
      improve,
      metrics: {
        taskFailRate: 0,
        agentFailureRate: 0,
        stuckActiveRuns: 0,
        logBackingRate: 1,
        probeRoundTripMs: null,
        llmUsage: {
          calls: 0,
          totalDurationMs: 0,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          reasoningTokens: 0,
          byStage: {},
          byProcess: {},
          byEngine: {},
        },
      },
    };

    const out = renderWindowCompareMd([window], undefined);
    expect(out).toContain("runs");
    expect(out).toContain("improve.resultRows.included");
    expect(out).toContain("improve.resultRows.normalized");
    expect(out).toContain("improve.resultRows.skipped.invalid");
  });
});
