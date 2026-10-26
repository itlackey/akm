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
// Every run of the binary is sandboxed. akm's spawn path hands the child the environment akm runs in, so the suite sets
// HOME, the XDG directories and the OpenCode variables itself, all under a temporary directory, and blanks every other
// OPENCODE_* the developer has exported; the provider is a loopback fake that the `@ai-sdk/openai-compatible` package
// already installed for akm reaches, so nothing is downloaded and no real account, key or OpenCode file is opened.
//
// Model work runs standalone (one process that ends with the run), so its cases need nothing more. Agent work is the
// plain `opencode run`, which OpenCode 2 runs through a background service on one port for every HOME: those cases end
// the service they start, and skip when something else already holds the port.

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
 * Set on every run, as the user's own configuration of their OpenCode would: no model catalog fetch, no project config,
 * and no hosted free model. A run with no usable provider would otherwise send its prompt to OpenCode's own service.
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
  /** How many requests the client gave up on (closed the connection before an answer). */
  readonly abandoned: () => number;
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
      // Whatever OpenCode variable the developer has exported, none of it reaches the run.
      ...Object.fromEntries(
        Object.keys(process.env)
          .filter((name) => name.startsWith("OPENCODE_"))
          .map((name) => [name, undefined]),
      ),
      OPENCODE_CONFIG_DIR: at("opencode"),
    },
    database: path.join(dataHome, "opencode", "opencode.db"),
  };
}

/** An OpenAI-compatible endpoint on loopback. It answers `PROBE_OK`, asks for `callTool` first, or never answers. */
function fakeModel(behaviour: { callTool?: string; stall?: boolean } = {}): FakeModel {
  const requests: ModelRequest[] = [];
  let abandoned = 0;
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
      if (behaviour.stall) {
        req.signal.addEventListener("abort", () => {
          abandoned += 1;
        });
        return new Response(new ReadableStream({ start() {} }), sse);
      }
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
  return { url: `http://127.0.0.1:${server.port}/v1`, requests, abandoned: () => abandoned };
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

interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
}

function listProcesses(): ProcessRow[] {
  const listing = spawnSync("ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8" }).stdout;
  return listing
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? "" }));
}

/** The pids of the OpenCode processes this process started, the run's server child included. */
function opencodeProcesses(): number[] {
  const rows = listProcesses();
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

/** The port OpenCode 2's background service listens on. It is one for every HOME on the machine. */
const SERVICE_PORT = 49374;

/** Whether nothing listens on {@link SERVICE_PORT} (a service the suite did not start is never touched, so the cases that need it skip). */
function servicePortFree(): boolean {
  try {
    Bun.listen({ hostname: "127.0.0.1", port: SERVICE_PORT, socket: { data() {} } }).stop(true);
    return true;
  } catch {
    return false;
  }
}

const serviceProcesses = (): number[] =>
  listProcesses()
    .filter((row) => row.command.startsWith(`${BIN} serve --service`))
    .map((row) => row.pid);

/** Run `run`, then end the background service(s) it started and wait for the port: the service outlives the CLI. */
async function leavingNoService(run: () => Promise<void>): Promise<void> {
  const before = new Set(serviceProcesses());
  try {
    await run();
  } finally {
    const started = serviceProcesses().filter((pid) => !before.has(pid));
    for (const pid of started) process.kill(pid, "SIGTERM");
    await waitFor(() => started.every((pid) => !alive(pid)) && servicePortFree(), 15_000, "the service to end").catch(
      () => {
        for (const pid of started) if (alive(pid)) process.kill(pid, "SIGKILL");
      },
    );
  }
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

    test("an entry of akm's agent name in the user's config does not lift the limit, in either map, inline or in a file", async () => {
      // OpenCode 2 reads its native `agents` map over the legacy `agent` one, and an entry there replaces the agent
      // whole: one that only labels it would otherwise take its permission rules away.
      const NAME = "akm-model-work";
      const allowAll = [{ action: "*", resource: "*", effect: "allow" }];
      const variants = [
        {
          where: "inline",
          entry: { agents: { [NAME]: { mode: "primary", description: "Label for automated model calls" } } },
        },
        { where: "inline", entry: { agents: { [NAME]: { mode: "primary", permissions: allowAll } } } },
        { where: "inline", entry: { agent: { [NAME]: { mode: "primary", permission: { "*": "allow" } } } } },
        { where: "file", entry: { agents: { [NAME]: { mode: "primary", permissions: allowAll } } } },
      ] as const;
      for (const { where, entry } of variants) {
        const box = sandbox();
        const model = fakeModel({ callTool: "review_note" });
        const marker = path.join(box.dir, "marker.txt");
        const config = providerConfig(model, {
          model: "fixture/fake-model",
          plugins: [writePlugin(box, [{ name: "review_note", body: writing(marker) }])],
          ...entry,
        });
        if (where === "file") writeConfig(box, config);
        const parentEnv: Record<string, string> =
          where === "inline" ? { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) } : {};

        const result = await runOpencode(box, { prompt: "probe", modelWork: true }, { parentEnv });

        expect(result.ok).toBe(true);
        expect([...(model.requests[0]?.tools ?? [])].sort()).toEqual(["glob", "grep", "read"]);
        expect(model.requests[1]?.toolResults.join("\n")).toContain("No tool named");
        expect(fs.existsSync(marker)).toBe(false);
      }
    }, 120_000);

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
  });

  describe("a stop releases OpenCode's claim on the session (model work, which runs standalone)", () => {
    /** Start a run that stays in flight (in a model request, or in a plugin tool call), then stop it. */
    async function stopDuring(inFlight: "model request" | "tool call", how: "abort" | "timeout"): Promise<void> {
      const box = sandbox();
      const started = path.join(box.dir, "tool-started");
      // `akm_search` is one of the three tools model work keeps, so the call is made.
      const model = fakeModel(inFlight === "model request" ? { stall: true } : { callTool: "akm_search" });
      const plugin = writePlugin(box, [
        {
          name: "akm_search",
          body: `${writing(started)}; await new Promise((resolve) => setTimeout(resolve, 120000))`,
        },
      ]);
      writeConfig(box, providerConfig(model, { model: "fixture/fake-model", plugins: [plugin] }));

      const controller = new AbortController();
      const running = runOpencode(
        box,
        { prompt: "probe", modelWork: true },
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

  // The provider is defined only in the inline config: no file in the config directory.
  const inline = (model: FakeModel): Record<string, string> => ({
    OPENCODE_CONFIG_CONTENT: JSON.stringify(providerConfig(model, { model: "fixture/second" })),
  });

  describe("the user's OPENCODE_CONFIG_CONTENT reaches model work", () => {
    test("model work keeps its provider and its model, and adds its own agent", async () => {
      const box = sandbox();
      const model = fakeModel();

      const result = await runOpencode(box, { prompt: "probe", modelWork: true }, { parentEnv: inline(model) });

      expect(result.ok).toBe(true);
      expect(result.stdout).toContain("PROBE_OK");
      expect(model.requests.map((request) => request.model)).toEqual(["second"]);
      expect([...(model.requests[0]?.tools ?? [])].sort()).toEqual(["glob", "grep", "read"]);
    }, 60_000);

    /**
     * OpenCode itself runs on the inline content `write` gives, as an authored standalone run that akm passes as
     * written; then model work runs on it, on its provider and its model, with its own agent.
     */
    async function modelWorkRunsAsOpencodeDoes(
      write: (config: Record<string, unknown>) => string,
      env: Record<string, string> = {},
    ): Promise<void> {
      const box = sandbox();
      const model = fakeModel();
      const parentEnv = { ...env, OPENCODE_CONFIG_CONTENT: write(providerConfig(model, { model: "fixture/second" })) };

      const direct = await runOpencode(box, { prompt: "probe" }, { args: ["run", "--standalone"], parentEnv });
      expect(direct.ok).toBe(true);
      expect(direct.stdout).toContain("PROBE_OK");
      const before = model.requests.length;

      const result = await runOpencode(box, { prompt: "probe", modelWork: true }, { parentEnv });

      expect(result.ok).toBe(true);
      expect(result.stdout).toContain("PROBE_OK");
      expect(model.requests.slice(before).map((request) => request.model)).toEqual(["second"]);
      expect([...(model.requests[before]?.tools ?? [])].sort()).toEqual(["glob", "grep", "read"]);
    }

    test("content written as JSONC, which OpenCode accepts, keeps its provider and its model", async () => {
      // A comment and a trailing comma, as a user may write it.
      await modelWorkRunsAsOpencodeDoes((config) =>
        JSON.stringify(config, null, 2)
          .replace("{", "{\n  // the user's own inline configuration")
          .replace(/\n}$/, ",\n}"),
      );
    }, 60_000);

    test("JSONC whose lines end in a carriage return alone, which OpenCode accepts, keeps its provider and its model", async () => {
      await modelWorkRunsAsOpencodeDoes((config) =>
        JSON.stringify(config, null, 2)
          .replace("{", "{\n  // the user's own inline configuration")
          .replaceAll("\n", "\r"),
      );
    }, 60_000);

    test("a {env:NAME} written outside a string, which OpenCode replaces before it parses, keeps its provider and its model", async () => {
      // The provider's timeout comes from the environment, written as a bare reference that names a number.
      await modelWorkRunsAsOpencodeDoes(
        (config) => {
          const fixture = (config.provider as { fixture: { options: Record<string, unknown> } }).fixture;
          fixture.options.timeout = "TIMEOUT_REFERENCE";
          return JSON.stringify(config).replace('"TIMEOUT_REFERENCE"', "{env:COMPAT_PROVIDER_TIMEOUT}");
        },
        { COMPAT_PROVIDER_TIMEOUT: "30000" },
      );
    }, 60_000);
  });

  // Agent work is the plain `opencode run`. OpenCode 2 runs that through its background service, which listens on one
  // port for every HOME and outlives the CLI, so each case ends the service it started, and the group skips when
  // something else already holds the port (a service the suite did not start is never touched).
  describe.skipIf(!servicePortFree())("agent work is the plain invocation, through OpenCode 2's own service", () => {
    test("it runs on the provider and the model the inherited OPENCODE_CONFIG_CONTENT names", async () => {
      await leavingNoService(async () => {
        const box = sandbox();
        const model = fakeModel();

        const result = await runOpencode(box, { prompt: "probe" }, { parentEnv: inline(model) });

        expect(result.ok).toBe(true);
        expect(result.stdout).toContain("PROBE_OK");
        expect(model.requests.map((request) => request.model)).toEqual(["second", "second"]);
      });
    }, 60_000);

    test("it offers and runs the plugin's tool: nothing limits it", async () => {
      await leavingNoService(async () => {
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
        expect(model.requests.some((request) => request.tools.includes("review_note"))).toBe(true);
        expect(fs.existsSync(marker)).toBe(true);
      });
    }, 60_000);

    // Recorded on OpenCode 2.1.2: the stop reaches the CLI and nothing else. The CLI is interrupted and exits 130, but
    // the turn belongs to the service, which stays up with its model requests still open. A run that must end when it
    // is stopped is a standalone run, which is what akm's own model work is.
    test("a stop ends the opencode command, not the service's turn", async () => {
      await leavingNoService(async () => {
        const box = sandbox();
        const model = fakeModel({ stall: true });
        writeConfig(box, providerConfig(model, { model: "fixture/fake-model" }));
        const controller = new AbortController();
        const running = runOpencode(box, { prompt: "probe" }, { signal: controller.signal });
        await waitFor(() => model.requests.length > 0, 30_000, "the run to be in a model request");
        const services = serviceProcesses();

        controller.abort();
        const result = await running;
        await sleep(3000);

        expect(result.reason).toBe("aborted");
        expect(result.exitCode).toBe(130);
        expect(opencodeProcesses()).toEqual([]);
        expect(serviceProcesses()).toEqual(services);
        expect(model.abandoned()).toBe(0);
      });
    }, 60_000);
  });

  test("an authored --standalone is passed as written, and the run is one process", async () => {
    const box = sandbox();
    const model = fakeModel();
    writeConfig(box, providerConfig(model, { model: "fixture/fake-model" }));

    const result = await runOpencode(box, { prompt: "probe" }, { args: ["run", "--standalone"] });

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("PROBE_OK");
  }, 60_000);
}

if (!BIN || process.platform === "win32") {
  test.skip(`the OpenCode 2 CLI compatibility suite needs ${GATE} naming an OpenCode 2 binary (not run on Windows; see testing-workflow.md)`, () => {});
} else {
  registerSuite(BIN);
}
