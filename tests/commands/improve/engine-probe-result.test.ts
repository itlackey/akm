// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * R17 (second half) — `--require-engines`'s reachability probe used to only
 * ever report a FAILURE (abort, exit 78); a passing probe left no trace, so
 * a slow or flapping gateway was invisible in the improve result. The CLI
 * now records per-target outcomes and threads them through
 * `AkmImproveOptions.engineProbe`, which the live-run assembler
 * (`finalizeImproveResult`) copies verbatim onto `AkmImproveResult.engineProbe`.
 *
 * These tests drive the real `akmImprove` with every heavy stage stubbed
 * (same seam pattern as improve-lowering-notices.test.ts) so only the
 * option -> result threading and the persisted-envelope decode are under
 * test. The CLI-level probe computation itself (dedup, latency, per-target
 * rows) is unit-tested in require-engines-cli.test.ts.
 */

import { expect, test } from "bun:test";
import { akmImprove } from "../../../src/commands/improve/improve";
import type { EngineProbeOutcome } from "../../../src/commands/improve/improve-strategies";
import type { AkmConfig } from "../../../src/core/config/config";
import { decodeImproveResult } from "../../../src/core/improve-result";
import { makeStashDir } from "../../_helpers/sandbox";

function noopStageSeams(config: AkmConfig, stashDir: string) {
  return {
    config,
    stashDir,
    ensureIndexFn: async () => undefined,
    collectEligibleRefsFn: (async () => ({
      plannedRefs: [],
      memorySummary: { eligible: 0, derived: 0 },
      strategyFilteredRefs: [],
    })) as never,
    runImprovePreparationStageFn: (async () => ({
      actionableRefs: [],
      loopRefs: [],
      distillOnlyRefs: [],
      distillCooledRefs: new Set(),
      signalBearingSet: new Set(),
      utilityMap: new Map(),
      actions: [],
      cleanupWarnings: [],
      validationFailures: [],
      schemaRepairs: [],
      coverageGaps: [],
      recentErrors: {},
      consolidation: {
        schemaVersion: 1,
        ok: true,
        shape: "consolidate-result",
        dryRun: false,
        previewOnly: false,
        target: "memory",
        processed: 0,
        merged: 0,
        deleted: 0,
        promoted: [],
        contradicted: 0,
        warnings: [],
        durationMs: 0,
      },
      consolidationRan: false,
    })) as never,
    runImproveLoopStageFn: (async () => ({
      reflectsWithErrorContext: 0,
      memoryRefsForInference: new Set(),
    })) as never,
    runImprovePostLoopStageFn: (async () => ({
      allWarnings: [],
      memoryInferenceDurationMs: 0,
      graphExtractionDurationMs: 0,
    })) as never,
  };
}

function cheapConfig(): AkmConfig {
  return {
    configVersion: "0.9.0",
    semanticSearchMode: "off",
    defaults: { improveStrategy: "probe-test" },
    improve: {
      strategies: {
        "probe-test": {
          processes: {
            reflect: { enabled: false },
            distill: { enabled: false },
            consolidate: { enabled: false },
            memoryInference: { enabled: false },
            graphExtraction: { enabled: false },
            extract: { enabled: false },
            validation: { enabled: false },
            triage: { enabled: false },
            proactiveMaintenance: { enabled: false },
          },
        },
      },
    },
  } as unknown as AkmConfig;
}

test("akmImprove copies options.engineProbe onto the live result, and it round-trips through decodeImproveResult", async () => {
  const stash = makeStashDir();
  try {
    const engineProbe: EngineProbeOutcome[] = [
      { process: "reflect", engine: "engineA", endpoint: "https://a.example.test/v1", reachable: true, latencyMs: 42 },
      { process: "distill", engine: "engineB", endpoint: "https://b.example.test/v1", reachable: true, latencyMs: 7 },
    ];

    const result = await akmImprove({
      ...noopStageSeams(cheapConfig(), stash.dir),
      engineProbe,
    });

    expect(result.ok).toBe(true);
    expect(result.engineProbe).toEqual(engineProbe);

    const decoded = decodeImproveResult(JSON.stringify(result));
    expect(decoded.envelope.engineProbe).toEqual(engineProbe);
  } finally {
    stash.cleanup();
  }
});

test("engineProbe is absent from the result when --require-engines was not set", async () => {
  const stash = makeStashDir();
  try {
    const result = await akmImprove(noopStageSeams(cheapConfig(), stash.dir));

    expect(result.ok).toBe(true);
    expect("engineProbe" in result).toBe(false);

    const decoded = decodeImproveResult(JSON.stringify(result));
    expect("engineProbe" in decoded.envelope).toBe(false);
  } finally {
    stash.cleanup();
  }
});

test("a legacy persisted envelope with no engineProbe field still decodes", () => {
  const legacy = {
    schemaVersion: 2,
    ok: true,
    strategy: "probe-test",
    scope: { mode: "all" },
    dryRun: false,
    memorySummary: { eligible: 0, derived: 0 },
    plannedRefs: [],
    actions: [],
  };

  const decoded = decodeImproveResult(JSON.stringify(legacy));
  expect("engineProbe" in decoded.envelope).toBe(false);
});
