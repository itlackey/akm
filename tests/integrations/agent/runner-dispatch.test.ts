// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import type { LlmConnectionConfig } from "../../../src/core/config/config";
import type { AgentRunResult } from "../../../src/integrations/agent";
import type { AgentProfile } from "../../../src/integrations/agent/profiles";
import type { RunnerSpec } from "../../../src/integrations/agent/runner";
// X3: the unified RunnerSpec dispatch seam (executeRunner in runner-dispatch.ts).
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

  test("uses the spec timeout when the caller does not provide one and passes SDK fallback connection", async () => {
    const fallbackConnection = { endpoint: "https://example.test/v1/chat/completions", model: "fallback" };
    let received: { timeoutMs?: number | null; fallback?: typeof fallbackConnection } | undefined;
    const spec: RunnerSpec = { kind: "sdk", engine: "sdk", profile: sdkProfile, timeoutMs: null, fallbackConnection };

    await executeRunner(
      spec,
      "sdk-prompt",
      {},
      {
        runSdk: async (_profile, _prompt, opts, fallback) => {
          received = { timeoutMs: opts.timeoutMs, fallback };
          return okResult("from-sdk");
        },
      },
    );

    expect(received).toEqual({ timeoutMs: null, fallback: fallbackConnection });
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

  test("redacts echoed engine, binding, profile-env, and non-allowlisted passthrough values", async () => {
    const values = {
      engine: "ENGINE-ECHO-SENTINEL",
      binding: "BINDING-ECHO-SENTINEL",
      asset: "ENV-ASSET-ECHO-SENTINEL",
      passthrough: "PASSTHROUGH-ECHO-SENTINEL",
      safePath: "/safe/runtime/path",
      safeProfile: "developer-profile",
      safeRegion: "us-test-1",
      safeModel: "local-model",
      safeBaseUrl: "http://localhost:1234/v1",
      safeOpencodeConfig: "/safe/opencode.json",
      safeClaudeConfig: "/safe/claude.json",
      safeCodexConfig: "/safe/codex.toml",
    };
    const profile: AgentProfile = {
      ...sdkProfile,
      env: { ENV_ASSET_VALUE: values.asset },
      envPassthrough: [
        "PATH",
        "CUSTOM_AGENT_TOKEN",
        "AWS_PROFILE",
        "AWS_REGION",
        "LLM_MODEL",
        "LLM_BASE_URL",
        "OPENCODE_CONFIG",
        "CLAUDE_CONFIG",
        "CODEX_CONFIG",
      ],
    };
    const spec: RunnerSpec = {
      kind: "sdk",
      profile,
      fallbackConnection: { ...llmConnection, apiKey: values.engine },
    };
    const echoed = Object.values(values).join(" | ");

    const result = await executeRunner(
      spec,
      "p",
      {
        env: { BOUND_VALUE: values.binding },
        envSource: {
          PATH: values.safePath,
          CUSTOM_AGENT_TOKEN: values.passthrough,
          AWS_PROFILE: values.safeProfile,
          AWS_REGION: values.safeRegion,
          LLM_MODEL: values.safeModel,
          LLM_BASE_URL: values.safeBaseUrl,
          OPENCODE_CONFIG: values.safeOpencodeConfig,
          CLAUDE_CONFIG: values.safeClaudeConfig,
          CODEX_CONFIG: values.safeCodexConfig,
        },
      },
      {
        runSdk: async () => ({
          ...okResult(echoed),
          stderr: echoed,
          error: echoed,
          parsed: { echoed },
        }),
      },
    );

    for (const secret of [values.engine, values.binding, values.asset, values.passthrough]) {
      expect(JSON.stringify(result)).not.toContain(secret);
    }
    expect(JSON.stringify(result)).toContain(values.safePath);
    for (const nonsecret of [
      values.safeProfile,
      values.safeRegion,
      values.safeModel,
      values.safeBaseUrl,
      values.safeOpencodeConfig,
      values.safeClaudeConfig,
      values.safeCodexConfig,
    ]) {
      expect(JSON.stringify(result)).toContain(nonsecret);
    }
    expect(result.stdout.match(/\[REDACTED\]/g)).toHaveLength(4);
  });

  test("redacts credential-bearing values even when their passthrough names are allowlisted", async () => {
    const userinfo = "https://user:password@example.test/v1";
    const signed = "https://example.test/object?X-Amz-Credential=owner&X-Amz-Signature=signed-secret";
    const profile: AgentProfile = { ...sdkProfile, envPassthrough: ["LLM_BASE_URL", "AWS_PROFILE"] };
    const echoed = `${userinfo} | ${signed}`;

    const result = await executeRunner(
      { kind: "sdk", profile },
      "p",
      { envSource: { LLM_BASE_URL: userinfo, AWS_PROFILE: signed } },
      { runSdk: async () => ({ ...okResult(echoed), parsed: { echoed } }) },
    );

    expect(JSON.stringify(result)).not.toContain(userinfo);
    expect(JSON.stringify(result)).not.toContain(signed);
    expect(result.stdout).toBe("[REDACTED] | [REDACTED]");
  });
});
