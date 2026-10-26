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
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { harnessProfile } from "../../src/integrations/agent/profiles";
import { type AgentRunResult, runAgent } from "../../src/integrations/agent/spawn";
import type { AgentDispatchRequest } from "../../src/integrations/harnesses/harness";
import { _setOpencodeVersionProbeForTests, isOpencode2 } from "../../src/integrations/harnesses/opencode/version";
import { openDatabase } from "../../src/storage/database";
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, ms: number, what: string): Promise<void> {
  const until = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

interface Box {
  readonly dir: string;
  /** The directory the run starts in. */
  readonly work: string;
  /** The parent environment of the run: everything an OpenCode reads from it points inside `dir`. */
  readonly env: Record<string, string | undefined>;
  /** OpenCode's own database, where a run's sessions are kept. */
  readonly database: string;
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
  const dataHome = at("data");
  return {
    dir: sb.dir,
    work: at("work"),
    env: {
      HOME: at("home"),
      XDG_CONFIG_HOME: at("config"),
      XDG_DATA_HOME: dataHome,
      XDG_CACHE_HOME: at("cache"),
      XDG_STATE_HOME: at("state"),
      OPENCODE_CONFIG_DIR: at("opencode"),
      // Whatever the developer has exported, none of it reaches the run.
      OPENCODE_API_KEY: undefined,
      OPENCODE_CONFIG: undefined,
      OPENCODE_CONFIG_CONTENT: undefined,
    },
    database: path.join(dataHome, "opencode", "opencode.db"),
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

/** The sessions the run left in OpenCode's database: `time_suspended` is set while a stopped run could still be resumed. */
function sessions(box: Box): Array<{ time_suspended: number | null }> {
  const db = openDatabase(box.database, { readonly: true, create: false });
  try {
    return db.prepare<{ time_suspended: number | null }>("select time_suspended from session_v2").all();
  } finally {
    db.close();
  }
}

/** The pids of the OpenCode processes this process started, the run's server child included. */
function opencodeProcesses(): number[] {
  const listing = spawnSync("ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8" }).stdout;
  const rows = listing
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? "" }));
  const descendants = new Set<number>([process.pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of rows) {
      if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
        descendants.add(row.pid);
        grew = true;
      }
    }
  }
  return rows
    .filter((row) => row.pid !== process.pid && descendants.has(row.pid) && row.command.includes(BIN ?? ""))
    .map((row) => row.pid);
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

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

  describe("a stop releases OpenCode's claim on the session", () => {
    /** Start a run that stays in flight (in a model request, or in a plugin tool call), then stop it. */
    async function stopDuring(inFlight: "model request" | "tool call", how: "abort" | "timeout"): Promise<void> {
      const box = sandbox();
      const started = path.join(box.dir, "tool-started");
      const model = fakeModel(inFlight === "model request" ? { stall: true } : { callTool: "slow_tool" });
      const plugin = writePlugin(box, [
        { name: "slow_tool", body: `${writing(started)}; await new Promise((resolve) => setTimeout(resolve, 120000))` },
      ]);
      writeConfig(box, providerConfig(model, { model: "fixture/fake-model", plugins: [plugin] }));

      const controller = new AbortController();
      const running = runOpencode(
        box,
        { prompt: "probe" },
        how === "abort" ? { signal: controller.signal } : { timeoutMs: 5000 },
      );
      await waitFor(
        () => (inFlight === "model request" ? model.requests.length > 0 : fs.existsSync(started)),
        30_000,
        `the run to be in a ${inFlight}`,
      );
      const processes = opencodeProcesses();
      expect(processes.length).toBeGreaterThan(0);
      if (how === "abort") controller.abort();
      const result = await running;

      expect(result.reason).toBe(how === "abort" ? "aborted" : "timeout");
      expect(result.exitCode).toBe(130);
      expect(sessions(box)).toEqual([{ time_suspended: null }]);
      await sleep(3000);
      expect(processes.filter(alive)).toEqual([]);
    }

    for (const how of ["abort", "timeout"] as const) {
      for (const inFlight of ["model request", "tool call"] as const) {
        test(`${how} during a ${inFlight} leaves the session interrupted, not resumable, and no process behind`, async () => {
          await stopDuring(inFlight, how);
        }, 60_000);
      }
    }
  });

  describe("the user's OPENCODE_CONFIG_CONTENT reaches the run", () => {
    // The provider is defined only there: no file in the config directory.
    const inline = (model: FakeModel): Record<string, string> => ({
      OPENCODE_CONFIG_CONTENT: JSON.stringify(providerConfig(model, { model: "fixture/second" })),
    });

    test("agent work runs on the provider and the model it names", async () => {
      const box = sandbox();
      const model = fakeModel();

      const result = await runOpencode(box, { prompt: "probe" }, { parentEnv: inline(model) });

      expect(result.ok).toBe(true);
      expect(result.stdout).toContain("PROBE_OK");
      expect(model.requests.map((request) => request.model)).toEqual(["second"]);
    }, 60_000);

    test("model work keeps its provider and its model, and adds its own agent", async () => {
      const box = sandbox();
      const model = fakeModel();

      const result = await runOpencode(box, { prompt: "probe", modelWork: true }, { parentEnv: inline(model) });

      expect(result.ok).toBe(true);
      expect(result.stdout).toContain("PROBE_OK");
      expect(model.requests.map((request) => request.model)).toEqual(["second"]);
      expect([...(model.requests[0]?.tools ?? [])].sort()).toEqual(["glob", "grep", "read"]);
    }, 60_000);
  });
}

if (!BIN || process.platform === "win32") {
  test.skip(`the OpenCode 2 CLI compatibility suite needs ${GATE} naming an OpenCode 2 binary (not run on Windows; see testing-workflow.md)`, () => {});
} else {
  registerSuite(BIN);
}
