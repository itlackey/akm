// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmImprove } from "../../../../src/commands/improve/improve";
import { resolveImprovePlan } from "../../../../src/commands/improve/improve-strategies";
import { runImproveLoopStage, runImproveMaintenancePasses } from "../../../../src/commands/improve/loop-stages";
import { runImprovePreparationStage, runValidationAndRepairPass } from "../../../../src/commands/improve/preparation";
import { createRunContext } from "../../../../src/commands/improve/run-context";
import type { AkmConfig, ImproveProfileConfig } from "../../../../src/core/config/config";
import { makeStashDir } from "../../../_helpers/sandbox";

const llm = (model: string) => ({
  kind: "llm" as const,
  endpoint: "https://example.test/v1/chat/completions",
  model,
});

function disabledProcesses(overrides: Record<string, unknown> = {}): ImproveProfileConfig["processes"] {
  return {
    reflect: { enabled: false },
    distill: { enabled: false },
    consolidate: { enabled: false },
    memoryInference: { enabled: false },
    graphExtraction: { enabled: false },
    extract: { enabled: false },
    validation: { enabled: false },
    triage: { enabled: false },
    proactiveMaintenance: { enabled: false },
    recombine: { enabled: false },
    procedural: { enabled: false },
    ...overrides,
  } as ImproveProfileConfig["processes"];
}

describe("improve engine-plan boundaries", () => {
  test("a missing fallback fails before index or stash side effects", async () => {
    const ensureIndexFn = mock(async () => undefined);
    await expect(
      akmImprove({
        strategy: "quick",
        config: {
          configVersion: "0.9.0",
          semanticSearchMode: "off",
        },
        ensureIndexFn,
      }),
    ).rejects.toThrow('Enabled improve process "reflect" requires an LLM engine.');
    expect(ensureIndexFn).not.toHaveBeenCalled();
  });

  test("structural validation still runs when validation repair is disabled", async () => {
    const stash = makeStashDir();
    try {
      const lessonDir = path.join(stash.dir, "lessons");
      fs.mkdirSync(lessonDir, { recursive: true });
      const filePath = path.join(lessonDir, "broken.md");
      fs.writeFileSync(filePath, "---\nwhen_to_use: Testing\n---\n\nBody.\n");
      const config: AkmConfig = {
        configVersion: "0.9.0",
        stashDir: stash.dir,
        semanticSearchMode: "off",
        sources: [{ type: "filesystem", name: "stash", path: stash.dir, writable: true }],
        defaults: { improveStrategy: "structural" },
        improve: { strategies: { structural: { processes: disabledProcesses() } } },
      };
      const resolvedPlan = resolveImprovePlan("structural", config, { repairValidationFailures: false });
      const result = await runImprovePreparationStage({
        scope: { mode: "all" },
        options: { config, stashDir: stash.dir, repairValidationFailures: false },
        plannedRefs: [{ ref: "lessons/broken", reason: "scope-type", filePath }],
        primaryStashDir: stash.dir,
        memorySummary: { eligible: 0, derived: 0 },
        reindexFn: async () => undefined,
        startMs: Date.now(),
        budgetMs: 60_000,
        improveProfile: resolvedPlan.strategy.config,
        resolvedPlan,
        strategyName: "structural",
      });
      expect(result.validationFailures).toEqual([{ ref: "lessons/broken", reason: "missing description" }]);
      expect(result.schemaRepairs).toEqual([]);
      expect(result.actionableRefs).toEqual([]);
    } finally {
      stash.cleanup();
    }
  });

  test("a queued schema repair remains a live structural validation failure", async () => {
    const stash = makeStashDir();
    try {
      const filePath = path.join(stash.dir, "lessons", "queued.md");
      const original = "---\nwhen_to_use: Testing queued repair\n---\n\nBody.\n";
      fs.writeFileSync(filePath, original);
      const config: AkmConfig = {
        configVersion: "0.9.0",
        stashDir: stash.dir,
        semanticSearchMode: "off",
        engines: { repair: llm("repair-model") },
        defaults: { llmEngine: "repair" },
        improve: {
          strategies: {
            repair: { processes: disabledProcesses({ validation: { enabled: true, engine: "repair" } }) },
          },
        },
      };
      const resolvedPlan = resolveImprovePlan("repair", config);
      const result = await runValidationAndRepairPass({
        postCleanupRefs: [{ ref: "lessons/queued", reason: "scope-type", filePath }],
        options: { config, stashDir: stash.dir },
        startMs: Date.now(),
        budgetMs: 60_000,
        primaryStashDir: stash.dir,
        resolvedPlan,
        repairValidationFailures: true,
        schemaRepairFn: async () => ({
          repairs: [
            {
              ref: "lessons/queued",
              reason: "missing description",
              outcome: "queued",
              proposalId: "proposal-1",
            },
          ],
          repairedRefs: new Set(["lessons/queued"]),
        }),
      });

      expect(result.schemaRepairs[0]?.outcome).toBe("queued");
      expect(result.validationFailureRefs).toEqual(new Set(["lessons/queued"]));
      expect(fs.readFileSync(filePath, "utf8")).toBe(original);
    } finally {
      stash.cleanup();
    }
  });

  test("nested contradiction detection receives the resolved selected strategy and connection", async () => {
    const stash = makeStashDir();
    try {
      const config: AkmConfig = {
        configVersion: "0.9.0",
        stashDir: stash.dir,
        semanticSearchMode: "off",
        sources: [{ type: "filesystem", name: "stash", path: stash.dir, writable: true }],
        engines: { consolidate: llm("contradiction-model") },
        improve: {
          strategies: {
            contradictions: {
              processes: disabledProcesses({
                consolidate: {
                  enabled: true,
                  engine: "consolidate",
                  contradictionDetection: { enabled: true },
                },
              }),
            },
          },
        },
      };
      let seenStrategy: ImproveProfileConfig | undefined;
      let seenModel: string | undefined;

      await expect(
        akmImprove({
          strategy: "contradictions",
          config,
          stashDir: stash.dir,
          ensureIndexFn: async () => undefined,
          collectEligibleRefsFn: (async () => ({
            plannedRefs: [],
            memorySummary: { eligible: 1, derived: 1 },
            strategyFilteredRefs: [],
          })) as never,
          contradictionDetectionFn: async (_stashDir, _config, _chat, strategy, llmConfig) => {
            seenStrategy = strategy;
            seenModel = llmConfig?.model;
            return { familiesExamined: 0, pairsChecked: 0, edgesWritten: 0, warnings: [] };
          },
          runImprovePreparationStageFn: (async () => {
            throw new Error("stop after contradiction boundary");
          }) as never,
        }),
      ).rejects.toThrow("stop after contradiction boundary");

      expect(seenStrategy?.processes?.consolidate?.contradictionDetection?.enabled).toBe(true);
      expect(seenModel).toBe("contradiction-model");
    } finally {
      stash.cleanup();
    }
  });

  test("reflect and distill keep the resolved process connections when live config changes", async () => {
    const stash = makeStashDir();
    try {
      const memoryDir = path.join(stash.dir, "memories");
      fs.mkdirSync(memoryDir, { recursive: true });
      fs.writeFileSync(path.join(memoryDir, "source.md"), "---\ntype: memory\n---\n\nSource.\n");
      const config: AkmConfig = {
        configVersion: "0.9.0",
        stashDir: stash.dir,
        semanticSearchMode: "off",
        sources: [{ type: "filesystem", name: "stash", path: stash.dir, writable: true }],
        engines: { reflect: llm("reflect-model"), distill: llm("distill-model") },
        improve: {
          strategies: {
            split: {
              processes: disabledProcesses({
                reflect: { enabled: true, engine: "reflect", allowedTypes: ["memory"] },
                distill: { enabled: true, engine: "distill", allowedTypes: ["memory"] },
              }),
            },
          },
        },
      };
      const plan = resolveImprovePlan("split", config, { repairValidationFailures: false });
      const reflectEngine = config.engines?.reflect;
      const distillEngine = config.engines?.distill;
      if (reflectEngine?.kind === "llm") reflectEngine.model = "changed-reflect-model";
      if (distillEngine?.kind === "llm") distillEngine.model = "changed-distill-model";
      const liveProcesses = config.improve?.strategies?.split?.processes;
      if (liveProcesses?.reflect) liveProcesses.reflect.engine = "distill";
      if (liveProcesses?.distill) liveProcesses.distill.engine = "reflect";
      let reflectOptions: Record<string, unknown> | undefined;
      let distillOptions: Record<string, unknown> | undefined;
      await runImproveLoopStage({
        ctx: createRunContext({
          stashDir: stash.dir,
          config,
          eventsCtx: {},
          proposalsCtx: {},
          getLlmConfig: () => null,
          sourceRun: "test-run",
          dryRun: false,
        }),
        primaryStashDir: stash.dir,
        scope: { mode: "ref", value: "memories/source" },
        options: { config, stashDir: stash.dir },
        reflectFn: async (options) => {
          reflectOptions = options as unknown as Record<string, unknown>;
          return {
            schemaVersion: 2,
            ok: false,
            reason: "no_change",
            error: "stable",
            ref: "memories/source",
            engine: "reflect",
            exitCode: null,
          };
        },
        distillFn: async (options) => {
          distillOptions = options as unknown as Record<string, unknown>;
          return {
            schemaVersion: 1,
            ok: true,
            outcome: "skipped",
            inputRef: options.ref,
            lessonRef: "lessons/source-lesson",
          };
        },
        loopRefs: [{ ref: "memories/source", reason: "scope-ref" }],
        actions: [],
        signalBearingSet: new Set(),
        distillCooledRefs: new Set(),
        distillOnlyRefs: [],
        recentErrors: {},
        rejectedProposalsByRef: new Map(),
        utilityMap: new Map(),
        startMs: Date.now(),
        budgetMs: 60_000,
        improveProfile: plan.strategy.config,
        resolvedPlan: plan,
      });
      expect((reflectOptions?.runner as { connection?: { model?: string } }).connection?.model).toBe("reflect-model");
      expect(reflectOptions?.llmConfig).toBeUndefined();
      expect(reflectOptions?.config).toBe(config);
      expect((distillOptions?.llmConfig as { model?: string }).model).toBe("distill-model");
      expect(distillOptions?.config).toBe(config);
    } finally {
      stash.cleanup();
    }
  });

  test("improve graph extraction passes process-owned includeTypes, batchSize, and topN", async () => {
    const stash = makeStashDir();
    try {
      const config: AkmConfig = {
        configVersion: "0.9.0",
        stashDir: stash.dir,
        semanticSearchMode: "off",
        sources: [{ type: "filesystem", name: "stash", path: stash.dir, writable: true }],
        engines: { graph: llm("graph-model") },
        index: {
          graph: { graphExtractionIncludeTypes: ["knowledge"], graphExtractionBatchSize: 99 },
        },
        improve: {
          strategies: {
            graph: {
              processes: disabledProcesses({
                graphExtraction: {
                  enabled: true,
                  engine: "graph",
                  fullScan: true,
                  includeTypes: ["memory"],
                  batchSize: 2,
                  topN: 7,
                },
              }),
            },
          },
        },
      };
      const plan = resolveImprovePlan("graph", config, { repairValidationFailures: false });
      let seenOptions: Record<string, unknown> | undefined;
      await runImproveMaintenancePasses({
        options: {
          config,
          stashDir: stash.dir,
          graphExtractionFn: async (ctx) => {
            seenOptions = ctx.options as unknown as Record<string, unknown>;
            return {
              considered: 0,
              extracted: 0,
              totalEntities: 0,
              totalRelations: 0,
              written: false,
              quality: {
                consideredFiles: 0,
                extractedFiles: 0,
                entityCount: 0,
                relationCount: 0,
                extractionCoverage: 0,
                density: 0,
              },
            };
          },
        },
        primaryStashDir: stash.dir,
        actionableRefs: [],
        memoryRefsForInference: new Set(),
        allWarnings: [],
        reindexFn: async () => undefined,
        improveProfile: plan.strategy.config,
        resolvedPlan: plan,
      });
      expect(seenOptions).toMatchObject({ includeTypes: ["memory"], batchSize: 2, topN: 7 });
    } finally {
      stash.cleanup();
    }
  });

  test("post-loop maintenance is a no-op when the run budget is already exhausted", async () => {
    const stash = makeStashDir();
    try {
      const config: AkmConfig = {
        configVersion: "0.9.0",
        stashDir: stash.dir,
        semanticSearchMode: "off",
        sources: [{ type: "filesystem", name: "stash", path: stash.dir, writable: true }],
        defaults: { improveStrategy: "disabled" },
        improve: { strategies: { disabled: { processes: disabledProcesses() } } },
      };
      const plan = resolveImprovePlan("disabled", config, { repairValidationFailures: false });
      const controller = new AbortController();
      controller.abort("improve budget exhausted");

      const result = await runImproveMaintenancePasses({
        options: { config, stashDir: stash.dir },
        primaryStashDir: stash.dir,
        actionableRefs: [],
        memoryRefsForInference: new Set(),
        allWarnings: [],
        reindexFn: async () => undefined,
        budgetSignal: controller.signal,
        improveProfile: plan.strategy.config,
        resolvedPlan: plan,
      });

      expect(result).toEqual({ memoryInferenceDurationMs: 0, graphExtractionDurationMs: 0 });
    } finally {
      stash.cleanup();
    }
  });
});
