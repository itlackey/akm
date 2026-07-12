// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import * as healthChecks from "../src/commands/health/checks";
import { runDefaultEngineProbe, runDefaultLlmEngineProbe } from "../src/commands/health/checks";
import type { AkmConfig } from "../src/core/config/config";

const llm = {
  kind: "llm" as const,
  endpoint: "https://example.test/v1/chat/completions",
  model: "fallback-model",
};

describe("health engine probes", () => {
  test("probes defaults.llmEngine independently from the general default", () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: { fast: llm },
      defaults: { llmEngine: "fast" },
    };
    const general = runDefaultEngineProbe({ loadConfig: () => config });
    const result = runDefaultLlmEngineProbe({ loadConfig: () => config });
    expect(general.status).toBe("unknown");
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
    const inheritedModel = runDefaultEngineProbe({
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
    const ready = runDefaultEngineProbe({
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
    const result = runDefaultEngineProbe({
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

  test("accepts native OpenCode SDK configuration without an AKM LLM fallback", () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: { sdk: { kind: "agent", platform: "opencode-sdk", model: "sdk-model" } },
      defaults: { engine: "sdk" },
    };
    const result = runDefaultEngineProbe({
      loadConfig: () => config,
      resolvePackage: () => "/sdk/package.json",
      spawnSync: (() => ({ status: 0 })) as never,
    });
    expect(result.status).toBe("pass");
    expect(result.evidence).toMatchObject({
      packageAvailable: true,
      binaryAvailable: true,
      model: "sdk-model",
      fallbackEngine: null,
    });
  });

  test("warns when an explicitly configured SDK fallback cannot be resolved", () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: { sdk: { kind: "agent", platform: "opencode-sdk", llmEngine: "missing" } },
      defaults: { engine: "sdk" },
    };
    const result = runDefaultEngineProbe({
      loadConfig: () => config,
      resolvePackage: () => "/sdk/package.json",
      spawnSync: (() => ({ status: 0 })) as never,
    });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("configured fallback LLM connection");
  });

  test("reports an unavailable required LLM credential without exposing its name", () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: {
        agent: { kind: "agent", platform: "claude" },
        improve: { ...llm, apiKey: "$PRIVATE_IMPROVE_TOKEN" },
      },
      defaults: { engine: "agent", llmEngine: "improve" },
    };
    const general = runDefaultEngineProbe({
      loadConfig: () => config,
      spawnSync: (() => ({ status: 0 })) as never,
      env: {},
    });
    const improve = runDefaultLlmEngineProbe({ loadConfig: () => config, env: {} });
    expect(general.status).toBe("pass");
    expect(improve.status).toBe("warn");
    expect(improve.message).toContain("required credential is unavailable");
    expect(JSON.stringify(improve)).not.toContain("PRIVATE_IMPROVE_TOKEN");
  });

  test("warns when an enabled active improve process lacks its required credential", () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: {
        ready: llm,
        private: { ...llm, apiKey: "$PRIVATE_REFLECT_TOKEN" },
      },
      defaults: { llmEngine: "ready", improveStrategy: "health-test" },
      improve: {
        strategies: {
          "health-test": { processes: { reflect: { enabled: true, engine: "private" } } },
        },
      },
    };
    const probe = (
      healthChecks as unknown as {
        runActiveImproveStrategyProbe: (deps: { loadConfig: () => AkmConfig; env: NodeJS.ProcessEnv }) => {
          status: string;
          message: string;
          evidence?: unknown;
        };
      }
    ).runActiveImproveStrategyProbe;
    expect(typeof probe).toBe("function");

    const result = probe({ loadConfig: () => config, env: {} });

    expect(result.status).toBe("warn");
    expect(result.message).toContain("reflect");
    expect(result.evidence).toMatchObject({ strategy: "health-test", unavailableProcesses: ["reflect"] });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_REFLECT_TOKEN");
  });

  test("warns when SDK triage judgment lacks its required fallback credential", () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: {
        ready: llm,
        fallback: { ...llm, apiKey: "$PRIVATE_SDK_FALLBACK_TOKEN" },
        reviewer: { kind: "agent", platform: "opencode-sdk", model: "review", llmEngine: "fallback" },
      },
      defaults: { llmEngine: "ready", improveStrategy: "sdk-triage-health" },
      improve: {
        strategies: {
          "sdk-triage-health": {
            processes: { triage: { enabled: true, judgment: { engine: "reviewer" } } },
          },
        },
      },
    };

    const result = healthChecks.runActiveImproveStrategyProbe({ loadConfig: () => config, env: {} });

    expect(result.status).toBe("warn");
    expect(result.message).toContain("triage.judgment");
    expect(result.evidence).toMatchObject({
      strategy: "sdk-triage-health",
      unavailableProcesses: ["triage.judgment"],
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SDK_FALLBACK_TOKEN");
  });
});
