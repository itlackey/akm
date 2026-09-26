// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { expect, test } from "bun:test";
import { akmImprove } from "../../../src/commands/improve/improve";
import type { AkmConfig } from "../../../src/core/config/config";
import { decodeImproveResult } from "../../../src/core/improve-result";
import type { LoweringNotice } from "../../../src/execution/resolved-request";
import { renderGenericText } from "../../../src/output/generic-render";
import { makeStashDir, withEnv } from "../../_helpers/sandbox";

const notice: Readonly<LoweringNotice> = Object.freeze({
  code: "untranslated-field",
  severity: "warning",
  adapter: "test-agent",
  field: "outputSchema",
  message: "The test adapter cannot translate outputSchema; dispatch continued optimistically.",
});

test("improve dedupes safe lowering notices through JSON and text output", async () => {
  const stash = makeStashDir();
  const secret = "IMPROVE-NOTICE-SECRET";
  try {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      bundles: { stash: { path: stash.dir, writable: true } },
      defaultBundle: "stash",
      defaults: { improveStrategy: "notices" },
      improve: {
        strategies: {
          notices: {
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
      engines: {
        dormant: {
          kind: "llm",
          endpoint: "https://example.test/v1/chat/completions",
          model: "unused",
          apiKey: "$IMPROVE_NOTICE_API_KEY",
        },
      },
    };

    const result = await withEnv({ IMPROVE_NOTICE_API_KEY: secret }, () =>
      akmImprove({
        config,
        stashDir: stash.dir,
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
          actions: [
            {
              ref: "memories/example",
              mode: "reflect-failed",
              result: {
                schemaVersion: 2,
                ok: false,
                reason: "parse_error",
                error: "safe failure",
                exitCode: null,
                notices: [notice],
              },
            },
          ],
          cleanupWarnings: [],
          validationFailures: [],
          schemaRepairs: [
            {
              ref: "memories/example",
              reason: "missing description",
              outcome: "skipped",
              notices: [notice],
            },
          ],
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
            notices: [notice],
          },
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
      }),
    );

    expect(result.notices).toEqual([notice]);
    const json = JSON.stringify(result);
    const text = renderGenericText("improve", result);
    expect(decodeImproveResult(json).envelope.notices).toEqual([notice]);
    expect(json).toContain('"code":"untranslated-field"');
    expect(text).toContain("untranslated-field");
    expect(json).not.toContain(secret);
    expect(text).not.toContain(secret);
  } finally {
    stash.cleanup();
  }
});

test("dry-run preserves the same plan-owned lowering notices as live output without dispatch", async () => {
  const stash = makeStashDir();
  const secret = "IMPROVE-PLAN-NOTICE-SECRET";
  let preparationCalls = 0;
  try {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      bundles: { stash: { path: stash.dir, writable: true } },
      defaultBundle: "stash",
      defaults: { improveStrategy: "plan-notices", llmEngine: "planner" },
      improve: {
        strategies: {
          "plan-notices": {
            processes: {
              reflect: {
                enabled: true,
                llm: { unsupportedPlannerField: true } as never,
              },
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
      engines: {
        planner: {
          kind: "llm",
          endpoint: "https://example.test/v1/chat/completions",
          model: "unused",
          apiKey: "$IMPROVE_PLAN_NOTICE_API_KEY",
        },
      },
    };
    const common = {
      config,
      stashDir: stash.dir,
      ensureIndexFn: async () => undefined,
      collectEligibleRefsFn: (async () => ({
        plannedRefs: [],
        memorySummary: { eligible: 0, derived: 0 },
        strategyFilteredRefs: [],
      })) as never,
      runImprovePreparationStageFn: (async () => {
        preparationCalls += 1;
        return {
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
        };
      }) as never,
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

    const [dry, live] = await withEnv({ IMPROVE_PLAN_NOTICE_API_KEY: secret }, async () => {
      const dryResult = await akmImprove({ ...common, dryRun: true });
      const liveResult = await akmImprove(common);
      return [dryResult, liveResult] as const;
    });

    expect(preparationCalls).toBe(2);
    expect(dry.notices).toEqual(live.notices);
    expect(dry.notices).toEqual([
      expect.objectContaining({
        code: "untranslated-field",
        adapter: "llm",
        field: "inference.unsupportedPlannerField",
      }),
    ]);
    expect(JSON.stringify(dry)).not.toContain(secret);
  } finally {
    stash.cleanup();
  }
});
