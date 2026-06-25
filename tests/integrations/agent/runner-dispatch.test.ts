// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import type { LlmConnectionConfig } from "../../../src/core/config/config";
import type { AgentRunResult } from "../../../src/integrations/agent";
import type { AgentProfile } from "../../../src/integrations/agent/profiles";
import type { RunnerSpec } from "../../../src/integrations/agent/runner";
// X3: the unified RunnerSpec dispatch seam. This module does not exist yet —
// this is the RED test that pins the target behavior before implementation.
import { executeRunner, type RunnerSeams } from "../../../src/integrations/agent/runner-dispatch";

function okResult(stdout: string): AgentRunResult {
  return { ok: true, exitCode: 0, stdout, stderr: "", durationMs: 1 };
}

const agentProfile: AgentProfile = {
  name: "opencode-default",
  bin: "opencode",
  args: ["run"],
  stdio: "captured",
  envPassthrough: [],
  parseOutput: "text",
};

const sdkProfile: AgentProfile = {
  name: "opencode-sdk",
  bin: "opencode",
  args: [],
  stdio: "captured",
  envPassthrough: [],
  parseOutput: "text",
  sdkMode: true,
  model: "anthropic/claude-sonnet-4-5",
};

const llmConnection: LlmConnectionConfig = {
  endpoint: "https://api.openai.com/v1/chat/completions",
  model: "gpt-4o-mini",
} as LlmConnectionConfig;

describe("executeRunner — unified RunnerSpec dispatch (X3)", () => {
  test("(a) {kind:'agent'} routes to the runAgent seam with profile + prompt", async () => {
    const calls: Array<{ profile: AgentProfile; prompt: string | undefined }> = [];
    const seams: RunnerSeams = {
      runAgent: async (profile, prompt) => {
        calls.push({ profile, prompt });
        return okResult("from-agent");
      },
      runSdk: async () => {
        throw new Error("sdk seam must not be called for an agent spec");
      },
    };
    const spec: RunnerSpec = { kind: "agent", profile: agentProfile, timeoutMs: 1234 };

    const result = await executeRunner(spec, "hello-prompt", {}, seams);

    expect(result.stdout).toBe("from-agent");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.profile).toBe(agentProfile);
    expect(calls[0]?.prompt).toBe("hello-prompt");
  });

  test("(b) {kind:'sdk'} routes to the runSdk seam with profile + prompt", async () => {
    const calls: Array<{ profile: AgentProfile; prompt: string }> = [];
    const seams: RunnerSeams = {
      runAgent: async () => {
        throw new Error("agent seam must not be called for an sdk spec");
      },
      runSdk: async (profile, prompt) => {
        calls.push({ profile, prompt });
        return okResult("from-sdk");
      },
    };
    const spec: RunnerSpec = { kind: "sdk", profile: sdkProfile };

    const result = await executeRunner(spec, "sdk-prompt", {}, seams);

    expect(result.stdout).toBe("from-sdk");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.profile).toBe(sdkProfile);
    expect(calls[0]?.prompt).toBe("sdk-prompt");
  });

  test("(c) {kind:'llm'} routes to the llm handler seam with the connection", async () => {
    const calls: Array<{ connection: LlmConnectionConfig; prompt: string }> = [];
    const seams: RunnerSeams = {
      llm: async (spec, prompt) => {
        calls.push({ connection: spec.connection, prompt });
        return okResult("from-llm");
      },
      runAgent: async () => {
        throw new Error("agent seam must not be called for an llm spec");
      },
      runSdk: async () => {
        throw new Error("sdk seam must not be called for an llm spec");
      },
    };
    const spec: RunnerSpec = { kind: "llm", connection: llmConnection };

    const result = await executeRunner(spec, "llm-prompt", {}, seams);

    expect(result.stdout).toBe("from-llm");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.connection).toBe(llmConnection);
    expect(calls[0]?.prompt).toBe("llm-prompt");
  });

  test("(d) a bogus kind hits the assertNever exhaustiveness arm", async () => {
    const seams: RunnerSeams = {
      llm: async () => okResult("x"),
      runAgent: async () => okResult("x"),
      runSdk: async () => okResult("x"),
    };
    // Force an invalid union member past the type system to exercise the
    // runtime exhaustiveness guard.
    const bogus = { kind: "telepathy" } as unknown as RunnerSpec;

    await expect(executeRunner(bogus, "p", {}, seams)).rejects.toThrow();
  });
});
