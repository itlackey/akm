// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import type { LlmConnectionConfig } from "../../src/core/config/config";
import type { UnresolvedExecutionDefaults } from "../../src/execution/source";
import type { AgentRunResult } from "../../src/integrations/agent";
import { type BuiltExecution, buildExecution, resolveExecution } from "../../src/integrations/agent/execution";
import type { AgentProfile } from "../../src/integrations/agent/profiles";
import type { RunnerSpec } from "../../src/integrations/agent/runner";
import { type RunExecutionOptions, runExecution } from "../../src/integrations/agent/runner-dispatch";
import { clearLlmUsageSink, type LlmUsageRecord, setLlmUsageSink } from "../../src/llm/usage-telemetry";
import { withEnv } from "../_helpers/sandbox";

function okResult(stdout: string): AgentRunResult {
  return { ok: true, exitCode: 0, stdout, stderr: "", durationMs: 1 };
}

const agentProfile: AgentProfile = {
  name: "opencode-default",
  platform: "opencode",
  bin: "opencode",
  args: ["run"],
  stdio: "captured",
  envPassthrough: [],
  parseOutput: "text",
};

const sdkProfile: AgentProfile = {
  name: "opencode-sdk",
  platform: "opencode-sdk",
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

function built(runner: RunnerSpec, content = "prompt", current?: UnresolvedExecutionDefaults): BuiltExecution {
  const resolved = resolveExecution({ content, runner, ...(current ? { current } : {}) });
  return buildExecution(resolved.request, resolved.runner);
}

const refuse = (kind: string) => async (): Promise<AgentRunResult> => {
  throw new Error(`the ${kind} transport must not be called`);
};

describe("runExecution routes each runner kind to its transport", () => {
  test("an agent runner goes to runAgent with its profile and prompt", async () => {
    const calls: Array<{ profile: AgentProfile; prompt: string }> = [];
    const result = await runExecution(built({ kind: "agent", engine: "agent", profile: agentProfile }, "hello"), {
      runAgent: async (profile, prompt) => {
        calls.push({ profile, prompt });
        return okResult("from-agent");
      },
      runSdk: refuse("sdk"),
    });
    expect(result.stdout).toBe("from-agent");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.profile.bin).toBe("opencode");
    expect(calls[0]?.prompt).toBe("hello");
  });

  test("an sdk runner goes to runSdk with its timeout and LLM fallback connection", async () => {
    const fallbackConnection = { endpoint: "https://example.test/v1/chat/completions", model: "fallback" };
    let received: { prompt: string; timeoutMs?: number | null; fallback?: LlmConnectionConfig } | undefined;
    await runExecution(
      built({ kind: "sdk", engine: "sdk", profile: sdkProfile, timeoutMs: null, fallbackConnection }, "sdk-prompt"),
      {
        runAgent: refuse("agent"),
        runSdk: async (_profile, prompt, opts, fallback) => {
          received = { prompt, timeoutMs: opts.timeoutMs, fallback };
          return okResult("from-sdk");
        },
      },
    );
    expect(received).toEqual({
      prompt: "sdk-prompt",
      timeoutMs: null,
      fallback: { ...fallbackConnection, timeoutMs: null },
    });
  });

  test("an llm runner goes to chat with the connection and the user message", async () => {
    const calls: Array<{ connection: LlmConnectionConfig; messages: unknown }> = [];
    const result = await runExecution(built({ kind: "llm", engine: "llm", connection: llmConnection }, "llm-prompt"), {
      runAgent: refuse("agent"),
      runSdk: refuse("sdk"),
      chat: async (connection, messages) => {
        calls.push({ connection, messages });
        return "from-llm";
      },
    });
    expect(result.stdout).toBe("from-llm");
    expect(calls[0]?.connection).toEqual({ ...llmConnection, timeoutMs: null });
    expect(calls[0]?.messages).toEqual([{ role: "user", content: "llm-prompt" }]);
  });

  test("reads the current symbolic credential at every dispatch", async () => {
    const seen: string[] = [];
    const runner: RunnerSpec = {
      kind: "llm",
      engine: "rotating",
      connection: llmConnection,
      credential: { names: ["ROTATING_RUNNER_API_KEY"], required: true },
      timeoutMs: 1234,
    };
    const execution = built(runner);
    const options: RunExecutionOptions = {
      chat: async (connection) => {
        seen.push(connection.apiKey ?? "");
        return "ok";
      },
    };
    await withEnv({ ROTATING_RUNNER_API_KEY: "first-key" }, async () => {
      await runExecution(execution, options);
      await withEnv({ ROTATING_RUNNER_API_KEY: "second-key" }, () => runExecution(execution, options));
    });
    expect(seen).toEqual(["first-key", "second-key"]);
    expect(JSON.stringify(execution)).not.toContain("key");
  });
});

describe("runExecution redacts what the child could have seen", () => {
  test("engine credentials, bound env, profile env and non-allowlisted passthrough values", async () => {
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
      safeEventSource: "improve",
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
    const runner: RunnerSpec = {
      kind: "sdk",
      engine: "sdk",
      profile,
      fallbackConnection: { ...llmConnection, apiKey: values.engine },
    };
    const echoed = Object.values(values).join(" | ");
    const result = await runExecution(
      built(runner, "p", { environment: { BOUND_VALUE: values.binding, AKM_EVENT_SOURCE: values.safeEventSource } }),
      {
        runOptions: {
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
        runSdk: async () => ({ ...okResult(echoed), stderr: echoed, error: echoed, parsed: { echoed } }),
      },
    );

    for (const secret of [values.engine, values.binding, values.asset, values.passthrough]) {
      expect(JSON.stringify(result)).not.toContain(secret);
    }
    for (const nonsecret of [
      values.safePath,
      values.safeProfile,
      values.safeRegion,
      values.safeModel,
      values.safeBaseUrl,
      values.safeOpencodeConfig,
      values.safeClaudeConfig,
      values.safeCodexConfig,
      values.safeEventSource,
    ]) {
      expect(JSON.stringify(result)).toContain(nonsecret);
    }
    expect(result.stdout.match(/\[REDACTED\]/g)).toHaveLength(4);
  });

  test("credential-bearing values even when their passthrough names are allowlisted", async () => {
    const userinfo = "https://user:password@example.test/v1";
    const signed = "https://example.test/object?X-Amz-Credential=owner&X-Amz-Signature=signed-secret";
    const clientAssertion = "https://example.test/token?client_assertion=RUNNER%2BASSERTION%2BSENTINEL";
    const codeVerifier = "https://example.test/#/oauth/callback?code_verifier=RUNNER%20PKCE%20SENTINEL";
    const profile: AgentProfile = {
      ...sdkProfile,
      envPassthrough: ["LLM_BASE_URL", "AWS_PROFILE", "OPENCODE_CONFIG", "CLAUDE_CONFIG"],
    };
    const partialCredentials = ["password", "signed-secret", "RUNNER+ASSERTION+SENTINEL", "RUNNER PKCE SENTINEL"];
    const echoed = partialCredentials.join(" | ");
    const result = await runExecution(built({ kind: "sdk", engine: "sdk", profile }), {
      runOptions: {
        envSource: {
          LLM_BASE_URL: userinfo,
          AWS_PROFILE: signed,
          OPENCODE_CONFIG: clientAssertion,
          CLAUDE_CONFIG: codeVerifier,
        },
      },
      runSdk: async () => ({ ...okResult(echoed), parsed: { echoed } }),
    });

    for (const url of [userinfo, signed, clientAssertion, codeVerifier]) {
      expect(JSON.stringify(result)).not.toContain(url);
    }
    for (const secret of partialCredentials) expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.stdout).toBe("[REDACTED] | [REDACTED] | [REDACTED] | [REDACTED]");
  });
});

describe("runExecution's usage record names the model the dispatch ran", () => {
  const agentRunner = (args: string[]): RunnerSpec => ({
    kind: "agent",
    engine: "oc",
    profile: { ...agentProfile, args },
  });

  /** The usage records one dispatch of `runner` leaves. */
  async function usageOf(runner: RunnerSpec, current?: UnresolvedExecutionDefaults): Promise<LlmUsageRecord[]> {
    const records: LlmUsageRecord[] = [];
    setLlmUsageSink((record) => records.push(record));
    try {
      await runExecution(built(runner, "p", current), {
        runAgent: async () => okResult("ok"),
        runSdk: async () => okResult("ok"),
      });
    } finally {
      clearLlmUsageSink();
    }
    return records;
  }

  test("an agent engine that names its model only in args is attributed to it", async () => {
    const records = await usageOf(agentRunner(["run", "--model", "krang/chat/qwen3.8-27b"]));

    expect(records).toHaveLength(1);
    expect(records[0]?.model).toBe("krang/chat/qwen3.8-27b");
  });

  test("the --model=<id> form is read too, and the last --model wins", async () => {
    const equals = await usageOf(agentRunner(["run", "--model=krang/chat/qwen3.8-27b"]));
    const twice = await usageOf(agentRunner(["--model", "first/model", "run", "--model=second/model"]));

    expect(equals[0]?.model).toBe("krang/chat/qwen3.8-27b");
    expect(twice[0]?.model).toBe("second/model");
  });

  test("a model the request names wins over the one in args", async () => {
    const records = await usageOf(agentRunner(["run", "--model", "from/args"]), { model: "from/request" });

    expect(records[0]?.model).toBe("from/request");
  });

  test("an agent engine that names no model stays unattributed", async () => {
    const records = await usageOf(agentRunner(["run"]));

    expect(records).toHaveLength(1);
    expect(records[0]).not.toHaveProperty("model");
  });

  test("an sdk engine's args are not read: its server never sees them", async () => {
    const { model: _model, ...unmodelled } = sdkProfile;
    const records = await usageOf({
      kind: "sdk",
      engine: "sdk",
      profile: { ...unmodelled, args: ["--model", "from/args"] },
    });

    expect(records).toHaveLength(1);
    expect(records[0]).not.toHaveProperty("model");
  });
});
