// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Integration: runs the real OpenCode 2 CLI as a child process, against a loopback model and its own SQLite file.
//
// Gate: `AKM_TEST_OPENCODE2_BIN=/path/to/opencode`. Without it the suite is one skipped test. The unit tests build
// the command line and the stub-program tests check it reaches a program; only a real OpenCode 2 can say what the
// flags, the permission map, the environment and a signal do to it. The CI workflow does not set the gate, so this runs
// where a binary is named (docs/architecture/testing/testing-workflow.md).
//
// Every run of the binary is sandboxed. akm's own spawn path builds the child's environment from its allowlist, so the
// child sees only HOME, the XDG directories and the OpenCode variables set here, all under a temporary directory; the
// provider is a loopback fake that the `@ai-sdk/openai-compatible` package already installed for akm reaches, so nothing
// is downloaded and no real account, key or OpenCode file is opened.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { harnessProfile } from "../../src/integrations/agent/profiles";
import { type AgentRunResult, runAgent } from "../../src/integrations/agent/spawn";
import type { AgentDispatchRequest } from "../../src/integrations/harnesses/harness";
import { _setOpencodeVersionProbeForTests, isOpencode2 } from "../../src/integrations/harnesses/opencode/version";
import { makeSandboxDir, withEnv } from "../_helpers/sandbox";

const GATE = "AKM_TEST_OPENCODE2_BIN";
const BIN = process.env[GATE];

/** The package that reaches the fake provider; installed with akm, so OpenCode downloads nothing. */
const PROVIDER_PACKAGE = pathToFileURL(
  path.resolve(import.meta.dir, "../../node_modules/@ai-sdk/openai-compatible/dist/index.mjs"),
).href;

/**
 * Set on every run, over what akm passes: no model catalog fetch, no project config, and no hosted free model. A run
 * with no usable provider would otherwise send its prompt to OpenCode's own service.
 */
const SANDBOX_CHILD_ENV = {
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  OPENCODE_DISABLE_FREE_MODELS: "1",
};

interface Box {
  readonly dir: string;
  /** The directory the run starts in. */
  readonly work: string;
  /** The parent environment of the run: everything an OpenCode reads from it points inside `dir`. */
  readonly env: Record<string, string | undefined>;
}

interface ModelRequest {
  readonly model: string | undefined;
  readonly tools: readonly string[];
  readonly toolResults: readonly string[];
}

interface FakeModel {
  readonly url: string;
  readonly requests: ModelRequest[];
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function sandbox(): Box {
  const sb = makeSandboxDir("akm-oc2-compat");
  cleanups.push(sb.cleanup);
  const at = (name: string): string => {
    const dir = path.join(sb.dir, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  return {
    dir: sb.dir,
    work: at("work"),
    env: {
      HOME: at("home"),
      XDG_CONFIG_HOME: at("config"),
      XDG_DATA_HOME: at("data"),
      XDG_CACHE_HOME: at("cache"),
      XDG_STATE_HOME: at("state"),
      OPENCODE_CONFIG_DIR: at("opencode"),
      // Whatever the developer has exported, none of it reaches the run.
      OPENCODE_API_KEY: undefined,
      OPENCODE_CONFIG: undefined,
      OPENCODE_CONFIG_CONTENT: undefined,
    },
  };
}

/** An OpenAI-compatible endpoint on loopback. It answers `PROBE_OK`, asks for `callTool` first, or never answers. */
function fakeModel(behaviour: { callTool?: string; stall?: boolean } = {}): FakeModel {
  const requests: ModelRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as {
        model?: string;
        messages?: Array<{ role: string; content?: unknown }>;
        tools?: Array<{ function?: { name?: string } }>;
      };
      const messages = body.messages ?? [];
      const toolResults = messages
        .filter((message) => message.role === "tool")
        .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)));
      requests.push({
        model: body.model,
        tools: (body.tools ?? []).map((tool) => tool.function?.name ?? ""),
        toolResults,
      });
      if (behaviour.stall) return new Response(new ReadableStream({ start() {} }), sse);
      const calling = behaviour.callTool !== undefined && toolResults.length === 0;
      const delta = calling
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_compat",
                type: "function",
                function: { name: behaviour.callTool, arguments: "{}" },
              },
            ],
          }
        : { role: "assistant", content: "PROBE_OK" };
      const chunk = (change: unknown, finish: string | null): string =>
        `data: ${JSON.stringify({
          id: "compat",
          object: "chat.completion.chunk",
          created: 1,
          model: "fake-model",
          choices: [{ index: 0, delta: change, finish_reason: finish }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })}\n\n`;
      return new Response(`${chunk(delta, null)}${chunk({}, calling ? "tool_calls" : "stop")}data: [DONE]\n\n`, sse);
    },
  });
  cleanups.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}/v1`, requests };
}

const sse = { headers: { "content-type": "text/event-stream" } };

/** An OpenCode config whose only provider is the fake: models `fake-model` and `second`, and the free providers off. */
function providerConfig(model: FakeModel, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    disabled_providers: ["opencode", "opencode-go"],
    provider: {
      fixture: {
        npm: PROVIDER_PACKAGE,
        options: { baseURL: model.url, apiKey: "SYNTHETIC_KEY" },
        models: { "fake-model": {}, second: {} },
      },
    },
    ...extra,
  };
}

function writeConfig(box: Box, config: Record<string, unknown>): void {
  fs.writeFileSync(path.join(box.env.OPENCODE_CONFIG_DIR ?? "", "opencode.json"), JSON.stringify(config));
}

/**
 * A directory plugin that registers tools. Each runs `body` (JavaScript, `fs` in scope) when the model calls it; a tool
 * with no body does nothing.
 */
function writePlugin(box: Box, tools: ReadonlyArray<{ name: string; body?: string }>): string {
  const dir = path.join(box.dir, "plugin");
  fs.mkdirSync(dir, { recursive: true });
  const add = tools
    .map(
      (tool) =>
        `editor.add({name:${JSON.stringify(tool.name)},description:"a fixture tool",input:{type:"object",properties:{},additionalProperties:false},options:{codemode:false},execute:async()=>{${tool.body ?? ""};return {content:"done"};}});`,
    )
    .join("");
  fs.writeFileSync(
    path.join(dir, "index.js"),
    `import fs from "node:fs";\nexport default {id:"compat-fixture",async setup(ctx){await ctx.tool.transform(editor=>{${add}});}};\n`,
  );
  return dir;
}

/** The code of a plugin tool that writes `file`. */
const writing = (file: string): string => `fs.writeFileSync(${JSON.stringify(file)},"written")`;

/** Run the CLI the way akm does, inside the sandbox. */
function runOpencode(
  box: Box,
  request: AgentDispatchRequest,
  options: {
    args?: readonly string[];
    timeoutMs?: number;
    signal?: AbortSignal;
    parentEnv?: Record<string, string>;
  } = {},
): Promise<AgentRunResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const profile = harnessProfile({
    kind: "harness",
    name: "opencode",
    platform: "opencode",
    bin: BIN ?? "",
    args: options.args ?? ["run"],
    timeoutMs,
  });
  return withEnv({ ...box.env, ...options.parentEnv }, () =>
    runAgent(profile, {
      cwd: box.work,
      stdio: "captured",
      timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
      env: SANDBOX_CHILD_ENV,
      dispatch: request,
    }),
  );
}

function registerSuite(bin: string): void {
  beforeAll(() => {
    // Each test asks the binary its major afresh, inside the sandbox it runs in.
    _setOpencodeVersionProbeForTests(undefined);
  });

  test("the named binary is OpenCode 2", async () => {
    const box = sandbox();
    await withEnv(box.env, async () => {
      expect(isOpencode2(bin)).toBe(true);
    });
  }, 30_000);

  describe("model work is limited to reading and searching", () => {
    test("a plugin's writing tool is neither offered nor callable, and nothing is written", async () => {
      const box = sandbox();
      const model = fakeModel({ callTool: "review_note" });
      const marker = path.join(box.dir, "marker.txt");
      writeConfig(
        box,
        providerConfig(model, {
          model: "fixture/fake-model",
          plugins: [writePlugin(box, [{ name: "review_note", body: writing(marker) }])],
        }),
      );

      const result = await runOpencode(box, { prompt: "probe", modelWork: true });

      expect(result.ok).toBe(true);
      expect(result.stdout).toContain("PROBE_OK");
      expect([...(model.requests[0]?.tools ?? [])].sort()).toEqual(["glob", "grep", "read"]);
      expect(model.requests[1]?.toolResults.join("\n")).toContain("No tool named");
      expect(fs.existsSync(marker)).toBe(false);
    }, 60_000);

    test("the akm plugin's three reading tools stay, and the two that write go", async () => {
      const box = sandbox();
      const model = fakeModel();
      const names = ["akm_search", "akm_show", "akm_curate", "akm_remember", "akm_feedback", "review_note"];
      writeConfig(
        box,
        providerConfig(model, {
          model: "fixture/fake-model",
          plugins: [
            writePlugin(
              box,
              names.map((name) => ({ name })),
            ),
          ],
        }),
      );

      const result = await runOpencode(box, { prompt: "probe", modelWork: true });

      expect(result.ok).toBe(true);
      expect([...(model.requests[0]?.tools ?? [])].sort()).toEqual([
        "akm_curate",
        "akm_search",
        "akm_show",
        "glob",
        "grep",
        "read",
      ]);
    }, 60_000);

    test("agent work, not model work, still offers and runs the plugin's tool", async () => {
      const box = sandbox();
      const model = fakeModel({ callTool: "review_note" });
      const marker = path.join(box.dir, "marker.txt");
      writeConfig(
        box,
        providerConfig(model, {
          model: "fixture/fake-model",
          plugins: [writePlugin(box, [{ name: "review_note", body: writing(marker) }])],
        }),
      );

      const result = await runOpencode(box, { prompt: "probe" });

      expect(result.ok).toBe(true);
      expect(model.requests[0]?.tools).toContain("review_note");
      expect(fs.existsSync(marker)).toBe(true);
    }, 60_000);
  });
}

if (!BIN || process.platform === "win32") {
  test.skip(`the OpenCode 2 CLI compatibility suite needs ${GATE} naming an OpenCode 2 binary (not run on Windows; see testing-workflow.md)`, () => {});
} else {
  registerSuite(BIN);
}
