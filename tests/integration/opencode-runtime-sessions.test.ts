// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * akm's own runtime on the real OpenCode binary (`runtime/`), against a loopback
 * model. A turn of agent work and a turn of model work each go through the real
 * process, its plugin and akm's own CLI, and the sessions they leave are listed
 * and read back by the history reader. The binary is fetched once into a cache
 * the test runs share (`tests/_helpers/opencode-binary.ts`); the suite is skipped,
 * with a message, when the registry cannot be reached.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getCacheDir, getDataDir } from "../../src/core/paths";
import { runtimeProfile } from "../../src/integrations/agent/profiles";
import type { ConnectionRunner } from "../../src/integrations/agent/runner";
import type { RunAgentOptions } from "../../src/integrations/agent/spawn";
import { akmOpencodeDatabasePath } from "../../src/integrations/harnesses/opencode/roots";
import { opencodeRuntime } from "../../src/integrations/harnesses/opencode/runtime";
import { OpenCodeProvider } from "../../src/integrations/harnesses/opencode/session-log";
import type { ChatCompletionConfig } from "../../src/llm/client";
import { type FakeModelServer, startFakeModel } from "../_helpers/fake-model-server";
import { useRealOpencodeRuntime } from "../_helpers/fake-opencode-runtime";
import { fetchSharedOpencode, linkSharedOpencode } from "../_helpers/opencode-binary";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

const unavailable = await fetchSharedOpencode();
if (unavailable)
  console.warn(`[opencode-runtime-sessions] skipped: the OpenCode binary is not available: ${unavailable}`);

let model: FakeModelServer;
let storage: IsolatedAkmStorage;
let work: string;

beforeAll(() => {
  model = startFakeModel();
});

afterAll(() => {
  model.stop();
});

beforeEach(() => {
  useRealOpencodeRuntime();
  storage = withIsolatedAkmStorage();
  linkSharedOpencode(getCacheDir());
  work = path.join(storage.root, "work");
  fs.mkdirSync(work, { recursive: true });
  model.requests.length = 0;
});

afterEach(() => {
  storage.cleanup();
});

const profile = runtimeProfile({ name: "lab" } as ConnectionRunner);

const connection = (extra: Partial<ChatCompletionConfig> = {}): ChatCompletionConfig => ({
  endpoint: model.url,
  model: "fake-model",
  timeoutMs: null,
  ...extra,
});

/** One run on the runtime: `MODE:<mode>` is what the loopback model acts on. */
function run(
  mode: string,
  options: {
    modelWork?: boolean;
    connection?: ChatCompletionConfig;
    timeoutMs?: number;
    env?: Record<string, string>;
  } = {},
) {
  const opts: RunAgentOptions = {
    cwd: work,
    timeoutMs: options.timeoutMs ?? 60_000,
    ...(options.env ? { env: options.env } : {}),
    dispatch: { prompt: `MODE:${mode} please`, ...(options.modelWork ? { modelWork: true } : {}) },
  };
  return opencodeRuntime.run(profile, opts, options.connection ?? connection());
}

/** Every file under `dir`, relative to it. */
function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .flatMap((entry) => (entry.isFile() ? [path.relative(dir, path.join(entry.parentPath, entry.name))] : []));
}

describe.skipIf(unavailable !== undefined)("akm's runtime on the real OpenCode binary", () => {
  test("agent work: the normal tools and akm's three, a tool call that reaches akm's CLI, the connection's fields and key", async () => {
    const result = await run("akm", {
      connection: connection({ apiKey: "sk-runtime-test", request: { reasoning_effort: "high", top_p: 0.9 } }),
      env: { AKM_EVENT_SOURCE: "task" },
    });

    expect(result.ok, `${result.stdout}\n${result.stderr}`).toBe(true);
    expect(result.exitCode).toBe(0);
    // The call went to akm's CLI (the plugin shells out to it) and its JSON came back through the tool.
    expect(result.stdout).toMatch(/^AKM:\{[\s\S]*"hits"/);
    const [first, second] = model.requests;
    expect(first?.tools).toEqual(
      expect.arrayContaining(["akm_search", "akm_show", "akm_curate", "shell", "write", "edit"]),
    );
    expect(second?.toolResult).toContain('"hits"');
    // The connection is the provider: its key, and its request fields over the request; OpenCode's own output cap is gone.
    expect(first?.authorization).toBe("Bearer sk-runtime-test");
    expect(first?.params).toMatchObject({ model: "fake-model", reasoning_effort: "high", top_p: 0.9 });
    expect(first?.params).not.toHaveProperty("max_tokens");
    expect(first?.params).not.toHaveProperty("max_completion_tokens");
  });

  test("the agent's commands get the environment akm runs in, not the runtime's: no key, no runtime roots", async () => {
    const ambient = {
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
      TMPDIR: process.env.TMPDIR ?? "unset",
    };
    const result = await run("runtime", {
      connection: connection({ apiKey: "sk-never-in-a-command" }),
      env: { AKM_EVENT_SOURCE: "task" },
    });

    expect(result.ok, `${result.stdout}\n${result.stderr}`).toBe(true);
    // What the shell tool printed: the runtime's own settings are not there, akm's environment and the run's variables are.
    expect(result.stdout).toContain(
      `CONFIG=unset DATA=${ambient.XDG_DATA_HOME} CACHE=${ambient.XDG_CACHE_HOME} TMP=${ambient.TMPDIR} CLI=unset FREE=unset SOURCE=task DIR=${getDataDir()}`,
    );
    expect(result.stdout).not.toContain("sk-never-in-a-command");
  });

  test("the cap a connection writes is the cap the request carries", async () => {
    const result = await run("answer", { connection: connection({ request: { max_tokens: 777 } }) });

    expect(result.ok, `${result.stdout}\n${result.stderr}\n${result.error}`).toBe(true);
    expect(model.requests[0]?.params).toMatchObject({ max_tokens: 777 });
    expect(model.requests[0]?.params).not.toHaveProperty("max_completion_tokens");
  });

  test("model work: reading and searching only, with akm's three tools", async () => {
    const result = await run("akm", { modelWork: true });

    expect(result.ok, `${result.stdout}\n${result.stderr}`).toBe(true);
    expect(result.stdout).toMatch(/^AKM:\{[\s\S]*"hits"/);
    expect([...(model.requests[0]?.tools ?? [])].sort()).toEqual([
      "akm_curate",
      "akm_search",
      "akm_show",
      "glob",
      "grep",
      "read",
    ]);
  });

  test("model work cannot write: a write call is refused and no file is made", async () => {
    const result = await run("write", { modelWork: true });

    expect(result.stdout).toContain("No tool named");
    expect(fs.existsSync(path.join(work, "x.md"))).toBe(false);
  });

  test("agent work in a project keeps the project's own files out of the model's instructions", async () => {
    fs.writeFileSync(path.join(work, "AGENTS.md"), "PROJECT-RULE-XYZ\n");
    const result = await run("answer");

    expect(result.ok).toBe(true);
    expect(model.requests[0]?.system).not.toContain("PROJECT-RULE-XYZ");
  });

  test("the sessions are listed by the history reader: the agent's, never the model work's, with their tool calls", async () => {
    await run("akm");
    await run("akm", { modelWork: true });

    const database = akmOpencodeDatabasePath();
    expect(database).toBe(path.join(getDataDir(), "opencode-runtime", "data", "opencode", "opencode.db"));
    expect(fs.existsSync(database)).toBe(true);
    const provider = new OpenCodeProvider();
    expect(provider.isAvailable()).toBe(true);
    const sessions = await provider.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ title: "akm", filePath: database });
    const data = await provider.readSession(sessions[0] as never);
    const texts = data.events.map((event) => [event.role, event.text]);
    expect(texts[0]).toEqual(["user", "MODE:akm please"]);
    expect(texts.some(([role, text]) => role === "assistant" && text?.startsWith("[tool:akm_search]"))).toBe(true);
    expect(texts.some(([role, text]) => role === "tool" && text?.includes("hits"))).toBe(true);
  });

  test("nothing is written outside akm's directories: not in the home directory, not in the temp directory", async () => {
    const home = process.env.HOME ?? "";
    const tmp = os.tmpdir();
    const tempBefore = new Set(fs.readdirSync(tmp));

    const result = await run("akm");

    expect(result.ok).toBe(true);
    for (const [root, name] of [
      [".local/share", "opencode"],
      [".config", "opencode"],
      [".cache", "opencode"],
      [".local/state", "opencode"],
    ] as const) {
      expect(fs.existsSync(path.join(home, root, name)), `${root}/${name} under ${home}`).toBe(false);
    }
    // The binary's own native pieces are extracted into the runtime's temp directory, not the system's.
    expect(fs.readdirSync(tmp).filter((name) => name.startsWith(".bun-") && !tempBefore.has(name))).toEqual([]);
    expect(
      filesUnder(path.join(getDataDir(), "opencode-runtime", "tmp")).some((file) => file.startsWith(".bun-")),
    ).toBe(true);
    // The runtime's own directory holds its roots.
    expect(fs.readdirSync(path.join(getDataDir(), "opencode-runtime")).sort()).toEqual(
      expect.arrayContaining(["cache", "config", "data", "state", "tmp"]),
    );
    expect(fs.existsSync(path.join(getDataDir(), "opencode-runtime", "config", "akm-plugin", "index.mjs"))).toBe(true);
  });

  test("a run that timed out is not replayed by the next one", async () => {
    const hung = await run("hang", { timeoutMs: 3_000 });
    expect(hung.reason).toBe("timeout");
    const afterHang = model.requests.length;

    const next = await run("answer");

    expect(next.ok).toBe(true);
    // Only the second run's own request reached the model: the hung turn was not resumed.
    expect(model.requests.slice(afterHang).map((request) => request.mode)).toEqual(["answer"]);
  }, 60_000);

  test("a run that fails says why: a native agent that does not exist is reported with the process's own message", async () => {
    const result = await opencodeRuntime.run(
      profile,
      { cwd: work, timeoutMs: 60_000, dispatch: { prompt: "MODE:answer please", agent: "no-such-agent" } },
      connection(),
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("non_zero_exit");
    expect(result.error).toContain("exited with code");
    expect(`${result.stderr}${result.stdout}`).toContain("no-such-agent");
  });
});
