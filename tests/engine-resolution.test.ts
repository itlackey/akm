// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { deepMergeConfig } from "../src/core/config/deep-merge";
import { resolveDispatchModel } from "../src/integrations/agent/builder-shared";
import {
  materializeLlmConnection,
  resolveEngine,
  resolveLlmEngineUse,
} from "../src/integrations/agent/engine-resolution";
import { buildSdkConfig } from "../src/integrations/harnesses/opencode-sdk/sdk-runner";

const config = {
  configVersion: "0.9.0",
  engines: {
    fast: {
      kind: "llm" as const,
      endpoint: "https://example.test/v1/chat/completions",
      model: "base-model",
      apiKey: `\${FAST_API_KEY}`,
      extraParams: { seed: 1, nested: { keep: true } },
    },
    reviewer: {
      kind: "agent" as const,
      platform: "pi" as const,
      model: "review-model",
    },
    sdk: {
      kind: "agent" as const,
      platform: "opencode-sdk" as const,
      llmEngine: "fast",
    },
  },
  defaults: { engine: "reviewer", llmEngine: "fast" },
};

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

describe("engine resolution", () => {
  test("projects invocation overrides over one selected LLM engine without resolving its credential", () => {
    const resolved = resolveLlmEngineUse(config, [
      { engine: "fast", llm: { extraParams: { nested: { override: true } }, temperature: 0.1 } },
      { model: "leaf-model", timeoutMs: null },
    ]);

    expect(resolved).toMatchObject({
      engine: "fast",
      timeoutMs: null,
      credential: { names: ["FAST_API_KEY"], required: true },
      connection: {
        endpoint: "https://example.test/v1/chat/completions",
        model: "leaf-model",
        temperature: 0.1,
        extraParams: { seed: 1, nested: { keep: true, override: true } },
      },
    });
    expect(JSON.stringify(resolved)).not.toContain(process.env.FAST_API_KEY ?? "not-set");
  });

  test("materializes an explicit symbolic credential only at dispatch", () => {
    process.env.FAST_API_KEY = "engine-secret";
    const resolved = resolveLlmEngineUse(config, [{ engine: "fast" }]);
    expect(materializeLlmConnection(resolved)?.apiKey).toBe("engine-secret");
  });

  test("revalidates extraParams at the dispatch boundary", () => {
    expect(() =>
      materializeLlmConnection({
        engine: "bypassed-validation",
        connection: {
          endpoint: "https://example.test/v1/chat/completions",
          model: "test",
          extraParams: { nested: [{ Authorization: "leak" }] },
        },
        timeoutMs: null,
      }),
    ).toThrow("cannot carry credentials");
  });

  test("uses the agent platform, rather than the engine name, to lower an SDK engine", () => {
    const resolved = resolveEngine("sdk", config);
    expect(resolved.kind).toBe("sdk");
    if (resolved.kind === "sdk") {
      expect(resolved.engine).toBe("sdk");
      expect(resolved.profile.platform).toBe("opencode-sdk");
      expect(resolved.fallbackConnection?.endpoint).toBe("https://example.test/v1/chat/completions");
    }
  });

  test("applies exact timeout precedence and preserves explicit null in direct HTTP materialization", () => {
    const defaults = resolveLlmEngineUse(config, [{ engine: "fast" }]);
    expect(defaults.timeoutMs).toBe(600_000);
    expect(materializeLlmConnection(defaults).timeoutMs).toBe(600_000);

    const disabled = resolveLlmEngineUse(config, [{ engine: "fast", timeoutMs: null }]);
    expect(disabled.timeoutMs).toBeNull();
    expect(Object.hasOwn(materializeLlmConnection(disabled), "timeoutMs")).toBe(true);
    expect(materializeLlmConnection(disabled).timeoutMs).toBeNull();

    const overridden = resolveLlmEngineUse(
      { ...config, engines: { ...config.engines, fast: { ...config.engines.fast, timeoutMs: 90_000 } } },
      [{ engine: "fast" }, { timeoutMs: 12_000 }],
    );
    expect(overridden.timeoutMs).toBe(12_000);
  });

  test("uses 60s for CLI agents and inherits the fallback LLM timeout for SDK agents", () => {
    const direct = resolveEngine("reviewer", config);
    expect(direct.timeoutMs).toBe(60_000);

    const inherited = resolveEngine("sdk", {
      ...config,
      engines: { ...config.engines, fast: { ...config.engines.fast, timeoutMs: 345_000 } },
    });
    expect(inherited.timeoutMs).toBe(345_000);

    const explicitNull = resolveEngine("sdk", {
      ...config,
      engines: { ...config.engines, sdk: { ...config.engines.sdk, timeoutMs: null } },
    });
    expect(explicitNull.timeoutMs).toBeNull();
  });

  test("does not resolve a lowered agent model through aliases a second time", () => {
    const lowered = resolveEngine("sdk", {
      ...config,
      engines: { ...config.engines, sdk: { ...config.engines.sdk, model: "premium" } },
      modelAliases: {
        premium: { "opencode-sdk": "provider/exact" },
        "provider/exact": { "opencode-sdk": "provider/wrong" },
      },
    });
    if (lowered.kind !== "sdk") throw new Error("fixture must lower to SDK");
    expect(lowered.profile.model).toBe("provider/exact");
    expect(lowered.profile.modelIsExact).toBe(true);
    expect(buildSdkConfig(lowered.profile, lowered.fallbackConnection).model).toBe("akm-custom/provider/exact");
    expect(resolveDispatchModel({ model: "provider/exact", modelIsExact: true }, lowered.profile, "opencode-sdk")).toBe(
      "provider/exact",
    );
  });

  test("canonicalizes a harness alias before agent model lowering", () => {
    const resolved = resolveEngine("legacy-claude", {
      engines: {
        "legacy-claude": { kind: "agent", platform: "claude-code", model: "sonnet" },
      },
    });
    if (resolved.kind !== "agent") throw new Error("fixture must lower to an agent");
    expect(resolved.profile.platform).toBe("claude");
    expect(resolved.profile.bin).toBe("claude");
    expect(resolved.profile.model).toBe("claude-sonnet-4-6");
    expect(resolved.profile.modelIsExact).toBe(true);
  });
});
