// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Integration: runs the real embedded OpenCode, which opens its own SQLite
// database and starts a shell tool, against a fake model served on 127.0.0.1.
// akm's internal runtime (#1244): no OpenCode binary and no external network. What
// a run is created with and what the endpoint receives are asserted; the fake host
// (tests/opencode-runtime-sessions.test.ts, a unit test) covers the rest.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Plugin } from "@opencode/plugin";
import { OpenCode } from "@opencode/sdk";
import { resetConfigCache } from "../../src/core/config/config";
import { getCacheDir, getConfigDir, getDataDir } from "../../src/core/paths";
import { runtimeProfile } from "../../src/integrations/agent/profiles";
import {
  _setOpencodeHostFactoryForTests,
  closeOpencodeSdk,
  hostFor,
} from "../../src/integrations/harnesses/opencode/embedded/host";
import { runOpencodeSdk } from "../../src/integrations/harnesses/opencode/embedded/run";
import { runnerModel } from "../../src/integrations/harnesses/opencode/embedded/runner-models";
import { runtimeConfigContent } from "../../src/integrations/harnesses/opencode/embedded/runtime-config";
import { createSdkHost } from "../../src/integrations/harnesses/opencode/embedded/sdk-host";
import { akmOpencodeDatabasePath } from "../../src/integrations/harnesses/opencode/roots";
import type { ChatCompletionConfig } from "../../src/llm/client";
import { type FakeModelServer, startFakeModel } from "../_helpers/fake-model-server";
import { withEnv, withMockedFetch, writeSandboxConfig } from "../_helpers/sandbox";
import { overrideSeam } from "../_helpers/seams";

const profile = runtimeProfile({
  kind: "connection",
  name: "lab",
  endpoint: "",
  model: "fake-model",
  request: {},
  timeoutMs: null,
});

let model: FakeModelServer;
let decoy: FakeModelServer;
let connection: ChatCompletionConfig;
let work: string;

beforeAll(() => {
  model = startFakeModel();
  decoy = startFakeModel();
  connection = { endpoint: model.url, model: "fake-model", apiKey: "test-key", contextLength: 40000 };
  work = fs.mkdtempSync(path.join(process.env.HOME ?? "/tmp", "sdk-work-"));
});

// A run is dispatched with its connection and reads no config: the live config names a different endpoint
// under the same name, and nothing may ever reach it. The real factory builds the host.
beforeEach(() => {
  writeSandboxConfig({
    connections: {
      lab: { endpoint: decoy.url, models: { fast: "fake-model" }, contextLength: 1000, max_tokens: 10 },
    },
  });
  resetConfigCache();
  overrideSeam(_setOpencodeHostFactoryForTests, createSdkHost);
});

afterEach(() => {
  expect(decoy.requests).toHaveLength(0);
});

afterAll(async () => {
  await closeOpencodeSdk();
  // The suite's data directory is shared with the files that run after this one.
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${akmOpencodeDatabasePath()}${suffix}`, { force: true });
  model.stop();
  decoy.stop();
});

const run = (prompt: string, extra: Parameters<typeof runOpencodeSdk>[1] = {}, using = connection) =>
  runOpencodeSdk(profile, { cwd: work, timeoutMs: 60_000, ...extra, dispatch: { ...extra.dispatch, prompt } }, using);

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

  test("the commands it runs get the allowlist, akm's directories and the run's variables, not the rest of the process environment", async () => {
    const result = await withEnv({ AKM_AMBIENT: "ambient" }, () =>
      run("MODE:env go", { env: { AKM_PROBE: "from-akm" } }),
    );
    expect(result.stdout).toContain(`PROBE=from-akm AMBIENT= HOME=${process.env.HOME} CONFIG=${getConfigDir()}`);
    expect(result.stdout).not.toContain("ambient");
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

  test("an exact model name the connection does not list is sent to the endpoint as written", async () => {
    const before = model.requests.length;
    const result = await run("MODE:answer exact name", {}, { ...connection, model: "not-listed" });
    expect(result.ok).toBe(true);
    expect(lastAnswer(before)?.params.model).toBe("not-listed");
  });
});

// The dispatched connection is the whole of a run's destination: its endpoint, key, model and window.
describe("a run's connection is what it was dispatched with", () => {
  const keyed = (key: string, endpoint = model.url): ChatCompletionConfig => ({ ...connection, endpoint, apiKey: key });

  test("a connection the live config does not list runs, and the live config's endpoint of that name gets nothing", async () => {
    const before = model.requests.length;
    const result = await runOpencodeSdk(
      { ...profile, name: "ghost" },
      { cwd: work, timeoutMs: 60_000, dispatch: { prompt: "MODE:answer go" } },
      keyed("frozen-key"),
    );
    expect(result.ok).toBe(true);
    expect(lastAnswer(before)?.authorization).toBe("Bearer frozen-key");
  });

  test("a connection edited or removed in the live config after it was frozen still runs against its own endpoint", async () => {
    writeSandboxConfig({ connections: { lab: { endpoint: decoy.url, models: { fast: "other-model" } } } });
    resetConfigCache();
    const edited = model.requests.length;
    expect((await run("MODE:answer edited", {}, keyed("edited-key"))).ok).toBe(true);
    expect(lastAnswer(edited)?.authorization).toBe("Bearer edited-key");
    writeSandboxConfig({});
    resetConfigCache();
    const removed = model.requests.length;
    expect((await run("MODE:answer removed", {}, keyed("removed-key"))).ok).toBe(true);
    expect(lastAnswer(removed)?.authorization).toBe("Bearer removed-key");
  });

  test("two frozen runners that share a name and differ in endpoint run side by side, each with its own key", async () => {
    const second = startFakeModel();
    try {
      const results = await Promise.all([
        run("MODE:answer first", {}, keyed("key-a")),
        run("MODE:answer second", {}, keyed("key-b", second.url)),
      ]);
      expect(results.map((r) => r.ok)).toEqual([true, true]);
      const seenBy = (server: FakeModelServer) =>
        server.requests.filter((r) => r.mode === "answer").map((r) => r.authorization);
      expect(seenBy(second)).toEqual(["Bearer key-b"]);
      expect(seenBy(model).slice(-1)).toEqual(["Bearer key-a"]);
      expect(seenBy(model)).not.toContain("Bearer key-b");
    } finally {
      second.stop();
    }
  });

  test("an endpoint-only connection runs its explicit model, with no alias map anywhere", async () => {
    writeSandboxConfig({ connections: { lab: { endpoint: decoy.url } } });
    resetConfigCache();
    const before = model.requests.length;
    const result = await run("MODE:answer bare", {}, { ...connection, model: "explicit-model" });
    expect(result.ok).toBe(true);
    expect(lastAnswer(before)?.params.model).toBe("explicit-model");
  });

  test("a window with no output cap is kept: the run compacts when its context nears it", async () => {
    // OpenCode's own assumption for an unstated window is 200,000 tokens, which a 38,000-token step does not near.
    const before = model.requests.length;
    const windowOnly: ChatCompletionConfig = { ...connection, contextLength: 40000 };
    expect(windowOnly.request).toBeUndefined();
    const result = await run("MODE:compact go", {}, windowOnly);
    expect(model.requests.slice(before).some((r) => r.summarize)).toBe(true);
    expect(result.ok).toBe(true);
    const unstated = model.requests.length;
    const { contextLength: _window, ...noWindow } = windowOnly;
    await run("MODE:compact again", {}, noWindow);
    expect(model.requests.slice(unstated).some((r) => r.summarize)).toBe(false);
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

  test("an endpoint with a query string is reached with the operation in the path and the query intact", async () => {
    const before = model.requests.length;
    const gateway = { ...connection, endpoint: `${model.url}?api-version=2026-01-01` };
    expect((await run("MODE:answer gateway", {}, gateway)).ok).toBe(true);
    expect(lastAnswer(before)?.url).toBe("/v1/chat/completions?api-version=2026-01-01");
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

  test("a connection that writes the model, the messages or the response format cannot replace them", async () => {
    const owned: ChatCompletionConfig = {
      ...connection,
      request: {
        model: "overridden",
        messages: [],
        stream: false,
        response_format: { type: "json_object" },
        top_p: 0.5,
      },
    };
    const before = model.requests.length;
    const result = await run("MODE:answer owned", {}, owned);
    expect(result.ok).toBe(true);
    const sent = lastAnswer(before);
    expect(sent?.params.model).toBe("fake-model");
    expect(sent?.lastUser).toContain("MODE:answer owned");
    expect(sent?.params.stream).toBe(true);
    expect(sent?.params).not.toHaveProperty("response_format");
    expect(sent?.params.top_p).toBe(0.5);
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

  test("no output cap is sent unless one was asked for", async () => {
    const before = model.requests.length;
    expect((await run("MODE:answer uncapped")).ok).toBe(true);
    const sent = lastAnswer(before);
    expect(sent?.params).not.toHaveProperty("max_tokens");
    expect(sent?.params).not.toHaveProperty("max_completion_tokens");
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

describe("akm's read tools on the runtime", () => {
  test("are offered to the model and run in-process", async () => {
    // akm search needs a bundle; this test's own, removed after so no other test sees it.
    const bundle = path.join(process.env.HOME ?? "", "akm");
    fs.mkdirSync(bundle, { recursive: true });
    try {
      const result = await run("MODE:akm go");
      expect(result.ok).toBe(true);
      expect(requestsFor("akm")[0]?.tools).toEqual(expect.arrayContaining(["akm_search", "akm_show", "akm_curate"]));
      // akm search's own JSON came back as the tool result.
      expect(requestsFor("akm").find((r) => r.toolResult)?.toolResult).toContain('"hits"');
    } finally {
      fs.rmSync(bundle, { recursive: true, force: true });
    }
  });
});

describe("the runtime's host", () => {
  test("offers the models its runs brought and none of OpenCode's own free ones", async () => {
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
    expect(models.map((m) => `${m.providerID}/${m.id}`)).toEqual([`${runnerModel(connection).providerID}/fake-model`]);
  });

  // `project: false`, `claude: false` and `models.fetch: false` (../../src/integrations/harnesses/opencode/embedded/sdk-host.ts)
  // keep a run off the developer's project files, Claude skills and the network; each leaves a trace when it is on.
  test("loads no project config or Claude skills and fetches no model catalog", async () => {
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
    const skill = path.join(process.env.HOME ?? "", ".claude", "skills", "leaked-skill");
    const projectConfig = path.join(work, "opencode.json");
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, "SKILL.md"), "---\nname: leaked-skill\ndescription: leaked\n---\nbody\n");
    fs.writeFileSync(
      projectConfig,
      JSON.stringify({
        provider: {
          leaked: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: "http://127.0.0.1:9/v1", apiKey: "k" },
            models: { "leaked-model": {} },
          },
        },
      }),
    );
    const realFetch = globalThis.fetch;
    const requested: string[] = [];
    try {
      await withMockedFetch(
        async () => {
          expect((await run("MODE:answer isolated")).ok).toBe(true);
        },
        (url, init) => {
          requested.push(url);
          return url.startsWith("http://127.0.0.1") ? realFetch(url, init) : new Response("blocked", { status: 503 });
        },
      );
      const listed = await context?.model.list({});
      const models = ((listed as { data?: unknown[] } | undefined)?.data ?? listed) as Array<{
        providerID: string;
        id: string;
      }>;
      expect(models.map((m) => m.providerID)).toEqual([runnerModel(connection).providerID]);
      expect(((await context?.skill.list({}))?.data ?? []).map((s) => s.id)).not.toContain("leaked-skill");
      expect(requested.filter((url) => url.includes("models.opencode.ai"))).toEqual([]);
    } finally {
      fs.rmSync(skill, { recursive: true, force: true });
      fs.rmSync(projectConfig, { force: true });
    }
  });

  test("rejects a permission request with a message, and the run carries on", async () => {
    const { host, models } = await hostFor();
    const declared = runnerModel(connection);
    await models.declare(declared);
    // OpenCode's own `permissions` is not part of akm's narrow contract; the spread keeps it out of the type check.
    const asks = { permissions: [{ action: "shell", resource: "*", effect: "ask" }] };
    const session = await host.sessions.create({
      title: "asks",
      location: { directory: work },
      model: { providerID: declared.providerID, id: declared.modelID },
      ...asks,
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
    await closeOpencodeSdk();
    const started = Date.now();
    const result = await run("MODE:answer down", { timeoutMs: 2_000 }, down);
    expect(result.reason).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe("what akm replaces in the embedded OpenCode", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const hangingRequests = () => model.requests.filter((r) => r.mode === "hang").length;
  const until = async (done: () => boolean, ms: number): Promise<boolean> => {
    for (const end = Date.now() + ms; !done() && Date.now() < end; ) await sleep(25);
    return done();
  };

  // At every start OpenCode resumes each top-level session whose turn never finished, whichever process owns it.
  test("akm's next host does not resume a turn left unfinished, where OpenCode's own sweep does", async () => {
    const before = hangingRequests();
    const running = run("MODE:hang go", { timeoutMs: 30_000 });
    expect(await until(() => hangingRequests() === before + 1, 10_000)).toBe(true);
    await closeOpencodeSdk(); // the process ends mid-turn: the turn stays unfinished in the database
    expect((await running).ok).toBe(false);

    await hostFor();
    await sleep(1_500);
    expect(hangingRequests()).toBe(before + 1);
    await closeOpencodeSdk();

    const declared = runnerModel(connection);
    const control = await OpenCode.create({
      database: { path: akmOpencodeDatabasePath() },
      models: { fetch: false },
      config: {
        directory: fs.mkdtempSync(path.join(os.tmpdir(), "akm-sweep-control-")),
        project: false,
        claude: false,
        content: JSON.stringify({
          ...runtimeConfigContent(),
          provider: {
            [declared.providerID]: {
              npm: "@ai-sdk/openai-compatible",
              options: { baseURL: declared.baseURL },
              models: { "fake-model": {} },
            },
          },
        }),
      },
    } as never);
    try {
      expect(await until(() => hangingRequests() === before + 2, 10_000)).toBe(true);
    } finally {
      await control.close();
    }
  });

  test("OpenCode's home is the suite's, so a run never loads the developer's ~/.agents", async () => {
    const { Global } = await import("@opencode/util/global");
    expect(Global.Path.home).toBe(process.env.HOME as string);
  });

  // OpenCode's roots follow XDG; akm gives it its own, so a run leaves the user's OpenCode directories as they were.
  test("a run writes OpenCode's own files under akm's directories, not under the XDG ones", async () => {
    const xdg = ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"].map((name) =>
      path.join(process.env[name] ?? "", "opencode"),
    );
    const tree = (dir: string): string[] =>
      fs.existsSync(dir)
        ? fs
            .readdirSync(dir, { recursive: true })
            .map((entry) => `${entry}:${fs.statSync(path.join(dir, String(entry))).mtimeMs}`)
            .sort()
        : [];
    const before = xdg.map(tree);
    expect((await run("MODE:answer roots")).ok).toBe(true);
    expect(xdg.map(tree)).toEqual(before);
    expect(fs.existsSync(path.join(getDataDir(), "opencode", "repos"))).toBe(true);
  });

  // OpenCode installs an AI SDK package it is not given from the npm registry, into its cache, on first use.
  test("a run reaches its endpoint with akm's own AI SDK package: OpenCode installs nothing", async () => {
    expect((await run("MODE:answer package")).ok).toBe(true);
    expect(fs.existsSync(path.join(getCacheDir(), "opencode", "npm"))).toBe(false);
  });
});
