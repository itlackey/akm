// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, expect, test } from "bun:test";
import { runReflectIteration } from "../../src/commands/improve/reflect";
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

function directRunner(
  connection: { endpoint: string; model: string },
  timeoutMs: number | null = null,
): Extract<RunnerSpec, { kind: "connection" }> {
  return { kind: "connection", name: "direct", ...connection, request: {}, timeoutMs };
}

test("reflect forwards a 1ms normalized timeout to the direct HTTP transport", async () => {
  const server = hungServer();
  const result = await runReflectIteration({
    prompt: "reflect",
    runner: directRunner({ endpoint: `http://localhost:${server.port}`, model: "test-model" }),
    timeoutMs: 1,
    outputMode: "json_schema",
  });

  if (result.ok) throw new Error("expected the 1ms timeout to fail the iteration");
  expect(result.reason).toBe("timeout");
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
    outputMode: "json_schema",
  });

  if (!result.ok) throw new Error(`expected a payload, got ${result.reason}: ${result.error}`);
  expect(result.payload.ref).toBe("lessons/delayed-reflect");
});
