// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { configuredDirectAutonomyLanes } from "../../../src/commands/improve/autonomy-gate";
import { akmImprove } from "../../../src/commands/improve/improve";
import { resolveImprovePlan } from "../../../src/commands/improve/improve-strategies";
import { runImproveLoopStage, runImproveMaintenancePasses } from "../../../src/commands/improve/loop-stages";
import { runImprovePreparationStage, runValidationAndRepairPass } from "../../../src/commands/improve/preparation";
import { akmReflect } from "../../../src/commands/improve/reflect";
import type { AkmConfig, ImproveProfileConfig } from "../../../src/core/config/config";
import { makeStashDir, withMockedFetch } from "../../_helpers/sandbox";

const lab = (model: string) => ({
  endpoint: "https://example.test/v1/chat/completions",
  models: { fast: model },
});

function disabledProcesses(overrides: Record<string, unknown> = {}): ImproveProfileConfig["processes"] {
  return {
    reflect: { enabled: false },
    distill: { enabled: false },
    consolidate: { enabled: false },
    memoryInference: { enabled: false },
    extract: { enabled: false },
    validation: { enabled: false },
    triage: { enabled: false },
    proactiveMaintenance: { enabled: false },
    recombine: { enabled: false },
    procedural: { enabled: false },
    ...overrides,
  } as ImproveProfileConfig["processes"];
}

describe("improve plan boundaries", () => {
  test("a missing fallback fails before index or stash side effects", async () => {
    const ensureIndexFn = mock(async () => undefined);
    await expect(
      akmImprove({
        strategy: "default",
        config: {
          configVersion: "0.9.0",
          semanticSearchMode: "off",
          // Deterministic triage (the default's) needs no connection or harness and would let the
          // plan resolve; switch it off so every enabled process wants one.
          improve: { strategies: { default: { processes: { triage: { enabled: false } } } } },
        },
        ensureIndexFn,
      }),
    ).rejects.toThrow("require a connection or harness that is not configured");
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
        semanticSearchMode: "off",
        bundles: { stash: { path: stash.dir, writable: true } },
        defaultBundle: "stash",
        improve: { strategy: "structural", strategies: { structural: { processes: disabledProcesses() } } },
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
        connections: { repair: lab("repair-model") },
        improve: {
          processes: { validation: { connection: "repair" } },
          strategies: { repair: { processes: disabledProcesses({ validation: { enabled: true } }) } },
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

  test("a legacy nested contradictionDetection key is tolerated and invokes no writer", async () => {
    const stash = makeStashDir();
    try {
      const config: AkmConfig = {
        configVersion: "0.9.0",
        semanticSearchMode: "off",
        bundles: { stash: { path: stash.dir, writable: true } },
        defaultBundle: "stash",
        connections: { consolidate: lab("contradiction-model") },
        improve: {
          processes: { consolidate: { connection: "consolidate" } },
          strategies: {
            contradictions: {
              processes: disabledProcesses({
                consolidate: { enabled: true, contradictionDetection: { enabled: true } },
              }),
            },
          },
        },
      };
      const plan = resolveImprovePlan("contradictions", config);
      expect(plan.processes.consolidate.enabled).toBe(true);
      expect(configuredDirectAutonomyLanes()).toEqual(["memoryCleanup"]);

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
          runImprovePreparationStageFn: (async () => {
            throw new Error("stop after contradiction boundary");
          }) as never,
        }),
      ).rejects.toThrow("stop after contradiction boundary");
    } finally {
      stash.cleanup();
    }
  });

  test("reflect dispatches through its frozen named-connection config when live config changes", async () => {
    const stash = makeStashDir();
    try {
      const memoryDir = path.join(stash.dir, "memories");
      fs.mkdirSync(memoryDir, { recursive: true });
      fs.writeFileSync(path.join(memoryDir, "source.md"), "---\ntype: memory\n---\n\nSource.\n");
      const config: AkmConfig = {
        configVersion: "0.9.0",
        semanticSearchMode: "off",
        bundles: { stash: { path: stash.dir, writable: true } },
        defaultBundle: "stash",
        connections: { reflect: lab("reflect-model"), distill: lab("distill-model") },
        improve: {
          processes: {
            reflect: { connection: "reflect", model: "process-model" },
            distill: { connection: "distill" },
          },
          strategies: {
            split: {
              processes: disabledProcesses({
                reflect: { enabled: true, allowedTypes: ["memory"] },
                distill: { enabled: true, allowedTypes: ["memory"] },
              }),
            },
          },
        },
      };
      const plan = resolveImprovePlan("split", config, { repairValidationFailures: false });
      const reflectConnection = config.connections?.reflect;
      const distillConnection = config.connections?.distill;
      if (reflectConnection) reflectConnection.models = { fast: "changed-reflect-model" };
      if (distillConnection) distillConnection.models = { fast: "changed-distill-model" };
      const liveProcesses = config.improve?.processes;
      if (liveProcesses?.reflect) liveProcesses.reflect.connection = "distill";
      if (liveProcesses?.distill) liveProcesses.distill.connection = "reflect";
      let reflectOptions: Record<string, unknown> | undefined;
      let distillOptions: Record<string, unknown> | undefined;
      const dispatchedModels: string[] = [];
      await runImproveLoopStage({
        eventsCtx: {},
        primaryStashDir: stash.dir,
        scope: { mode: "ref", value: "memories/source" },
        options: { config, stashDir: stash.dir },
        reflectFn: async (options) => {
          reflectOptions = options as unknown as Record<string, unknown>;
          return await withMockedFetch(
            () =>
              akmReflect({
                ...options,
                assetContent: "---\ntype: memory\n---\n\nSource.\n",
              }),
            async (_url, init) => {
              const body = JSON.parse(String(init?.body)) as { model?: string };
              if (body.model) dispatchedModels.push(body.model);
              return Response.json({
                choices: [
                  {
                    finish_reason: "stop",
                    message: {
                      content: JSON.stringify({
                        ref: "memories/source",
                        content: "---\ntype: memory\n---\n\nSource.\n",
                      }),
                    },
                  },
                ],
              });
            },
          );
        },
        distillFn: async (options) => {
          distillOptions = options as unknown as Record<string, unknown>;
          return {
            schemaVersion: 1,
            ok: true,
            outcome: "skipped",
            inputRef: options.ref,
            proposalRef: "lessons/source-lesson",
          };
        },
        loopRefs: [{ ref: "memories/source", reason: "scope-ref" }],
        actions: [],
        signalBearingSet: new Set(),
        distillCooledRefs: new Set(),
        distillOnlyRefs: [],
        recentErrors: {},
        startMs: Date.now(),
        budgetMs: 60_000,
        improveProfile: plan.strategy.config,
        resolvedPlan: plan,
      });
      expect(reflectOptions).not.toHaveProperty("runner");
      // The plan froze reflect's runner; no asset resolves it again.
      expect(reflectOptions?.llmRunner).toBe(plan.processes.reflect.runner);
      expect(reflectOptions).not.toHaveProperty("engine");
      expect(reflectOptions?.config).not.toBe(config);
      expect((reflectOptions?.config as AkmConfig).connections?.reflect).toMatchObject({
        models: { fast: "reflect-model" },
      });
      // Where reflect runs is frozen with the config, so the live swap above does not reach it.
      expect((reflectOptions?.config as AkmConfig).improve?.processes?.reflect).toMatchObject({
        connection: "reflect",
        model: "process-model",
      });
      expect(dispatchedModels.length).toBeGreaterThan(0);
      expect(new Set(dispatchedModels)).toEqual(new Set(["process-model"]));
      expect((distillOptions?.llmRunner as { model?: string }).model).toBe("distill-model");
      expect(distillOptions?.llmConfig).toBeUndefined();
      expect(distillOptions?.config).toBe(config);
    } finally {
      stash.cleanup();
    }
  });

  test("post-loop maintenance is a no-op when the run budget is already exhausted", async () => {
    const stash = makeStashDir();
    try {
      const config: AkmConfig = {
        configVersion: "0.9.0",
        semanticSearchMode: "off",
        bundles: { stash: { path: stash.dir, writable: true } },
        defaultBundle: "stash",
        improve: { strategy: "disabled", strategies: { disabled: { processes: disabledProcesses() } } },
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
        budgetSignal: controller.signal,
        improveProfile: plan.strategy.config,
        resolvedPlan: plan,
      });

      expect(result).toEqual({ memoryInferenceDurationMs: 0 });
    } finally {
      stash.cleanup();
    }
  });
});
