// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * An improve process's `llm` overlay (`improve.strategies.<s>.processes.<p>.llm`)
 * reaches an agent engine's model work. Model work resolves its runner once,
 * freezes it in the improve plan, and every stage call resolves from that
 * runner again, so the overlay must survive that round trip. With no overlay,
 * akm sends nothing of its own and the model's configured default applies.
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
): { config: AkmConfig; profile: ImproveProfileConfig } {
  const profile = {
    engine: "x",
    processes: { reflect: { enabled: true, ...(llm ? { llm } : {}) } },
  } as unknown as ImproveProfileConfig;
  const config = {
    configVersion: "0.9.0",
    engines: { x: engine },
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
  test("the process overlay survives the frozen runner and reaches the model-work agent", () => {
    const { config, profile } = configFor(OPENCODE, { reasoningEffort: "low", temperature: 0.2 });
    const resolved = resolveReflect(config, profile);

    const again = resolveAgain(resolved.runner);
    expect(again.request.inference).toEqual({ reasoningEffort: "low", temperature: 0.2 });
    expect(again.runner.kind === "agent" && again.runner.profile.inference).toEqual({
      reasoningEffort: "low",
      temperature: 0.2,
    });
    const built = buildExecution(again.request, again.runner);
    const command = getHarness("opencode")?.agentBuilder?.build(
      agentProfile(built.runner),
      built.options.dispatch ?? { prompt: "" },
    );
    expect(JSON.parse(command?.env?.OPENCODE_CONFIG_CONTENT ?? "null").agent["akm-model-work"].options).toEqual({
      reasoningEffort: "low",
      temperature: 0.2,
    });
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
});
