// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// What akm creates a session on its internal runtime with, against the scripted
// host (tests/_helpers/fake-opencode-host.ts): the host and its providers, the
// session's model, environment and persona, the request settings the plugin
// applies to that session's requests, and how a timeout or abort ends a turn.
// tests/opencode-sdk-runner.test.ts runs the same runner on the real OpenCode.

import { beforeEach, describe, expect, test } from "bun:test";
import { resetConfigCache } from "../src/core/config/config";
import type { AgentProfile } from "../src/integrations/agent/profiles";
import { closeOpencodeSdk, hostFor } from "../src/integrations/harnesses/opencode/embedded/host";
import { runOpencodeSdk } from "../src/integrations/harnesses/opencode/embedded/run";
import type { ChatCompletionConfig } from "../src/llm/client";
import { installFakeOpencodeHost } from "./_helpers/fake-opencode-host";
import { writeSandboxConfig } from "./_helpers/sandbox";

const profile: AgentProfile = {
  name: "lab",
  platform: "opencode-sdk",
  bin: "",
  args: [],
  stdio: "captured",
  envPassthrough: [],
  parseOutput: "text",
};
const connection: ChatCompletionConfig = { endpoint: "https://lab.invalid/v1/chat/completions", model: "glm-5" };

beforeEach(() => {
  writeSandboxConfig({
    connections: {
      lab: {
        endpoint: connection.endpoint,
        apiKey: "$LAB_KEY",
        contextLength: 32768,
        models: { fast: "glm-5", balanced: { model: "glm-5.1", max_tokens: 2048 }, reasoning: "glm-5.1" },
      },
      other: { endpoint: "http://localhost:11434/v1", models: { fast: "qwen3" } },
    },
  });
  resetConfigCache();
});

const run = (prompt: string, opts: Parameters<typeof runOpencodeSdk>[2] = {}, using = connection) =>
  runOpencodeSdk(profile, prompt, { timeoutMs: 5_000, ...opts }, using);

describe("the runtime host", () => {
  test("has one provider per configured connection, listing its models, and OpenCode's free ones off", async () => {
    const { specs } = installFakeOpencodeHost({ reply: () => "ok" });
    await run("p");
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ kind: "runtime", isolated: true, fetchModels: false });
    expect(specs[0]?.content).toEqual({
      disabled_providers: ["opencode"],
      provider: {
        "akm-lab": {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "https://lab.invalid/v1" },
          models: { "glm-5": {}, "glm-5.1": { limit: { context: 32768, output: 2048 } } },
        },
        "akm-other": {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "http://localhost:11434/v1" },
          models: { qwen3: {} },
        },
      },
    });
  });

  test("is started once and shared by every run, until it is closed", async () => {
    const { lifecycle } = installFakeOpencodeHost({ reply: () => "ok" });
    await run("one", {}, { ...connection, model: "glm-5" });
    await run("two", {}, { ...connection, model: "glm-5.1" });
    expect(lifecycle).toEqual({ created: 1, closed: 0 });
    await closeOpencodeSdk();
    expect(lifecycle).toEqual({ created: 1, closed: 1 });
    await run("three");
    expect(lifecycle.created).toBe(2);
  });

  test("loads akm's read tools", async () => {
    const { tools } = installFakeOpencodeHost({ reply: () => "ok" });
    await run("p");
    expect(tools.runtime).toEqual(["akm_curate", "akm_search", "akm_show"]);
  });
});

describe("a session on the runtime", () => {
  test("is created with the connection's provider and the run's model, in the working directory", async () => {
    const { calls } = installFakeOpencodeHost({ reply: () => "ok" });
    await run("p", { cwd: "/work/here" }, { ...connection, model: "glm-5.1" });
    expect(calls[0]).toMatchObject({
      kind: "runtime",
      model: { providerID: "akm-lab", id: "glm-5.1" },
      directory: "/work/here",
      metadata: { akm: "agent" },
    });
    expect(calls[0]?.permissions).toBeUndefined();
  });

  test("carries the run's environment, and the persona as its instructions", async () => {
    const { calls } = installFakeOpencodeHost({ reply: () => "ok" });
    await run("p", {
      env: { AKM_EVENT_SOURCE: "task", API_TOKEN: "t" },
      dispatch: { prompt: "p", systemPrompt: "BE BRIEF" },
    });
    expect(calls[0]?.environment).toEqual({ AKM_EVENT_SOURCE: "task", API_TOKEN: "t" });
    expect(calls[0]?.system).toBe("BE BRIEF");
  });

  test("sets no environment when the run has none", async () => {
    const { calls } = installFakeOpencodeHost({ reply: () => "ok" });
    await run("p");
    expect(calls[0]?.environment).toBeUndefined();
  });

  test("model work is created with the deny permissions, and none of them is a tool OpenCode names differently", async () => {
    const { calls } = installFakeOpencodeHost({ reply: () => "ok" });
    await run("p", { dispatch: { prompt: "p", modelWork: true } });
    expect(calls[0]).toMatchObject({ metadata: { akm: "model-work" } });
    expect(calls[0]?.permissions).toEqual(
      ["edit", "shell", "execute", "subagent"].map((action) => ({ action, resource: "*", effect: "deny" })),
    );
  });
});

describe("the settings the plugin applies to a session's model requests", () => {
  test("are the connection's request fields and the call's translated settings, with the key", async () => {
    const { calls } = installFakeOpencodeHost({ reply: () => "ok" });
    await run(
      "p",
      {},
      {
        ...connection,
        apiKey: "sk-lab",
        request: { top_p: 0.9, chat_template_kwargs: { enable_thinking: true, thinking_budget: 8192 } },
        inference: { temperature: 0.2, maxTokens: 512, enableThinking: false, reasoningEffort: "high" },
      },
    );
    expect(calls[0]?.requestBody).toEqual({
      model: "glm-5",
      stream: true,
      top_p: 0.9,
      temperature: 0.2,
      max_tokens: 512,
      chat_template_kwargs: { enable_thinking: false, thinking_budget: 8192 },
      enable_thinking: false,
      reasoning_effort: "high",
    });
    expect(calls[0]?.requestHeaders.authorization).toBe("Bearer sk-lab");
  });

  test("change nothing for a call that sets none", async () => {
    const { calls } = installFakeOpencodeHost({ reply: () => "ok" });
    await run("p");
    expect(calls[0]?.requestBody).toEqual({ model: "glm-5", stream: true, max_completion_tokens: 32000 });
    expect(calls[0]?.requestHeaders.authorization).toBeUndefined();
  });

  test("are forgotten when the run ends", async () => {
    installFakeOpencodeHost({ reply: () => "ok" });
    await run("p", {}, { ...connection, apiKey: "sk-lab", request: { top_p: 0.9 } });
    expect((await hostFor("runtime")).sessions.size).toBe(0);
  });

  test("are forgotten when the run times out", async () => {
    installFakeOpencodeHost({ reply: () => new Promise(() => {}) });
    const result = await run("p", { timeoutMs: 20 }, { ...connection, request: { top_p: 0.9 } });
    expect(result.reason).toBe("timeout");
    expect((await hostFor("runtime")).sessions.size).toBe(0);
  });
});

describe("a run that is cut short", () => {
  test("interrupts its session and waits for OpenCode to confirm before it reports the timeout", async () => {
    const interrupted: string[] = [];
    installFakeOpencodeHost({
      reply: () => new Promise(() => {}),
      onInterrupt: async (sessionID) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        interrupted.push(sessionID);
      },
    });
    const result = await run("p", { timeoutMs: 20 });
    expect(result.reason).toBe("timeout");
    expect(interrupted).toEqual([result.sessionId as string]);
  });

  test("interrupts a session the caller aborts", async () => {
    const interrupted: string[] = [];
    installFakeOpencodeHost({ reply: () => new Promise(() => {}), onInterrupt: (id) => void interrupted.push(id) });
    const controller = new AbortController();
    const running = run("p", { signal: controller.signal, timeoutMs: null });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const result = await running;
    expect(result.reason).toBe("aborted");
    expect(interrupted).toEqual([result.sessionId as string]);
  });

  test("does not wait for an interrupt OpenCode never confirms", async () => {
    installFakeOpencodeHost({ reply: () => new Promise(() => {}), onInterrupt: () => new Promise(() => {}) });
    const shortened = ((callback: () => void, ms?: number) =>
      setTimeout(callback, ms !== undefined && ms > 1_000 ? 20 : ms)) as typeof setTimeout;
    const result = await run("p", { timeoutMs: 20, setTimeoutFn: shortened });
    expect(result.reason).toBe("timeout");
  });
});
