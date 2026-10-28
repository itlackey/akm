// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The plugin akm's own runtime gives OpenCode (`src/assets/opencode/akm-plugin.js`):
 * akm's three read tools, which run the argv `AKM_OPENCODE_CLI` holds (the akm that started OpenCode), and
 * the connection's request fields laid over each model request. The plugin is loaded
 * here from its shipped text, as akm writes it for OpenCode, against a stand-in for
 * OpenCode's plugin context; OpenCode itself loads it in
 * tests/integration/opencode-runtime-sessions.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import akmPlugin from "../src/assets/opencode/akm-plugin.js" with { type: "text" };
import { makeSandboxDir, type SandboxedDir, withEnv } from "./_helpers/sandbox";

interface ToolDefinition {
  name: string;
  description: string;
  input: { properties: Record<string, unknown>; required?: string[] };
  options: { codemode: boolean };
  execute(input: unknown): Promise<{ content: string }>;
}
type RequestHook = (event: { request: Request }) => Promise<void>;
interface Plugin {
  id: string;
  setup(context: unknown): Promise<void>;
}

let scratch: SandboxedDir;

beforeEach(() => {
  scratch = makeSandboxDir("akm-runtime-plugin");
});

afterEach(() => {
  scratch.cleanup();
});

/** The plugin as OpenCode would load it (a module file), set up against a context that keeps what it registers. */
async function load(options?: Record<string, unknown>) {
  const file = path.join(scratch.dir, "index.mjs");
  fs.writeFileSync(file, akmPlugin);
  const plugin = ((await import(pathToFileURL(file).href)) as { default: Plugin }).default;
  const tools = new Map<string, ToolDefinition>();
  const hooks = new Map<string, RequestHook>();
  const shellHooks = new Map<string, (event: { env: Record<string, string | undefined> }) => Promise<void>>();
  await plugin.setup({
    options,
    shell: {
      hook: async (name: string, callback: (event: { env: Record<string, string | undefined> }) => Promise<void>) =>
        void shellHooks.set(name, callback),
    },
    tool: {
      transform: async (edit: (editor: { add(tool: ToolDefinition): void }) => void) =>
        edit({ add: (tool) => void tools.set(tool.name, tool) }),
    },
    session: { hook: async (name: string, callback: RequestHook) => void hooks.set(name, callback) },
  });
  return { plugin, tools, request: hooks.get("http.request") as RequestHook, shell: shellHooks.get("create.before") };
}

const REPORT_ARGS =
  "console.log(JSON.stringify({ argv: process.argv.slice(2), source: process.env.AKM_EVENT_SOURCE ?? null }));";

/**
 * A stand-in for a compiled akm: one executable that prints the arguments it was called with, or fails. The value of
 * `AKM_OPENCODE_CLI` that runs it is the executable alone.
 */
function installAkm(body = REPORT_ARGS): string {
  const file = path.join(scratch.dir, "akm");
  fs.writeFileSync(file, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return JSON.stringify([file]);
}

describe("the plugin's identity", () => {
  test("is an OpenCode 2 plugin: a default export with an id and a setup", async () => {
    const { plugin } = await load();

    expect(plugin.id).toBe("akm");
    expect(typeof plugin.setup).toBe("function");
  });
});

describe.skipIf(process.platform === "win32")("akm's read tools", () => {
  test("are exactly akm_curate, akm_search and akm_show, each with a described input", async () => {
    const { tools } = await load();

    expect([...tools.keys()].sort()).toEqual(["akm_curate", "akm_search", "akm_show"]);
    for (const tool of tools.values()) {
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.options).toEqual({ codemode: false });
    }
    expect(tools.get("akm_show")?.input.required).toEqual(["ref"]);
    expect(tools.get("akm_search")?.input.required).toEqual(["query"]);
  });

  test.each([
    [
      "akm_search",
      { query: "backup", type: "skill", limit: 3 },
      ["search", "backup", "--type", "skill", "--limit", "3"],
    ],
    ["akm_curate", { query: "deploy a service" }, ["curate", "deploy a service"]],
    ["akm_show", { ref: "knowledge/deploy#Rollback", type: "ignored" }, ["show", "knowledge/deploy#Rollback"]],
  ])("%s calls akm with the agent detail and JSON, and returns what it printed", async (name, input, args) => {
    const { tools } = await load();
    const akm = installAkm();

    const result = await withEnv({ AKM_OPENCODE_CLI: akm, AKM_EVENT_SOURCE: "improve" }, () =>
      tools.get(name)?.execute(input),
    );

    expect(JSON.parse(result?.content as string)).toEqual({
      argv: [...args, "--detail", "agent", "--format", "json"],
      // The run's environment is the call's: its provenance reaches akm.
      source: "improve",
    });
  });

  test('akm_show with detail "brief" asks akm for the outline, and tells the agent to read it first', async () => {
    const { tools } = await load();
    const akm = installAkm();
    const show = tools.get("akm_show");

    expect(show?.input.properties.detail).toMatchObject({ enum: ["brief"] });
    expect(show?.description).toContain('detail "brief"');
    expect(show?.description).toContain("ref#<slug>");
    const result = await withEnv({ AKM_OPENCODE_CLI: akm, AKM_EVENT_SOURCE: undefined }, () =>
      show?.execute({ ref: "knowledge/deploy", detail: "brief" }),
    );

    expect(JSON.parse(result?.content as string)).toEqual({
      argv: ["show", "knowledge/deploy", "--detail", "brief", "--format", "json"],
      source: null,
    });
  });

  test("akm run as a script is the runtime and the script, which needs neither a shebang nor the executable bit", async () => {
    const { tools } = await load();
    const script = path.join(scratch.dir, "akm.js");
    fs.writeFileSync(script, REPORT_ARGS, { mode: 0o644 });

    const result = await withEnv(
      { AKM_OPENCODE_CLI: JSON.stringify([process.execPath, script]), AKM_EVENT_SOURCE: undefined },
      () => tools.get("akm_show")?.execute({ ref: "knowledge/deploy" }),
    );

    expect(JSON.parse(result?.content as string)).toEqual({
      argv: ["show", "knowledge/deploy", "--detail", "agent", "--format", "json"],
      source: null,
    });
  });

  test("a call without its required argument fails in words, and starts nothing", async () => {
    const { tools } = await load();
    const akm = installAkm('require("node:fs").writeFileSync(process.env.MARKER, "ran");');
    const marker = path.join(scratch.dir, "marker");

    const result = await withEnv({ AKM_OPENCODE_CLI: akm, MARKER: marker }, () =>
      tools.get("akm_search")?.execute({ query: " " }),
    );

    expect(result?.content).toBe('akm_search failed: "query" is required');
    expect(fs.existsSync(marker)).toBe(false);
  });

  test("akm failing is reported with its own message", async () => {
    const { tools } = await load();
    const akm = installAkm('console.error("No such asset"); process.exit(4);');

    const result = await withEnv({ AKM_OPENCODE_CLI: akm }, () =>
      tools.get("akm_show")?.execute({ ref: "knowledge/none" }),
    );

    expect(result?.content).toContain("akm_show failed:");
    expect(result?.content).toContain("No such asset");
  });

  test("without the akm executable named, the tool says so", async () => {
    const { tools } = await load();

    const result = await withEnv({ AKM_OPENCODE_CLI: undefined }, () =>
      tools.get("akm_search")?.execute({ query: "x" }),
    );

    expect(result?.content).toBe("akm_search failed: AKM_OPENCODE_CLI is not set");
  });

  test("an AKM_OPENCODE_CLI that is not an argv is refused in words", async () => {
    const { tools } = await load();

    const result = await withEnv({ AKM_OPENCODE_CLI: '"/usr/bin/akm"' }, () =>
      tools.get("akm_search")?.execute({ query: "x" }),
    );

    expect(result?.content).toBe("akm_search failed: AKM_OPENCODE_CLI is not a JSON array of strings");
  });
});

describe("the shell hook", () => {
  test("puts back what akm runs in for the variables the run set, and removes the rest", async () => {
    const { shell } = await load({
      shellEnv: { XDG_DATA_HOME: "/home/me/.local/share", XDG_CACHE_HOME: null, OPENCODE_CONFIG_CONTENT: null },
    });
    const env: Record<string, string | undefined> = {
      XDG_DATA_HOME: "/akm/opencode-runtime/data",
      XDG_CACHE_HOME: "/akm/opencode-runtime/cache",
      OPENCODE_CONFIG_CONTENT: '{"provider":{"akm":{"options":{"apiKey":"sk-secret"}}}}',
      PATH: "/usr/bin",
    };

    await shell?.({ env });

    expect(env).toEqual({ XDG_DATA_HOME: "/home/me/.local/share", PATH: "/usr/bin" });
  });

  test("is not registered when the plugin is given nothing to put back", async () => {
    expect((await load({ requestFields: {} })).shell).toBeUndefined();
  });
});

describe("the request hook", () => {
  const post = (body: unknown, headers: Record<string, string> = {}): Request =>
    new Request("http://llm.example/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "9999", authorization: "Bearer k", ...headers },
      body: JSON.stringify(body),
    });

  /** The body a request carries after the hook ran over it. */
  async function after(options: Record<string, unknown> | undefined, request: Request) {
    const { request: hook } = await load(options);
    const event = { request };
    await hook(event);
    return { event, body: (await event.request.json()) as Record<string, unknown> };
  }

  test("drops OpenCode's own output cap, whichever name it uses, and keeps the rest", async () => {
    for (const cap of ["max_tokens", "max_completion_tokens"]) {
      const { body } = await after(
        { requestFields: {} },
        post({ model: "m", messages: [{ role: "user" }], [cap]: 32000, stream: true }),
      );

      expect(body).toEqual({ model: "m", messages: [{ role: "user" }], stream: true });
    }
  });

  test("lays the connection's fields over the request, and the cap it writes is the cap sent", async () => {
    const { body } = await after(
      { requestFields: { reasoning_effort: "high", top_p: 0.9, max_tokens: 2048 } },
      post({ model: "m", max_completion_tokens: 32000, temperature: 0.7 }),
    );

    expect(body).toEqual({ model: "m", temperature: 0.7, reasoning_effort: "high", top_p: 0.9, max_tokens: 2048 });
  });

  test("a field that is an object on both sides is merged one level, anything else is replaced", async () => {
    const { body } = await after(
      { requestFields: { chat_template_kwargs: { enable_thinking: false }, stop: ["a"] } },
      post({ model: "m", chat_template_kwargs: { keep: 1, enable_thinking: true }, stop: ["b", "c"] }),
    );

    expect(body).toEqual({ model: "m", chat_template_kwargs: { keep: 1, enable_thinking: false }, stop: ["a"] });
  });

  test("keeps the request's destination, method and headers, and drops the stale length", async () => {
    const { event } = await after({ requestFields: { top_p: 1 } }, post({ model: "m" }));

    expect(event.request.url).toBe("http://llm.example/v1/chat/completions");
    expect(event.request.method).toBe("POST");
    expect(event.request.headers.get("authorization")).toBe("Bearer k");
    expect(event.request.headers.get("content-length")).toBeNull();
  });

  test("without request fields the cap is still dropped", async () => {
    const { body } = await after(undefined, post({ model: "m", max_tokens: 5 }));

    expect(body).toEqual({ model: "m" });
  });

  test("a request that is not a JSON object is left as it was", async () => {
    const { request: hook } = await load({ requestFields: { top_p: 1 } });
    for (const request of [
      new Request("http://llm.example/v1/models"),
      new Request("http://llm.example/v1/x", { method: "POST", body: "not json" }),
      new Request("http://llm.example/v1/x", { method: "POST", body: "[1,2]" }),
    ]) {
      const event = { request };
      await hook(event);
      expect(event.request).toBe(request);
    }
  });
});

describe("the repeated-call guard", () => {
  type Call = readonly [name: string, input: unknown, result: string];
  const SAME: Call = ["shell", { command: "echo same" }, "same\n"];
  const message = (tools: string) =>
    `akm stopped this run: the model called ${tools} with the same input three times in a row and got the same result each time.`;

  /** The messages of a chat request after `turns`: each is the assistant's calls and the tool messages that answer them. */
  function conversation(...turns: Call[][]): unknown[] {
    return [
      { role: "system", content: "rules" },
      { role: "user", content: "do the task" },
      ...turns.flatMap((calls, turn) => [
        {
          role: "assistant",
          content: null,
          // Every call has an id of its own, as every model request's has.
          tool_calls: calls.map(([name, input], index) => ({
            id: `call_${turn}_${index}`,
            type: "function",
            function: { name, arguments: JSON.stringify(input) },
          })),
        },
        ...calls.map(([, , result], index) => ({
          role: "tool",
          tool_call_id: `call_${turn}_${index}`,
          content: result,
        })),
      ]),
    ];
  }

  /** What the request hook does with a request carrying `messages`: it resolves, or it fails with the guard's message. */
  async function send(messages: unknown[]) {
    const { request: hook } = await load({ requestFields: {} });
    const event = {
      request: new Request("http://llm.example/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "m", messages }),
      }),
    };
    await hook(event);
    return event;
  }

  test("fails the run when the last three turns made the same call and got the same result", async () => {
    await expect(send(conversation([SAME], [SAME], [SAME]))).rejects.toThrow(message("`shell`"));
    // Still three, however much came before.
    await expect(send(conversation([["read", {}, "x"]], [SAME], [SAME], [SAME]))).rejects.toThrow(message("`shell`"));
  });

  test("lets two repeats through, and forwards the request as it does any other", async () => {
    const event = await send(conversation([SAME], [SAME]));

    expect(((await event.request.json()) as { messages: unknown[] }).messages).toHaveLength(6);
  });

  test("lets a call through whose result changes, which is how a poll looks", async () => {
    const poll = (result: string): Call => ["shell", { command: "date +%s%N" }, result];

    await send(conversation([poll("1\n")], [poll("2\n")], [poll("3\n")]));
    // Two of the three alike is not enough.
    await send(conversation([poll("1\n")], [poll("2\n")], [poll("2\n")]));
  });

  test("lets a call through whose input changes", async () => {
    await send(conversation([SAME], [SAME], [["shell", { command: "echo same " }, "same\n"]]));
  });

  test("counts only turns in a row: another call between the repeats starts the count again", async () => {
    const other: Call = ["read", { filePath: "a" }, "text"];

    await send(conversation([SAME], [SAME], [other], [SAME], [SAME]));
    await send(conversation([SAME], [other], [SAME]));
  });

  test("counts only turns of calls: a reply in words or a message from the user ends the run of turns", async () => {
    const reply = { role: "assistant", content: "let me think" };
    const user = { role: "user", content: "go on" };

    await send([...conversation([SAME], [SAME]), reply, ...conversation([SAME]).slice(2)]);
    await send([...conversation([SAME], [SAME], [SAME]), user]);
  });

  test("compares parallel calls as a set, in whatever order the model lists them", async () => {
    const read: Call = ["read", { filePath: "a" }, "text"];

    await expect(send(conversation([SAME, read], [read, SAME], [SAME, read]))).rejects.toThrow(
      message("`shell`, `read`"),
    );
    // One call of the set alone is a different turn.
    await send(conversation([SAME, read], [SAME], [SAME, read]));
  });

  test("a call that was never answered is no repeat", async () => {
    const messages = conversation([SAME], [SAME], [SAME]);

    await send(messages.slice(0, -1));
  });
});
