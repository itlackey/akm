// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P1.3 (meta-review 07, Chain G), as the model-work tool policy now states it:
 * unattended `akm improve` never hands reflect an agent that can write the
 * stash. An agent process engine runs under the policy (its own scratch
 * directory, no stash access beyond `akm search`/`akm show`); one whose
 * harness cannot confine the policy runs unrestricted, in the same scratch
 * directory, with a notice; an LLM
 * process engine is honored as-is; with no engine to resolve, reflect fails
 * CLOSED instead of dispatching an agent.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { akmReflect } from "../../../src/commands/improve/reflect";
import type { AkmConfig } from "../../../src/core/config/config";
import type { SpawnedSubprocess, SpawnFn } from "../../../src/core/subprocess";
import type { ChatCompletionConfig } from "../../../src/llm/client";
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

/** Config whose reflect process resolves a TOOL-CAPABLE (harness) runner. */
function agentModeConfig(overrides: Partial<AkmConfig> = {}): AkmConfig {
  return {
    configVersion: "0.9.0",
    connections: { "pin-target": { endpoint: "http://127.0.0.1:9", models: { fast: "pin-model" } } },
    harnesses: { "fake-agent": { platform: "claude", bin: "fake-agent" } },
    improve: {
      strategies: {
        default: {
          processes: {
            reflect: { enabled: true, harness: "fake-agent", qualityGate: { enabled: false } },
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
  test("eventSource=improve runs a harness process under the model-work tool policy", async () => {
    const stash = makeStashDir();
    const config = agentModeConfig();
    let seen: { cmd: string[]; env: Record<string, string>; cwd?: string } | undefined;
    const payload = reflectReply({ description: "Alpha, the first memory" });

    const result = await akmReflect({
      ref: "memories/alpha",
      stashDir: stash,
      eventSource: "improve",
      config,
      improveProfile: config.improve?.strategies?.default,
      runAgentOptions: { spawn: spySpawn((cmd, env, cwd) => (seen = { cmd, env, cwd }), payload) },
    });

    expect(result.ok).toBe(true);
    // claude runs confined to the model-work tools, in its own scratch directory, not the stash.
    expect(seen?.cmd.slice(1, 3)).toEqual(["--restricted", "--strict-mcp-config"]);
    expect(seen?.cmd).toContain("--permission-mode");
    expect(seen?.cmd).toContain("Read,Edit,Bash(akm search *),Bash(akm show *)");
    expect(path.basename(seen?.cwd ?? "")).toStartWith("akm-model-work-");
    // The proposal comes back as the JSON reply of the output schema, which the prompt ends with.
    expect(seen?.cmd.at(-1)).toContain("Respond with ONLY a JSON value matching this JSON Schema");
  });

  test("eventSource=improve runs a harness that cannot confine the policy unrestricted, in the scratch directory", async () => {
    const stash = makeStashDir();
    const config = agentModeConfig({
      harnesses: { "fake-agent": { platform: "pi", bin: "fake-agent" } },
    } as Partial<AkmConfig>);
    let seen: { cmd: string[]; cwd?: string } | undefined;
    const payload = reflectReply({ description: "Alpha, the first memory" });

    const result = await akmReflect({
      ref: "memories/alpha",
      stashDir: stash,
      eventSource: "improve",
      config,
      improveProfile: config.improve?.strategies?.default,
      runAgentOptions: { spawn: spySpawn((cmd, _env, cwd) => (seen = { cmd, cwd }), payload) },
    });

    expect(result.ok).toBe(true);
    expect(seen?.cmd[0]).toBe("fake-agent");
    expect(path.basename(seen?.cwd ?? "")).toStartWith("akm-model-work-");
  });

  test("eventSource=improve honors a connection process unchanged", async () => {
    const stash = makeStashDir();
    let chatConnection: ChatCompletionConfig | undefined;
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      connections: {
        default: { endpoint: "http://127.0.0.1:9", models: { fast: "default-model" } },
        judge: { endpoint: "http://127.0.0.1:9", models: { fast: "block-model" } },
      },
      improve: {
        strategies: {
          default: {
            processes: {
              reflect: { enabled: true, connection: "judge", qualityGate: { enabled: false } },
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

    // The process connection is used; the default one does not clobber it.
    expect(chatConnection?.model).toBe("block-model");
  });

  test("eventSource=improve with no connection or harness to resolve fails CLOSED instead of dispatching an agent", async () => {
    const stash = makeStashDir();
    let spawned = false;

    const config = agentModeConfig({ connections: undefined, harnesses: undefined });
    const strategy = config.improve?.strategies?.default;
    if (strategy?.processes?.reflect) delete strategy.processes.reflect.harness;

    await expect(
      akmReflect({
        ref: "memories/alpha",
        stashDir: stash,
        eventSource: "improve",
        config,
        improveProfile: strategy,
        runAgentOptions: { spawn: spySpawn(() => (spawned = true)) },
      }),
    ).rejects.toThrow("Reflect requires a connection or harness for the active improve strategy.");
    expect(spawned).toBe(false);
  });

  test("interactive reflect (no eventSource) dispatches the configured harness", async () => {
    const stash = makeStashDir();
    let spawned = false;

    await akmReflect({
      ref: "memories/alpha",
      stashDir: stash,
      config: agentModeConfig({ connections: undefined }),
      runAgentOptions: { spawn: spySpawn(() => (spawned = true)) },
    });

    expect(spawned).toBe(true);
  });
});
