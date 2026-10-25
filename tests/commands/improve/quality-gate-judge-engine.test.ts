/**
 * 0.9.23: a quality gate may name its own judge (#1011), the judge thinks only
 * when that connection enables thinking, and memory inference uses the configured
 * temperature (0.1 only when nothing sets one).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveImprovePlan } from "../../../src/commands/improve/improve-strategies";
import {
  buildReflectJudgePrompt,
  resolveQualityGateJudge,
  runReflectQualityJudge,
} from "../../../src/commands/improve/stage";
import type { AkmConfig, ImproveProfileConfig } from "../../../src/core/config/config";
import { validateConfigShape } from "../../../src/core/config/config-schema";
import { ConfigError } from "../../../src/core/errors";
import { compressMemoryToDerivedMemory } from "../../../src/llm/memory-infer";
import {
  clearLlmUsageSink,
  type LlmUsageRecord,
  setLlmUsageSink,
  withLlmStage,
} from "../../../src/llm/usage-telemetry";
import { asLlmRunner } from "../../_helpers/llm-runner";
import { fakeOpencodeMajor } from "../../_helpers/opencode-version";

beforeEach(() => fakeOpencodeMajor(1));

function config(extra: Record<string, unknown> = {}, connections: Record<string, unknown> = {}): AkmConfig {
  return {
    semanticSearchMode: "auto",
    stashDir: "/tmp/does-not-matter",
    sources: [],
    defaultWriteTarget: "stash",
    connections: {
      default: { endpoint: "http://localhost:11434/v1/chat/completions", models: { fast: "gen-model" } },
      judge: {
        endpoint: "http://localhost:11435/v1/chat/completions",
        models: { fast: "judge-model" },
        chat_template_kwargs: { enable_thinking: true },
      },
      ...connections,
    },
    harnesses: { agent: { platform: "claude", bin: "fake-agent" } },
    ...extra,
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

  test("qualityGate.connection selects that connection for the judge", () => {
    const runner = resolveQualityGateJudge(
      config(),
      strategy({ reflect: { qualityGate: { connection: "judge" } } }),
      "reflect",
    );
    expect(runner?.name).toBe("judge");
    expect(asLlmRunner(runner).model).toBe("judge-model");
  });

  test("qualityGate.llm alone keeps the process's connection and overrides its settings", () => {
    const runner = resolveQualityGateJudge(
      config(
        {},
        { other: { endpoint: "http://localhost:11436/v1/chat/completions", models: { fast: "other-model" } } },
      ),
      strategy({
        distill: { connection: "other", llm: { temperature: 0.3 }, qualityGate: { llm: { temperature: 0.5 } } },
      }),
      "distill",
    );
    expect(runner?.name).toBe("other");
    expect(asLlmRunner(runner).request.temperature).toBe(0.5);
  });

  test("an explicit timeoutMs: null names a judge too", () => {
    const runner = resolveQualityGateJudge(
      config(),
      strategy({ reflect: { qualityGate: { timeoutMs: null } } }),
      "reflect",
    );
    expect(runner?.name).toBe("default");
    expect(runner?.timeoutMs).toBeNull();
  });

  test("a gate that is off names no judge, whatever else it sets", () => {
    expect(
      resolveQualityGateJudge(
        config(),
        strategy({ reflect: { qualityGate: { enabled: false, harness: "agent" } } }),
        "reflect",
      ),
    ).toBeUndefined();
  });

  test("the judge may be a harness that confines the model-work tool policy", () => {
    const runner = resolveQualityGateJudge(
      config(),
      strategy({ reflect: { qualityGate: { harness: "agent" } } }),
      "reflect",
    );
    expect(runner).toMatchObject({ kind: "harness", name: "agent" });
  });

  test("a gate that resolves to no connection or harness at all fails instead of falling back", () => {
    const nothing = config({ harnesses: undefined, connections: undefined });
    expect(() =>
      resolveQualityGateJudge(nothing, strategy({ reflect: { qualityGate: { model: "judge-model" } } }), "reflect"),
    ).toThrow(ConfigError);
  });
});

describe("a quality gate's judge is checked when it resolves, not when the config loads", () => {
  const reviewers = {
    judge: { endpoint: "http://localhost:11435/v1/chat/completions", models: { fast: "judge-model" } },
  };

  function gateErrors(gate: Record<string, unknown>): string[] {
    const result = validateConfigShape({
      configVersion: "0.9.0",
      connections: reviewers,
      harnesses: { reviewer: { platform: "pi" }, confined: { platform: "claude" } },
      improve: { strategies: { custom: { processes: { reflect: { qualityGate: gate } } } } },
    });
    return result.ok ? [] : result.errors.map((issue) => `${issue.path}: ${issue.message}`);
  }

  test("any name loads, configured or not", () => {
    expect(gateErrors({ connection: "judge" })).toEqual([]);
    expect(gateErrors({ harness: "confined" })).toEqual([]);
    expect(gateErrors({ harness: "reviewer" })).toEqual([]);
    expect(gateErrors({ connection: "missing" })).toEqual([]);
  });

  test("a harness that cannot confine the policy judges unrestricted: it resolves", () => {
    const cfg = config({ harnesses: { reviewer: { platform: "pi" } } });
    expect(
      resolveQualityGateJudge(cfg, strategy({ reflect: { qualityGate: { harness: "reviewer" } } }), "reflect"),
    ).toMatchObject({ kind: "harness", name: "reviewer" });
  });

  test("a connection that is not configured uses the default one", () => {
    const runner = resolveQualityGateJudge(
      config(),
      strategy({ reflect: { qualityGate: { connection: "missing" } } }),
      "reflect",
    );
    expect(runner?.name).toBe("default");
  });
});

describe("the judge thinks only when its own connection enables thinking", () => {
  test("a judge connection that enables thinking asks for thinking", async () => {
    const llmRunner = resolveQualityGateJudge(
      config(),
      strategy({ reflect: { qualityGate: { connection: "judge" } } }),
      "reflect",
    );
    if (!llmRunner) throw new Error("expected the judge connection to resolve");
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

  test("a judge on a harness gets the asset's ref and the tool rules; the plain judge gets neither", async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akm-judge-harness-"));
    try {
      const argvPath = path.join(sandbox, "argv.bin");
      const bin = path.join(sandbox, "judge-claude");
      fs.writeFileSync(
        bin,
        [
          "#!/bin/sh",
          `printf '%s\\0' "$@" > '${argvPath}'`,
          `printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":${JSON.stringify(PASSING_VERDICT).replaceAll("'", "")},"session_id":"j"}'`,
        ].join("\n"),
        "utf8",
      );
      fs.chmodSync(bin, 0o755);
      const cfg = config({ harnesses: { agent: { platform: "claude", bin } } });
      const llmRunner = resolveQualityGateJudge(
        cfg,
        strategy({ reflect: { qualityGate: { harness: "agent" } } }),
        "reflect",
      );
      const result = await runReflectQualityJudge(cfg, "candidate", "source", [], undefined, {
        llmRunner,
        ref: "knowledge/x",
      });
      expect(result.pass).toBe(true);
      const sent = fs.readFileSync(argvPath).toString("utf8");
      expect(sent).toContain("Tools: The asset is `knowledge/x`: read it with akm_show");
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }

    let plain = "";
    await runReflectQualityJudge(config(), "candidate", "source", [], async (_connection, messages) => {
      plain = messages.map((m) => m.content).join("\n");
      return PASSING_VERDICT;
    });
    expect(plain).toContain("Return ONLY valid JSON");
    expect(plain).not.toContain("Tools:");
    expect(buildReflectJudgePrompt("candidate", "source", [])).not.toContain("Tools:");
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

  test("inside a stage planned on another connection", async () => {
    const llmRunner = resolveQualityGateJudge(
      config(),
      strategy({ reflect: { qualityGate: { connection: "judge" } } }),
      "reflect",
    );
    if (!llmRunner) throw new Error("expected the judge connection to resolve");
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

  async function temperatureSent(connectionTemperature?: number, processTemperature?: number): Promise<unknown> {
    const cfg = {
      ...config(
        {},
        {
          default: {
            endpoint: "http://localhost:11434/v1/chat/completions",
            models: { fast: "gen-model" },
            ...(connectionTemperature === undefined ? {} : { temperature: connectionTemperature }),
          },
        },
      ),
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
    if (!runner || runner.kind !== "connection") throw new Error("expected a connection runner for memory inference");
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

  test("0.1 when neither the connection nor the process sets a temperature", async () => {
    expect(await temperatureSent()).toBe(0.1);
  });

  test("the connection's temperature when it sets one", async () => {
    expect(await temperatureSent(0.4)).toBe(0.4);
  });

  test("the process's llm.temperature over the connection's", async () => {
    expect(await temperatureSent(0.4, 0.6)).toBe(0.6);
  });
});
