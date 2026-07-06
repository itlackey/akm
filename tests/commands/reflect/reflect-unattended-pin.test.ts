// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P1.3 (meta-review 07, Chain G): unattended `akm improve` must never hand
 * reflect a tool-capable runner. When `eventSource: "improve"`, config that
 * resolves an agent/SDK runner (or would fall back to the default agent
 * profile) is pinned to the tool-less LLM HTTP runner; a proper llm-mode
 * process block is honored as-is; with no defaults.llm to pin to, reflect
 * fails CLOSED instead of dispatching an agent with filesystem access.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { akmReflect } from "../../../src/commands/improve/reflect";
import type { AkmConfig, LlmConnectionConfig } from "../../../src/core/config/config";
import type { SpawnedSubprocess, SpawnFn } from "../../../src/integrations/agent/spawn";
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
    defaults: { llm: "pin-target", agent: "fake-agent" },
    profiles: {
      llm: { "pin-target": { endpoint: "http://127.0.0.1:9", model: "pin-model" } },
      agent: { "fake-agent": { platform: "opencode", bin: "fake-agent" } },
      improve: {
        default: {
          processes: {
            reflect: { enabled: true, mode: "agent", profile: "fake-agent" },
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
  test("eventSource=improve downgrades an agent-mode runner to the tool-less LLM runner", async () => {
    const stash = makeStashDir();
    let chatConnection: LlmConnectionConfig | undefined;

    await akmReflect({
      ref: "memory:alpha",
      stashDir: stash,
      eventSource: "improve",
      config: agentModeConfig(),
      chat: async (connection) => {
        chatConnection = connection;
        throw new Error("stop-after-capture");
      },
    });

    // The pin routed dispatch to the LLM HTTP path (chat seam), built from
    // defaults.llm — no agent/SDK dispatch is reachable on this path.
    expect(chatConnection?.model).toBe("pin-model");
  });

  test("eventSource=improve honors an llm-mode process block unchanged", async () => {
    const stash = makeStashDir();
    let chatConnection: LlmConnectionConfig | undefined;

    await akmReflect({
      ref: "memory:alpha",
      stashDir: stash,
      eventSource: "improve",
      config: {
        defaults: { llm: "other" },
        profiles: {
          llm: {
            other: { endpoint: "http://127.0.0.1:9", model: "default-model" },
            judge: { endpoint: "http://127.0.0.1:9", model: "block-model" },
          },
          improve: {
            default: {
              processes: {
                reflect: { enabled: true, mode: "llm", profile: "judge" },
                distill: { qualityGate: { enabled: false } },
              },
            },
          },
        },
      } as unknown as AkmConfig,
      chat: async (connection) => {
        chatConnection = connection;
        throw new Error("stop-after-capture");
      },
    });

    // The block's own llm profile is used — the pin does not clobber it.
    expect(chatConnection?.model).toBe("block-model");
  });

  test("eventSource=improve with no defaults.llm fails CLOSED instead of dispatching an agent", async () => {
    const stash = makeStashDir();
    let spawned = false;

    const config = agentModeConfig();
    // biome-ignore lint/suspicious/noExplicitAny: test mutates a fixture
    (config as any).defaults = { agent: "fake-agent" };

    await expect(
      akmReflect({
        ref: "memory:alpha",
        stashDir: stash,
        eventSource: "improve",
        config,
        runAgentOptions: { spawn: spySpawn(() => (spawned = true)) },
      }),
    ).rejects.toThrow(/tool-less LLM runner/);
    expect(spawned).toBe(false);
  });

  test("interactive reflect (no eventSource) still dispatches the injected agent profile", async () => {
    const stash = makeStashDir();
    let spawned = false;

    await akmReflect({
      ref: "memory:alpha",
      stashDir: stash,
      agentProfile: {
        name: "fake-agent",
        bin: "fake-agent",
        args: [],
        stdio: "captured",
        envPassthrough: ["PATH"],
        parseOutput: "text",
      },
      config: agentModeConfig(),
      runAgentOptions: { spawn: spySpawn(() => (spawned = true)) },
    });

    expect(spawned).toBe(true);
  });
});
