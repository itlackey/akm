// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// akm's internal runtime (#1244) against the real embedded OpenCode and a
// loopback fake model: no binary, no network. What a run is created with and what
// the endpoint receives are asserted; the fake host (tests/opencode-runtime-sessions.test.ts)
// covers the rest.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "@opencode/plugin";
import { resetConfigCache } from "../src/core/config/config";
import type { AgentProfile } from "../src/integrations/agent/profiles";
import {
  _setOpencodeHostFactoryForTests,
  closeOpencodeSdk,
  hostFor,
} from "../src/integrations/harnesses/opencode/embedded/host";
import { akmOpencodeDatabasePath } from "../src/integrations/harnesses/opencode/embedded/host-spec";
import { runOpencodeSdk } from "../src/integrations/harnesses/opencode/embedded/run";
import { createSdkHost } from "../src/integrations/harnesses/opencode/embedded/sdk-host";
import type { ChatCompletionConfig } from "../src/llm/client";
import { type FakeModelServer, startFakeModel } from "./_helpers/fake-model-server";
import { withEnv, writeSandboxConfig } from "./_helpers/sandbox";
import { overrideSeam } from "./_helpers/seams";

const profile: AgentProfile = {
  name: "lab",
  platform: "opencode-sdk",
  bin: "",
  args: [],
  stdio: "captured",
  envPassthrough: [],
};

let model: FakeModelServer;
let connection: ChatCompletionConfig;
let work: string;

beforeAll(() => {
  model = startFakeModel();
  connection = { endpoint: model.url, model: "fake-model", apiKey: "test-key", contextLength: 40000 };
  work = fs.mkdtempSync(path.join(process.env.HOME ?? "/tmp", "sdk-work-"));
});

// The runtime's providers are the configured connections; the real factory builds the host.
beforeEach(() => {
  writeSandboxConfig({
    connections: {
      lab: { endpoint: model.url, models: { fast: "fake-model" }, contextLength: 40000, max_tokens: 4000 },
    },
  });
  resetConfigCache();
  overrideSeam(_setOpencodeHostFactoryForTests, createSdkHost);
});

afterAll(async () => {
  await closeOpencodeSdk();
  // The suite's data directory is shared with the files that run after this one.
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${akmOpencodeDatabasePath()}${suffix}`, { force: true });
  model.stop();
});

const run = (prompt: string, extra: Parameters<typeof runOpencodeSdk>[2] = {}, using = connection) =>
  runOpencodeSdk(profile, prompt, { cwd: work, timeoutMs: 60_000, ...extra }, using);

const requestsFor = (mode: string) => model.requests.filter((r) => r.mode === mode);
const lastAnswer = (since: number) => model.requests.slice(since).find((r) => r.mode === "answer");

describe("a run on akm's internal runtime", () => {
  test("answers through the embedded OpenCode and stores the session in akm's database", async () => {
    const result = await run("MODE:answer hello");
    expect(result.ok).toBe(true);
    expect(result.stdout).toMatch(/^ANSWER-\d+$/);
    expect(result.sessionId).toBeTruthy();
    expect(result.usage?.inputTokens).toBeGreaterThan(0);
    expect(fs.existsSync(akmOpencodeDatabasePath())).toBe(true);
  });

  test("the system prompt reaches the model", async () => {
    await run("MODE:answer with persona", { dispatch: { prompt: "", systemPrompt: "PERSONA-MARKER" } });
    expect(requestsFor("answer").some((r) => r.system.includes("PERSONA-MARKER"))).toBe(true);
  });

  test("the run's environment reaches the commands the agent runs", async () => {
    const result = await run("MODE:env go", { env: { AKM_PROBE: "from-akm" } });
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("PROBE=from-akm");
  });

  test("the commands it runs keep the process environment under the run's variables", async () => {
    const result = await withEnv({ AKM_AMBIENT: "ambient" }, () =>
      run("MODE:env go", { env: { AKM_PROBE: "from-akm" } }),
    );
    expect(result.stdout).toContain("PROBE=from-akm AMBIENT=ambient");
  });

  test("a question is cancelled with a message and the run carries on", async () => {
    const result = await run("MODE:question go");
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("Q-DONE");
  });

  test("a compaction in the middle of a turn does not hide the turn", async () => {
    const before = model.requests.length;
    const result = await run("MODE:compact go");
    expect(model.requests.slice(before).some((r) => r.summarize)).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.stdout).not.toBe("");
  });

  test("a reply cut at the output limit is joined with its continuation", async () => {
    const result = await run("MODE:length go");
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("PART-ONE PART-TWO");
  });

  test("a reply still cut off after OpenCode's continuations is a parse_error", async () => {
    const result = await run("MODE:cutoff go");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("parse_error");
  });

  test("a model the connection does not list fails the run, naming it", async () => {
    const result = await run("MODE:answer go", {}, { ...connection, model: "not-listed" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("akm-lab/not-listed");
  });

  test("a connection that is not configured fails the run, naming it", async () => {
    const result = await runOpencodeSdk({ ...profile, name: "ghost" }, "MODE:answer go", { cwd: work }, connection);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("akm-ghost/fake-model");
  });
});

describe("what the endpoint receives", () => {
  test("the key is sent as a bearer token, and no key sends none", async () => {
    const before = model.requests.length;
    await run("MODE:answer keyed");
    expect(lastAnswer(before)?.authorization).toBe("Bearer test-key");
    const without = model.requests.length;
    await run("MODE:answer keyless", {}, { ...connection, apiKey: undefined });
    expect(lastAnswer(without)?.authorization).toBeUndefined();
  });

  test("the connection's request fields reach the model as written", async () => {
    const withFields: ChatCompletionConfig = {
      ...connection,
      request: { top_p: 0.9, chat_template_kwargs: { enable_thinking: false }, reasoning_effort: "low" },
    };
    const before = model.requests.length;
    expect((await run("MODE:answer with request fields", {}, withFields)).ok).toBe(true);
    const sent = lastAnswer(before);
    expect(sent?.params.top_p).toBe(0.9);
    expect(sent?.params.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(sent?.params.reasoning_effort).toBe("low");
  });

  test("a call's portable settings are translated, and its enableThinking keeps the thinking fields beside it", async () => {
    const withSettings: ChatCompletionConfig = {
      ...connection,
      request: { chat_template_kwargs: { enable_thinking: true, thinking_budget: 8192 } },
      inference: { enableThinking: false, temperature: 0.2, extraParams: { top_k: 40 } },
    };
    const before = model.requests.length;
    expect((await run("MODE:answer with merged thinking fields", {}, withSettings)).ok).toBe(true);
    const sent = lastAnswer(before);
    expect(sent?.params.chat_template_kwargs).toEqual({ enable_thinking: false, thinking_budget: 8192 });
    expect(sent?.params.temperature).toBe(0.2);
    expect(sent?.params.top_k).toBe(40);
  });

  test("a call's maxTokens is the request's only output limit", async () => {
    const before = model.requests.length;
    await run("MODE:answer capped", {}, { ...connection, inference: { maxTokens: 777 } });
    const sent = lastAnswer(before);
    expect(sent?.params.max_tokens).toBe(777);
    expect(sent?.params).not.toHaveProperty("max_completion_tokens");
  });

  test("one session's fields do not reach another's requests", async () => {
    const before = model.requests.length;
    await Promise.all([
      run("MODE:answer first", {}, { ...connection, request: { top_k: 11 } }),
      run("MODE:answer second", {}, { ...connection, request: { top_k: 22 } }),
    ]);
    const sent = model.requests.slice(before).filter((r) => r.mode === "answer" && r.params.top_k !== undefined);
    expect(sent.map((r) => [r.lastUser.includes("first"), r.params.top_k]).sort()).toEqual([
      [false, 22],
      [true, 11],
    ]);
  });
});

describe("a subagent the run starts", () => {
  test("is given the run's key, request fields and environment", async () => {
    const before = model.requests.length;
    const result = await run(
      "MODE:subagent go",
      { env: { AKM_PROBE: "from-akm" } },
      { ...connection, request: { top_k: 7 } },
    );
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("PROBE=from-akm");
    const child = model.requests.slice(before).filter((r) => r.mode === "env");
    expect(child.length).toBeGreaterThan(0);
    for (const request of child) {
      expect(request.authorization).toBe("Bearer test-key");
      expect(request.params.top_k).toBe(7);
    }
  });
});

describe("model work on the runtime's host", () => {
  test("gets OpenCode's read-only tools and akm's, and akm's tools run in-process", async () => {
    // akm search needs a bundle; this test's own, removed after so no other test sees it.
    const bundle = path.join(process.env.HOME ?? "", "akm");
    fs.mkdirSync(bundle, { recursive: true });
    try {
      const result = await run("MODE:akm go", { dispatch: { prompt: "", modelWork: true } });
      expect(result.ok).toBe(true);
      const offered = requestsFor("akm")[0]?.tools ?? [];
      expect(offered).toEqual(expect.arrayContaining(["read", "grep", "glob", "akm_search", "akm_show", "akm_curate"]));
      for (const tool of ["edit", "write", "shell", "execute", "subagent"]) expect(offered).not.toContain(tool);
      // akm search's own JSON came back as the tool result.
      expect(requestsFor("akm").find((r) => r.toolResult)?.toolResult).toContain('"hits"');
    } finally {
      fs.rmSync(bundle, { recursive: true, force: true });
    }
  });

  test("cannot write", async () => {
    const result = await run("MODE:write go", { dispatch: { prompt: "", modelWork: true } });
    expect(result.stdout).toContain("No tool named");
  });
});

describe("the runtime's host", () => {
  test("offers the connections' models and none of OpenCode's own free ones", async () => {
    // A probe plugin beside akm's keeps the context OpenCode hands plugins, to ask it which models a session may pick.
    let context: Parameters<Plugin.Plugin["setup"]>[0] | undefined;
    overrideSeam(_setOpencodeHostFactoryForTests, (spec) =>
      createSdkHost({
        ...spec,
        plugin: {
          id: "probe",
          setup: async (ctx) => {
            context = ctx;
            await spec.plugin.setup(ctx);
          },
        },
      }),
    );
    // Plugins are set up per location, when a run first opens one.
    expect((await run("MODE:answer probe")).ok).toBe(true);
    const listed = await context?.model.list({});
    const models = ((listed as { data?: unknown[] } | undefined)?.data ?? listed) as Array<{
      providerID: string;
      id: string;
    }>;
    expect(models.map((m) => `${m.providerID}/${m.id}`)).toEqual(["akm-lab/fake-model"]);
  });

  test("rejects a permission request with a message, and the run carries on", async () => {
    const { host } = await hostFor("runtime");
    const session = await host.sessions.create({
      title: "asks",
      metadata: { akm: "agent" },
      location: { directory: work },
      model: { providerID: "akm-lab", id: "fake-model" },
      permissions: [{ action: "shell", resource: "*", effect: "ask" }],
    });
    await host.sessions.prompt({ sessionID: session.id, text: "MODE:shell ask first" });
    await host.sessions.wait({ sessionID: session.id });
    const page = await host.message.list({ sessionID: session.id, limit: 50, order: "asc" });
    expect(JSON.stringify(page.data)).toContain("nobody can answer");
  });
});

describe("limits", () => {
  test("the deadline ends a run as a timeout", async () => {
    const result = await run("MODE:answer slow", { timeoutMs: 1 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("timeout");
  });

  test("an aborted signal ends a run as aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await run("MODE:answer", { signal: controller.signal });
    expect(result.reason).toBe("aborted");
  });

  test("a unit timeout ends a turn promptly on an endpoint that is down", async () => {
    // OpenCode retries a failing endpoint with backoff for over a minute; the unit's timeout is what ends the turn.
    const down: ChatCompletionConfig = { ...connection, endpoint: "http://127.0.0.1:1/v1" };
    writeSandboxConfig({
      connections: { lab: { endpoint: down.endpoint, models: { fast: "fake-model" } } },
    });
    resetConfigCache();
    await closeOpencodeSdk();
    const started = Date.now();
    const result = await run("MODE:answer down", { timeoutMs: 2_000 }, down);
    expect(result.reason).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
