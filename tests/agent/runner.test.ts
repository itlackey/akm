import { describe, expect, test } from "bun:test";
import { resolveProcessEnabled } from "../../src/commands/improve/improve-strategies";
import type { AkmConfig } from "../../src/core/config/config";
import { type ConnectionRunner, decodeFrozenRunnerSpec } from "../../src/integrations/agent/runner";

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

  test("an earlier release's llm, agent and sdk runners are refused, so the run starts afresh", () => {
    for (const kind of ["llm", "agent", "sdk"]) {
      expect(() => decodeFrozenRunnerSpec({ kind, engine: "lab" }), kind).toThrow(/connection or harness/);
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

describe("resolveProcessEnabled", () => {
  test("reflects the configured enabled flag on improve strategy processes", () => {
    const strategy = makeConfig().improve?.strategies?.default ?? {};
    expect(resolveProcessEnabled("reflect", strategy)).toBe(true);
    expect(resolveProcessEnabled("consolidate", strategy)).toBe(false);
    expect(resolveProcessEnabled("distill", strategy)).toBe(true);
  });
});
