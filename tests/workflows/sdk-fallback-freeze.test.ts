// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A workflow freezes its engine's runner and, for an SDK engine, the LLM
 * fallback it carries and that fallback's concurrency cap. The fallback comes
 * only from the SDK engine's own `llmEngine`: `defaults.llmEngine` is the
 * default engine for model work, not a connection every SDK engine borrows.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { type AkmConfig, loadConfig, resetConfigCache } from "../../src/core/config/config";
import { resolveEngine } from "../../src/integrations/agent/engine-resolution";
import { DEFAULT_REMOTE_LLM_ENGINE_CONCURRENCY } from "../../src/workflows/concurrency-policy";
import { freezeWorkflow } from "../../src/workflows/freeze/freeze";
import { targetConcurrency } from "../../src/workflows/freeze/step-values";
import type { FrozenWorkflowCommandTarget } from "../../src/workflows/plan";
import { loadWorkflowAsset } from "../../src/workflows/runtime/workflow-asset-loader";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  resetConfigCache();
  storage.cleanup();
});

/** One gated step, so the freeze resolves both the step's engine and the gate judge's. */
const GATED_WORKFLOW = [
  "---",
  "type: workflow",
  "steps:",
  "  - id: work",
  "---",
  "",
  "## work",
  "",
  "Do the work.",
  "",
  "### gate",
  "",
  "- Confirm the work is done.",
  "",
].join("\n");

const llm = (host: string, concurrency: number) => ({
  kind: "llm",
  endpoint: `https://${host}.example.test/v1/chat/completions`,
  model: `${host}-model`,
  concurrency,
});

/** The step's frozen command target and the gate judge's, after freezing under `config`. */
async function freezeTargets(config: Record<string, unknown>) {
  writeSandboxConfig(config);
  resetConfigCache();
  const file = path.join(storage.stashDir, "workflows/gated.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, GATED_WORKFLOW, "utf8");
  const frozen = await freezeWorkflow(await loadWorkflowAsset("workflows/gated"), loadConfig());
  const step = frozen.plan.steps[0];
  const root = step?.root;
  if (root?.kind !== "unit" || root.frozenTarget.kind !== "command" || !step?.gate.frozenJudge) {
    throw new Error("expected a frozen command unit and a frozen judge");
  }
  const unit: FrozenWorkflowCommandTarget = root.frozenTarget;
  return { unit, judge: step.gate.frozenJudge };
}

describe("a frozen opencode-sdk target takes its LLM fallback only from its own llmEngine", () => {
  test("with no llmEngine of its own it freezes no fallback connection and no concurrency cap", async () => {
    const { unit, judge } = await freezeTargets({
      engines: { sdk: { kind: "agent", platform: "opencode-sdk" }, shared: llm("shared", 3) },
      defaults: { engine: "sdk", llmEngine: "shared" },
    });
    for (const target of [unit, judge]) {
      expect(target.request.engine).toEqual({ name: "sdk", kind: "sdk", platform: "opencode-sdk" });
      if (target.runner.kind !== "sdk") throw new Error("expected an SDK runner");
      expect(target.runner.fallbackConnection).toBeUndefined();
      expect(target.runner.fallbackCredential).toBeUndefined();
      expect(target.concurrency).toBeUndefined();
    }
  });

  test("with its own llmEngine it freezes that engine's connection and concurrency, not defaults.llmEngine's", async () => {
    const { unit, judge } = await freezeTargets({
      engines: {
        sdk: { kind: "agent", platform: "opencode-sdk", llmEngine: "own" },
        own: llm("own", 2),
        shared: llm("shared", 3),
      },
      defaults: { engine: "sdk", llmEngine: "shared" },
    });
    for (const target of [unit, judge]) {
      if (target.runner.kind !== "sdk") throw new Error("expected an SDK runner");
      expect(target.runner.fallbackConnection).toMatchObject({
        endpoint: "https://own.example.test/v1/chat/completions",
        model: "own-model",
      });
      expect(target.concurrency).toBe(2);
    }
  });
});

describe("targetConcurrency", () => {
  test("reads an SDK runner's cap from its engine's own llmEngine, never from defaults.llmEngine", () => {
    const runner = resolveEngine("sdk", {
      engines: { sdk: { kind: "agent", platform: "opencode-sdk", llmEngine: "own" }, own: llm("own", 2) } as never,
    });
    // The same runner, read against a config whose `sdk` engine names no llmEngine of its own.
    const config = {
      configVersion: "0.9.0",
      engines: { sdk: { kind: "agent", platform: "opencode-sdk" }, shared: llm("shared", 3) },
      defaults: { engine: "sdk", llmEngine: "shared" },
    } as unknown as AkmConfig;
    expect(targetConcurrency(runner, config)).toBe(DEFAULT_REMOTE_LLM_ENGINE_CONCURRENCY);
  });
});
