// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm improve` field re-test (#957): a real reflect dispatch against a dead
 * endpoint used to be silent and unstoppable — `--timeout-ms` never aborted
 * the in-flight request and SIGTERM was ignored, needing `kill -9`. This
 * spawns the REAL CLI process (`bun src/cli.ts`) with one real memory asset
 * and a `quick` (reflect-only) strategy against a mock chat-completions
 * server whose handler never resolves, proving:
 *
 *   1. a default-level heartbeat line appears once the run has waited a few
 *      seconds on its first engine response, so the run is never silent;
 *   2. `--timeout-ms` aborts the in-flight request and ends the run promptly
 *      instead of waiting out the engine's own (much longer) timeout;
 *   3. SIGTERM sent while a request is in flight ends the process within a
 *      bounded grace period.
 *
 * A second, negative case (#957 field-G r2-1) pins the opposite direction:
 * the heartbeat used to be armed at run start, before the triage/index
 * prepass, so it fired on healthy runs whose prepass alone (not the engine)
 * took longer than its window. That test drives a slow *embedding* endpoint
 * (semanticSearchMode "auto") to make the prepass slow deterministically,
 * paired with a fast-answering chat-completions engine, and asserts the
 * heartbeat line does NOT appear even though the run's total wall time
 * exceeds the heartbeat window.
 *
 * Integration-scoped (ORG-03/06): spawns real child processes, opens a real
 * index.db, and touches the network.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { saveConfig } from "../../../../src/core/config/config";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../../_helpers/sandbox";

const repoRoot = path.resolve(import.meta.dir, "../../../..");

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

function writeMemory(name: string): void {
  const filePath = path.join(storage.stashDir, "memories", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `---\ndescription: ${name}\n---\n\nSubstantial content for ${name}, long enough to be a plausible reflect candidate on its own.\n`,
    "utf8",
  );
}

function hangingChatServer() {
  let requestCount = 0;
  const server = Bun.serve({
    port: 0,
    async fetch() {
      requestCount++;
      await new Promise(() => {});
      return new Response("unreachable");
    },
  });
  return { server, requestCount: () => requestCount };
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, description: string): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function configureHungEngine(port: number): void {
  saveConfig({
    semanticSearchMode: "off",
    engines: {
      hung: { kind: "llm", endpoint: `http://localhost:${port}/v1`, model: "hung-model" },
    },
    defaults: { llmEngine: "hung" },
  });
}

/**
 * An `/embeddings` mock that sleeps before answering — makes the triage/index
 * prepass slow deterministically (with `semanticSearchMode: "auto"`) instead
 * of seeding a large stash. Responds with one placeholder vector per
 * requested input so `generateEmbeddingsForDb` accepts the batch.
 */
function slowEmbeddingServer(delayMs: number) {
  return Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { input?: string[] };
      const count = body.input?.length ?? 1;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return new Response(
        JSON.stringify({
          data: Array.from({ length: count }, (_, i) => ({ embedding: [0.1, 0.2, 0.3], index: i })),
          model: "slow-embed-model",
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    },
  });
}

/**
 * A chat-completions mock that answers immediately with a valid framed
 * direct-reflect response (see `parseFramedReflectOutput` in reflect.ts) so
 * the run completes as a genuinely healthy reflect pass, not an error.
 */
function fastReflectServer() {
  let requestCount = 0;
  const server = Bun.serve({
    port: 0,
    async fetch() {
      requestCount++;
      const raw = [
        "AKM_REFLECT_CONFIDENCE: 0.9",
        'AKM_REFLECT_FRONTMATTER_PATCH: {"description":null,"when_to_use":null}',
        "AKM_REFLECT_CONTENT_BEGIN",
        "Updated content for note-c, still substantial enough to be a plausible reflect candidate on its own.",
        "AKM_REFLECT_CONTENT_END",
      ].join("\n");
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: raw }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          model: "fast-model",
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    },
  });
  return { server, requestCount: () => requestCount };
}

function configureSlowPrepassFastEngine(embedPort: number, chatPort: number): void {
  saveConfig({
    semanticSearchMode: "auto",
    embedding: { endpoint: `http://localhost:${embedPort}/v1`, model: "slow-embed-model" },
    engines: {
      fast: { kind: "llm", endpoint: `http://localhost:${chatPort}/v1`, model: "fast-model" },
    },
    defaults: { llmEngine: "fast" },
  });
}

describe("akm improve — real reflect dispatch against a dead endpoint (#957)", () => {
  test("--timeout-ms aborts the in-flight request and prints the first-response heartbeat", async () => {
    writeMemory("note-a");
    const { server, requestCount } = hangingChatServer();
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      configureHungEngine(server.port!);

      const startedAt = Date.now();
      const spawned = Bun.spawn(
        [
          "bun",
          "src/cli.ts",
          "improve",
          "memories/note-a",
          "--strategy",
          "quick",
          "--timeout-ms",
          "7000",
          "--json-to-stdout",
        ],
        { cwd: repoRoot, env: { ...process.env }, stdout: "pipe", stderr: "pipe" },
      );
      child = spawned;

      await waitUntil(() => requestCount() > 0, 15_000, "the first chat-completion request to reach the mock server");

      const [stderr, code] = await Promise.all([new Response(spawned.stderr).text(), spawned.exited]);
      const elapsedMs = Date.now() - startedAt;

      // Budget exhaustion is a normal scheduled-task condition (armBudgetWatchdog),
      // not an error — the run completes cleanly rather than crashing.
      expect(code).toBe(0);
      // 7000ms budget (long enough for the 5000ms heartbeat to fire first) +
      // the watchdog's hard-kill grace, generously bounded well under the
      // field's multi-minute hang.
      expect(elapsedMs).toBeLessThan(20_000);
      expect(stderr).toContain("Still waiting for the first engine response");
    } finally {
      child?.kill("SIGKILL");
      server.stop(true);
    }
  }, 30_000);

  test("SIGTERM sent during a hanging request ends the process within the grace bound", async () => {
    writeMemory("note-b");
    const { server, requestCount } = hangingChatServer();
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      configureHungEngine(server.port!);

      child = Bun.spawn(["bun", "src/cli.ts", "improve", "memories/note-b", "--strategy", "quick"], {
        cwd: repoRoot,
        env: { ...process.env },
        stdout: "pipe",
        stderr: "pipe",
      });

      await waitUntil(() => requestCount() > 0, 15_000, "the first chat-completion request to reach the mock server");

      const signalledAt = Date.now();
      child.kill("SIGTERM");
      const code = await child.exited;
      const elapsedMs = Date.now() - signalledAt;

      // SIGNAL_TABLE (improve-session.ts): SIGTERM -> exit 143.
      expect(code).toBe(143);
      // #956/#957: the 2000ms in-process watchdog plus scheduling slack —
      // generous enough to absorb CI jitter while still catching a run that
      // ignores the signal outright.
      expect(elapsedMs).toBeLessThan(5_000);
    } finally {
      child?.kill("SIGKILL");
      server.stop(true);
    }
  }, 30_000);
});

describe("akm improve — a slow prepass must not trip the first-response heartbeat (#957 field-G r2-1)", () => {
  test("negative case: slow embedding prepass + fast-answering engine never prints the heartbeat", async () => {
    writeMemory("note-c");
    const embedServer = slowEmbeddingServer(6_000);
    const { server: chatServer, requestCount } = fastReflectServer();
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      configureSlowPrepassFastEngine(embedServer.port!, chatServer.port!);

      const startedAt = Date.now();
      const spawned = Bun.spawn(["bun", "src/cli.ts", "improve", "memories/note-c", "--strategy", "quick"], {
        cwd: repoRoot,
        env: { ...process.env },
        stdout: "pipe",
        stderr: "pipe",
      });
      child = spawned;

      const [stderr, code] = await Promise.all([new Response(spawned.stderr).text(), spawned.exited]);
      const elapsedMs = Date.now() - startedAt;

      // Confirms this run actually exercised the slow path: the prepass
      // (embedding) alone took longer than the heartbeat's own window, and
      // the chat engine was reached and answered — a genuinely healthy run,
      // not a run that skipped indexing or never dispatched an engine call.
      expect(elapsedMs).toBeGreaterThan(5_000);
      expect(requestCount()).toBeGreaterThan(0);
      expect(code).toBe(0);
      // #957 field-G r2-1: the heartbeat used to be armed at run start, so a
      // slow prepass alone (no slow engine at all) tripped it. It must stay
      // silent when the engine itself never took long.
      expect(stderr).not.toContain("Still waiting for the first engine response");
    } finally {
      child?.kill("SIGKILL");
      embedServer.stop(true);
      chatServer.stop(true);
    }
  }, 40_000);
});
