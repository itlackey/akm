// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setSecret } from "../src/commands/env/secret";
import * as healthChecks from "../src/commands/health/checks";
import {
  HEALTH_CHECKS,
  runConfiguredEnginesProbe,
  runDefaultEngineProbe,
  runDefaultLlmEngineProbe,
} from "../src/commands/health/checks";
import type { AkmConfig } from "../src/core/config/config";
import { validateConfigShape } from "../src/core/config/config-schema";
import { withIsolatedAkmStorage } from "./_helpers/sandbox";

const llm = {
  kind: "llm" as const,
  endpoint: "https://example.test/v1/chat/completions",
  model: "fallback-model",
};

describe("health engine probes", () => {
  test("shares one availability probe across default, default LLM, and configured projections", async () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: { shared: { kind: "agent", platform: "claude" } },
      defaults: { engine: "shared", llmEngine: "shared" },
    };
    let spawnCalls = 0;

    const probe = (
      healthChecks as unknown as {
        runHealthEngineProbes?: (deps: {
          loadConfig: () => AkmConfig;
          spawnSync: typeof import("node:child_process").spawnSync;
        }) => Promise<{
          defaultEngine: { name: string; status: string };
          defaultLlmEngine: { name: string; status: string };
          configuredEngines: { name: string; status: string; evidence?: unknown };
        }>;
      }
    ).runHealthEngineProbes;
    expect(typeof probe).toBe("function");
    if (!probe) return;

    const result = await probe({
      loadConfig: () => config,
      spawnSync: (() => {
        spawnCalls += 1;
        return { status: 0 };
      }) as never,
    });

    expect(spawnCalls).toBe(1);
    expect(result.defaultEngine).toMatchObject({ name: "default-engine", status: "pass" });
    expect(result.defaultLlmEngine).toMatchObject({ name: "default-llm-engine", status: "pass" });
    expect(result.configuredEngines).toMatchObject({
      name: "configured-engines",
      status: "pass",
      evidence: { engines: [{ engine: "shared", status: "pass" }] },
    });
  });

  test("sanitizes SDK executable probe exceptions, including a NUL bin", async () => {
    const sentinel = "PRIVATE_SDK_BIN_SENTINEL";
    const parsed = validateConfigShape({
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: {
        sdk: { kind: "agent", platform: "opencode-sdk", bin: `${sentinel}\0` },
      },
      defaults: { engine: "sdk" },
    });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));

    const result = await runDefaultEngineProbe({
      loadConfig: () => parsed.value,
      resolvePackage: () => "/sdk/package.json",
      spawnSync: (() => {
        throw new TypeError(`spawn rejected ${sentinel}: raw child output`);
      }) as never,
    });

    expect(result).toEqual({
      name: "default-engine",
      kind: "deterministic",
      status: "warn",
      confidence: "high",
      message: 'SDK engine "sdk" executable availability could not be checked.',
      evidence: { engine: "sdk", runtimeKind: "sdk", binaryAvailable: false },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain("raw child output");
    expect(serialized).not.toContain("NUL");
  });

  test("reports all explicitly configured engine availability in sorted, safe evidence", async () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: {
        zeta: {
          ...llm,
          endpoint: "https://private-zeta.example/v1/chat/completions",
          model: "private-zeta-model",
          apiKey: "$PRIVATE_ZETA_HEALTH_TOKEN",
        },
        alpha: {
          ...llm,
          endpoint: "https://private-alpha.example/v1/chat/completions",
          model: "private-alpha-model",
        },
      },
    };

    const result = await runConfiguredEnginesProbe({ loadConfig: () => config, env: {} });
    expect(result).toEqual({
      name: "configured-engines",
      kind: "deterministic",
      status: "warn",
      confidence: "high",
      message: "1 of 2 explicitly configured engines is unavailable.",
      evidence: {
        engines: [
          { engine: "alpha", status: "pass" },
          { engine: "zeta", status: "warn" },
        ],
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("PRIVATE_ZETA_HEALTH_TOKEN");
    expect(serialized).not.toContain("private-zeta.example");
    expect(serialized).not.toContain("private-alpha.example");
    expect(serialized).not.toContain("private-zeta-model");
    expect(serialized).not.toContain("private-alpha-model");
  });

  test("returns unknown when there are no explicitly configured engines", async () => {
    const config: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "off" };
    expect(await runConfiguredEnginesProbe({ loadConfig: () => config })).toEqual({
      name: "configured-engines",
      kind: "deterministic",
      status: "unknown",
      confidence: "high",
      message: "No engines are explicitly configured.",
      evidence: { engines: [] },
    });
  });

  test("registers aggregate availability after default-llm-engine", () => {
    const names = HEALTH_CHECKS.map((check) => check.name);
    expect(names.indexOf("configured-engines")).toBe(names.indexOf("default-llm-engine") + 1);
    expect(names.indexOf("active-improve-strategy")).toBe(names.indexOf("configured-engines") + 1);
    expect(HEALTH_CHECKS.find((check) => check.name === "configured-engines")?.channel).toBe("hard");
  });

  test("probes defaults.llmEngine independently from the general default", async () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: { fast: llm },
      defaults: { llmEngine: "fast" },
    };
    const general = await runDefaultEngineProbe({ loadConfig: () => config, which: () => undefined });
    const result = await runDefaultLlmEngineProbe({ loadConfig: () => config });
    expect(general.status).toBe("unknown");
    expect(result.status).toBe("pass");
    expect(result.message).toBe('LLM engine "fast" is configured. Reachability was not probed.');
    expect(result.evidence).toMatchObject({ engine: "fast", runtimeKind: "llm", model: "fallback-model" });
  });

  test("accepts the SDK fallback model and reports it as the effective model", async () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: {
        sdk: { kind: "agent", platform: "opencode-sdk", bin: "opencode-test", llmEngine: "fallback" },
        fallback: llm,
      },
      defaults: { engine: "sdk", llmEngine: "fallback" },
    };
    const inheritedModel = await runDefaultEngineProbe({
      loadConfig: () => config,
      resolvePackage: () => "/sdk/package.json",
      spawnSync: (() => ({ status: 0 })) as never,
    });
    expect(inheritedModel.status).toBe("pass");
    expect(inheritedModel.message).toBe('SDK engine "sdk" is available. Reachability was not probed.');
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
    const ready = await runDefaultEngineProbe({
      loadConfig: () => readyConfig,
      resolvePackage: () => "/sdk/package.json",
      spawnSync: (() => ({ status: 0 })) as never,
    });
    expect(ready.status).toBe("pass");
    expect(ready.message).toBe('SDK engine "sdk" is available. Reachability was not probed.');
    expect(ready.evidence).toMatchObject({ model: "sdk-model", configuredModel: "sdk-model", modelSource: "sdk" });
  });

  test("reports SDK package and binary failures independently", async () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: {
        sdk: { kind: "agent", platform: "opencode-sdk", model: "sdk-model", llmEngine: "fallback" },
        fallback: llm,
      },
      defaults: { engine: "sdk", llmEngine: "fallback" },
    };
    const result = await runDefaultEngineProbe({
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

  test("accepts native OpenCode SDK configuration without an AKM LLM fallback", async () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: { sdk: { kind: "agent", platform: "opencode-sdk", model: "sdk-model" } },
      defaults: { engine: "sdk" },
    };
    const result = await runDefaultEngineProbe({
      loadConfig: () => config,
      spawnSync: (() => ({ status: 0 })) as never,
    });
    expect(result.status).toBe("pass");
    expect(result.message).toBe('SDK engine "sdk" is available.');
    expect(result.evidence).toMatchObject({
      packageAvailable: true,
      binaryAvailable: true,
      model: "sdk-model",
      fallbackEngine: null,
    });
  });

  test("warns when an explicitly configured SDK fallback cannot be resolved", async () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: { sdk: { kind: "agent", platform: "opencode-sdk", llmEngine: "missing" } },
      defaults: { engine: "sdk" },
    };
    const result = await runDefaultEngineProbe({
      loadConfig: () => config,
      resolvePackage: () => "/sdk/package.json",
      spawnSync: (() => ({ status: 0 })) as never,
    });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("configured fallback LLM connection");
  });

  test("reports an unavailable required LLM credential without exposing its name", async () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: {
        agent: { kind: "agent", platform: "claude" },
        improve: { ...llm, apiKey: "$PRIVATE_IMPROVE_TOKEN" },
      },
      defaults: { engine: "agent", llmEngine: "improve" },
    };
    const general = await runDefaultEngineProbe({
      loadConfig: () => config,
      spawnSync: (() => ({ status: 0 })) as never,
      env: {},
    });
    const improve = await runDefaultLlmEngineProbe({ loadConfig: () => config, env: {} });
    expect(general.status).toBe("pass");
    expect(improve.status).toBe("warn");
    expect(improve.message).toContain("required credential is unavailable");
    expect(JSON.stringify(improve)).not.toContain("PRIVATE_IMPROVE_TOKEN");
  });

  test("#950: names the env asset that supplies an unavailable required credential, never the variable name", async () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: { improve: { ...llm, apiKey: "$PRIVATE_IMPROVE_TOKEN" } },
      defaults: { llmEngine: "improve" },
    };
    const improve = await runDefaultLlmEngineProbe({
      loadConfig: () => config,
      env: {},
      listEnvAssets: () => [{ ref: "env/lab", path: "/stash/env/lab.env", keys: ["PRIVATE_IMPROVE_TOKEN"] }],
    });
    expect(improve.status).toBe("warn");
    expect(improve.message).toContain("env/lab");
    expect(improve.message).toContain("akm env run env/lab");
    expect(improve.evidence?.suppliedByEnvAsset).toBe("env/lab");
    expect(JSON.stringify(improve)).not.toContain("PRIVATE_IMPROVE_TOKEN");
  });

  test("#950: no matching env asset keeps the generic unavailable message and a null suppliedByEnvAsset", async () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: { improve: { ...llm, apiKey: "$PRIVATE_IMPROVE_TOKEN" } },
      defaults: { llmEngine: "improve" },
    };
    const improve = await runDefaultLlmEngineProbe({
      loadConfig: () => config,
      env: {},
      listEnvAssets: () => [{ ref: "env/other", path: "/stash/env/other.env", keys: ["SOME_OTHER_VAR"] }],
    });
    expect(improve.status).toBe("warn");
    expect(improve.message).toContain("required credential is unavailable");
    expect(improve.evidence?.suppliedByEnvAsset).toBeNull();
  });

  test("#950: SDK engine names the env asset that supplies its missing fallback credential", async () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: {
        sdk: { kind: "agent", platform: "opencode-sdk", llmEngine: "improve" },
        improve: { ...llm, apiKey: "$PRIVATE_IMPROVE_TOKEN" },
      },
      defaults: { engine: "sdk" },
    };
    const result = await runDefaultEngineProbe({
      loadConfig: () => config,
      resolvePackage: () => "/sdk/package.json",
      spawnSync: (() => ({ status: 0 })) as never,
      env: {},
      listEnvAssets: () => [{ ref: "env/lab", path: "/stash/env/lab.env", keys: ["PRIVATE_IMPROVE_TOKEN"] }],
    });
    expect(result.status).toBe("warn");
    expect(result.message).toContain('SDK engine "sdk" is incomplete: missing');
    expect(result.message).toContain("env/lab");
    expect(result.message).toContain("akm env run env/lab");
    expect(result.evidence).toMatchObject({ suppliedByEnvAsset: "env/lab" });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_IMPROVE_TOKEN");
  });

  test("#950: walks env assets at most once per probe run across multiple engines with missing credentials", async () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: {
        improve: { ...llm, apiKey: "$PRIVATE_IMPROVE_TOKEN" },
        distill: { ...llm, endpoint: "https://example.test/v2/chat/completions", apiKey: "$PRIVATE_DISTILL_TOKEN" },
      },
    };
    let calls = 0;
    const result = await runConfiguredEnginesProbe({
      loadConfig: () => config,
      env: {},
      listEnvAssets: () => {
        calls += 1;
        return [];
      },
    });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("2 of 2");
    expect(calls).toBe(1);
  });

  test("#950: the default listEnvAssets seam honours the injected loadConfig, not the real one", async () => {
    const labStashDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-health-lab-"));
    fs.mkdirSync(path.join(labStashDir, "env"), { recursive: true });
    fs.writeFileSync(path.join(labStashDir, "env", "lab.env"), "PRIVATE_IMPROVE_TOKEN=secret\n", "utf8");
    try {
      const config: AkmConfig = {
        configVersion: "0.9.0",
        semanticSearchMode: "off",
        engines: { improve: { ...llm, apiKey: "$PRIVATE_IMPROVE_TOKEN" } },
        defaults: { llmEngine: "improve" },
        bundles: { lab: { path: labStashDir } },
        defaultBundle: "lab",
      };
      // No listEnvAssets seam injected: this exercises the default seam,
      // which must walk the *injected* config's bundles, not the real
      // (sandboxed, unrelated) HOME/XDG config `loadConfig()` would read.
      const result = await runDefaultLlmEngineProbe({ loadConfig: () => config, env: {} });
      expect(result.status).toBe("warn");
      expect(result.evidence?.suppliedByEnvAsset).toBe("env/lab");
      expect(JSON.stringify(result)).not.toContain("PRIVATE_IMPROVE_TOKEN");
    } finally {
      fs.rmSync(labStashDir, { recursive: true, force: true });
    }
  });

  test("a secret:// engine reports available only when the store resolves it (#953)", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      const config: AkmConfig = {
        configVersion: "0.9.0",
        semanticSearchMode: "off",
        engines: {
          agent: { kind: "agent", platform: "claude" },
          improve: { ...llm, apiKey: "secret://953-health-probe-key" },
        },
        defaults: { engine: "agent", llmEngine: "improve" },
      };

      const unavailable = await runDefaultLlmEngineProbe({ loadConfig: () => config, env: {} });
      expect(unavailable.status).toBe("warn");
      expect(unavailable.message).toContain("required credential is unavailable");

      setSecret(path.join(storage.stashDir, "secrets", "953-health-probe-key"), Buffer.from("health-probe-secret"));
      const available = await runDefaultLlmEngineProbe({ loadConfig: () => config, env: {} });
      expect(available.status).not.toBe("warn");
      expect(JSON.stringify(available)).not.toContain("health-probe-secret");
    } finally {
      storage.cleanup();
    }
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

  test("disabled triage judgment neither requires credentials nor appears unavailable", () => {
    const parsed = validateConfigShape({
      configVersion: "0.9.0",
      engines: {
        ready: llm,
        private: { ...llm, apiKey: "$PRIVATE_DISABLED_JUDGMENT_TOKEN" },
      },
      defaults: { llmEngine: "ready", improveStrategy: "disabled-triage-health" },
      improve: {
        strategies: {
          "disabled-triage-health": {
            processes: { triage: { enabled: true, judgment: { enabled: false, engine: "private" } } },
          },
        },
      },
    });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));

    const result = healthChecks.runActiveImproveStrategyProbe({ loadConfig: () => parsed.value, env: {} });

    expect(result.status).toBe("pass");
    expect(result.message).not.toContain("triage.judgment");
    expect(result.evidence).toMatchObject({ strategy: "disabled-triage-health", unavailableProcesses: [] });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_DISABLED_JUDGMENT_TOKEN");
  });

  test("names the resolved engine per process on the active-improve-strategy probe (#913)", () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: { lab: llm, default: { ...llm, endpoint: "https://default.example/v1/chat/completions" } },
      defaults: { llmEngine: "default", improveStrategy: "pinned" },
      improve: {
        strategies: {
          pinned: { processes: { extract: { enabled: true, engine: "lab" } } },
        },
      },
    };

    const result = healthChecks.runActiveImproveStrategyProbe({ loadConfig: () => config, env: {} });

    expect(result.status).toBe("pass");
    expect(result.evidence).toMatchObject({ engines: { extract: "lab" } });
    expect(result.message).toContain('extract: "lab"');
  });

  test("fails when every enabled LLM-backed process of the active strategy is unavailable (#957)", () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      // No credentialed fallback engine anywhere — every default-strategy
      // process that needs an LLM engine resolves to "private", whose
      // credential is not in `env`. proactiveMaintenance stays enabled (it
      // has no engine capability) so the plan does not hit the separate
      // ALL-disabled ConfigError guard.
      engines: { private: { ...llm, apiKey: "$PRIVATE_ALL_UNAVAILABLE_TOKEN" } },
      defaults: { llmEngine: "private" },
      improve: {
        strategies: {
          default: { processes: { proactiveMaintenance: { enabled: true } } },
        },
      },
    };

    const result = healthChecks.runActiveImproveStrategyProbe({ loadConfig: () => config, env: {} });

    expect(result.status).toBe("fail");
    expect(result.message).toContain("no-op");
    expect(result.evidence).toMatchObject({
      strategy: "default",
      unavailableProcesses: expect.arrayContaining(["reflect", "distill", "consolidate", "validation"]),
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_ALL_UNAVAILABLE_TOKEN");
  });

  test("fails for the shipped default strategy with no non-LLM process enabled and every LLM engine credential-unavailable (#957 round 2)", () => {
    // Reproduces the issue's exact scenario: the *unmodified* default
    // strategy (proactiveMaintenance and triage left disabled, as shipped —
    // no `improve.strategies` override at all) with every capability:"llm"
    // process pointed at a credential-unavailable engine. This used to trip
    // buildImprovePlan's ALL-disabled ConfigError guard (every process ends
    // up disabled, not just the LLM-backed ones), which made
    // `resolveImprovePlan` throw and fall into the probe's catch block —
    // regressing this exact case from `warn` to `unknown`/`warn` with a
    // misleading "engine that is not configured" message instead of the
    // accurate credential-unavailable `fail`.
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: { private: { ...llm, apiKey: "$PRIVATE_DEFAULT_STRATEGY_TOKEN" } },
      defaults: { llmEngine: "private" },
    };

    const result = healthChecks.runActiveImproveStrategyProbe({ loadConfig: () => config, env: {} });

    expect(result.status).toBe("fail");
    expect(result.message).toContain("no-op");
    expect(result.message).not.toContain("is unavailable:");
    expect(result.evidence).toMatchObject({
      strategy: "default",
      unavailableProcesses: expect.arrayContaining(["reflect", "distill", "consolidate", "graphExtraction"]),
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_DEFAULT_STRATEGY_TOKEN");
  });

  test("fails when only LLM-backed processes are enabled and nothing else — every one named in unavailableProcesses (#957 addendum)", () => {
    // Unlike the #957 (proactiveMaintenance stays enabled) and #957 round 2
    // (relies on memoryInference silently disappearing via the autonomy gate)
    // cases above, this pins the strategy explicitly: every LLM-backed
    // process this strategy could enable is enabled and shares the single
    // credential-unavailable "private" engine; every non-LLM-backed process
    // (proactiveMaintenance, triage) and the autonomy-gated memoryInference
    // lane are explicitly off, so nothing is left to keep the check at warn.
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: { private: { ...llm, apiKey: "$PRIVATE_ONLY_LLM_TOKEN" } },
      defaults: { llmEngine: "private" },
      improve: {
        strategies: {
          default: {
            processes: {
              reflect: { enabled: true },
              distill: { enabled: true },
              consolidate: { enabled: true },
              graphExtraction: { enabled: true },
              validation: { enabled: true },
              memoryInference: { enabled: false },
              extract: { enabled: false },
              proactiveMaintenance: { enabled: false },
              triage: { enabled: false },
            },
          },
        },
      },
    };

    const result = healthChecks.runActiveImproveStrategyProbe({ loadConfig: () => config, env: {} });

    expect(result.status).toBe("fail");
    expect(result.message).toContain("no-op");
    const evidence = result.evidence as { strategy: string; unavailableProcesses: string[] };
    expect(evidence.strategy).toBe("default");
    expect([...evidence.unavailableProcesses].sort()).toEqual(
      ["consolidate", "distill", "graphExtraction", "reflect", "validation"].sort(),
    );
    expect(JSON.stringify(result)).not.toContain("PRIVATE_ONLY_LLM_TOKEN");
  });
});

describe("health engine reachability probe (#914)", () => {
  test("reports reachable when the probe seam confirms connectivity", async () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: { fast: llm },
      defaults: { llmEngine: "fast" },
    };
    const result = await runDefaultLlmEngineProbe({
      loadConfig: () => config,
      probeReachable: async () => ({ reachable: true }),
    });
    expect(result.status).toBe("pass");
    expect(result.message).toBe('LLM engine "fast" is configured and reachable.');
    expect(result.evidence).toMatchObject({ probed: true, reachable: true });
  });

  test("fails default-llm-engine with the probe's error text when the endpoint refuses", async () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: { fast: llm },
      defaults: { llmEngine: "fast" },
    };
    const result = await runDefaultLlmEngineProbe({
      loadConfig: () => config,
      probeReachable: async () => ({ reachable: false, error: "connection refused" }),
    });
    expect(result.status).toBe("fail");
    expect(result.message).toBe('LLM engine "fast" is not reachable: connection refused');
    expect(result.evidence).toMatchObject({ probed: true, reachable: false, error: "connection refused" });
  });

  test("warns (not fails) a non-default configured engine that refuses connections", async () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: { backup: llm },
    };
    const result = await runConfiguredEnginesProbe({
      loadConfig: () => config,
      probeReachable: async () => ({ reachable: false, error: "connection refused" }),
    });
    expect(result.status).toBe("warn");
    expect(result.evidence).toMatchObject({ engines: [{ engine: "backup", status: "warn" }] });
  });

  test("skips the probe and notes it when the seam is absent", async () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: { fast: llm },
      defaults: { llmEngine: "fast" },
    };
    const result = await runDefaultLlmEngineProbe({ loadConfig: () => config });
    expect(result.status).toBe("pass");
    expect(result.message).toBe('LLM engine "fast" is configured. Reachability was not probed.');
    expect(result.evidence).toMatchObject({ probed: false, reachable: null });
  });

  test("does not probe when the required credential is unavailable", async () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: { improve: { ...llm, apiKey: "$PRIVATE_NO_PROBE_TOKEN" } },
      defaults: { llmEngine: "improve" },
    };
    let probeCalls = 0;
    const result = await runDefaultLlmEngineProbe({
      loadConfig: () => config,
      env: {},
      probeReachable: async () => {
        probeCalls += 1;
        return { reachable: true };
      },
    });
    expect(probeCalls).toBe(0);
    expect(result.status).toBe("warn");
    expect(result.message).toContain("required credential is unavailable");
  });

  test("probes a shared endpoint once across default-llm-engine and configured-engines", async () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: { primary: llm, mirror: { ...llm } },
      defaults: { llmEngine: "primary" },
    };
    let probeCalls = 0;
    const result = await healthChecks.runHealthEngineProbes({
      loadConfig: () => config,
      probeReachable: async () => {
        probeCalls += 1;
        return { reachable: true };
      },
    });
    expect(probeCalls).toBe(1);
    expect(result.defaultLlmEngine.status).toBe("pass");
    expect(result.configuredEngines.status).toBe("pass");
  });

  test("escalates an unreachable default-llm-engine to fail while the same probe warns as configured-engines", async () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: { down: llm },
      defaults: { llmEngine: "down" },
    };
    const result = await healthChecks.runHealthEngineProbes({
      loadConfig: () => config,
      probeReachable: async () => ({ reachable: false, error: "connection refused" }),
    });
    expect(result.defaultLlmEngine.status).toBe("fail");
    expect(result.defaultLlmEngine.message).toContain("connection refused");
    expect(result.configuredEngines.status).toBe("warn");
  });

  test("probes an SDK engine's LLM fallback connection", async () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      engines: {
        sdk: { kind: "agent", platform: "opencode-sdk", bin: "opencode-test", llmEngine: "fallback" },
        fallback: llm,
      },
      defaults: { engine: "sdk", llmEngine: "fallback" },
    };
    const result = await runDefaultEngineProbe({
      loadConfig: () => config,
      resolvePackage: () => "/sdk/package.json",
      spawnSync: (() => ({ status: 0 })) as never,
      probeReachable: async () => ({ reachable: false, error: "ECONNREFUSED" }),
    });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("its LLM fallback is not reachable: ECONNREFUSED");
    expect(result.evidence).toMatchObject({ probed: true, reachable: false });
  });
});
