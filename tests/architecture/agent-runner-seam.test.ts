import { describe, expect, test } from "bun:test";
import { resolveEngine } from "../../src/integrations/agent/engine-resolution";
import type { AgentProfile } from "../../src/integrations/agent/profiles";
import type { RunnerSpec } from "../../src/integrations/agent/runner";
import { executeRunner } from "../../src/integrations/agent/runner-dispatch";

const profile: AgentProfile = {
  name: "runner-test-agent",
  bin: "runner-test-agent",
  args: [],
  stdio: "captured",
  envPassthrough: ["PATH"],
  parseOutput: "text",
};

const result = (stdout: string) => ({ ok: true, exitCode: 0, stdout, stderr: "", durationMs: 1 });

describe("RunnerSpec dispatch authority", () => {
  test("routes an sdk spec through the SDK path", async () => {
    const spec: RunnerSpec = { kind: "sdk", profile };
    const actual = await executeRunner(
      spec,
      "hello",
      {},
      {
        runAgent: async () => result("spawn"),
        runSdk: async () => result("sdk"),
      },
    );
    expect(actual.stdout).toBe("sdk");
  });

  test("routes an agent spec through the spawn path", async () => {
    const spec: RunnerSpec = { kind: "agent", profile };
    const actual = await executeRunner(
      spec,
      "hello",
      {},
      {
        runAgent: async () => result("spawn"),
        runSdk: async () => result("sdk"),
      },
    );
    expect(actual.stdout).toBe("spawn");
  });

  test("engine lowering, not profile fields, selects SDK versus spawn", () => {
    const config = {
      engines: {
        agent: { kind: "agent" as const, platform: "opencode" },
        sdk: { kind: "agent" as const, platform: "opencode-sdk", llmEngine: "llm" },
        llm: { kind: "llm" as const, endpoint: "https://example.test/v1/chat/completions", model: "test" },
      },
      defaults: { engine: "agent", llmEngine: "llm" },
    };
    expect(resolveEngine("agent", config).kind).toBe("agent");
    expect(resolveEngine("sdk", config).kind).toBe("sdk");
  });
});
