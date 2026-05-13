import { describe, expect, test } from "bun:test";

import type { AgentProfile } from "../../src/integrations/agent/profiles";
import { runWithAgentRunner, selectAgentRunner } from "../../src/integrations/agent/runners";
import type { AgentRunResult } from "../../src/integrations/agent/spawn";

function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    name: "runner-test-agent",
    bin: "runner-test-agent",
    args: [],
    stdio: "captured",
    envPassthrough: ["PATH"],
    parseOutput: "text",
    ...overrides,
  };
}

function makeResult(name: string): AgentRunResult {
  return {
    ok: true,
    exitCode: 0,
    stdout: name,
    stderr: "",
    durationMs: 1,
  };
}

describe("AgentRunner seam", () => {
  test("selects the first supporting runner deterministically", () => {
    const profile = makeProfile();
    const runner = selectAgentRunner(profile, [
      {
        name: "first",
        supports: () => true,
        run: async () => makeResult("first"),
      },
      {
        name: "second",
        supports: () => true,
        run: async () => makeResult("second"),
      },
    ]);
    expect(runner.name).toBe("first");
  });

  test("routes sdkMode profiles through the sdk-capable runner", async () => {
    const profile = makeProfile({ name: "custom-sdk", sdkMode: true });
    const result = await runWithAgentRunner(
      {
        profile,
        prompt: "hello",
      },
      [
        {
          name: "spawn",
          supports: (candidate) => candidate.sdkMode !== true,
          run: async () => makeResult("spawn"),
        },
        {
          name: "sdk",
          supports: (candidate) => candidate.sdkMode === true,
          run: async () => makeResult("sdk"),
        },
      ],
    );
    expect(result.stdout).toBe("sdk");
  });

  test("routes normal profiles through the spawn-capable runner", async () => {
    const profile = makeProfile({ name: "claude" });
    const result = await runWithAgentRunner(
      {
        profile,
        prompt: "hello",
      },
      [
        {
          name: "spawn",
          supports: (candidate) => candidate.sdkMode !== true,
          run: async () => makeResult("spawn"),
        },
        {
          name: "sdk",
          supports: (candidate) => candidate.sdkMode === true,
          run: async () => makeResult("sdk"),
        },
      ],
    );
    expect(result.stdout).toBe("spawn");
  });
});
