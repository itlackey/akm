// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P1.3 (meta-review 07, Chain G), as the model-work tool policy now states it:
 * unattended `akm improve` never hands reflect an agent that can write the
 * stash. An agent process engine runs under the policy (its own scratch
 * directory, no stash access beyond `akm search`/`akm show`); one whose
 * harness cannot confine the policy is refused before dispatch; an LLM
 * process engine is honored as-is; with no engine to resolve, reflect fails
 * CLOSED instead of dispatching an agent.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { akmReflect } from "../../../src/commands/improve/reflect";
import type { AkmConfig, LlmConnectionConfig } from "../../../src/core/config/config";
import type { SpawnedSubprocess, SpawnFn } from "../../../src/core/subprocess";
import { reflectReply } from "../../_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

function makeStashDir(): string {
  const stash = storage.stashDir;
  fs.writeFileSync(path.join(stash, "memories", "alpha.md"), "---\ndescription: alpha\n---\n\nAlpha memory.\n");
  return stash;
}

function asReadableStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function spySpawn(onSpawn: (cmd: string[], env: Record<string, string>, cwd?: string) => void, stdout = ""): SpawnFn {
  return (cmd, options) => {
    onSpawn(cmd, options.env ?? {}, options.cwd);
    const proc: SpawnedSubprocess = {
      exitCode: 0,
      exited: Promise.resolve(0),
      stdout: asReadableStream(stdout),
      stderr: asReadableStream(""),
      stdin: null,
      kill: () => undefined,
    };
    return proc;
  };
}

/** Config whose reflect process resolves a TOOL-CAPABLE (agent) runner. */
function agentModeConfig(overrides: Partial<AkmConfig> = {}): AkmConfig {
  return {
    configVersion: "0.9.0",
    defaults: { llmEngine: "pin-target", engine: "fake-agent", improveStrategy: "default" },
    engines: {
      "pin-target": { kind: "llm", endpoint: "http://127.0.0.1:9", model: "pin-model" },
      "fake-agent": { kind: "agent", platform: "opencode", bin: "fake-agent" },
    },
    improve: {
      strategies: {
        default: {
          processes: {
            reflect: { enabled: true, engine: "fake-agent", qualityGate: { enabled: false } },
          },
        },
      },
    },
    ...overrides,
  } as unknown as AkmConfig;
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

describe("unattended-improve reflect pin (07 Chain-G / P1.3)", () => {
  test("eventSource=improve runs an agent process engine under the model-work tool policy", async () => {
    const stash = makeStashDir();
    const config = agentModeConfig();
    let seen: { cmd: string[]; env: Record<string, string>; cwd?: string } | undefined;
    const payload = reflectReply("---\ndescription: alpha\n---\n\nAlpha memory, revised.\n");

    const result = await akmReflect({
      ref: "memories/alpha",
      stashDir: stash,
      eventSource: "improve",
      config,
      improveProfile: config.improve?.strategies?.default,
      runAgentOptions: { spawn: spySpawn((cmd, env, cwd) => (seen = { cmd, env, cwd }), payload) },
    });

    expect(result.ok).toBe(true);
    // opencode runs the injected, confined agent in its own scratch directory, not the stash.
    expect(seen?.cmd.slice(1, 4)).toEqual(["run", "--agent", "akm-model-work"]);
    expect(JSON.parse(seen?.env.OPENCODE_CONFIG_CONTENT ?? "{}").agent["akm-model-work"].permission).toMatchObject({
      "*": "deny",
      bash: "deny",
      akm_feedback: "deny",
    });
    expect(path.basename(seen?.cwd ?? "")).toStartWith("akm-model-work-");
    // The proposal comes back as the JSON reply of the output schema, which the prompt ends with.
    expect(seen?.cmd.at(-1)).toContain("Respond with ONLY a JSON value matching this JSON Schema");
  });

  test("eventSource=improve refuses an agent engine that cannot confine the policy, before dispatch", async () => {
    const stash = makeStashDir();
    const config = agentModeConfig({
      engines: {
        "pin-target": { kind: "llm", endpoint: "http://127.0.0.1:9", model: "pin-model" },
        "fake-agent": { kind: "agent", platform: "pi", bin: "fake-agent" },
      },
    } as Partial<AkmConfig>);
    let spawned = false;

    await expect(
      akmReflect({
        ref: "memories/alpha",
        stashDir: stash,
        eventSource: "improve",
        config,
        improveProfile: config.improve?.strategies?.default,
        runAgentOptions: { spawn: spySpawn(() => (spawned = true)) },
      }),
    ).rejects.toThrow("The pi transport cannot enforce the model-work tool policy.");
    expect(spawned).toBe(false);
  });

  test("eventSource=improve honors an LLM process engine unchanged", async () => {
    const stash = makeStashDir();
    let chatConnection: LlmConnectionConfig | undefined;
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      defaults: { llmEngine: "other", improveStrategy: "default" },
      engines: {
        other: { kind: "llm", endpoint: "http://127.0.0.1:9", model: "default-model" },
        judge: { kind: "llm", endpoint: "http://127.0.0.1:9", model: "block-model" },
      },
      improve: {
        strategies: {
          default: {
            processes: {
              reflect: { enabled: true, engine: "judge", qualityGate: { enabled: false } },
            },
          },
        },
      },
    };

    await akmReflect({
      ref: "memories/alpha",
      stashDir: stash,
      eventSource: "improve",
      config,
      improveProfile: config.improve?.strategies?.default,
      chat: async (connection) => {
        chatConnection = connection;
        throw new Error("stop-after-capture");
      },
    });

    // The process engine is used; defaults.llmEngine does not clobber it.
    expect(chatConnection?.model).toBe("block-model");
  });

  test("eventSource=improve with no engine to resolve fails CLOSED instead of dispatching an agent", async () => {
    const stash = makeStashDir();
    let spawned = false;

    const config = agentModeConfig();
    config.defaults = { engine: "fake-agent", improveStrategy: "default" };
    const strategy = config.improve?.strategies?.default;
    if (strategy?.processes?.reflect) delete strategy.processes.reflect.engine;

    await expect(
      akmReflect({
        ref: "memories/alpha",
        stashDir: stash,
        eventSource: "improve",
        config,
        improveProfile: strategy,
        runAgentOptions: { spawn: spySpawn(() => (spawned = true)) },
      }),
    ).rejects.toThrow("Reflect requires an engine for the active improve strategy.");
    expect(spawned).toBe(false);
  });

  test("interactive reflect (no eventSource) dispatches the configured agent engine", async () => {
    const stash = makeStashDir();
    let spawned = false;

    await akmReflect({
      ref: "memories/alpha",
      stashDir: stash,
      config: agentModeConfig(),
      runAgentOptions: { spawn: spySpawn(() => (spawned = true)) },
    });

    expect(spawned).toBe(true);
  });
});
