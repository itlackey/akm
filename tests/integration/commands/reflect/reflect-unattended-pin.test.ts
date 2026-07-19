// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P1.3 (meta-review 07, Chain G): unattended `akm improve` must never hand
 * reflect a tool-capable runner. When `eventSource: "improve"`, config that
 * resolves an agent/SDK runner fails loudly rather than falling back; a proper
 * LLM process engine is honored as-is; with no defaults.llmEngine to pin to,
 * reflect fails CLOSED instead of dispatching an agent with filesystem access.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { akmReflect } from "../../../../src/commands/improve/reflect";
import type { AkmConfig, LlmConnectionConfig } from "../../../../src/core/config/config";
import type { SpawnedSubprocess, SpawnFn } from "../../../../src/integrations/agent/spawn";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../../_helpers/sandbox";

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

function spySpawn(onSpawn: () => void): SpawnFn {
  return () => {
    onSpawn();
    const proc: SpawnedSubprocess = {
      exitCode: 0,
      exited: Promise.resolve(0),
      stdout: asReadableStream(""),
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
            reflect: { enabled: true, engine: "fake-agent" },
            distill: { qualityGate: { enabled: false } },
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
  test("eventSource=improve rejects an explicit agent engine without falling back", async () => {
    const stash = makeStashDir();
    const config = agentModeConfig();
    let chatCalled = false;

    await expect(
      akmReflect({
        ref: "memories/alpha",
        stashDir: stash,
        eventSource: "improve",
        config,
        improveProfile: config.improve?.strategies?.default,
        chat: async () => {
          chatCalled = true;
          throw new Error("must-not-run");
        },
      }),
    ).rejects.toThrow('Engine "fake-agent" is not an LLM engine.');

    expect(chatCalled).toBe(false);
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
              reflect: { enabled: true, engine: "judge" },
              distill: { qualityGate: { enabled: false } },
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

  test("eventSource=improve with no defaults.llmEngine fails CLOSED instead of dispatching an agent", async () => {
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
    ).rejects.toThrow(/requires an LLM engine/);
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
