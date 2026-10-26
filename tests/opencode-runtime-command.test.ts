// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The OpenCode process akm's own runtime starts for one run (`runtime/command.ts`):
 * its inline config, its environment and its command line, for agent work and for
 * model work. The connection is the only provider; akm's roots, the free-model and
 * catalog switches and the plugin are set; model work runs as the read-only agent.
 */

import { describe, expect, test } from "bun:test";
import path from "node:path";
import { MODEL_WORK_AGENT_DEFINITION } from "../src/integrations/harnesses/opencode/agent-builder";
import {
  type RuntimeLocations,
  runtimeArgv,
  runtimeConfig,
  runtimeEnv,
} from "../src/integrations/harnesses/opencode/runtime/command";
import type { ChatCompletionConfig } from "../src/llm/client";

const PLUGIN = "/akm/data/opencode-runtime/config/akm-plugin";

const connection = (extra: Partial<ChatCompletionConfig> = {}): ChatCompletionConfig => ({
  endpoint: "https://llm.example/v1/chat/completions",
  model: "org/model:7b",
  ...extra,
});

const where: RuntimeLocations = {
  binary: "/akm/cache/opencode/2.1.4/opencode",
  directory: "/akm/data/opencode-runtime",
  pluginDirectory: PLUGIN,
  akm: "/usr/local/bin/akm",
};

type Provider = {
  npm: string;
  name: string;
  options: { baseURL: string; apiKey?: string };
  models: Record<string, { name: string; limit?: { context: number; output: number } }>;
};
const providerOf = (config: Record<string, unknown>): Provider => (config.provider as { akm: Provider }).akm;

describe("the inline config", () => {
  test("the connection is the only provider: the package OpenCode bundles, the endpoint's base URL, the one model", () => {
    const config = runtimeConfig(connection(), false, PLUGIN);

    expect(Object.keys(config.provider as object)).toEqual(["akm"]);
    expect(providerOf(config)).toEqual({
      npm: "@ai-sdk/openai-compatible",
      name: "akm",
      options: { baseURL: "https://llm.example/v1" },
      models: { "org/model:7b": { name: "org/model:7b" } },
    });
  });

  test("the key is the provider's, and only when the connection has one", () => {
    expect(providerOf(runtimeConfig(connection({ apiKey: "sk-secret" }), false, PLUGIN)).options).toEqual({
      baseURL: "https://llm.example/v1",
      apiKey: "sk-secret",
    });
    expect(providerOf(runtimeConfig(connection(), false, PLUGIN)).options).not.toHaveProperty("apiKey");
  });

  test.each([
    ["states neither", {}, undefined],
    ["states its window", { contextLength: 32_768 }, { context: 32_768, output: 32_000 }],
    ["states its output cap", { request: { max_tokens: 2_048 } }, { context: 200_000, output: 2_048 }],
    ["states both", { contextLength: 32_768, request: { max_tokens: 2_048 } }, { context: 32_768, output: 2_048 }],
    // OpenCode refuses a model whose limit states only one of the two, so the other is its own assumption.
  ] as const)("a connection that %s", (_name, extra, limit) => {
    const model = providerOf(runtimeConfig(connection(extra as Partial<ChatCompletionConfig>), false, PLUGIN)).models[
      "org/model:7b"
    ];
    expect(model?.limit).toEqual(limit);
  });

  test("the plugin is named with the connection's request fields in the endpoint's own names", () => {
    const config = runtimeConfig(
      connection({
        request: { top_p: 0.9, chat_template_kwargs: { thinking_budget: 100 } },
        inference: { temperature: 0.2, maxTokens: 4096, reasoningEffort: "high", enableThinking: false },
      }),
      false,
      PLUGIN,
    );

    expect(config.plugins).toEqual([
      {
        package: PLUGIN,
        options: {
          shellEnv: expect.any(Object),
          requestFields: expect.objectContaining({
            top_p: 0.9,
            temperature: 0.2,
            max_tokens: 4096,
            reasoning_effort: "high",
            chat_template_kwargs: { thinking_budget: 100, enable_thinking: false },
          }),
        },
      },
    ]);
  });

  test("the fields akm owns are not the connection's to send", () => {
    const config = runtimeConfig(
      connection({ request: { model: "other", messages: [], stream: false } }),
      false,
      PLUGIN,
    );

    const [entry] = config.plugins as Array<{ options: { requestFields: Record<string, unknown> } }>;
    expect(entry?.options.requestFields).toEqual({});
  });

  test("agent work defines no agent: OpenCode's own default runs, with its normal tools", () => {
    expect(runtimeConfig(connection(), false, PLUGIN)).not.toHaveProperty("agents");
  });

  test("model work defines the read-only agent: everything denied, then reading and akm's three tools allowed", () => {
    const { agents } = runtimeConfig(connection(), true, PLUGIN) as {
      agents: Record<string, typeof MODEL_WORK_AGENT_DEFINITION>;
    };

    expect(agents).toEqual({ "akm-model-work": MODEL_WORK_AGENT_DEFINITION });
    expect(agents["akm-model-work"]?.mode).toBe("primary");
    expect(agents["akm-model-work"]?.permissions.map((rule) => [rule.action, rule.effect])).toEqual([
      ["*", "deny"],
      ["read", "allow"],
      ["glob", "allow"],
      ["grep", "allow"],
      ["akm_search", "allow"],
      ["akm_show", "allow"],
      ["akm_curate", "allow"],
    ]);
  });
});

describe("the environment", () => {
  const env = runtimeEnv(runtimeConfig(connection({ apiKey: "sk-secret" }), false, PLUGIN), where);

  test("OpenCode's roots and its temp directory are akm's, under the runtime directory", () => {
    expect(env).toMatchObject({
      XDG_CONFIG_HOME: path.join(where.directory, "config"),
      XDG_DATA_HOME: path.join(where.directory, "data"),
      XDG_CACHE_HOME: path.join(where.directory, "cache"),
      XDG_STATE_HOME: path.join(where.directory, "state"),
      TMPDIR: path.join(where.directory, "tmp"),
    });
  });

  test("no hosted free models, no model catalog fetch, no project config", () => {
    expect(env).toMatchObject({
      OPENCODE_DISABLE_FREE_MODELS: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    });
  });

  test("the plugin is told, for each variable the run sets, what the agent's commands get: akm's value, or none", () => {
    const config = runtimeConfig(connection(), false, PLUGIN, {
      XDG_DATA_HOME: "/home/me/.local/share",
      TMPDIR: "/tmp",
    });

    const [entry] = config.plugins as Array<{ options: { shellEnv: Record<string, string | null> } }>;
    const { shellEnv } = entry?.options ?? { shellEnv: {} };
    expect(shellEnv.XDG_DATA_HOME).toBe("/home/me/.local/share");
    expect(shellEnv.TMPDIR).toBe("/tmp");
    expect(shellEnv.XDG_CACHE_HOME).toBeNull();
    expect(shellEnv.OPENCODE_CONFIG_CONTENT).toBeNull();
    // Every variable runtimeEnv sets is covered, so the key in the config never reaches a command.
    expect(Object.keys(shellEnv).sort()).toEqual(Object.keys(env).sort());
  });

  test("the config goes in OPENCODE_CONFIG_CONTENT, and the akm executable the plugin calls in AKM_OPENCODE_CLI", () => {
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT as string)).toEqual(
      runtimeConfig(connection({ apiKey: "sk-secret" }), false, PLUGIN),
    );
    expect(env.AKM_OPENCODE_CLI).toBe("/usr/local/bin/akm");
  });
});

describe("the command line", () => {
  test("agent work: a standalone run named akm, on the connection's model", () => {
    expect(runtimeArgv(connection(), { prompt: "p" }, where.binary)).toEqual([
      where.binary,
      "run",
      "--standalone",
      "--title",
      "akm",
      "--model",
      "akm/org/model:7b",
    ]);
  });

  test("a native agent the request names runs", () => {
    expect(runtimeArgv(connection(), { prompt: "p", agent: "plan" }, where.binary)).toContain("plan");
    expect(runtimeArgv(connection(), { prompt: "p", agent: "plan" }, where.binary).join(" ")).toContain("--agent plan");
  });

  test("model work runs as the read-only agent, whatever agent the request names", () => {
    const argv = runtimeArgv(connection(), { prompt: "p", modelWork: true, agent: "plan" }, where.binary);

    expect(argv.join(" ")).toContain("--agent akm-model-work");
    expect(argv).not.toContain("plan");
  });

  test("neither the prompt nor the key is on the command line", () => {
    const argv = runtimeArgv(connection({ apiKey: "sk-secret" }), { prompt: "a secret prompt" }, where.binary).join(
      " ",
    );

    expect(argv).not.toContain("sk-secret");
    expect(argv).not.toContain("a secret prompt");
  });
});
