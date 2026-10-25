// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The OpenCode SDK runner (#1244) against the real embedded OpenCode and a
// loopback fake model: no binary, no network.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { OpenCode } from "@opencode/sdk";
import type { AgentProfile } from "../src/integrations/agent/profiles";
import {
  _setOpencodeHostFactoryForTests,
  akmOpencodeDatabasePath,
  closeOpencodeSdk,
  runOpencodeSdk,
} from "../src/integrations/harnesses/opencode-sdk/sdk-runner";
import type { ChatCompletionConfig } from "../src/llm/client";
import { type FakeModelServer, startFakeModel } from "./_helpers/fake-model-server";
import { installFakeOpencodeHost } from "./_helpers/fake-opencode-host";
import { overrideSeam } from "./_helpers/seams";

const profile: AgentProfile = {
  name: "opencode-sdk",
  platform: "opencode-sdk",
  bin: "",
  args: [],
  stdio: "captured",
  envPassthrough: [],
  parseOutput: "text",
};

let model: FakeModelServer;
let llm: ChatCompletionConfig;
let work: string;

beforeAll(() => {
  model = startFakeModel();
  llm = {
    endpoint: model.url,
    model: "fake-model",
    apiKey: "test-key",
    contextLength: 40000,
    inference: { maxTokens: 4000 },
  };
  work = fs.mkdtempSync(path.join(process.env.HOME ?? "/tmp", "sdk-work-"));
});

// No model catalog fetch: tests stay off the network.
beforeEach(() =>
  overrideSeam(_setOpencodeHostFactoryForTests, (options) => OpenCode.create({ ...options, models: { fetch: false } })),
);

afterAll(async () => {
  await closeOpencodeSdk();
  model.stop();
});

const run = (prompt: string, extra: Parameters<typeof runOpencodeSdk>[2] = {}) =>
  runOpencodeSdk(profile, prompt, { cwd: work, timeoutMs: 60_000, ...extra }, llm);

const requestsFor = (mode: string) => model.requests.filter((r) => r.mode === mode);

describe("runOpencodeSdk", () => {
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

  test("a question is cancelled with a message and the run carries on", async () => {
    const result = await run("MODE:question go");
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("Q-DONE");
  });

  test("a permission request is rejected with a message and the run carries on", async () => {
    const config = path.join(process.env.XDG_CONFIG_HOME ?? "", "opencode");
    fs.mkdirSync(config, { recursive: true });
    fs.writeFileSync(
      path.join(config, "opencode.json"),
      JSON.stringify({ permissions: [{ action: "shell", resource: "*", effect: "ask" }] }),
    );
    try {
      const result = await run("MODE:shell ask first");
      expect(result.ok).toBe(true);
      expect(result.stdout).toContain("permission.rejected");
      expect(result.stdout).toContain("nobody can answer");
    } finally {
      fs.rmSync(path.join(config, "opencode.json"));
    }
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

  test("model work gets OpenCode's read-only tools and akm's, and akm's tools run in-process", async () => {
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

  test("model work cannot write", async () => {
    const result = await run("MODE:write go", { dispatch: { prompt: "", modelWork: true } });
    expect(result.stdout).toContain("No tool named");
  });

  test("model work uses the user's OpenCode model when akm names none", async () => {
    const config = path.join(process.env.XDG_CONFIG_HOME ?? "", "opencode");
    fs.mkdirSync(config, { recursive: true });
    fs.writeFileSync(
      path.join(config, "opencode.json"),
      JSON.stringify({
        model: "userfake/fake-model",
        provider: {
          userfake: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: model.url, apiKey: "{env:USERFAKE_KEY}" },
            models: { "fake-model": {} },
          },
        },
      }),
    );
    process.env.USERFAKE_KEY = "user-key";
    try {
      const result = await runOpencodeSdk(profile, "MODE:answer from user model", {
        cwd: work,
        timeoutMs: 60_000,
        dispatch: { prompt: "", modelWork: true },
      });
      expect(result.ok).toBe(true);
      expect(result.stdout).toMatch(/^ANSWER-\d+$/);
    } finally {
      delete process.env.USERFAKE_KEY;
      fs.rmSync(path.join(config, "opencode.json"));
    }
  });

  test("inference is laid over a model from the user's OpenCode config", async () => {
    const config = path.join(process.env.XDG_CONFIG_HOME ?? "", "opencode");
    fs.mkdirSync(config, { recursive: true });
    fs.writeFileSync(
      path.join(config, "opencode.json"),
      JSON.stringify({
        provider: {
          userfake: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: model.url, apiKey: "user-key" },
            models: { "fake-model": {} },
          },
        },
      }),
    );
    try {
      const before = model.requests.length;
      const result = await runOpencodeSdk(profile, "MODE:answer with effort", {
        cwd: work,
        timeoutMs: 60_000,
        dispatch: { prompt: "", model: "userfake/fake-model", inference: { reasoningEffort: "high" } },
      });
      expect(result.ok).toBe(true);
      const sent = model.requests.slice(before).find((r) => r.mode === "answer");
      expect(sent?.params.reasoning_effort).toBe("high");
    } finally {
      fs.rmSync(path.join(config, "opencode.json"));
    }
  });

  test("the connection's request fields reach the model as written", async () => {
    const connection: ChatCompletionConfig = {
      ...llm,
      request: { top_p: 0.9, chat_template_kwargs: { enable_thinking: false }, reasoning_effort: "low" },
    };
    const before = model.requests.length;
    const result = await runOpencodeSdk(
      profile,
      "MODE:answer with request fields",
      { cwd: work, timeoutMs: 60_000 },
      connection,
    );
    expect(result.ok).toBe(true);
    const sent = model.requests.slice(before).find((r) => r.mode === "answer");
    expect(sent?.params.top_p).toBe(0.9);
    expect(sent?.params.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(sent?.params.reasoning_effort).toBe("low");
  });

  test("a call's enableThinking does not erase the thinking fields the connection wrote beside it", async () => {
    const connection: ChatCompletionConfig = {
      ...llm,
      request: { chat_template_kwargs: { enable_thinking: true, thinking_budget: 8192 } },
      inference: { enableThinking: false, extraParams: { top_k: 40 } },
    };
    const before = model.requests.length;
    const result = await runOpencodeSdk(
      profile,
      "MODE:answer with merged thinking fields",
      { cwd: work, timeoutMs: 60_000 },
      connection,
    );
    expect(result.ok).toBe(true);
    const sent = model.requests.slice(before).find((r) => r.mode === "answer");
    expect(sent?.params.chat_template_kwargs).toEqual({ enable_thinking: false, thinking_budget: 8192 });
    expect(sent?.params.top_k).toBe(40);
  });

  test("a turn longer than one page of history is read across pages", async () => {
    installFakeOpencodeHost({ reply: () => ({ text: "AFTER-MANY-STEPS", steps: 450 }) });
    const result = await run("long turn");
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("AFTER-MANY-STEPS");
  });

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
});
