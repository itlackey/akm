import { describe, expect, test } from "bun:test";
import { resolveProcessEnabled } from "../../src/commands/improve/improve-strategies";
import type { AkmConfig } from "../../src/core/config/config";
import { type ConnectionRunner, decodeFrozenRunnerSpec } from "../../src/integrations/agent/runner";
import { isProcessEnabled } from "../../src/llm/feature-gate";

const lab: ConnectionRunner = {
  kind: "connection",
  name: "lab",
  endpoint: "https://lab.invalid/v1",
  model: "qwen",
  request: { top_p: 0.9 },
  apiKey: "$LAB_KEY",
  timeoutMs: 600_000,
};

describe("decodeFrozenRunnerSpec", () => {
  test("a connection runner is kept as stored, and a harness runner gets the args it lacks", () => {
    expect(decodeFrozenRunnerSpec(lab)).toEqual(lab);
    expect(
      decodeFrozenRunnerSpec({ kind: "harness", name: "pi", platform: "pi", bin: "pi", timeoutMs: null, futureKey: 1 }),
    ).toMatchObject({ kind: "harness", name: "pi", platform: "pi", bin: "pi", args: [], timeoutMs: null });
  });

  test("a runner missing what it needs is refused", () => {
    expect(() => decodeFrozenRunnerSpec(null)).toThrow(/must be an object/);
    expect(() => decodeFrozenRunnerSpec({ kind: "connection", name: "lab" })).toThrow(/name, endpoint and model/);
    expect(() => decodeFrozenRunnerSpec({ kind: "harness", name: "pi" })).toThrow(/name, platform and bin/);
    expect(() => decodeFrozenRunnerSpec({ kind: "teleport" })).toThrow(/connection or harness/);
  });

  test("an earlier release's llm runner is the connection runner it became, its inference the request it was sent as", () => {
    const runner = decodeFrozenRunnerSpec({
      kind: "llm",
      engine: "lab",
      connection: {
        endpoint: "https://lab.invalid/v1/chat/completions",
        model: "qwen",
        temperature: 0.2,
        maxTokens: 512,
        contextLength: 8192,
        extraParams: { top_p: 0.9 },
      },
      credential: { names: ["LAB_KEY"] },
      timeoutMs: 90_000,
    });
    expect(runner).toEqual({
      kind: "connection",
      name: "lab",
      endpoint: "https://lab.invalid/v1/chat/completions",
      model: "qwen",
      request: { temperature: 0.2, max_tokens: 512, top_p: 0.9 },
      apiKey: "$LAB_KEY",
      contextLength: 8192,
      timeoutMs: 90_000,
    });
  });

  test("an earlier release's agent runner is the harness runner it became", () => {
    const runner = decodeFrozenRunnerSpec({
      kind: "agent",
      engine: "work",
      profile: {
        name: "work",
        platform: "claude",
        bin: "/opt/claude",
        args: ["--print"],
        model: "m",
        agent: "reviewer",
      },
      timeoutMs: null,
    });
    expect(runner).toEqual({
      kind: "harness",
      name: "work",
      platform: "claude",
      bin: "/opt/claude",
      args: ["--print"],
      agent: "reviewer",
      model: "m",
      timeoutMs: null,
    });
  });

  test("a runner an earlier release froze that cannot run now is refused, so the run starts afresh", () => {
    const llm = { kind: "llm", engine: "lab", connection: { endpoint: "https://lab.invalid/v1", model: "qwen" } };
    const refused: Array<[string, Record<string, unknown>]> = [
      ["OpenCode as an engine of its own", { kind: "sdk", engine: "sdk", profile: { name: "sdk", bin: "" } }],
      ["a key file", { ...llm, apiKeyFile: "/run/key" }],
      ["a secret-store reference", { ...llm, apiKeySecretRef: "secret://lab" }],
      ["an AKM_ENGINE_* variable", { ...llm, credential: { names: ["AKM_ENGINE_LAB_API_KEY"] } }],
    ];
    for (const [why, runner] of refused) {
      expect(() => decodeFrozenRunnerSpec(runner), why).toThrow(/cannot run now.*start the run afresh/);
    }
  });
});

function makeConfig(): AkmConfig {
  return {
    semanticSearchMode: "auto",
    configVersion: "0.9.0",
    connections: {
      default: { endpoint: "https://api.openai.com/v1", models: { fast: "gpt-4o-mini", balanced: "gpt-4o" } },
    },
    harnesses: { opencode: {}, claude: {} },
    improve: {
      strategy: "default",
      strategies: {
        default: {
          processes: {
            reflect: { enabled: true, connection: "default", timeoutMs: 60000 },
            distill: { enabled: true },
            consolidate: { enabled: false },
            memoryInference: { enabled: true },
          },
        },
      },
    },
  } as AkmConfig;
}

describe("isProcessEnabled", () => {
  test("reflects the configured enabled flag on improve strategy processes", () => {
    const strategy = makeConfig().improve?.strategies?.default ?? {};
    expect(resolveProcessEnabled("reflect", strategy)).toBe(true);
    expect(resolveProcessEnabled("consolidate", strategy)).toBe(false);
    expect(resolveProcessEnabled("distill", strategy)).toBe(true);
  });

  test("reflects the configured enabled flag on improve processes", () => {
    const config = makeConfig();
    expect(isProcessEnabled("index", "memoryInference", config)).toBe(true);
    const off: AkmConfig = { ...config, index: { memory: { enabled: false } } };
    expect(isProcessEnabled("index", "memoryInference", off)).toBe(false);
  });

  // 0.9.17-alpha.9: the LLM entity-graph extraction pass this once gated is
  // retired — graphExtraction/graph_extraction are no longer recognized names.
  test("graphExtraction is no longer a recognized isProcessEnabled process name (retired 0.9.17-alpha.9)", () => {
    const config = makeConfig();
    expect(isProcessEnabled("index", "graphExtraction", config)).toBe(false);
    expect(isProcessEnabled("index", "graph_extraction", config)).toBe(false);
  });
});
