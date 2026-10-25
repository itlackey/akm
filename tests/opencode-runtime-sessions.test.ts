// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// What akm creates a session on its internal runtime with, against the scripted
// host (tests/_helpers/fake-opencode-host.ts): the host and its providers, the
// session's model, environment and persona, the request settings the plugin
// applies to that session's requests, and how a timeout or abort ends a turn.
// tests/integration/opencode-sdk-runner.test.ts runs the same runner on the real OpenCode.

import { describe, expect, test } from "bun:test";
import type { AkmConfig } from "../src/core/config/config-types";
import { getConfigDir } from "../src/core/paths";
import { _setWarnSinkForTests } from "../src/core/warn";
import { runtimeProfile } from "../src/integrations/agent/profiles";
import { resolveTarget } from "../src/integrations/agent/resolution";
import { closeOpencodeSdk, hostFor } from "../src/integrations/harnesses/opencode/embedded/host";
import { runOpencodeSdk } from "../src/integrations/harnesses/opencode/embedded/run";
import { runnerModel } from "../src/integrations/harnesses/opencode/embedded/runner-models";
import type { ChatCompletionConfig } from "../src/llm/client";
import { type FakeChildSession, installFakeOpencodeHost } from "./_helpers/fake-opencode-host";
import { withEnv } from "./_helpers/sandbox";
import { overrideSeam } from "./_helpers/seams";

const profile = runtimeProfile({
  kind: "connection",
  name: "lab",
  endpoint: "",
  model: "glm-5",
  request: {},
  timeoutMs: null,
});
const connection: ChatCompletionConfig = { endpoint: "https://lab.invalid/v1/chat/completions", model: "glm-5" };

const run = (prompt: string, opts: Parameters<typeof runOpencodeSdk>[1] = {}, using = connection) =>
  runOpencodeSdk(profile, { timeoutMs: 5_000, ...opts, dispatch: { ...opts.dispatch, prompt } }, using);

describe("the runtime host", () => {
  test("is created with no provider of its own and OpenCode's free ones off, whatever the config lists", async () => {
    const { specs } = installFakeOpencodeHost({ reply: () => "ok" });
    await run("p");
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ kind: "runtime", isolated: true, fetchModels: false });
    expect(specs[0]?.content).toEqual({ disabled_providers: ["opencode"] });
  });

  test("declares the connection a run brings as a provider: its base URL, its model, its window and its cap", async () => {
    const { providers, calls } = installFakeOpencodeHost({ reply: () => "ok" });
    await run(
      "p",
      {},
      {
        ...connection,
        endpoint: "https://lab.invalid/v1/chat/completions",
        contextLength: 32768,
        request: { max_tokens: 2048 },
      },
    );
    const provider = providers.get(calls[0]?.model?.providerID ?? "");
    expect(provider?.info).toMatchObject({ activation: "enabled", settings: { baseURL: "https://lab.invalid/v1" } });
    expect(provider?.models).toHaveLength(1);
    expect(provider?.models[0]).toMatchObject({ id: "glm-5", limit: { context: 32768, output: 2048 } });
  });

  test("keeps OpenCode's own assumption for a window or cap the connection does not state", async () => {
    const { providers, calls } = installFakeOpencodeHost({ reply: () => "ok" });
    await run("p", {}, { ...connection, contextLength: 8192 });
    expect(providers.get(calls[0]?.model?.providerID ?? "")?.models[0]).toMatchObject({
      limit: { context: 8192, output: 32000 },
    });
  });

  test("declares connections that differ in endpoint, model or window as different providers, and one connection once", async () => {
    const { providers, calls } = installFakeOpencodeHost({ reply: () => "ok" });
    await run("a", {}, connection);
    await run("b", {}, connection);
    await run("c", {}, { ...connection, endpoint: "https://elsewhere.invalid/v1" });
    await run("d", {}, { ...connection, model: "glm-5.1" });
    await run("e", {}, { ...connection, contextLength: 4096 });
    const ids = calls.map((call) => call.model?.providerID);
    expect(ids[0]).toBe(ids[1]);
    expect(new Set(ids).size).toBe(4);
    expect(providers.size).toBe(4);
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

  test("closing waits for a close that something else started", async () => {
    // Resetting the host factory closes the hosts too, without waiting; a later close must still wait for them.
    const { lifecycle } = installFakeOpencodeHost({ reply: () => "ok", closeDelayMs: 50 });
    await run("p");
    void closeOpencodeSdk();
    await closeOpencodeSdk();
    expect(lifecycle.closed).toBe(1);
  });

  test("loads akm's read tools", async () => {
    const { tools } = installFakeOpencodeHost({ reply: () => "ok" });
    await run("p");
    expect(tools.runtime).toEqual(["akm_curate", "akm_search", "akm_show"]);
  });
});

describe("a session on the runtime", () => {
  test("is created with the run's model on the connection's provider, in the working directory", async () => {
    const { calls } = installFakeOpencodeHost({ reply: () => "ok" });
    await run("p", { cwd: "/work/here" }, { ...connection, model: "glm-5.1" });
    expect(calls[0]).toMatchObject({
      kind: "runtime",
      model: { providerID: runnerModel({ ...connection, model: "glm-5.1" }).providerID, id: "glm-5.1" },
      directory: "/work/here",
      metadata: { akm: "agent" },
    });
    expect(calls[0]?.permissions).toBeUndefined();
  });

  test("an exact model name is the session's model and the request's, whatever the config lists", async () => {
    const { calls } = installFakeOpencodeHost({ reply: () => "ok" });
    await run("p", {}, { ...connection, model: "glm-exact" });
    expect(calls[0]?.model?.id).toBe("glm-exact");
    expect(calls[0]?.requestBody.model).toBe("glm-exact");
  });

  test("carries the run's environment, and the persona as its instructions", async () => {
    const { calls } = installFakeOpencodeHost({ reply: () => "ok" });
    await run("p", {
      env: { AKM_EVENT_SOURCE: "task", API_TOKEN: "t" },
      dispatch: { prompt: "p", systemPrompt: "BE BRIEF" },
    });
    expect(calls[0]?.environment).toMatchObject({ AKM_EVENT_SOURCE: "task", API_TOKEN: "t" });
    expect(calls[0]?.system).toBe("BE BRIEF");
  });

  // OpenCode gives a session's commands its environment in place of the process's, so the session is always given
  // one, built as a CLI harness's child gets its own: akm's directories, the allowlist, then the run's variables.
  test("gives the commands an environment of the allowlist and akm's directories, never the whole process's", async () => {
    const { calls } = installFakeOpencodeHost({ reply: () => "ok" });
    await withEnv({ AKM_AMBIENT: "ambient", OPENAI_API_KEY: "sk-other-vendor" }, () => run("p"));
    const environment = calls[0]?.environment ?? {};
    expect(environment).toMatchObject({ HOME: process.env.HOME, AKM_CONFIG_DIR: getConfigDir() });
    expect(environment.PATH).toBeTruthy();
    expect(environment).not.toHaveProperty("AKM_AMBIENT");
    expect(environment).not.toHaveProperty("OPENAI_API_KEY");
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

  test("never replace the model, the conversation, the tools, streaming or the response format, which are akm's and the SDK's", async () => {
    const { calls } = installFakeOpencodeHost({ reply: () => "ok" });
    await run(
      "p",
      {},
      {
        ...connection,
        request: {
          model: "overridden",
          messages: [],
          tools: [],
          stream: false,
          response_format: { type: "json_object" },
          top_p: 0.9,
        },
      },
    );
    const body = calls[0]?.requestBody ?? {};
    expect(body.model).toBe("glm-5");
    expect(body.stream).toBe(true);
    for (const field of ["messages", "tools", "response_format"]) expect(body).not.toHaveProperty(field);
    expect(body.top_p).toBe(0.9);
  });

  test("never take the tools from an extraParams of a call, a process or a workflow step either", async () => {
    const { calls } = installFakeOpencodeHost({ reply: () => "ok" });
    const runner = resolveTarget({
      config: {
        connections: { lab: { endpoint: "https://lab.invalid/v1/chat/completions", models: { fast: "glm-5" } } },
      } as unknown as AkmConfig,
      modelWork: true,
      layers: [{ inference: { extraParams: { tools: [{ type: "function" }], top_k: 40 } } }],
    });
    if (runner.kind !== "connection") throw new Error("expected a connection");
    await run(
      "p",
      {},
      { endpoint: runner.endpoint, model: runner.model, request: runner.request, inference: runner.inference },
    );
    const body = calls[0]?.requestBody ?? {};
    expect(body).not.toHaveProperty("tools");
    expect(body.top_k).toBe(40);
    expect(body.model).toBe("glm-5");
  });

  test("send an output cap when the connection or the call writes one, by the name it wrote it", async () => {
    const { calls } = installFakeOpencodeHost({ reply: () => "ok" });
    await run("a", {}, { ...connection, request: { max_tokens: 777 } });
    await run("b", {}, { ...connection, request: { max_completion_tokens: 888 } });
    await run("c", {}, { ...connection, inference: { maxTokens: 999 } });
    expect(calls.map((call) => [call.requestBody.max_tokens, call.requestBody.max_completion_tokens])).toEqual([
      [777, undefined],
      [undefined, 888],
      [999, undefined],
    ]);
  });

  test("change nothing for a call that sets none", async () => {
    const { calls } = installFakeOpencodeHost({ reply: () => "ok" });
    await run("p");
    // OpenCode's own output cap (32,000 tokens unless the model's limit says) is not one anyone asked for.
    expect(calls[0]?.requestBody).toEqual({ model: "glm-5", stream: true });
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

describe("a subagent session the run starts", () => {
  const withSettings = {
    ...connection,
    apiKey: "sk-lab",
    request: { top_k: 7 },
    inference: { temperature: 0.2 },
  };
  const env = { AKM_EVENT_SOURCE: "task", API_TOKEN: "t" };

  /** Run a prompt whose agent starts a subagent, and report what the subagent was given. */
  async function runWithSubagent() {
    let seen: { request: Awaited<ReturnType<FakeChildSession["request"]>>; environment: unknown } | undefined;
    const host = installFakeOpencodeHost({
      reply: async (call) => {
        const child = host.spawnChild("runtime", call.sessionID);
        seen = { request: await child.request(), environment: child.environment() };
        return "done";
      },
    });
    const result = await run("p", { env }, withSettings);
    return { result, seen, sessionsAfter: (await hostFor("runtime")).sessions.size };
  }

  test("is given the run's key and request fields on its first request", async () => {
    const { result, seen } = await runWithSubagent();
    expect(result.ok).toBe(true);
    expect(seen?.request.requestHeaders.authorization).toBe("Bearer sk-lab");
    expect(seen?.request.requestBody).toMatchObject({ top_k: 7, temperature: 0.2 });
  });

  test("has the run's environment set before that request goes out, so before any command it runs", async () => {
    expect((await runWithSubagent()).seen?.environment).toMatchObject(env);
  });

  test("is forgotten with the run", async () => {
    expect((await runWithSubagent()).sessionsAfter).toBe(0);
  });

  test("a session that no run started is given nothing", async () => {
    const host = installFakeOpencodeHost({ reply: () => "ok" });
    await run("p", { env }, withSettings);
    const stranger = host.spawnChild("runtime", "ses_not_a_run");
    expect((await stranger.request()).requestHeaders.authorization).toBeUndefined();
    expect(stranger.environment()).toBeUndefined();
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
    expect(result.error).toStartWith(`akm's runtime on connection "lab" timed out after 20ms`);
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
    // The interrupt's grace period is five seconds; shorten it for this test.
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((callback: () => void, ms?: number) =>
      realSetTimeout(callback, ms !== undefined && ms > 1_000 ? 20 : ms)) as typeof setTimeout;
    try {
      const result = await run("p", { timeoutMs: 20 });
      expect(result.reason).toBe("timeout");
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });
});

/** A promise a test settles itself, to hold a call of the fake host as long as it likes. */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the deadline and the abort signal govern every step of a run", () => {
  test("a setup call that outlasts the deadline is a timeout, and the turn is never started after it", async () => {
    const hold = deferred();
    const { calls } = installFakeOpencodeHost({ reply: () => "ok", hold: { create: hold.promise } });
    const started = Date.now();
    const result = await run("p", { timeoutMs: 5 });
    const waited = Date.now() - started;
    hold.release();
    await sleep(50);

    expect(result.reason).toBe("timeout");
    expect(result.error).toBe(`akm's runtime on connection "lab" timed out during startup after 5ms`);
    expect(waited).toBeLessThan(40);
    // The session was created after the run was given up on: nothing was prompted, and nothing is left registered.
    expect(calls).toHaveLength(0);
    expect((await hostFor("runtime")).sessions.size).toBe(0);
  });

  for (const step of ["create", "environment", "instructions"] as const) {
    test(`a ${step} call that never settles ends at the deadline, not never`, async () => {
      const interrupted: string[] = [];
      installFakeOpencodeHost({
        reply: () => "ok",
        hold: { [step]: new Promise<void>(() => {}) },
        onInterrupt: (id) => void interrupted.push(id),
      });
      const result = await run("p", { timeoutMs: 30, dispatch: { prompt: "p", systemPrompt: "persona" } });

      expect(result.reason).toBe("timeout");
      // Once the session exists the run says so and interrupts it; before, it was still starting.
      if (step === "create") {
        expect(result.sessionId).toBeUndefined();
        expect(result.error).toContain("during startup");
      } else {
        expect(interrupted).toEqual([result.sessionId as string]);
      }
      expect((await hostFor("runtime")).sessions.size).toBe(0);
    });
  }

  test("a caller that aborts while a setup call hangs gets its answer at once, and the late session is released", async () => {
    const hold = deferred();
    const { calls } = installFakeOpencodeHost({ reply: () => "ok", hold: { create: hold.promise } });
    const controller = new AbortController();
    const running = run("p", { signal: controller.signal, timeoutMs: null });
    await sleep(20);
    controller.abort();
    const result = await running;
    hold.release();
    await sleep(50);

    expect(result.reason).toBe("aborted");
    expect(result.error).toContain("during startup");
    expect(calls).toHaveLength(0);
    expect((await hostFor("runtime")).sessions.size).toBe(0);
  });

  test("a deadline that has already passed when the host is ready starts nothing", async () => {
    const { calls, lifecycle } = installFakeOpencodeHost({ reply: () => "ok" });
    const result = await run("p", { timeoutMs: 0 });
    expect(result.reason).toBe("timeout");
    expect(calls).toHaveLength(0);
    expect(lifecycle.created).toBe(1);
  });
});

describe("closing the embedded hosts is bounded", () => {
  /** The grace periods are seconds; shorten them for a test. */
  async function withShortGrace<T>(work: () => Promise<T>): Promise<T> {
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((callback: () => void, ms?: number) =>
      realSetTimeout(callback, ms !== undefined && ms >= 1_000 ? 40 : ms)) as typeof setTimeout;
    try {
      return await work();
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  }

  test("a start that never settles times the run out, and closing gives up on it instead of waiting for it", async () => {
    const warnings: string[] = [];
    overrideSeam(_setWarnSinkForTests, (level, args) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });
    installFakeOpencodeHost({ reply: () => "ok", ready: new Promise<void>(() => {}) });
    const result = await run("p", { timeoutMs: 5 });
    expect(result.error).toBe(`akm's runtime on connection "lab" timed out during startup after 5ms`);

    const started = Date.now();
    await withShortGrace(() => closeOpencodeSdk());

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(warnings.some((w) => w.includes("did not stop starting"))).toBe(true);
  });

  test("a start that is asked to stop does, and closing does not wait out the grace period", async () => {
    installFakeOpencodeHost({ reply: () => "ok", ready: new Promise<void>(() => {}), startupHonorsAbort: true });
    await run("p", { timeoutMs: 5 });
    const started = Date.now();
    await closeOpencodeSdk();
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("a host that finishes starting after it was given up on is closed, not left running", async () => {
    const ready = deferred();
    const { lifecycle } = installFakeOpencodeHost({ reply: () => "ok", ready: ready.promise });
    await run("p", { timeoutMs: 5 });
    await withShortGrace(() => closeOpencodeSdk());
    ready.release();
    await sleep(50);
    expect(lifecycle).toEqual({ created: 1, closed: 1 });
  });

  test("a host whose close never finishes is named and left, and closing returns", async () => {
    const warnings: string[] = [];
    overrideSeam(_setWarnSinkForTests, (level, args) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });
    installFakeOpencodeHost({ reply: () => "ok", closeDelayMs: Number.POSITIVE_INFINITY });
    await run("p");
    const started = Date.now();
    await withShortGrace(() => closeOpencodeSdk());
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(warnings.some((w) => w.includes("did not close"))).toBe(true);
  });
});
