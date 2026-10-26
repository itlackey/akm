// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A run on akm's own runtime (`runtime/index.ts`) through the real spawn path, with
 * a stand-in for the OpenCode binary in akm's cache: a program that reports what it
 * was started with. The real binary is run by
 * tests/integration/opencode-runtime-sessions.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import akmPlugin from "../src/assets/opencode/akm-plugin.js" with { type: "text" };
import { getDataDir } from "../src/core/paths";
import { runtimeProfile } from "../src/integrations/agent/profiles";
import type { ConnectionRunner } from "../src/integrations/agent/runner";
import type { AgentRunResult, RunAgentOptions } from "../src/integrations/agent/spawn";
import { opencodeRuntime } from "../src/integrations/harnesses/opencode/runtime";
import { runtimeBinaryPath } from "../src/integrations/harnesses/opencode/runtime/binary";
import type { ChatCompletionConfig } from "../src/llm/client";
import { resolveAkmInvocation } from "../src/tasks/resolve-akm-bin";
import { useRealOpencodeRuntime } from "./_helpers/fake-opencode-runtime";
import { type IsolatedAkmStorage, withEnv, withIsolatedAkmStorage, withMockedFetch } from "./_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  useRealOpencodeRuntime();
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

const profile = runtimeProfile({ name: "lab" } as ConnectionRunner);
const connection: ChatCompletionConfig = {
  endpoint: "http://127.0.0.1:1/v1",
  model: "fake-model",
  apiKey: "sk-secret",
};

/**
 * What the stand-in does for `session list`, the command that prepares OpenCode's database: it makes the file, as
 * OpenCode does before it migrates it. With `STARTS_LOG` set it logs its start and end and takes half a second
 * between them, as a migration would.
 */
const PREPARE = `if (process.argv[2] === "session") {
  const fs = require("node:fs");
  const path = require("node:path");
  const log = process.env.STARTS_LOG;
  fs.mkdirSync(path.join(process.env.XDG_DATA_HOME, "opencode"), { recursive: true });
  fs.writeFileSync(path.join(process.env.XDG_DATA_HOME, "opencode", "opencode.db"), "");
  if (log) fs.appendFileSync(log, "prepare start\\n");
  if (log) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  if (log) fs.appendFileSync(log, "prepare end\\n");
  process.exit(0);
}`;

/**
 * Put a program where akm keeps the OpenCode binary. A first run on a fresh runtime directory prepares OpenCode's
 * database with `session list`, which the stand-in answers by making the file; everything else is `body`.
 */
function installBinary(body: string): void {
  const binary = runtimeBinaryPath();
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, `#!${process.execPath}\n${PREPARE}\n${body}\n`, { mode: 0o755 });
}

/** A binary that prints what it was started with, as JSON. */
const REPORTER = `
const stdin = require("node:fs").readFileSync(0, "utf8");
console.log(JSON.stringify({ argv: process.argv.slice(2), stdin, cwd: process.cwd(), env: process.env }));
`;

interface Report {
  argv: string[];
  stdin: string;
  cwd: string;
  env: Record<string, string>;
}

const run = (opts: Partial<RunAgentOptions> = {}, using: ChatCompletionConfig = connection): Promise<AgentRunResult> =>
  opencodeRuntime.run(profile, { timeoutMs: 20_000, dispatch: { prompt: "MODE:answer hi" }, ...opts }, using);

const reported = (result: AgentRunResult): Report => JSON.parse(result.stdout) as Report;

describe.skipIf(process.platform === "win32")("a run on akm's runtime", () => {
  test("starts the binary in the cache as a standalone run, the prompt on stdin, in the call's directory", async () => {
    installBinary(REPORTER);
    const cwd = fs.realpathSync(storage.root);

    const result = await run({ cwd });

    expect(result.ok, result.stderr).toBe(true);
    const started = reported(result);
    expect(started.argv).toEqual(["run", "--standalone", "--title", "akm", "--model", "akm/fake-model"]);
    expect(started.stdin).toBe("MODE:answer hi");
    expect(fs.realpathSync(started.cwd)).toBe(cwd);
  });

  test("the process is akm's own: its roots, no inherited OpenCode setting, the call's environment and akm's locations", async () => {
    installBinary(REPORTER);

    const result = await withEnv(
      {
        OPENCODE_CONFIG_DIR: "/users/own/opencode",
        OPENCODE_DB: "/users/own.db",
        OPENCODE_CONFIG_CONTENT: '{"model":"x"}',
      },
      () => run({ env: { AKM_EVENT_SOURCE: "task" } }),
    );

    const { env } = reported(result);
    const directory = path.join(getDataDir(), "opencode-runtime");
    expect(env.XDG_DATA_HOME).toBe(path.join(directory, "data"));
    expect(env.TMPDIR).toBe(path.join(directory, "tmp"));
    expect(env.OPENCODE_CONFIG_DIR).toBeUndefined();
    expect(env.OPENCODE_DB).toBeUndefined();
    // The inline config is akm's own, not the one the user's environment holds.
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT as string)).not.toHaveProperty("model");
    expect(env.AKM_EVENT_SOURCE).toBe("task");
    expect(env.AKM_DATA_DIR).toBe(getDataDir());
    // The argv that runs this akm: here the runtime and the source entry.
    expect(JSON.parse(env.AKM_OPENCODE_CLI as string)).toEqual(resolveAkmInvocation().argv);
    expect(path.basename(resolveAkmInvocation().argv.at(-1) as string)).toBe("cli.ts");
    for (const name of ["config", "data", "cache", "state", "tmp"]) {
      expect(fs.statSync(path.join(directory, name)).isDirectory()).toBe(true);
    }
  });

  test("the plugin is written to the runtime's config directory and named in the config", async () => {
    installBinary(REPORTER);

    const result = await run();

    const pluginDirectory = path.join(getDataDir(), "opencode-runtime", "config", "akm-plugin");
    expect(fs.readFileSync(path.join(pluginDirectory, "index.mjs"), "utf8")).toBe(akmPlugin);
    const config = JSON.parse(reported(result).env.OPENCODE_CONFIG_CONTENT as string) as {
      plugins: Array<{ package: string }>;
    };
    expect(config.plugins[0]?.package).toBe(pluginDirectory);
  });

  test("runs that start together on a fresh runtime directory wait for the one that prepares OpenCode's database", async () => {
    const log = path.join(storage.root, "starts.log");
    installBinary(
      'require("node:fs").readFileSync(0, "utf8"); require("node:fs").appendFileSync(process.env.STARTS_LOG, "run\\n");',
    );
    const lines = () => fs.readFileSync(log, "utf8").trim().split("\n");

    const results = await Promise.all(Array.from({ length: 6 }, () => run({ env: { STARTS_LOG: log } })));

    expect(results.map((result) => result.ok)).toEqual(Array(6).fill(true));
    // One preparing run, alone, then the six runs: none started while the database was being prepared.
    expect(lines()).toEqual(["prepare start", "prepare end", ...Array(6).fill("run")]);
    // The next run finds the database prepared and starts at once.
    await run({ env: { STARTS_LOG: log } });
    expect(lines().filter((line) => line.startsWith("prepare"))).toHaveLength(2);
  });

  test("two akm processes that start together prepare the database once, before either run starts", async () => {
    const log = path.join(storage.root, "starts.log");
    installBinary(
      'require("node:fs").readFileSync(0, "utf8"); require("node:fs").appendFileSync(process.env.STARTS_LOG, "run\\n");',
    );
    const script = `
      const { opencodeRuntime } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../src/integrations/harnesses/opencode/runtime/index.ts"))});
      const result = await opencodeRuntime.run(
        { name: "lab" },
        { timeoutMs: 20000, env: { STARTS_LOG: ${JSON.stringify(log)} }, dispatch: { prompt: "p" } },
        { endpoint: "http://127.0.0.1:1/v1", model: "fake-model" },
      );
      console.log(JSON.stringify(result.ok || result.error));
    `;
    const child = () =>
      new Promise<string>((resolve) => {
        const started = spawn(process.execPath, ["-e", script], {
          env: process.env,
          stdio: ["ignore", "pipe", "inherit"],
        });
        let out = "";
        started.stdout.on("data", (chunk) => (out += chunk));
        started.on("close", () => resolve(out.trim()));
      });

    expect(await Promise.all([child(), child()])).toEqual(["true", "true"]);
    expect(fs.readFileSync(log, "utf8").trim().split("\n")).toEqual(["prepare start", "prepare end", "run", "run"]);
  });

  test("a lock its holder left behind when it died does not keep a run waiting", async () => {
    installBinary(REPORTER);
    const directory = path.join(getDataDir(), "opencode-runtime");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "prepare.lock"), JSON.stringify({ pid: 999_999_999, lockId: "gone" }));

    const result = await run();

    expect(result.ok, result.error).toBe(true);
    expect(fs.existsSync(path.join(directory, "prepare.lock"))).toBe(false);
  });

  test("a failing process is a failed run, with its own output kept", async () => {
    installBinary('console.error("Error: Model unavailable"); process.exit(1);');

    const result = await run();

    expect(result).toMatchObject({ ok: false, reason: "non_zero_exit", exitCode: 1 });
    expect(result.stderr).toContain("Model unavailable");
    expect(result.error).toContain(`akm's runtime on connection "lab" exited with code 1`);
  });

  test("a run past its deadline is a timeout, and the process is ended", async () => {
    installBinary("setTimeout(() => {}, 60_000);");

    const result = await run({ timeoutMs: 300 });

    expect(result).toMatchObject({ ok: false, reason: "timeout" });
    expect(result.error).toContain(`akm's runtime on connection "lab" timed out after 300ms`);
  });

  test("a caller that has already given up starts nothing", async () => {
    installBinary(REPORTER);

    const result = await run({ signal: AbortSignal.abort() });

    expect(result).toMatchObject({ ok: false, reason: "aborted" });
    expect(result.stdout).toBe("");
  });

  test("with no binary in the cache and no registry to fetch it from, the run fails as not started, naming what it needed", async () => {
    const result = await withMockedFetch(
      () => run(),
      () => new Response("gone", { status: 404 }),
    );

    expect(result).toMatchObject({ ok: false, reason: "spawn_failed", exitCode: null });
    expect(result.error).toMatch(/package @opencode\/cli-[a-z0-9-]+ from https:\/\/registry\.npmjs\.org\//);
    expect(result.error).toContain(path.dirname(runtimeBinaryPath()));
  });

  test("a run is given a prompt", async () => {
    await expect(opencodeRuntime.run(profile, { dispatch: {} }, connection)).rejects.toThrow(TypeError);
  });
});
