/**
 * 0.9.23: a quality gate may name its own judge (#1011), the judge thinks only
 * when that engine enables thinking, and memory inference uses the configured
 * temperature (0.1 only when nothing sets one).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { resolveImprovePlan } from "../../../src/commands/improve/improve-strategies";
import { resolveQualityGateJudge, runReflectQualityJudge } from "../../../src/commands/improve/stage";
import type { AkmConfig, ImproveProfileConfig } from "../../../src/core/config/config";
import { validateConfigShape } from "../../../src/core/config/config-schema";
import { ConfigError } from "../../../src/core/errors";
import { resolveEngine } from "../../../src/integrations/agent/engine-resolution";
import { __setTestServer } from "../../../src/integrations/harnesses/opencode-sdk/sdk-runner";
import { compressMemoryToDerivedMemory } from "../../../src/llm/memory-infer";
import {
  clearLlmUsageSink,
  type LlmUsageRecord,
  setLlmUsageSink,
  withLlmStage,
} from "../../../src/llm/usage-telemetry";
import { asLlmRunner } from "../../_helpers/llm-runner";

function config(engines: Record<string, unknown> = {}): AkmConfig {
  return {
    semanticSearchMode: "auto",
    stashDir: "/tmp/does-not-matter",
    sources: [],
    defaultWriteTarget: "stash",
    engines: {
      default: { kind: "llm", endpoint: "http://localhost:11434/v1/chat/completions", model: "gen-model" },
      judge: {
        kind: "llm",
        endpoint: "http://localhost:11435/v1/chat/completions",
        model: "judge-model",
        enableThinking: true,
      },
      agent: { kind: "agent", platform: "opencode", bin: "fake-agent" },
      ...engines,
    },
    defaults: { llmEngine: "default" },
  } as unknown as AkmConfig;
}

const PASSING_VERDICT = JSON.stringify({ scores: { need: 4, preservation: 4, quality: 4 }, reason: "ok" });

function strategy(processes: Record<string, unknown>): ImproveProfileConfig {
  return { processes } as unknown as ImproveProfileConfig;
}

describe("resolveQualityGateJudge (#1011)", () => {
  test("a gate that names no judge leaves the caller's judge in place", () => {
    expect(resolveQualityGateJudge(config(), undefined, "reflect")).toBeUndefined();
    expect(
      resolveQualityGateJudge(config(), strategy({ reflect: { qualityGate: { enabled: true } } }), "reflect"),
    ).toBeUndefined();
  });

  test("qualityGate.engine selects that engine for the judge", () => {
    const runner = resolveQualityGateJudge(
      config(),
      strategy({ reflect: { qualityGate: { engine: "judge" } } }),
      "reflect",
    );
    expect(runner?.engine).toBe("judge");
    expect(asLlmRunner(runner).connection.model).toBe("judge-model");
  });

  test("qualityGate.llm alone keeps the process's engine and overrides its settings", () => {
    const runner = resolveQualityGateJudge(
      config({ other: { kind: "llm", endpoint: "http://localhost:11436/v1/chat/completions", model: "other-model" } }),
      strategy({ distill: { engine: "other", llm: { temperature: 0.3 }, qualityGate: { llm: { temperature: 0.5 } } } }),
      "distill",
    );
    expect(runner?.engine).toBe("other");
    expect(asLlmRunner(runner).connection.temperature).toBe(0.5);
  });

  test("an explicit timeoutMs: null names a judge too", () => {
    const runner = resolveQualityGateJudge(
      config(),
      strategy({ reflect: { qualityGate: { timeoutMs: null } } }),
      "reflect",
    );
    expect(runner?.engine).toBe("default");
  });

  test("a gate that is off names no judge, whatever else it sets", () => {
    expect(
      resolveQualityGateJudge(
        config(),
        strategy({ reflect: { qualityGate: { enabled: false, engine: "agent" } } }),
        "reflect",
      ),
    ).toBeUndefined();
  });

  test("the judge may be an agent engine that confines the model-work tool policy", () => {
    const runner = resolveQualityGateJudge(
      config(),
      strategy({ reflect: { qualityGate: { engine: "agent" } } }),
      "reflect",
    );
    expect(runner).toMatchObject({ kind: "agent", engine: "agent" });
  });

  test("a gate that resolves to no engine at all fails instead of falling back", () => {
    const noDefault = { ...config(), defaults: {} } as AkmConfig;
    expect(() =>
      resolveQualityGateJudge(noDefault, strategy({ reflect: { qualityGate: { model: "judge-model" } } }), "reflect"),
    ).toThrow(ConfigError);
  });
});

describe("qualityGate.engine is checked when the config loads", () => {
  function gateEngineErrors(engine: string): string[] {
    const result = validateConfigShape({
      configVersion: "0.9.0",
      engines: {
        judge: { kind: "llm", endpoint: "http://localhost:11435/v1/chat/completions", model: "judge-model" },
        reviewer: { kind: "agent", platform: "pi" },
        confined: { kind: "agent", platform: "claude" },
      },
      improve: { strategies: { custom: { processes: { reflect: { qualityGate: { engine } } } } } },
    });
    return result.ok ? [] : result.errors.map((issue) => `${issue.path}: ${issue.message}`);
  }

  test("an LLM engine, or an agent that confines the model-work tool policy, is accepted", () => {
    expect(gateEngineErrors("judge")).toEqual([]);
    expect(gateEngineErrors("confined")).toEqual([]);
  });

  test("an agent that cannot confine the policy, or a missing engine, is rejected", () => {
    const path = "improve.strategies.custom.processes.reflect.qualityGate.engine";
    expect(gateEngineErrors("reviewer")).toEqual([
      `${path}: engine "reviewer" (platform pi) cannot confine the model-work tool policy, which unattended model work requires. Use an LLM engine, or an agent engine on opencode, claude or opencode-sdk.`,
    ]);
    expect(gateEngineErrors("missing")).toEqual([`${path}: engine does not name a configured engine`]);
  });
});

describe("the judge thinks only when its own engine enables thinking", () => {
  test("a judge engine with enableThinking: true asks for thinking", async () => {
    const llmRunner = resolveQualityGateJudge(
      config(),
      strategy({ reflect: { qualityGate: { engine: "judge" } } }),
      "reflect",
    );
    if (!llmRunner) throw new Error("expected the judge engine to resolve");
    let thinking: boolean | undefined;
    await runReflectQualityJudge(
      config(),
      "candidate",
      "source",
      [],
      async (connection, _messages, options) => {
        thinking = options?.enableThinking ?? connection.enableThinking;
        return PASSING_VERDICT;
      },
      { llmRunner },
    );
    expect(thinking).toBe(true);
  });

  test("a judge on an opencode-sdk runner runs; its thinking comes from the provider fallback", async () => {
    const cfg = config({
      "sdk-judge": { kind: "agent", platform: "opencode-sdk", opencodeVersion: 1, llmEngine: "judge" },
    });
    __setTestServer({
      client: {
        session: {
          create: async () => ({ data: { id: "judge-session" } }),
          prompt: async () => ({ data: { info: {}, parts: [{ type: "text", text: PASSING_VERDICT }] } }) as never,
        },
      },
      server: { close() {} },
    });
    try {
      const result = await runReflectQualityJudge(cfg, "candidate", "source", [], undefined, {
        llmRunner: resolveEngine("sdk-judge", cfg),
      });
      expect(result.pass).toBe(true);
    } finally {
      __setTestServer(null);
    }
  });

  test("a judge on an agent engine gets the asset's ref and the tool rules; the plain judge gets neither", async () => {
    const cfg = config({
      "sdk-judge": { kind: "agent", platform: "opencode-sdk", opencodeVersion: 1, llmEngine: "judge" },
    });
    let sent = "";
    __setTestServer({
      client: {
        session: {
          create: async () => ({ data: { id: "judge-session" } }),
          prompt: (async (args: { body: { parts: { text: string }[] } }) => {
            sent = args.body.parts.map((p) => p.text).join("\n");
            return { data: { info: {}, parts: [{ type: "text", text: PASSING_VERDICT }] } };
          }) as never,
        },
      },
      server: { close() {} },
    });
    try {
      await runReflectQualityJudge(cfg, "candidate", "source", [], undefined, {
        llmRunner: resolveEngine("sdk-judge", cfg),
        ref: "knowledge/x",
      });
    } finally {
      __setTestServer(null);
    }
    expect(sent).toContain("Tools: The asset is `knowledge/x`: read it with akm_show");
    let plain = "";
    await runReflectQualityJudge(config(), "candidate", "source", [], async (_connection, messages) => {
      plain = messages.map((m) => m.content).join("\n");
      return PASSING_VERDICT;
    });
    expect(plain).toContain("Return ONLY valid JSON");
    expect(plain).not.toContain("Tools:");
  });

  test("otherwise the judge keeps thinking off, as before", async () => {
    let thinking: boolean | undefined;
    await runReflectQualityJudge(config(), "candidate", "source", [], async (connection, _messages, options) => {
      thinking = options?.enableThinking ?? connection.enableThinking;
      return PASSING_VERDICT;
    });
    expect(thinking).toBe(false);
  });
});

describe("a judge's usage is credited to the engine that served it", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearLlmUsageSink();
  });

  test("inside a stage planned on another engine", async () => {
    const llmRunner = resolveQualityGateJudge(
      config(),
      strategy({ reflect: { qualityGate: { engine: "judge" } } }),
      "reflect",
    );
    if (!llmRunner) throw new Error("expected the judge engine to resolve");
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: PASSING_VERDICT } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const records: LlmUsageRecord[] = [];
    setLlmUsageSink((record) => records.push(record));

    await withLlmStage(
      "reflect",
      () => runReflectQualityJudge(config(), "candidate", "source", [], undefined, { llmRunner }),
      { engine: "default", process: "reflect" },
    );

    expect(records.map((record) => [record.stage, record.process, record.engine])).toEqual([
      ["reflect", "reflect", "judge"],
    ]);
  });
});

describe("memory inference uses the configured temperature", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function temperatureSent(engineTemperature?: number, processTemperature?: number): Promise<unknown> {
    const cfg = {
      ...config({
        default: {
          kind: "llm",
          endpoint: "http://localhost:11434/v1/chat/completions",
          model: "gen-model",
          ...(engineTemperature === undefined ? {} : { temperature: engineTemperature }),
        },
      }),
      // Memory inference is an autonomy lane: off unless improveAutonomy is on.
      experimental: { improveAutonomy: true },
      improve: {
        strategies: {
          default: {
            processes: {
              memoryInference: {
                enabled: true,
                ...(processTemperature === undefined ? {} : { llm: { temperature: processTemperature } }),
              },
            },
          },
        },
      },
    } as AkmConfig;
    // The runner improve hands memory inference.
    const runner = resolveImprovePlan("default", cfg).processes.memoryInference.runner;
    if (!runner || runner.kind !== "llm") throw new Error("expected an LLM runner for memory inference");
    let body: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      const draft = { title: "t", description: "d", body: "b", tags: [] };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(draft) } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    await compressMemoryToDerivedMemory(runner, "A memory body long enough to infer from.", undefined, cfg);
    return body?.temperature;
  }

  test("0.1 when neither the engine nor the process sets a temperature", async () => {
    expect(await temperatureSent()).toBe(0.1);
  });

  test("the engine's temperature when it sets one", async () => {
    expect(await temperatureSent(0.4)).toBe(0.4);
  });

  test("the process's llm.temperature over the engine's", async () => {
    expect(await temperatureSent(0.4, 0.6)).toBe(0.6);
  });
});
