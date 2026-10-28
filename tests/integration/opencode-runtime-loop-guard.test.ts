// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The end of a run that repeats itself, on akm's own runtime and the real OpenCode binary, against a loopback model
 * (`src/assets/opencode/akm-plugin.js`): OpenCode has no check of its own for a model that makes the same tool call
 * and gets the same result over and over, so the plugin fails the run after three such turns, with a message, instead
 * of leaving it to its deadline (or, with no deadline, to run for ever). The binary is fetched once into a cache the
 * test runs share (`tests/_helpers/opencode-binary.ts`); the suite is skipped, with a message, when the registry
 * cannot be reached.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import akmPlugin from "../../src/assets/opencode/akm-plugin.js" with { type: "text" };
import { getCacheDir } from "../../src/core/paths";
import { runtimeProfile } from "../../src/integrations/agent/profiles";
import type { ConnectionRunner } from "../../src/integrations/agent/runner";
import { type AgentRunResult, runBuiltCommand } from "../../src/integrations/agent/spawn";
import { akmOpencodeDatabasePath, akmRuntimeDir } from "../../src/integrations/harnesses/opencode/roots";
import { opencodeRuntime } from "../../src/integrations/harnesses/opencode/runtime";
import { runtimeBinaryPath } from "../../src/integrations/harnesses/opencode/runtime/binary";
import { runtimeArgv, runtimeConfig, runtimeEnv } from "../../src/integrations/harnesses/opencode/runtime/command";
import type { ChatCompletionConfig } from "../../src/llm/client";
import { openDatabase } from "../../src/storage/database";
import { resolveAkmInvocation } from "../../src/tasks/resolve-akm-bin";
import { type FakeModelServer, startFakeModel } from "../_helpers/fake-model-server";
import { useRealOpencodeRuntime } from "../_helpers/fake-opencode-runtime";
import { fetchSharedOpencode, linkSharedOpencode } from "../_helpers/opencode-binary";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

const unavailable = await fetchSharedOpencode();
if (unavailable)
  console.warn(`[opencode-runtime-loop-guard] skipped: the OpenCode binary is not available: ${unavailable}`);

const STOPPED =
  "akm stopped this run: the model called `shell` with the same input three times in a row and got the same result each time.";

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

const connection: () => ChatCompletionConfig = () => ({ endpoint: model.url, model: "fake-model", timeoutMs: null });

/** One run on the runtime: `MODE:<mode>` is what the loopback model acts on. */
function run(mode: string, timeoutMs: number): Promise<AgentRunResult> {
  return opencodeRuntime.run(
    profile,
    { cwd: work, timeoutMs, dispatch: { prompt: `MODE:${mode} please` } },
    connection(),
  );
}

/** The session a run left, which every run on the runtime reports. */
function sessionOf(result: AgentRunResult): string {
  expect(result.sessionId).toBeDefined();
  return result.sessionId as string;
}

/** The tool calls a session ran to the end, counted in the runtime's database. */
function executedCalls(sessionId: string): number {
  const db = openDatabase(akmOpencodeDatabasePath(), { readonly: true, create: false });
  try {
    const row = db
      .prepare<{ calls: number }>(
        `SELECT count(*) AS calls FROM session_message AS message, json_each(message.data, '$.content') AS part
         WHERE message.session_id = ? AND message.type = 'assistant'
           AND json_extract(part.value, '$.type') = 'tool' AND json_extract(part.value, '$.state.status') = 'completed'`,
      )
      .get(sessionId);
    return row?.calls ?? 0;
  } finally {
    db.close();
  }
}

/** How a session ended, as OpenCode recorded it: the `idle` message's outcome and error. */
function outcome(sessionId: string): { outcome?: string; error?: { message?: string } } | undefined {
  const db = openDatabase(akmOpencodeDatabasePath(), { readonly: true, create: false });
  try {
    const row = db
      .prepare<{ data: string }>("SELECT data FROM session_message WHERE session_id = ? AND type = 'idle'")
      .get(sessionId);
    return row ? JSON.parse(row.data) : undefined;
  } finally {
    db.close();
  }
}

describe.skipIf(unavailable !== undefined)("a run on akm's runtime that repeats one call and result", () => {
  test("fails after the third, with the reason, before another request goes to the model", async () => {
    const result = await run("repeat", 60_000);

    // Not the deadline: the run ended by itself, as a failed process, in seconds.
    expect(result.reason).toBe("non_zero_exit");
    expect(result.exitCode).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.durationMs).toBeLessThan(30_000);
    expect(result.stderr).toContain(STOPPED);
    // The error says why too: a workflow keeps the error, not stderr.
    expect(result.error).toBe(`akm's runtime on connection "lab" exited with code 1: ${STOPPED}`);
    // Three requests went out, three calls ran; the fourth request, the one that would have made it a fourth, did not.
    expect(model.requests.map((request) => request.mode)).toEqual(["repeat", "repeat", "repeat"]);
    expect(executedCalls(sessionOf(result))).toBe(3);
    expect(outcome(sessionOf(result))).toMatchObject({ outcome: "failed", error: { message: STOPPED } });
    // The three turns are still counted: the tokens the run used are reported.
    expect(result.usage).toEqual({ inputTokens: 33, outputTokens: 21, reasoningTokens: 0 });
  }, 90_000);

  test("fails after the third when the output is too long to send whole, which OpenCode saves to a file of its own each time", async () => {
    const result = await run("long", 60_000);

    expect(result.reason).toBe("non_zero_exit");
    expect(result.stderr).toContain(STOPPED);
    expect(model.requests.map((request) => request.mode)).toEqual(["long", "long", "long"]);
    // What the model was given names the call's own file, so no two results are alike as text.
    const results = model.requests.flatMap((request) => (request.toolResult === undefined ? [] : [request.toolResult]));
    expect(results.every((text) => text.includes("full output saved to"))).toBe(true);
    expect(new Set(results).size).toBe(results.length);
  }, 90_000);

  test("is what the plugin's check does: without the check the same run goes on until its deadline", async () => {
    // The first run makes and prepares the runtime directory, as every run does.
    expect((await run("answer", 60_000)).ok).toBe(true);
    model.requests.length = 0;
    // The plugin as shipped, with the number of turns that count as a repeat raised out of reach.
    const unchecked = (akmPlugin as string).replace("const REPEATED_TURNS = 3;", "const REPEATED_TURNS = 1e9;");
    expect(unchecked).not.toBe(akmPlugin);
    const directory = akmRuntimeDir();
    const pluginDirectory = path.join(storage.root, "unchecked-plugin");
    fs.mkdirSync(pluginDirectory, { recursive: true });
    fs.writeFileSync(path.join(pluginDirectory, "index.mjs"), unchecked);
    const config = runtimeConfig(connection(), pluginDirectory, path.join(directory, "keys", "none"));
    const binary = runtimeBinaryPath();
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => !!entry[1])),
      ...runtimeEnv(config, { binary, directory, pluginDirectory, akm: resolveAkmInvocation().argv }),
    };
    const session = `ses_akm${randomUUID().replaceAll("-", "")}`;
    const prompt = "MODE:repeat please";

    const result = await runBuiltCommand(
      "the runtime without the check",
      { argv: runtimeArgv(connection(), { prompt }, binary, session), env, stdin: prompt },
      { cwd: work, timeoutMs: 8_000 },
      "captured",
    );

    expect(result.reason).toBe("timeout");
    expect(result.stderr).not.toContain("akm stopped this run");
    expect(model.requests.length).toBeGreaterThan(10);
    expect(executedCalls(session)).toBeGreaterThan(10);
  }, 90_000);

  test("is left alone when the same call gets a different result each time, as a poll does", async () => {
    const result = await run("poll", 8_000);

    expect(result.reason).toBe("timeout");
    expect(result.stderr).not.toContain("akm stopped this run");
    expect(model.requests.length).toBeGreaterThan(10);
    expect(executedCalls(sessionOf(result))).toBeGreaterThan(10);
    // It is the same call each time, and each time a result the model has not been given before.
    const results = model.requests.flatMap((request) => (request.toolResult === undefined ? [] : [request.toolResult]));
    expect(new Set(results).size).toBe(results.length);
  }, 60_000);

  test("is left alone when it repeats twice and then answers", async () => {
    const result = await run("twice", 60_000);

    expect(result.ok, `${result.stderr}${result.error}`).toBe(true);
    expect(result.stdout).toContain("TWICE-DONE");
    expect(model.requests.map((request) => request.mode)).toEqual(["twice", "twice", "twice"]);
    expect(executedCalls(sessionOf(result))).toBe(2);
  }, 60_000);
});
