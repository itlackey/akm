// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import type { UnresolvedExecutionDefaults } from "../../src/execution/source";
import type { AgentRunResult } from "../../src/integrations/agent";
import { type BuiltExecution, buildExecution, resolveExecution } from "../../src/integrations/agent/execution";
import type { AgentProfile } from "../../src/integrations/agent/profiles";
import type { ConnectionRunner, HarnessRunner, RunnerSpec } from "../../src/integrations/agent/runner";
import {
  collectDispatchSensitiveValues,
  type RunExecutionOptions,
  runExecution,
} from "../../src/integrations/agent/runner-dispatch";
import type { ChatCompletionConfig } from "../../src/llm/client";
import { clearLlmUsageSink, type LlmUsageRecord, setLlmUsageSink } from "../../src/llm/usage-telemetry";
import { withEnv } from "../_helpers/sandbox";

function okResult(stdout: string): AgentRunResult {
  return { ok: true, exitCode: 0, stdout, stderr: "", durationMs: 1 };
}

const opencodeHarness: HarnessRunner = {
  kind: "harness",
  name: "opencode-default",
  platform: "opencode",
  bin: "opencode",
  args: ["run"],
  timeoutMs: null,
};

const claudeHarness: HarnessRunner = {
  kind: "harness",
  name: "claude-default",
  platform: "claude",
  bin: "claude",
  args: [],
  timeoutMs: null,
};

const lab: ConnectionRunner = {
  kind: "connection",
  name: "lab",
  endpoint: "https://api.openai.com/v1/chat/completions",
  model: "gpt-4o-mini",
  request: {},
  timeoutMs: null,
};

function built(
  runner: RunnerSpec,
  content = "prompt",
  current?: UnresolvedExecutionDefaults,
  modelWork = false,
): BuiltExecution {
  const resolved = resolveExecution({ content, runner, modelWork, ...(current ? { current } : {}) });
  return buildExecution(resolved.request, resolved.runner);
}

const refuse = (kind: string) => async (): Promise<AgentRunResult> => {
  throw new Error(`the ${kind} transport must not be called`);
};

describe("runExecution routes each runner kind to its transport", () => {
  test("a harness runner goes to runAgent with its profile and prompt", async () => {
    const calls: Array<{ profile: AgentProfile; prompt: string }> = [];
    const result = await runExecution(built(opencodeHarness, "hello"), {
      runAgent: async (profile, prompt) => {
        calls.push({ profile, prompt });
        return okResult("from-agent");
      },
      runSdk: refuse("sdk"),
      chat: refuse("chat") as never,
    });
    expect(result.stdout).toBe("from-agent");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.profile.bin).toBe("opencode");
    expect(calls[0]?.prompt).toBe("hello");
  });

  test("a connection running agent work goes to runSdk with its timeout and the connection", async () => {
    let received: { prompt: string; timeoutMs?: number | null; connection?: ChatCompletionConfig } | undefined;
    await runExecution(built({ ...lab, request: { top_p: 0.9 } }, "sdk-prompt"), {
      runAgent: refuse("agent"),
      chat: refuse("chat") as never,
      runSdk: async (_profile, prompt, opts, connection) => {
        received = { prompt, timeoutMs: opts.timeoutMs, connection };
        return okResult("from-sdk");
      },
    });
    expect(received).toEqual({
      prompt: "sdk-prompt",
      timeoutMs: null,
      connection: {
        endpoint: lab.endpoint,
        model: lab.model,
        request: { top_p: 0.9 },
        timeoutMs: null,
      },
    });
  });

  test("a connection running model work goes to chat with the connection and the user message", async () => {
    const calls: Array<{ connection: ChatCompletionConfig; messages: unknown }> = [];
    const result = await runExecution(built(lab, "llm-prompt", undefined, true), {
      runAgent: refuse("agent"),
      runSdk: refuse("sdk"),
      chat: async (connection, messages) => {
        calls.push({ connection, messages });
        return "from-llm";
      },
    });
    expect(result.stdout).toBe("from-llm");
    expect(calls[0]?.connection).toEqual({
      endpoint: lab.endpoint,
      model: lab.model,
      request: {},
      timeoutMs: null,
    });
    expect(calls[0]?.messages).toEqual([{ role: "user", content: "llm-prompt" }]);
  });

  test("reads the current symbolic credential at every dispatch", async () => {
    const seen: string[] = [];
    const runner: ConnectionRunner = { ...lab, name: "rotating", apiKey: "$ROTATING_RUNNER_API_KEY", timeoutMs: 1234 };
    const execution = built(runner, "prompt", undefined, true);
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

describe("collectDispatchSensitiveValues", () => {
  test("an agent unit's bound env is configuration; the credential and an unsafe passthrough value still count", () => {
    const harnessValues = collectDispatchSensitiveValues(
      claudeHarness,
      { env: { HOOK_URL: "https://hooks.example.test/inbox/7", CHANNEL_ID: "1234567890" } },
      { PATH: "/safe/bin", ANTHROPIC_API_KEY: "UNSAFE-PASSTHROUGH" },
    );
    expect(harnessValues).toContain("UNSAFE-PASSTHROUGH");
    expect(harnessValues).not.toContain("https://hooks.example.test/inbox/7");
    expect(harnessValues).not.toContain("1234567890");

    const connectionValues = collectDispatchSensitiveValues(
      { ...lab, apiKey: "$LAB_KEY" },
      { env: { HOOK_URL: "https://hooks.example.test/inbox/7" } },
      { LAB_KEY: "ENGINE-CREDENTIAL" },
    );
    expect(connectionValues).toEqual(["ENGINE-CREDENTIAL"]);
  });

  test("a connection's stored key counts too, and reading it for redaction does not warn", () => {
    expect(collectDispatchSensitiveValues({ ...lab, apiKey: "$ABSENT_KEY" }, {}, {})).toEqual([]);
  });
});

describe("runExecution redacts what the child could have seen", () => {
  test("the connection's credential and non-allowlisted passthrough values, but not bound env", async () => {
    const values = {
      credential: "CREDENTIAL-ECHO-SENTINEL",
      binding: "BINDING-ECHO-SENTINEL",
      passthrough: "PASSTHROUGH-ECHO-SENTINEL",
      safePath: "/safe/runtime/path",
      safeClaudeConfig: "/safe/claude.json",
      safeEventSource: "improve",
    };
    const echoed = Object.values(values).join(" | ");
    const result = await runExecution(
      built(claudeHarness, "p", {
        environment: { BOUND_VALUE: values.binding, AKM_EVENT_SOURCE: values.safeEventSource },
      }),
      {
        runOptions: {
          envSource: {
            PATH: values.safePath,
            ANTHROPIC_API_KEY: values.passthrough,
            CLAUDE_CONFIG: values.safeClaudeConfig,
          },
        },
        runAgent: async () => ({ ...okResult(echoed), stderr: echoed, error: echoed, parsed: { echoed } }),
      },
    );

    expect(JSON.stringify(result)).not.toContain(values.passthrough);
    for (const nonsecret of [values.binding, values.safePath, values.safeClaudeConfig, values.safeEventSource]) {
      expect(JSON.stringify(result)).toContain(nonsecret);
    }
    expect(result.stdout.match(/\[REDACTED\]/g)).toHaveLength(1);

    const viaConnection = await runExecution(
      built({ ...lab, apiKey: "$LAB_KEY" }, "p", { environment: { BOUND_VALUE: values.binding } }),
      {
        runOptions: { envSource: { LAB_KEY: values.credential } },
        runSdk: async () => ({ ...okResult(echoed), stderr: echoed, error: echoed, parsed: { echoed } }),
      },
    );
    expect(JSON.stringify(viaConnection)).not.toContain(values.credential);
    expect(JSON.stringify(viaConnection)).toContain(values.binding);
  });

  // The XDG directories are paths, like HOME and TMPDIR: an opencode child that echoes the config
  // directory it read (in an error, say) must not have it scrubbed to [REDACTED].
  test("not the XDG base directories an opencode child was given", async () => {
    const directories = {
      XDG_CONFIG_HOME: "/sandbox/xdg-config",
      XDG_DATA_HOME: "/sandbox/xdg-data",
      XDG_CACHE_HOME: "/sandbox/xdg-cache",
      XDG_STATE_HOME: "/sandbox/xdg-state",
    };
    const echoed = Object.values(directories).join(" | ");
    const result = await runExecution(built(opencodeHarness), {
      runOptions: { envSource: { PATH: "/safe/bin", ...directories } },
      runAgent: async () => ({ ...okResult(echoed), stderr: echoed, error: echoed, parsed: { echoed } }),
    });

    expect(result.stdout).toBe(echoed);
    expect(result.stderr).toBe(echoed);
    expect(result.error).toBe(echoed);
    expect(result.stdout).not.toContain("[REDACTED]");
  });

  test("credential-bearing values even when their passthrough names are allowlisted", async () => {
    const cases = [
      // [platform, allowlisted name, value, the credential inside it]
      ["openhands", "LLM_BASE_URL", "https://user:password@example.test/v1", "password"],
      [
        "amazonq",
        "AWS_PROFILE",
        "https://example.test/object?X-Amz-Credential=owner&X-Amz-Signature=signed-secret",
        "signed-secret",
      ],
      [
        "opencode",
        "OPENCODE_CONFIG",
        "https://example.test/token?client_assertion=RUNNER%2BASSERTION%2BSENTINEL",
        "RUNNER+ASSERTION+SENTINEL",
      ],
      [
        "claude",
        "CLAUDE_CONFIG",
        "https://example.test/#/oauth/callback?code_verifier=RUNNER%20PKCE%20SENTINEL",
        "RUNNER PKCE SENTINEL",
      ],
    ] as const;
    for (const [platform, name, value, secret] of cases) {
      const runner: HarnessRunner = { ...opencodeHarness, platform, bin: platform, args: [] };
      const echoed = `${value} | ${secret}`;
      const result = await runExecution(built(runner), {
        runOptions: { envSource: { [name]: value } },
        runAgent: async () => ({ ...okResult(echoed), parsed: { echoed } }),
      });
      expect(JSON.stringify(result), `${platform} ${name}`).not.toContain(value);
      expect(JSON.stringify(result), `${platform} ${name}`).not.toContain(secret);
      expect(result.stdout).toBe("[REDACTED] | [REDACTED]");
    }
  });
});

describe("runExecution's usage record names the model the dispatch ran", () => {
  const harnessRunner = (args: string[]): HarnessRunner => ({ ...opencodeHarness, args });

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

  test("a harness that names its model only in args is attributed to it", async () => {
    const records = await usageOf(harnessRunner(["run", "--model", "krang/chat/qwen3.8-27b"]));

    expect(records).toHaveLength(1);
    expect(records[0]?.model).toBe("krang/chat/qwen3.8-27b");
  });

  test("the --model=<id> form is read too, and the last --model wins", async () => {
    const equals = await usageOf(harnessRunner(["run", "--model=krang/chat/qwen3.8-27b"]));
    const twice = await usageOf(harnessRunner(["--model", "first/model", "run", "--model=second/model"]));

    expect(equals[0]?.model).toBe("krang/chat/qwen3.8-27b");
    expect(twice[0]?.model).toBe("second/model");
  });

  test("a model the request names wins over the one in args", async () => {
    const records = await usageOf(harnessRunner(["run", "--model", "from/args"]), { model: "from/request" });

    expect(records[0]?.model).toBe("from/request");
  });

  test("a harness that names no model stays unattributed", async () => {
    const records = await usageOf(harnessRunner(["run"]));

    expect(records).toHaveLength(1);
    expect(records[0]).not.toHaveProperty("model");
  });

  test("a connection running agent work is attributed to its model", async () => {
    const records = await usageOf(lab);

    expect(records).toHaveLength(1);
    expect(records[0]?.model).toBe("gpt-4o-mini");
  });
});
