// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Inference reaches an agent engine wherever it already reaches an LLM engine:
 * the engine's own settings, and the improve process overlay
 * (`improve.strategies.<s>.processes.<p>.llm`). Model work resolves its runner
 * once, freezes it in the improve plan, and every stage call resolves from that
 * runner again, so the inference must survive that round trip. With no setting
 * anywhere, akm sends nothing of its own and the model's configured default
 * applies.
 */

import { describe, expect, test } from "bun:test";
import { resolveImproveExecution } from "../../../src/commands/improve/execution";
import type { AkmConfig, ImproveProfileConfig } from "../../../src/core/config/config";
import { MODEL_WORK_TOOLS } from "../../../src/execution/source";
import { buildExecution, resolveExecution } from "../../../src/integrations/agent/execution";
import type { AgentProfile } from "../../../src/integrations/agent/profiles";
import type { RunnerSpec } from "../../../src/integrations/agent/runner";
import { getHarness } from "../../../src/integrations/harnesses";

const OPENCODE = { kind: "agent", platform: "opencode", args: ["run", "--model", "krang/chat/qwen3.8-27b"] };

function configFor(
  engine: Record<string, unknown>,
  llm?: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): { config: AkmConfig; profile: ImproveProfileConfig } {
  const profile = {
    engine: "x",
    processes: { reflect: { enabled: true, ...(llm ? { llm } : {}) } },
  } as unknown as ImproveProfileConfig;
  const config = {
    configVersion: "0.9.0",
    engines: { x: engine, ...extra },
    improve: { strategies: { s: profile } },
  } as unknown as AkmConfig;
  return { config, profile };
}

function resolveReflect(config: AkmConfig, profile: ImproveProfileConfig) {
  const resolved = resolveImproveExecution({
    config,
    profile,
    process: profile.processes?.reflect,
    processName: "reflect",
  });
  if (!resolved) throw new Error("no runner resolved");
  return resolved;
}

function agentProfile(runner: RunnerSpec): AgentProfile {
  if (runner.kind === "llm") throw new Error("expected an agent runner");
  return runner.profile;
}

/** What a stage call resolves from the runner the improve plan froze. */
function resolveAgain(runner: ReturnType<typeof resolveReflect>["runner"]) {
  return resolveExecution({ content: "Reflect.", runner, current: { tools: MODEL_WORK_TOOLS } });
}

describe("improve model work on an agent engine", () => {
  test("the process overlay is translated, not reported untranslated, and survives the frozen runner", () => {
    const { config, profile } = configFor(OPENCODE, { reasoningEffort: "low", temperature: 0.2 });
    const resolved = resolveReflect(config, profile);

    expect(resolved.notices.filter((notice) => (notice.field ?? "").startsWith("inference."))).toEqual([]);
    const again = resolveAgain(resolved.runner);
    expect(again.request.inference).toEqual({ reasoningEffort: "low", temperature: 0.2 });
    expect(again.runner.kind === "agent" && again.runner.profile.inference).toEqual({
      reasoningEffort: "low",
      temperature: 0.2,
    });
  });

  test("the overlay wins over the engine's own setting, field by field", () => {
    const { config, profile } = configFor(
      { ...OPENCODE, reasoningEffort: "none", temperature: 0 },
      { reasoningEffort: "low" },
    );
    const { runner } = resolveReflect(config, profile);

    expect(resolveAgain(runner).request.inference).toEqual({ reasoningEffort: "low", temperature: 0 });
  });

  test("the overlay's effort reaches claude as --effort", () => {
    const { config, profile } = configFor({ kind: "agent", platform: "claude" }, { reasoningEffort: "low" });
    const { runner } = resolveReflect(config, profile);
    const again = resolveAgain(runner);
    const built = buildExecution(again.request, again.runner);
    const argv = getHarness("claude")?.agentBuilder?.build(
      agentProfile(built.runner),
      built.options.dispatch ?? { prompt: "" },
    ).argv;

    expect(argv).toContain("--effort");
    expect(argv?.[(argv?.indexOf("--effort") ?? -1) + 1]).toBe("low");
  });

  test("with no setting anywhere, akm sends nothing of its own", () => {
    const { config, profile } = configFor(OPENCODE);
    const { runner } = resolveReflect(config, profile);
    const again = resolveAgain(runner);
    const built = buildExecution(again.request, again.runner);
    const command = getHarness("opencode")?.agentBuilder?.build(
      agentProfile(built.runner),
      built.options.dispatch ?? { prompt: "" },
    );

    expect(again.request).not.toHaveProperty("inference");
    expect(runner.kind === "agent" && runner.profile).not.toHaveProperty("inference");
    // The injected config defines the model-work agent and nothing about the model or its options.
    const injected = JSON.parse(command?.env?.OPENCODE_CONFIG_CONTENT ?? "null");
    expect(Object.keys(injected).sort()).toEqual(["agent", "compaction", "permission"]);
    expect(injected.agent["akm-model-work"]).not.toHaveProperty("options");
  });

  test("an opencode-sdk engine's own setting is added over its LLM fallback's, field by field", () => {
    const { config, profile } = configFor(
      { kind: "agent", platform: "opencode-sdk", llmEngine: "backing", reasoningEffort: "high" },
      undefined,
      {
        backing: {
          kind: "llm",
          endpoint: "https://example.test/v1/chat/completions",
          model: "stub-model",
          temperature: 0,
          reasoningEffort: "none",
          enableThinking: false,
        },
      },
    );
    const { runner } = resolveReflect(config, profile);

    expect(resolveAgain(runner).request.inference).toEqual({
      temperature: 0,
      reasoningEffort: "high",
      enableThinking: false,
    });
  });
});
