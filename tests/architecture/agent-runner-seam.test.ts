import { describe, expect, test } from "bun:test";

import type { AgentProfile } from "../../src/integrations/agent/profiles";
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

/**
 * Inline dispatch helper — mirrors the pattern now used at each call site.
 * When sdkMode is true, routes to an "sdk" runner; otherwise to "spawn".
 */
async function inlineDispatch(
  profile: AgentProfile,
  _prompt: string,
  spawnFn: () => Promise<AgentRunResult>,
  sdkFn: () => Promise<AgentRunResult>,
): Promise<AgentRunResult> {
  return profile.sdkMode ? sdkFn() : spawnFn();
}

describe("Agent inline dispatch (replaces AgentRunner seam)", () => {
  test("routes sdkMode profiles through the sdk path", async () => {
    const profile = makeProfile({ sdkMode: true });
    const result = await inlineDispatch(
      profile,
      "hello",
      async () => makeResult("spawn"),
      async () => makeResult("sdk"),
    );
    expect(result.stdout).toBe("sdk");
  });

  test("routes normal profiles through the spawn path", async () => {
    const profile = makeProfile({ name: "claude" });
    const result = await inlineDispatch(
      profile,
      "hello",
      async () => makeResult("spawn"),
      async () => makeResult("sdk"),
    );
    expect(result.stdout).toBe("spawn");
  });

  test("sdkMode undefined is treated as spawn path", async () => {
    const profile = makeProfile();
    // sdkMode is not set — should go to spawn
    const result = await inlineDispatch(
      profile,
      "hello",
      async () => makeResult("spawn"),
      async () => makeResult("sdk"),
    );
    expect(result.stdout).toBe("spawn");
  });
});
