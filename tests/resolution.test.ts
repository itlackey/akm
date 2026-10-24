// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Where an execution runs: which connection or harness, with which model, request
 * fields and timeout. Every case drives `resolveTarget` with a config and the
 * layers (an asset's frontmatter, a process, a flag) farther to nearer.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { AkmConfig } from "../src/core/config/config";
import { deepMergeConfig } from "../src/core/config/deep-merge";
import { ConfigError } from "../src/core/errors";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../src/core/warn";
import type { UnresolvedExecutionDefaults } from "../src/execution/source";
import { parseTimeout, resolveTarget } from "../src/integrations/agent/resolution";
import type { ConnectionRunner, HarnessRunner } from "../src/integrations/agent/runner";
import { overrideSeam } from "./_helpers/seams";

const configOf = (parts: Record<string, unknown>): AkmConfig => ({ configVersion: "0.9.0", ...parts }) as AkmConfig;

const lab = {
  endpoint: "http://lab:8080/v1",
  models: {
    fast: "qwen3-8b",
    balanced: "qwen3-32b",
    reasoning: { model: "glm-5", reasoning_effort: "high", max_tokens: 16384 },
  },
};
const cloud = {
  endpoint: "https://cloud.example/v1",
  apiKey: "$CLOUD_KEY",
  models: { fast: "cloud-small", balanced: "cloud-medium" },
};

let warnings: string[] = [];
beforeEach(() => {
  warnings = [];
  _resetWarnOnceForTests();
  overrideSeam(_setWarnSinkForTests, (level: string, args: unknown[]) => {
    if (level === "warn") warnings.push(args.map(String).join(" "));
  });
});

function connectionFor(
  config: AkmConfig,
  layers: UnresolvedExecutionDefaults[] = [],
  modelWork = true,
): ConnectionRunner {
  const runner = resolveTarget({ config, layers, modelWork });
  if (runner.kind !== "connection") throw new Error(`expected a connection, got a ${runner.kind}`);
  return runner;
}

function harnessFor(config: AkmConfig, layers: UnresolvedExecutionDefaults[] = [], modelWork = false): HarnessRunner {
  const runner = resolveTarget({ config, layers, modelWork });
  if (runner.kind !== "harness") throw new Error(`expected a harness, got a ${runner.kind}`);
  return runner;
}

function failureOf(run: () => unknown): ConfigError {
  try {
    run();
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error("expected resolveTarget to throw");
}

describe("deepMergeConfig", () => {
  test("recursively merges plain objects while replacing arrays and preserving explicit values", () => {
    const merged = deepMergeConfig(
      { nested: { keep: 1, replace: true }, values: ["old"], nullable: 100 },
      { nested: { replace: false, added: 0 }, values: [], nullable: null },
    );

    expect(merged).toEqual({
      nested: { keep: 1, replace: false, added: 0 },
      values: [],
      nullable: null,
    });
  });

  test("rejects prototype-pollution keys at every depth", () => {
    expect(() => deepMergeConfig({}, JSON.parse('{"nested":{"__proto__":{"polluted":true}}}'))).toThrow(
      "Unsafe configuration key",
    );
  });
});

describe("the default is chosen by name", () => {
  test("the entry named default is the default connection, whatever else is configured", () => {
    const runner = connectionFor(configOf({ connections: { cloud, default: lab } }));
    expect(runner.name).toBe("default");
    expect(runner.endpoint).toBe("http://lab:8080/v1");
  });

  test("a lone entry is the default whatever it is called", () => {
    expect(connectionFor(configOf({ connections: { cloud } })).name).toBe("cloud");
    expect(harnessFor(configOf({ harnesses: { claude: {} } })).name).toBe("claude");
  });

  test("several entries and none named default is no default at all", () => {
    const config = configOf({ connections: { lab, cloud } });
    const failure = failureOf(() => resolveTarget({ config, layers: [], modelWork: true }));
    expect(failure.code).toBe("LLM_NOT_CONFIGURED");
  });

  test("nothing configured is LLM_NOT_CONFIGURED for model work and AGENT_NOT_CONFIGURED for agent work, both pointing at akm setup", () => {
    const model = failureOf(() => resolveTarget({ config: configOf({}), layers: [], modelWork: true }));
    const agent = failureOf(() => resolveTarget({ config: configOf({}), layers: [] }));
    expect(model.code).toBe("LLM_NOT_CONFIGURED");
    expect(agent.code).toBe("AGENT_NOT_CONFIGURED");
    expect(model.hint()).toContain("akm setup");
    expect(agent.hint()).toContain("akm setup");
  });

  test("model work prefers the default connection and falls back to the default harness", () => {
    const both = configOf({ connections: { default: lab }, harnesses: { claude: {} } });
    expect(resolveTarget({ config: both, layers: [], modelWork: true }).kind).toBe("connection");
    const harnessOnly = configOf({ harnesses: { claude: {} } });
    expect(resolveTarget({ config: harnessOnly, layers: [], modelWork: true }).kind).toBe("harness");
  });

  test("agent work prefers the default harness and falls back to a connection, which akm's own runtime runs over", () => {
    const both = configOf({ connections: { default: lab }, harnesses: { claude: {} } });
    expect(resolveTarget({ config: both, layers: [] }).kind).toBe("harness");
    const connectionOnly = configOf({ connections: { default: lab } });
    expect(resolveTarget({ config: connectionOnly, layers: [] }).kind).toBe("connection");
  });
});

describe("the nearest layer that names a target decides", () => {
  const config = configOf({
    connections: { default: lab, cloud },
    harnesses: { default: { platform: "opencode" }, claude: {} },
  });

  test("a connection name picks that connection, a harness name that harness", () => {
    expect(connectionFor(config, [{ connection: "cloud" }]).name).toBe("cloud");
    expect(harnessFor(config, [{ harness: "claude" }]).name).toBe("claude");
  });

  test("a nearer layer outranks a farther one, and one naming nothing is passed over", () => {
    const layers = [{ connection: "cloud" }, { model: "fast" }, { connection: "default" }, {}];
    expect(connectionFor(config, layers).name).toBe("default");
    expect(connectionFor(config, [{ connection: "cloud" }, { model: "fast" }]).name).toBe("cloud");
  });

  test("the retired engine key is a connection by that name, else a harness", () => {
    expect(connectionFor(config, [{ engine: "cloud" }]).name).toBe("cloud");
    expect(harnessFor(config, [{ engine: "claude" }]).name).toBe("claude");
  });

  test("a name that is not configured warns once and uses the default for the work", () => {
    expect(connectionFor(config, [{ connection: "gone" }]).name).toBe("default");
    expect(connectionFor(config, [{ connection: "gone" }]).name).toBe("default");
    expect(harnessFor(config, [{ harness: "absent" }]).name).toBe("default");
    expect(warnings.filter((w) => w.includes('"gone"'))).toHaveLength(1);
    expect(warnings.filter((w) => w.includes('"absent"'))).toHaveLength(1);
  });
});

describe("the model", () => {
  const config = configOf({ connections: { default: { ...lab, models: { ...lab.models, coder: "qwen3-coder" } } } });

  test("an alias is looked up in the connection's models", () => {
    expect(connectionFor(config, [{ model: "fast" }]).model).toBe("qwen3-8b");
    expect(connectionFor(config, [{ model: "coder" }]).model).toBe("qwen3-coder");
  });

  test("a model entry's own fields are request fields, under the layer's inference", () => {
    const runner = connectionFor(config, [{ model: "reasoning", inference: { maxTokens: 100 } }]);
    expect(runner.model).toBe("glm-5");
    expect(runner.request).toEqual({ reasoning_effort: "high", max_tokens: 100 });
  });

  test("a name that is not an alias anywhere is the exact model", () => {
    expect(connectionFor(config, [{ model: "llama-3.3-70b" }]).model).toBe("llama-3.3-70b");
  });

  test("a known alias the connection lacks, and no request at all, mean its first model", () => {
    const partial = configOf({ connections: { default: { ...cloud }, other: { ...lab, models: { coder: "c" } } } });
    expect(connectionFor(partial, [{ model: "reasoning" }]).model).toBe("cloud-small");
    expect(connectionFor(partial, []).model).toBe("cloud-small");
    // An alias another connection added counts as an alias, so it is not sent as an exact name.
    expect(connectionFor(partial, [{ model: "coder" }]).model).toBe("cloud-small");
  });

  test("the nearest layer's model wins", () => {
    expect(connectionFor(config, [{ model: "fast" }, { model: "balanced" }]).model).toBe("qwen3-32b");
    expect(connectionFor(config, [{ model: "fast" }, {}]).model).toBe("qwen3-8b");
  });

  test("a connection with no models cannot choose one", () => {
    const empty = configOf({ connections: { default: { endpoint: "http://x/v1" } } });
    const failure = failureOf(() => resolveTarget({ config: empty, layers: [], modelWork: true }));
    expect(failure.code).toBe("INVALID_CONFIG_FILE");
    expect(failure.message).toContain("connections.default.models");
  });
});

describe("the request", () => {
  test("is the connection's request fields, then the model entry's, then the layers' inference", () => {
    const config = configOf({
      connections: {
        default: {
          endpoint: "http://lab:8080/v1",
          chat_template_kwargs: { enable_thinking: false },
          temperature: 0.7,
          top_p: 0.9,
          models: { fast: "m", reasoning: { model: "r", temperature: 0.2, reasoning_effort: "high" } },
        },
      },
    });
    expect(connectionFor(config, [{ model: "fast" }]).request).toEqual({
      chat_template_kwargs: { enable_thinking: false },
      temperature: 0.7,
      top_p: 0.9,
    });
    expect(
      connectionFor(config, [{ model: "reasoning" }, { inference: { temperature: 0, maxTokens: 512 } }]).request,
    ).toEqual({
      chat_template_kwargs: { enable_thinking: false },
      temperature: 0,
      top_p: 0.9,
      reasoning_effort: "high",
      max_tokens: 512,
    });
  });

  test("the keys akm owns are not request fields", () => {
    const config = configOf({
      connections: {
        default: {
          ...cloud,
          contextLength: 8192,
          timeoutMs: 1000,
          concurrency: 2,
          temperature: 0.1,
        },
      },
    });
    const runner = connectionFor(config);
    expect(runner.request).toEqual({ temperature: 0.1 });
    expect(runner).toMatchObject({
      apiKey: "$CLOUD_KEY",
      contextLength: 8192,
      concurrency: 2,
      endpoint: cloud.endpoint,
    });
  });

  test("effort is reasoningEffort, in whichever layer and whichever word the nearest layer used", () => {
    const config = configOf({ connections: { default: lab } });
    const request = (layers: UnresolvedExecutionDefaults[]) => connectionFor(config, layers).request;
    expect(request([{ inference: { effort: "low" } }])).toMatchObject({ reasoning_effort: "low" });
    expect(request([{ inference: { reasoningEffort: "low" } }, { inference: { effort: "high" } }])).toMatchObject({
      reasoning_effort: "high",
    });
    expect(request([{ inference: { effort: "high" } }, { inference: { reasoningEffort: "low" } }])).toMatchObject({
      reasoning_effort: "low",
    });
  });

  test("an inference of null clears what the farther layers set", () => {
    const config = configOf({ connections: { default: lab } });
    const runner = connectionFor(config, [{ inference: { temperature: 0.9 } }, { inference: null }]);
    expect(runner.request).toEqual({});
  });

  test("contextLength in a layer's inference outranks the connection's", () => {
    const config = configOf({ connections: { default: { ...lab, contextLength: 8192 } } });
    expect(connectionFor(config).contextLength).toBe(8192);
    expect(connectionFor(config, [{ inference: { contextLength: 4096 } }]).contextLength).toBe(4096);
  });
});

describe("the timeout", () => {
  test("is the nearest layer's, else the connection's, else 600 s", () => {
    const withTimeout = configOf({ connections: { default: { ...lab, timeoutMs: 900_000 } } });
    expect(connectionFor(withTimeout, [{ timeout: "20m" }, { timeout: 5000 }]).timeoutMs).toBe(5000);
    expect(connectionFor(withTimeout, [{ timeout: "20m" }]).timeoutMs).toBe(1_200_000);
    expect(connectionFor(withTimeout, []).timeoutMs).toBe(900_000);
    expect(connectionFor(configOf({ connections: { default: lab } })).timeoutMs).toBe(600_000);
  });

  test("an explicit null is no timeout, not a missing one", () => {
    const withTimeout = configOf({ connections: { default: { ...lab, timeoutMs: 900_000 } } });
    expect(connectionFor(withTimeout, [{ timeout: null }]).timeoutMs).toBeNull();
    expect(connectionFor(withTimeout, [{ timeout: 1000 }, { timeout: null }]).timeoutMs).toBeNull();
  });

  test("a harness running agent work has none unless set; model work on it gets 600 s", () => {
    const config = configOf({ harnesses: { claude: {}, slow: { platform: "claude", timeoutMs: 30_000 } } });
    expect(harnessFor(config, [{ harness: "claude" }]).timeoutMs).toBeNull();
    expect(harnessFor(config, [{ harness: "slow" }]).timeoutMs).toBe(30_000);
    expect(harnessFor(config, [{ harness: "claude" }], true).timeoutMs).toBe(600_000);
    expect(harnessFor(config, [{ harness: "slow" }, { timeout: "1m" }]).timeoutMs).toBe(60_000);
  });

  test("a value that is not a duration is refused", () => {
    for (const bad of [-1, 1.5, "soon", Number.MAX_SAFE_INTEGER]) {
      expect(() => parseTimeout(bad)).toThrow(/Execution timeout/);
    }
    expect(parseTimeout(null)).toBeNull();
    expect(parseTimeout("2h")).toBe(7_200_000);
  });
});

describe("a harness", () => {
  test("takes its platform from its key unless platform says otherwise, and its program from the platform", () => {
    const config = configOf({
      harnesses: {
        claude: {},
        "claude-work": {
          platform: "claude",
          bin: "/opt/claude-work/bin/claude",
          args: ["--print"],
          workspace: "/work",
        },
      },
    });
    const plain = harnessFor(config, [{ harness: "claude" }]);
    expect(plain).toMatchObject({ platform: "claude", bin: "claude" });
    const work = harnessFor(config, [{ harness: "claude-work" }]);
    expect(work).toMatchObject({
      platform: "claude",
      bin: "/opt/claude-work/bin/claude",
      args: ["--print"],
      workspace: "/work",
    });
  });

  test("its models map an alias; the shipped map for claude covers the rest", () => {
    const config = configOf({ harnesses: { claude: { models: { fast: { model: "claude-haiku-custom" } } } } });
    expect(harnessFor(config, [{ model: "fast" }]).model).toBe("claude-haiku-custom");
    expect(harnessFor(config, [{ model: "reasoning" }]).model).toBe("claude-opus-4-7");
    expect(harnessFor(config, [{ model: "claude-exact-1" }]).model).toBe("claude-exact-1");
    expect(warnings).toEqual([]);
  });

  test("a layer that sets model to null passes no model; a connection, which must send one, uses its first", () => {
    const harnesses = configOf({ harnesses: { claude: { models: { fast: "f" } } } });
    expect(harnessFor(harnesses, [{ model: "fast" }, { model: null }]).model).toBeUndefined();
    const connections = configOf({ connections: { default: lab } });
    expect(connectionFor(connections, [{ model: "balanced" }, { model: null }]).model).toBe("qwen3-8b");
  });

  test("with no request it uses its first configured model, or none", () => {
    const named = configOf({ harnesses: { claude: { models: { fast: "f", balanced: "b" } } } });
    expect(harnessFor(named).model).toBe("f");
    expect(harnessFor(configOf({ harnesses: { claude: {} } })).model).toBeUndefined();
  });

  test("an alias it has no model for passes no model, with one notice", () => {
    const config = configOf({ harnesses: { opencode: {} } });
    expect(harnessFor(config, [{ model: "fast" }]).model).toBeUndefined();
    expect(harnessFor(config, [{ model: "fast" }]).model).toBeUndefined();
    expect(warnings.filter((w) => w.includes('"opencode"') && w.includes('"fast"'))).toHaveLength(1);
    // An exact name is not an alias: the harness is handed it.
    expect(harnessFor(config, [{ model: "anthropic/x" }]).model).toBe("anthropic/x");
  });

  test("its default agent is kept on a platform with native agents and ignored, with a notice, elsewhere", () => {
    const config = configOf({
      harnesses: { claude: { agent: "reviewer" }, aider: { agent: "reviewer" } },
    });
    expect(harnessFor(config, [{ harness: "claude" }]).agent).toBe("reviewer");
    expect(harnessFor(config, [{ harness: "aider" }]).agent).toBeUndefined();
    expect(warnings.filter((w) => w.includes('"aider"') && w.includes("agent setting is ignored"))).toHaveLength(1);
  });
});
