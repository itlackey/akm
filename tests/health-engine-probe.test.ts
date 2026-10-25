// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as healthChecks from "../src/commands/health/checks";
import {
  HEALTH_CHECKS,
  runConfiguredEnginesProbe,
  runDefaultEngineProbe,
  runDefaultLlmEngineProbe,
} from "../src/commands/health/checks";
import type { AkmConfig } from "../src/core/config/config";
import { validateConfigShape } from "../src/core/config/config-schema";

const lab = {
  endpoint: "https://example.test/v1/chat/completions",
  models: { fast: "fallback-model" },
};

describe("health engine probes", () => {
  test("shares one availability probe across default, default LLM, and configured projections", async () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      harnesses: { shared: { platform: "claude" } },
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

  test("reports all explicitly configured engine availability in sorted, safe evidence", async () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      connections: {
        zeta: {
          endpoint: "https://private-zeta.example/v1/chat/completions",
          models: { fast: "private-zeta-model" },
          apiKey: "$PRIVATE_ZETA_HEALTH_TOKEN",
        },
        alpha: {
          endpoint: "https://private-alpha.example/v1/chat/completions",
          models: { fast: "private-alpha-model" },
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

  test("probes the default connection independently from the default harness", async () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      connections: { fast: lab },
      harnesses: { claude: {} },
    };
    const general = await runDefaultEngineProbe({
      loadConfig: () => config,
      spawnSync: (() => ({ status: 0 })) as never,
    });
    const result = await runDefaultLlmEngineProbe({ loadConfig: () => config });
    // Agent work prefers the default harness; model work, the default connection.
    expect(general.status).toBe("pass");
    expect(general.evidence).toMatchObject({ engine: "claude", runtimeKind: "harness" });
    expect(result.status).toBe("pass");
    expect(result.message).toBe('Connection "fast" is configured. Reachability was not probed.');
    expect(result.evidence).toMatchObject({ engine: "fast", runtimeKind: "connection", model: "fallback-model" });
  });

  test("with only a connection, agent work is probed on it: akm's own runtime runs there", async () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      connections: { fast: lab },
    };
    const general = await runDefaultEngineProbe({ loadConfig: () => config });
    expect(general.status).toBe("pass");
    expect(general.evidence).toMatchObject({ engine: "fast", runtimeKind: "connection" });
  });

  test("with nothing configured both default probes are unknown", async () => {
    const config: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "off" };
    expect((await runDefaultEngineProbe({ loadConfig: () => config })).status).toBe("unknown");
    expect((await runDefaultLlmEngineProbe({ loadConfig: () => config })).status).toBe("unknown");
  });

  test("reports an unavailable key without exposing its name", async () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      connections: { improve: { ...lab, apiKey: "$PRIVATE_IMPROVE_TOKEN" } },
      harnesses: { agent: { platform: "claude" } },
    };
    const general = await runDefaultEngineProbe({
      loadConfig: () => config,
      spawnSync: (() => ({ status: 0 })) as never,
      env: {},
    });
    const improve = await runDefaultLlmEngineProbe({ loadConfig: () => config, env: {} });
    expect(general.status).toBe("pass");
    expect(improve.status).toBe("warn");
    expect(improve.message).toContain("its key is unavailable");
    expect(JSON.stringify(improve)).not.toContain("PRIVATE_IMPROVE_TOKEN");
  });

  test("a key that is set is available", async () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      connections: { improve: { ...lab, apiKey: "$PRIVATE_IMPROVE_TOKEN" } },
    };
    const improve = await runDefaultLlmEngineProbe({ loadConfig: () => config, env: { PRIVATE_IMPROVE_TOKEN: "x" } });
    expect(improve.status).toBe("pass");
    expect(improve.evidence).toMatchObject({ requiredCredentialAvailable: true });
  });

  test("#950: names the env asset that supplies an unavailable key, never the variable name", async () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      connections: { improve: { ...lab, apiKey: "$PRIVATE_IMPROVE_TOKEN" } },
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
      connections: { improve: { ...lab, apiKey: "$PRIVATE_IMPROVE_TOKEN" } },
    };
    const improve = await runDefaultLlmEngineProbe({
      loadConfig: () => config,
      env: {},
      listEnvAssets: () => [{ ref: "env/other", path: "/stash/env/other.env", keys: ["SOME_OTHER_VAR"] }],
    });
    expect(improve.status).toBe("warn");
    expect(improve.message).toContain("its key is unavailable");
    expect(improve.evidence?.suppliedByEnvAsset).toBeNull();
  });

  test("#950: walks env assets at most once per probe run across multiple connections with missing keys", async () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      connections: {
        improve: { ...lab, apiKey: "$PRIVATE_IMPROVE_TOKEN" },
        distill: { ...lab, endpoint: "https://example.test/v2/chat/completions", apiKey: "$PRIVATE_DISTILL_TOKEN" },
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
        connections: { improve: { ...lab, apiKey: "$PRIVATE_IMPROVE_TOKEN" } },
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

  test("warns when an enabled active improve process has no connection or harness", () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      improve: {
        strategy: "health-test",
        strategies: {
          // Triage needs no connection, so it keeps the plan alive; reflect has nothing to run on.
          "health-test": { processes: { reflect: { enabled: true }, triage: { enabled: true } } },
        },
      },
    };

    const result = healthChecks.runActiveImproveStrategyProbe({ loadConfig: () => config, env: {} });

    expect(result.status).toBe("warn");
    expect(result.message).toContain("reflect");
    expect(result.evidence).toMatchObject({
      strategy: "health-test",
      unavailableProcesses: expect.arrayContaining(["reflect"]),
    });
  });

  test("disabled triage judgment neither requires a connection nor appears unavailable", () => {
    const parsed = validateConfigShape({
      configVersion: "0.9.0",
      connections: {
        default: lab,
        private: { ...lab, apiKey: "$PRIVATE_DISABLED_JUDGMENT_TOKEN" },
      },
      improve: {
        strategy: "disabled-triage-health",
        strategies: {
          "disabled-triage-health": {
            processes: { triage: { enabled: true, judgment: { enabled: false, connection: "private" } } },
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

  test("names the resolved connection per process on the active-improve-strategy probe (#913)", () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      connections: { lab, default: { ...lab, endpoint: "https://default.example/v1/chat/completions" } },
      improve: {
        strategy: "pinned",
        strategies: {
          pinned: { processes: { extract: { enabled: true, connection: "lab" } } },
        },
      },
    };

    const result = healthChecks.runActiveImproveStrategyProbe({ loadConfig: () => config, env: {} });

    expect(result.status).toBe("pass");
    expect(result.evidence).toMatchObject({ engines: { extract: "lab" } });
    expect(result.message).toContain('extract: "lab"');
  });

  test("warns, naming the processes, when every enabled model-calling process of a chosen strategy has no connection or harness (#957)", () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      // Nothing configured. proactiveMaintenance stays enabled (it has no engine
      // capability) so the plan does not hit the separate ALL-disabled guard.
      improve: {
        strategies: {
          default: { processes: { proactiveMaintenance: { enabled: true } } },
        },
      },
    };

    const result = healthChecks.runActiveImproveStrategyProbe({ loadConfig: () => config, env: {} });

    expect(result.status).toBe("warn");
    expect(result.message).toContain("no-op");
    expect(result.evidence).toMatchObject({
      strategy: "default",
      unavailableProcesses: expect.arrayContaining(["reflect", "distill", "consolidate", "validation"]),
    });
  });

  test("is unknown for the shipped default strategy on an install with nothing configured yet (#957 round 2)", () => {
    const config: AkmConfig = { configVersion: "0.9.0", semanticSearchMode: "off" };

    const result = healthChecks.runActiveImproveStrategyProbe({ loadConfig: () => config, env: {} });

    expect(result.status).toBe("unknown");
    expect(result.message).toContain("no-op");
    expect(result.evidence).toMatchObject({
      strategy: "default",
      unavailableProcesses: expect.arrayContaining(["reflect", "distill", "consolidate"]),
    });
  });

  test("a chosen strategy that could run nothing at all is unavailable, not a no-op (#957 addendum)", () => {
    // Every model-calling process is enabled and nothing else is: with no connection or harness
    // the plan cannot run anything, so the probe reports the plan's own refusal.
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      improve: {
        strategy: "only-models",
        strategies: {
          "only-models": {
            processes: {
              reflect: { enabled: true },
              distill: { enabled: true },
              consolidate: { enabled: true },
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

    expect(result.status).toBe("warn");
    expect(result.message).toContain("No improve process can run");
    expect(result.evidence).toMatchObject({ strategy: "only-models" });
  });
});

describe("health engine reachability probe (#914)", () => {
  test("reports reachable when the probe seam confirms connectivity", async () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      connections: { fast: lab },
    };
    const result = await runDefaultLlmEngineProbe({
      loadConfig: () => config,
      probeReachable: async () => ({ reachable: true }),
    });
    expect(result.status).toBe("pass");
    expect(result.message).toBe('Connection "fast" is configured and reachable.');
    expect(result.evidence).toMatchObject({ probed: true, reachable: true });
  });

  test("fails default-llm-engine with the probe's error text when the endpoint refuses", async () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      connections: { fast: lab },
    };
    const result = await runDefaultLlmEngineProbe({
      loadConfig: () => config,
      probeReachable: async () => ({ reachable: false, error: "connection refused" }),
    });
    expect(result.status).toBe("fail");
    expect(result.message).toBe('Connection "fast" is not reachable: connection refused');
    expect(result.evidence).toMatchObject({ probed: true, reachable: false, error: "connection refused" });
  });

  test("warns (not fails) a configured connection that refuses connections", async () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      connections: { backup: lab },
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
      connections: { fast: lab },
    };
    const result = await runDefaultLlmEngineProbe({ loadConfig: () => config });
    expect(result.status).toBe("pass");
    expect(result.message).toBe('Connection "fast" is configured. Reachability was not probed.');
    expect(result.evidence).toMatchObject({ probed: false, reachable: null });
  });

  test("does not probe when the key is unavailable", async () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      connections: { improve: { ...lab, apiKey: "$PRIVATE_NO_PROBE_TOKEN" } },
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
    expect(result.message).toContain("its key is unavailable");
  });

  test("probes a shared endpoint once across default-llm-engine and configured-engines", async () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      connections: { default: lab, mirror: { ...lab } },
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
      connections: { down: lab },
    };
    const result = await healthChecks.runHealthEngineProbes({
      loadConfig: () => config,
      probeReachable: async () => ({ reachable: false, error: "connection refused" }),
    });
    expect(result.defaultLlmEngine.status).toBe("fail");
    expect(result.defaultLlmEngine.message).toContain("connection refused");
    expect(result.configuredEngines.status).toBe("warn");
  });
});
