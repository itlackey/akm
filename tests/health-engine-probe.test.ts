// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { runAgentProbe } from "../src/commands/health/checks";
import type { AkmConfig } from "../src/core/config/config";

const llm = {
  kind: "llm" as const,
  endpoint: "https://example.test/v1/chat/completions",
  model: "fallback-model",
};

describe("health engine probes", () => {
  test("probes defaults.llmEngine when no general default engine is selected", () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: { fast: llm },
      defaults: { llmEngine: "fast" },
    };
    const result = runAgentProbe({ loadConfig: () => config });
    expect(result.status).toBe("pass");
    expect(result.message).toBe('LLM engine "fast" is configured.');
    expect(result.evidence).toMatchObject({ engine: "fast", runtimeKind: "llm", model: "fallback-model" });
  });

  test("accepts the SDK fallback model and reports it as the effective model", () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: {
        sdk: { kind: "agent", platform: "opencode-sdk", bin: "opencode-test", llmEngine: "fallback" },
        fallback: llm,
      },
      defaults: { engine: "sdk", llmEngine: "fallback" },
    };
    const inheritedModel = runAgentProbe({
      loadConfig: () => config,
      resolvePackage: () => "/sdk/package.json",
      spawnSync: (() => ({ status: 0 })) as never,
    });
    expect(inheritedModel.status).toBe("pass");
    expect(inheritedModel.message).toBe('SDK engine "sdk" is available.');
    expect(inheritedModel.evidence).toMatchObject({
      binary: "opencode-test",
      binaryAvailable: true,
      packageAvailable: true,
      fallbackEngine: "fallback",
      fallbackModel: "fallback-model",
      model: "fallback-model",
      configuredModel: null,
      modelSource: "fallback",
    });

    const readyConfig: AkmConfig = {
      ...config,
      engines: {
        ...config.engines,
        sdk: { ...config.engines?.sdk, kind: "agent", platform: "opencode-sdk", model: "sdk-model" },
      },
    };
    const ready = runAgentProbe({
      loadConfig: () => readyConfig,
      resolvePackage: () => "/sdk/package.json",
      spawnSync: (() => ({ status: 0 })) as never,
    });
    expect(ready.status).toBe("pass");
    expect(ready.message).toBe('SDK engine "sdk" is available.');
    expect(ready.evidence).toMatchObject({ model: "sdk-model", configuredModel: "sdk-model", modelSource: "sdk" });
  });

  test("reports SDK package and binary failures independently", () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: {
        sdk: { kind: "agent", platform: "opencode-sdk", model: "sdk-model", llmEngine: "fallback" },
        fallback: llm,
      },
      defaults: { engine: "sdk", llmEngine: "fallback" },
    };
    const result = runAgentProbe({
      loadConfig: () => config,
      resolvePackage: () => {
        throw new Error("missing");
      },
      spawnSync: (() => ({ status: 1 })) as never,
    });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("@opencode-ai/sdk package");
    expect(result.message).toContain("opencode binary");
  });

  test("reports a missing SDK fallback without suppressing the other probes", () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: { sdk: { kind: "agent", platform: "opencode-sdk", model: "sdk-model" } },
      defaults: { engine: "sdk" },
    };
    const result = runAgentProbe({
      loadConfig: () => config,
      resolvePackage: () => "/sdk/package.json",
      spawnSync: (() => ({ status: 0 })) as never,
    });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("fallback LLM connection");
    expect(result.evidence).toMatchObject({
      packageAvailable: true,
      binaryAvailable: true,
      model: "sdk-model",
      fallbackEngine: null,
    });
  });
});
