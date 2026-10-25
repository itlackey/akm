// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The shipped alias per kind of call: the farthest layer of every call asks for
 * `fast`, `balanced` or `reasoning` until something nearer (an asset, a process,
 * a flag) names a model.
 */

import { describe, expect, test } from "bun:test";
import { prepareCommandInvocation } from "../src/commands/command/command-execution";
import { resolveStandaloneExtractPlan } from "../src/commands/improve/extract";
import { resolveImprovePlan } from "../src/commands/improve/improve-strategies";
import { resolveQualityGateJudge } from "../src/commands/improve/stage";
import type { AkmConfig } from "../src/core/config/config";
import { SHIPPED_ALIAS } from "../src/core/config/model-aliases";
import { resolveIndexPassExecution } from "../src/llm/index-passes";
import { asLlmRunner } from "./_helpers/llm-runner";

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
