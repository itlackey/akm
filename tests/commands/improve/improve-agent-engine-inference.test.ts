// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * An improve process's `llm` overlay (`improve.strategies.<s>.processes.<p>.llm`)
 * reaches an `opencode-sdk` engine's model work. Model work resolves its runner once,
 * freezes it in the improve plan, and every stage call resolves from that
 * runner again, so the overlay must survive that round trip. With no overlay,
 * akm sends nothing of its own and the model's configured default applies.
 */

import { describe, expect, test } from "bun:test";
import { resolveImproveExecution } from "../../../src/commands/improve/execution";
import type { AkmConfig, ImproveProfileConfig } from "../../../src/core/config/config";
import { buildExecution, resolveExecution } from "../../../src/integrations/agent/execution";
import type { AgentProfile } from "../../../src/integrations/agent/profiles";
import type { RunnerSpec } from "../../../src/integrations/agent/runner";
import { modelConfig } from "../../../src/integrations/harnesses/opencode-sdk/sdk-runner";

const OPENCODE_SDK = { kind: "agent", platform: "opencode-sdk", model: "krang/chat/qwen3.8-27b" };

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
  return resolveExecution({ content: "Reflect.", runner, modelWork: true });
}

describe("improve model work on an agent engine", () => {
  test("the process overlay survives the frozen runner and reaches the model-work agent", () => {
    const { config, profile } = configFor(OPENCODE_SDK, { reasoningEffort: "low", temperature: 0.2 });
    const resolved = resolveReflect(config, profile);

    expect(resolved.notices.filter((notice) => (notice.field ?? "").startsWith("inference."))).toEqual([]);
    const again = resolveAgain(resolved.runner);
    expect(again.request.inference).toEqual({ reasoningEffort: "low", temperature: 0.2 });
    expect(agentProfile(again.runner).inference).toEqual({ reasoningEffort: "low", temperature: 0.2 });
    const built = buildExecution(again.request, again.runner);
    const sent = modelConfig(agentProfile(built.runner).model, undefined, built.options.dispatch?.inference);
    expect(sent).toEqual({
      model: "krang/chat/qwen3.8-27b",
      provider: {
        krang: { models: { "chat/qwen3.8-27b": { options: { reasoningEffort: "low", temperature: 0.2 } } } },
      },
    });
  });

  test("with no setting anywhere, akm sends nothing of its own", () => {
    const { config, profile } = configFor(OPENCODE_SDK);
    const { runner } = resolveReflect(config, profile);
    const again = resolveAgain(runner);
    const built = buildExecution(again.request, again.runner);

    expect(again.request).not.toHaveProperty("inference");
    expect(agentProfile(runner)).not.toHaveProperty("inference");
    // The config names the model and nothing about its options.
    expect(modelConfig(agentProfile(built.runner).model, undefined, built.options.dispatch?.inference)).toEqual({
      model: "krang/chat/qwen3.8-27b",
    });
  });
});
