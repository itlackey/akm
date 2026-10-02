// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm mcp` over stdio: the real command, spawned against a fixture stash.
 *
 * Integration, by the "spawns a real process" clause: each test drives a
 * `bun src/cli.ts mcp` child through its stdin and stdout, and the stash is
 * indexed in a real database. Nothing leaves loopback; there is no model.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { setSecret } from "../../src/commands/env/secret";
import { akmIndex } from "../../src/indexer/indexer";
import { runCliCapture } from "../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";
import { snapshotTree } from "../_helpers/snapshot-tree";

const CLI = path.join(import.meta.dir, "..", "..", "src", "cli.ts");
// One search token each, so a search for the value matches nothing unless the value was indexed.
const SECRET_VALUE = "zxqsecretvalue0f3a";
const ENV_VALUE = "zxqenvvalue91bc";

let storage: IsolatedAkmStorage;
const clients: McpClient[] = [];

interface ToolInfo {
  name: string;
  inputSchema: unknown;
  annotations: { readOnlyHint?: boolean };
}

/** The parts of a JSON-RPC reply these tests read. */
interface Reply {
  id: number | null;
  result?: {
    protocolVersion?: string;
    serverInfo?: { name: string };
    capabilities?: unknown;
    tools?: ToolInfo[];
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

/** A line-oriented JSON-RPC client for one `akm mcp` child. */
class McpClient {
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly lines: string[] = [];
  private waiting: { resolve: (line: string) => void; reject: (error: Error) => void } | undefined;
  private nextId = 1;
  private stderr = "";
  private closed: number | null | undefined;
  readonly exited: Promise<number | null>;

  constructor() {
    // The child inherits the sandbox env `withIsolatedAkmStorage` set on this process. Bun keeps its
    // transpile cache under XDG_CACHE_HOME, which would show up in the "wrote nothing" snapshots.
    this.proc = spawn("bun", [CLI, "mcp"], {
      env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stderr.on("data", (chunk) => {
      this.stderr += String(chunk);
    });
    createInterface({ input: this.proc.stdout }).on("line", (line) => {
      if (this.waiting) {
        const { resolve } = this.waiting;
        this.waiting = undefined;
        resolve(line);
      } else {
        this.lines.push(line);
      }
    });
    this.exited = new Promise((resolve) =>
      this.proc.on("close", (code) => {
        this.closed = code;
        this.waiting?.reject(this.exitError());
        resolve(code);
      }),
    );
    clients.push(this);
  }

  send(message: object | string): void {
    this.proc.stdin.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`);
  }

  private exitError(): Error {
    return new Error(`akm mcp exited with code ${this.closed} and no reply; stderr: ${this.stderr}`);
  }

  /** The next line the server wrote; fails with its stderr if it exits, or says nothing for 20s. */
  nextLine(): Promise<string> {
    const queued = this.lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.closed !== undefined) return Promise.reject(this.exitError());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no reply from akm mcp; stderr: ${this.stderr}`)), 20_000);
      this.waiting = {
        resolve: (line) => {
          clearTimeout(timer);
          resolve(line);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });
  }

  async request(method: string, params?: object): Promise<Reply> {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    const reply = JSON.parse(await this.nextLine()) as Reply;
    expect(reply.id).toBe(id);
    return reply;
  }

  /** A tools/call whose reply is a tool result: its text, and whether it is an error. */
  async call(name: string, args: object): Promise<{ text: string; isError: boolean }> {
    const reply = await this.request("tools/call", { name, arguments: args });
    expect(reply.error).toBeUndefined();
    return { text: reply.result?.content?.[0]?.text ?? "", isError: reply.result?.isError === true };
  }

  /** Close stdin, as a client does to stop the server, and wait for the exit code. */
  close(): Promise<number | null> {
    this.proc.stdin.end();
    return this.exited;
  }

  kill(): void {
    this.proc.kill();
  }
}

/** A stash with a lesson, a memory, an env file, a secret and a `.meta` doc, indexed. */
async function fixtureStash(): Promise<void> {
  const { stashDir } = storage;
  writeSandboxConfig({ semanticSearchMode: "off" });
  for (const dir of ["lessons", "memories", "env", ".meta"])
    fs.mkdirSync(path.join(stashDir, dir), { recursive: true });
  fs.writeFileSync(
    path.join(stashDir, "lessons", "rg.md"),
    "---\ndescription: Prefer ripgrep for repository search\n---\n\n# Prefer ripgrep\n\nUse rg for recursive search.\n",
  );
  fs.writeFileSync(
    path.join(stashDir, "memories", "alias-tip.md"),
    "---\ndescription: Shell alias tip\n---\n\nUse aliases.\n",
  );
  fs.writeFileSync(path.join(stashDir, "env", "prod.env"), `API_URL=https://example.test\nTOKEN=${ENV_VALUE}\n`);
  setSecret(path.join(stashDir, "secrets", "deploy-key"), Buffer.from(SECRET_VALUE));
  fs.writeFileSync(path.join(stashDir, ".meta", "overview.md"), "# Stash orientation\n\nThis stash holds notes.\n");
  await akmIndex({ stashDir, full: true });
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  for (const client of clients.splice(0)) client.kill();
  storage.cleanup();
});

describe("akm mcp: protocol", () => {
  test("initialize, the initialized notification, ping and tools/list", async () => {
    const client = new McpClient();

    const init = await client.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(init.result?.protocolVersion).toBe("2025-03-26");
    expect(init.result?.serverInfo?.name).toBe("akm");
    expect(init.result?.capabilities).toEqual({ tools: {} });

    // A notification gets no reply: the next line is the answer to the ping.
    client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect((await client.request("ping")).result).toEqual({});

    const list = await client.request("tools/list");
    const tools = list.result?.tools ?? [];
    expect(tools.map((tool) => tool.name)).toEqual(["search", "show"]);
    for (const tool of tools) expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tools[0]?.inputSchema).toMatchObject({
      type: "object",
      required: ["query"],
      properties: { query: { type: "string" }, type: { type: "string" }, limit: { type: "integer" } },
    });
    expect(tools[1]?.inputSchema).toMatchObject({
      type: "object",
      required: ["ref"],
      properties: { ref: { type: "string" } },
    });

    expect(await client.close()).toBe(0);
  });

  test("an unknown protocol version is answered with the newest this server speaks", async () => {
    const client = new McpClient();
    const init = await client.request("initialize", { protocolVersion: "2099-01-01" });
    expect(init.result?.protocolVersion).toBe("2025-06-18");
  });

  test("bad input gets JSON-RPC errors, and the server keeps serving", async () => {
    const client = new McpClient();

    client.send("this is not json");
    expect(JSON.parse(await client.nextLine())).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    client.send("[1,2]");
    expect((JSON.parse(await client.nextLine()) as Reply).error?.code).toBe(-32600);

    expect((await client.request("resources/list")).error?.code).toBe(-32601);
    expect((await client.request("tools/call", { name: "nope", arguments: {} })).error).toEqual({
      code: -32602,
      message: "Unknown tool: nope",
    });
    expect((await client.request("tools/call", {})).error?.code).toBe(-32602);
    expect((await client.request("ping")).result).toEqual({});
  });
});

describe("akm mcp: search and show", () => {
  test("search returns compact hits: ref, type, description, score", async () => {
    await fixtureStash();
    const client = new McpClient();

    const found = await client.call("search", { query: "ripgrep" });
    expect(found.isError).toBe(false);
    const { hits } = JSON.parse(found.text) as { hits: Array<Record<string, unknown>> };
    expect(hits).toHaveLength(1);
    expect(Object.keys(hits[0] ?? {}).sort()).toEqual(["description", "ref", "score", "type"]);
    expect(hits[0]).toMatchObject({
      ref: "lessons/rg",
      type: "lesson",
      description: "Prefer ripgrep for repository search",
    });
    expect(typeof hits[0]?.score).toBe("number");

    // `type` narrows, and `limit` caps, as they do for `akm search`.
    expect(JSON.parse((await client.call("search", { query: "ripgrep", type: "memory" })).text).hits).toEqual([]);
    const all = JSON.parse((await client.call("search", { query: "", limit: 1 })).text).hits;
    expect(all).toHaveLength(1);
  });

  test("a bad search argument is a tool error, not a crash", async () => {
    await fixtureStash();
    const client = new McpClient();
    expect(await client.call("search", {})).toEqual({ text: "query is required.", isError: true });
    expect(await client.call("search", { query: "x", limit: 0 })).toEqual({
      text: "limit must be a positive integer.",
      isError: true,
    });
    expect((await client.call("show", { ref: "lessons/missing" })).isError).toBe(true);
    expect((await client.request("ping")).result).toEqual({});
  });

  test("show returns the text `akm show` prints", async () => {
    await fixtureStash();
    const client = new McpClient();

    const shown = await client.call("show", { ref: "lessons/rg" });
    expect(shown.isError).toBe(false);
    const cli = await runCliCapture(["show", "lessons/rg", "--no-track-usage"]);
    expect(shown.text).toBe(cli.stdout.trimEnd());
    expect(JSON.parse(shown.text)).toMatchObject({ ref: "lessons/rg", type: "lesson" });

    const section = await client.call("show", { ref: "lessons/rg#prefer-ripgrep" });
    expect(JSON.parse(section.text).content).toContain("Use rg for recursive search.");
  });

  test("a large asset arrives whole, on one line", async () => {
    await fixtureStash();
    // Well past a pipe's buffer, which is where a short write would cut a reply off.
    const lastLine = "The last line of a large document.";
    const body = `${"A line of a large document, long enough to fill a pipe buffer many times over.\n".repeat(20_000)}${lastLine}\n`;
    fs.mkdirSync(path.join(storage.stashDir, "knowledge"), { recursive: true });
    fs.writeFileSync(
      path.join(storage.stashDir, "knowledge", "big.md"),
      `---\ndescription: A large document\n---\n\n${body}`,
    );
    await akmIndex({ stashDir: storage.stashDir, full: true });
    const client = new McpClient();

    const shown = await client.call("show", { ref: "knowledge/big" });

    expect(shown.isError).toBe(false);
    expect(shown.text.length).toBeGreaterThan(1_500_000);
    expect(JSON.parse(shown.text).content).toContain(`${lastLine}\n`);
    expect(await client.close()).toBe(0);
  });

  test("show on a secret or an env file returns names, never values", async () => {
    await fixtureStash();
    const client = new McpClient();

    const secret = await client.call("show", { ref: "secrets/deploy-key" });
    expect(secret.isError).toBe(false);
    expect(JSON.parse(secret.text)).toMatchObject({ type: "secret", name: "deploy-key" });
    expect(secret.text).not.toContain(SECRET_VALUE);

    const env = await client.call("show", { ref: "env/prod" });
    expect(JSON.parse(env.text)).toMatchObject({ type: "env", keys: ["API_URL", "TOKEN"] });
    expect(env.text).not.toContain(ENV_VALUE);

    // A search finds both by name, and no value is searchable.
    const byName = await client.call("search", { query: "deploy-key" });
    expect(byName.text).toContain("secrets/deploy-key");
    for (const value of [SECRET_VALUE, ENV_VALUE]) {
      expect(JSON.parse((await client.call("search", { query: value })).text).hits).toEqual([]);
    }
  });
});

describe("akm mcp: read-only", () => {
  test("a session that searches and shows everything writes nothing", async () => {
    await fixtureStash();
    const before = snapshotTree(storage.root);

    const client = new McpClient();
    await client.request("initialize", { protocolVersion: "2025-06-18" });
    await client.call("search", { query: "ripgrep" });
    await client.call("search", { query: "" });
    await client.call("show", { ref: "lessons/rg" });
    await client.call("show", { ref: "memories/alias-tip" });
    await client.call("show", { ref: "env/prod" });
    await client.call("show", { ref: "secrets/deploy-key" });
    await client.call("show", { ref: "meta:overview" });
    await client.call("show", { ref: "lessons/missing" });
    expect(await client.close()).toBe(0);

    expect(snapshotTree(storage.root)).toEqual(before);

    // The check can fail: the same reads through the CLI record usage.
    await runCliCapture(["search", "ripgrep"]);
    await runCliCapture(["show", "lessons/rg"]);
    expect(snapshotTree(storage.root)).not.toEqual(before);
  });

  test("it never builds a missing index", async () => {
    writeSandboxConfig({ semanticSearchMode: "off" });
    fs.mkdirSync(path.join(storage.stashDir, "lessons"), { recursive: true });
    fs.writeFileSync(path.join(storage.stashDir, "lessons", "rg.md"), "---\ndescription: rg\n---\n\nUse rg.\n");
    const before = snapshotTree(storage.root);

    const client = new McpClient();
    for (const reply of [
      await client.call("search", { query: "rg" }),
      await client.call("show", { ref: "lessons/rg" }),
    ]) {
      expect(reply.isError).toBe(true);
      expect(reply.text).toContain("akm index");
    }
    expect(await client.close()).toBe(0);

    expect(snapshotTree(storage.root)).toEqual(before);
  });
});
