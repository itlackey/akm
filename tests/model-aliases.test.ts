// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The shipped alias per kind of call: the farthest layer of every call asks for
 * `fast`, `balanced` or `reasoning` until something nearer (an asset, a process,
 * a flag) names a model.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { prepareCommandInvocation } from "../src/commands/command/command-execution";
import { resolveStandaloneExtractPlan } from "../src/commands/improve/extract";
import { resolveImprovePlan } from "../src/commands/improve/improve-strategies";
import { resolveQualityGateJudge } from "../src/commands/improve/stage";
import { type AkmConfig, loadConfig, resetConfigCache } from "../src/core/config/config";
import { SHIPPED_ALIAS } from "../src/core/config/model-aliases";
import { getConfigPath } from "../src/core/paths";
import { resolveIndexPassExecution } from "../src/llm/index-passes";
import { asLlmRunner } from "./_helpers/llm-runner";

const EXAMPLES = path.join(import.meta.dir, "fixtures", "config-examples");

const LAB = {
  endpoint: "http://lab:8080/v1",
  models: { fast: "m-fast", balanced: "m-balanced", reasoning: "m-reasoning" },
};

function configOf(extra: Record<string, unknown> = {}): AkmConfig {
  return { configVersion: "0.9.0", semanticSearchMode: "off", connections: { default: LAB }, ...extra } as AkmConfig;
}

const REFLECT_AND_TRIAGE = {
  strategies: {
    nightly: {
      processes: {
        reflect: { enabled: true },
        distill: { enabled: false },
        consolidate: { enabled: false },
        memoryInference: { enabled: false },
        extract: { enabled: false },
        validation: { enabled: false },
        proactiveMaintenance: { enabled: false },
        triage: { enabled: true, judgment: true },
      },
    },
  },
};

describe("the shipped alias per kind of call", () => {
  test("the table is the design's: passes fast, judges balanced, agents balanced, extract, enrich and the index fast", () => {
    expect(SHIPPED_ALIAS).toEqual({
      improve: "fast",
      judge: "balanced",
      agent: "balanced",
      extract: "fast",
      enrich: "fast",
      index: "fast",
    });
  });

  test("an improve pass asks for fast, and its judges for balanced", () => {
    const plan = resolveImprovePlan("nightly", configOf({ improve: REFLECT_AND_TRIAGE }));
    expect(asLlmRunner(plan.processes.reflect.runner).model).toBe("m-fast");
    expect(asLlmRunner(plan.triageJudgment).model).toBe("m-balanced");

    const gated = configOf({ improve: { qualityGate: { connection: "default" } } });
    expect(asLlmRunner(resolveQualityGateJudge(gated, undefined, "reflect")).model).toBe("m-balanced");
  });

  test("the reflect and distill quality gates judge on balanced whether or not improve.qualityGate is set", () => {
    const config = configOf();
    expect(asLlmRunner(resolveQualityGateJudge(config, undefined, "reflect")).model).toBe("m-balanced");
    expect(asLlmRunner(resolveQualityGateJudge(config, undefined, "distill")).model).toBe("m-balanced");
  });

  test("on the 1-basic example, loaded from a file, a pass writes on fast and both gate judges run on balanced", () => {
    fs.writeFileSync(getConfigPath(), fs.readFileSync(path.join(EXAMPLES, "1-basic.jsonc"), "utf8"));
    resetConfigCache();
    const config = loadConfig();
    expect(asLlmRunner(resolveImprovePlan("default", config).processes.reflect.runner).model).toBe("qwen3-8b");
    expect(asLlmRunner(resolveQualityGateJudge(config, undefined, "reflect")).model).toBe("qwen3-32b");
    expect(asLlmRunner(resolveQualityGateJudge(config, undefined, "distill")).model).toBe("qwen3-32b");
  });

  test("the process's own model and connection are the writer's: the judge takes improve-wide and the gate only", () => {
    const config = configOf({
      connections: { default: LAB, other: { endpoint: "http://other:1/v1", models: { balanced: "other-balanced" } } },
      improve: { processes: { reflect: { model: "reasoning", connection: "other" } } },
    });
    // The pass that writes runs on what its process says.
    expect(asLlmRunner(resolveImprovePlan("default", config).processes.reflect.runner).model).toBe("other-balanced");
    // The judge stays on the default connection and the judge alias.
    const judge = resolveQualityGateJudge(config, undefined, "reflect");
    expect(judge).toMatchObject({ name: "default" });
    expect(asLlmRunner(judge).model).toBe("m-balanced");
    // Improve-wide settings do reach it.
    const wide = configOf({
      connections: { default: LAB, other: { endpoint: "http://other:1/v1", models: { balanced: "other-balanced" } } },
      improve: { connection: "other", processes: { reflect: { model: "reasoning" } } },
    });
    expect(asLlmRunner(resolveQualityGateJudge(wide, undefined, "reflect")).model).toBe("other-balanced");
  });

  test("extract and the index passes ask for fast", () => {
    expect(asLlmRunner(resolveStandaloneExtractPlan(configOf(), {}).runner).model).toBe("m-fast");
    expect(asLlmRunner(resolveIndexPassExecution("memory", configOf()).runner).model).toBe("m-fast");
  });

  test("agent work asks for balanced: on a connection's models, and on a harness's shipped map", async () => {
    const onConnection = await prepareCommandInvocation({ action: { content: "Review." }, config: configOf() });
    expect(onConnection.request.model).toEqual({ model: "m-balanced", alias: "balanced" });

    const onClaude = await prepareCommandInvocation({
      action: { content: "Review." },
      config: configOf({ harnesses: { claude: {} } }),
    });
    expect(onClaude.request.target).toMatchObject({ kind: "harness", name: "claude" });
    expect(onClaude.request.model).toMatchObject({ model: "claude-sonnet-4-6", alias: "balanced" });
  });

  test("anything nearer names a model over it: a flag, or a process's settings", async () => {
    const flagged = await prepareCommandInvocation({
      action: { content: "Review." },
      config: configOf(),
      current: { model: "reasoning" },
    });
    expect(flagged.request.model).toEqual({ model: "m-reasoning", alias: "reasoning" });

    const processed = resolveImprovePlan(
      "nightly",
      configOf({ improve: { ...REFLECT_AND_TRIAGE, processes: { reflect: { model: "reasoning" } } } }),
    );
    expect(asLlmRunner(processed.processes.reflect.runner).model).toBe("m-reasoning");
  });
});
