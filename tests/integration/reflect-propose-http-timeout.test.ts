// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runReflectIteration } from "../../src/commands/improve/reflect";
import { akmPropose } from "../../src/commands/proposal/propose";
import type { AkmConfig } from "../../src/core/config/config";
import type { RunnerSpec } from "../../src/integrations/agent/runner";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function delayedServer(content: string, delayMs: number): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({
    port: 0,
    async fetch() {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return Response.json({ choices: [{ message: { content } }] });
    },
  });
  cleanups.push(() => server.stop(true));
  return server;
}

// A server whose fetch handler never resolves. Used by the tests that expect
// the client's timeout to fire: racing a short timeout against a server that
// merely responds *later* (e.g. after 50ms) depends on a real elapsed-time
// margin between the client timer and the server's delay, which can narrow
// or invert under scheduler load on a busy shard. A server that never
// answers removes that margin entirely — the client timeout is the only way
// the request can ever settle, so the assertion holds regardless of how
// slow or fast the scheduler is on the day the test runs.
function hungServer(): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Promise<Response>(() => {});
    },
  });
  cleanups.push(() => server.stop(true));
  return server;
}

function makeStash(): string {
  const stash = fs.mkdtempSync(path.join(os.tmpdir(), "akm-http-timeout-"));
  for (const dir of ["skills", "lessons", "memories", "knowledge"]) {
    fs.mkdirSync(path.join(stash, dir), { recursive: true });
  }
  cleanups.push(() => fs.rmSync(stash, { recursive: true, force: true }));
  return stash;
}

const validSkill = JSON.stringify({
  ref: "skills/http-timeout",
  content: "---\ndescription: Exercise direct HTTP timeout forwarding\n---\n\nUse the direct transport.\n",
});

function directRunner(
  connection: Extract<RunnerSpec, { kind: "llm" }>["connection"],
  timeoutMs?: number | null,
): Extract<RunnerSpec, { kind: "llm" }> {
  return { kind: "llm", engine: "direct", connection, ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
}

test("reflect forwards a 1ms normalized timeout to the direct HTTP transport", async () => {
  const server = hungServer();
  const result = await runReflectIteration({
    prompt: "reflect",
    runner: directRunner({ endpoint: `http://localhost:${server.port}`, model: "test-model" }),
    timeoutMs: 1,
    iteration: 0,
    outputMode: "json_schema",
  });

  expect(result.ok).toBe(false);
  expect(result.error).toContain("timed out after 1ms");
});

test("reflect explicit null disables the direct HTTP timer", async () => {
  const server = delayedServer(
    JSON.stringify({
      ref: "lessons/delayed-reflect",
      confidence: 0.9,
      frontmatterPatch: { description: null, when_to_use: null, title: null },
    }),
    20,
  );
  const result = await runReflectIteration({
    prompt: "reflect",
    runner: directRunner({ endpoint: `http://localhost:${server.port}`, model: "test-model" }, 1),
    timeoutMs: null,
    iteration: 0,
    outputMode: "json_schema",
  });

  expect(result.ok).toBe(true);
  expect(JSON.parse(result.stdout).ref).toBe("lessons/delayed-reflect");
});

test("propose forwards a 1ms call override instead of the engine timeout", async () => {
  const server = hungServer();
  const stashDir = makeStash();
  const config: AkmConfig = {
    configVersion: "0.9.0",
    semanticSearchMode: "auto",
    stashDir,
    engines: {
      direct: { kind: "llm", endpoint: `http://localhost:${server.port}`, model: "test-model", timeoutMs: null },
    },
    defaults: { engine: "direct", llmEngine: "direct" },
  };

  const result = await akmPropose({
    type: "skill",
    name: "http-timeout",
    task: "exercise timeout",
    timeoutMs: 1,
    stashDir,
    agentConfig: config,
  });

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected timeout failure");
  expect(result.error).toContain("timed out after 1ms");
});

test("propose preserves an inherited null timeout for direct HTTP", async () => {
  const server = delayedServer(validSkill, 20);
  const stashDir = makeStash();
  const config: AkmConfig = {
    configVersion: "0.9.0",
    semanticSearchMode: "auto",
    stashDir,
    engines: {
      direct: { kind: "llm", endpoint: `http://localhost:${server.port}`, model: "test-model", timeoutMs: null },
    },
    defaults: { engine: "direct", llmEngine: "direct" },
  };

  const result = await akmPropose({
    type: "skill",
    name: "http-timeout",
    task: "exercise null timeout",
    stashDir,
    agentConfig: config,
  });

  expect(result.ok).toBe(true);
});
