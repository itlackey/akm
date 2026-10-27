// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P1.3 (meta-review 07, Chain G), as the model-work tool policy now states it:
 * unattended `akm improve` never hands reflect an agent that can write the
 * stash. A process on a harness runs under the policy (its own scratch
 * directory, no stash access beyond `akm search`/`akm show`); one whose
 * harness cannot confine the policy runs unrestricted, in the same scratch
 * directory, with a notice; a process on a
 * connection is honored as-is; with no connection or harness to resolve, reflect fails
 * CLOSED instead of dispatching an agent.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { akmReflect } from "../../../src/commands/improve/reflect";
import type { AkmConfig } from "../../../src/core/config/config";
import type { ChatCompletionConfig } from "../../../src/llm/client";
import { harnessCalls, writeFakeHarness } from "../../_helpers/engine-stubs";
import { reflectReply } from "../../_helpers/factories";
import {
  type IsolatedAkmStorage,
  makeSandboxDir,
  type SandboxedDir,
  withIsolatedAkmStorage,
} from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let binDir: SandboxedDir;

function makeStashDir(): string {
  const stash = storage.stashDir;
  fs.writeFileSync(path.join(stash, "memories", "alpha.md"), "---\ndescription: alpha\n---\n\nAlpha memory.\n");
  return stash;
}

/** A fake harness binary that answers with `replies`, and a config whose reflect process runs `platform` on it. */
function fakeAgent(platform = "claude", replies: readonly string[] = [""]): { bin: string; config: AkmConfig } {
  const bin = writeFakeHarness(binDir.dir, `fake-agent-${platform}`, replies);
  return { bin, config: agentModeConfig({ harnesses: { "fake-agent": { platform, bin } } } as Partial<AkmConfig>) };
}

/** Config whose reflect process resolves a TOOL-CAPABLE (harness) runner. */
function agentModeConfig(overrides: Partial<AkmConfig> = {}): AkmConfig {
  return {
    configVersion: "0.9.0",
    connections: { "pin-target": { endpoint: "http://127.0.0.1:9", models: { fast: "pin-model" } } },
    harnesses: { "fake-agent": { platform: "claude", bin: "fake-agent" } },
    improve: {
      processes: { reflect: { harness: "fake-agent" } },
      strategies: { default: { processes: { reflect: { enabled: true, qualityGate: { enabled: false } } } } },
    },
    ...overrides,
  } as unknown as AkmConfig;
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  binDir = makeSandboxDir("akm-unattended-pin-bin");
});

afterEach(() => {
  binDir.cleanup();
  storage.cleanup();
});

describe("unattended-improve reflect pin (07 Chain-G / P1.3)", () => {
  test("eventSource=improve runs a harness process under the model-work tool policy", async () => {
    const stash = makeStashDir();
    const { bin, config } = fakeAgent("claude", [reflectReply({ description: "Alpha, the first memory" })]);

    const result = await akmReflect({
      ref: "memories/alpha",
      stashDir: stash,
      eventSource: "improve",
      config,
      improveProfile: config.improve?.strategies?.default,
    });

    expect(result.ok).toBe(true);
    const [seen] = harnessCalls(bin);
    // claude runs confined to the model-work tools, in its own scratch directory, not the stash.
    expect(seen?.argv.slice(0, 2)).toEqual(["--restricted", "--strict-mcp-config"]);
    expect(seen?.argv).toContain("--permission-mode");
    expect(seen?.argv).toContain("Read,Bash(akm search *),Bash(akm show *),Bash(akm curate *)");
    expect(seen?.argv).toContain("--no-session-persistence");
    expect(path.basename(seen?.cwd ?? "")).toStartWith("akm-model-work-");
    // The proposal comes back as the JSON reply of the output schema, which the prompt ends with.
    expect(seen?.stdin).toContain("Respond with ONLY a JSON value matching this JSON Schema");
  });

  test("eventSource=improve runs a harness that cannot confine the policy unrestricted, in the scratch directory", async () => {
    const stash = makeStashDir();
    const { bin, config } = fakeAgent("pi", [reflectReply({ description: "Alpha, the first memory" })]);

    const result = await akmReflect({
      ref: "memories/alpha",
      stashDir: stash,
      eventSource: "improve",
      config,
      improveProfile: config.improve?.strategies?.default,
    });

    expect(result.ok).toBe(true);
    const [seen] = harnessCalls(bin);
    expect(seen?.argv).toContain("-p");
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
        processes: { reflect: { connection: "judge" } },
        strategies: { default: { processes: { reflect: { enabled: true, qualityGate: { enabled: false } } } } },
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
    const bin = path.join(binDir.dir, "never-run");

    const config = agentModeConfig({ connections: undefined, harnesses: undefined });
    // Nothing is configured and nothing is pinned: a pin to a harness that is not configured would fail on its own.
    delete (config.improve as { processes?: unknown }).processes;
    const strategy = config.improve?.strategies?.default;

    await expect(
      akmReflect({
        ref: "memories/alpha",
        stashDir: stash,
        eventSource: "improve",
        config,
        improveProfile: strategy,
      }),
    ).rejects.toThrow("Reflect requires a connection or harness for the active improve strategy.");
    expect(harnessCalls(bin)).toEqual([]);
  });

  test("interactive reflect (no eventSource) dispatches the configured harness", async () => {
    const stash = makeStashDir();
    const { bin, config } = fakeAgent("gemini");

    await akmReflect({ ref: "memories/alpha", stashDir: stash, config: { ...config, connections: undefined } });

    expect(harnessCalls(bin)).toHaveLength(1);
  });
});
