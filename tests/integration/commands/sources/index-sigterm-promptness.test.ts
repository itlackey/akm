// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #956: `akm index` must abort promptly on SIGTERM/SIGINT — cancel
 * the in-flight embedding request through the AbortSignal, dispatch no
 * further batch, release the rebuild lock, and exit within about a second of
 * the signal. This spawns the REAL CLI process (not the in-process
 * `runCliCapture` harness, since the point is what happens when the OS
 * actually delivers SIGTERM to the running process) against a mock embedding
 * server whose handler never resolves on its own, so a request still stuck
 * there when the assertions run proves the client itself cancelled it rather
 * than the server ever answering.
 *
 * Integration-scoped (ORG-03/06): spawns a real child process and opens a
 * real index.db.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { saveConfig } from "../../../../src/core/config/config";
import { getIndexRebuildLockPath } from "../../../../src/core/paths";
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
  fs.writeFileSync(filePath, `---\ndescription: ${name}\n---\n\nContent for ${name}.\n`, "utf8");
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, description: string): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("akm index — SIGTERM promptness (#956)", () => {
  test("cancels the in-flight request, dispatches no further batch, releases the lock, and exits promptly", async () => {
    // batchSize: 1 with a loopback endpoint (fixed concurrency 1, #954) means
    // one document per request, strictly sequential — three documents give a
    // run that kept going after the signal two more chances to prove it.
    for (let i = 0; i < 3; i++) writeMemory(`note-${i}`);

    let requestCount = 0;
    const server = Bun.serve({
      port: 0,
      async fetch() {
        requestCount++;
        // Never resolves on its own — only the client aborting the request
        // (or the server being stopped) ends it, so this stays "in flight"
        // for as long as the test needs.
        await new Promise(() => {});
        return new Response("unreachable");
      },
    });

    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      saveConfig({
        semanticSearchMode: "auto",
        embedding: { endpoint: `http://localhost:${server.port}`, model: "test-model", batchSize: 1 },
      });

      child = Bun.spawn(["bun", "src/cli.ts", "index", "--full", "--format=json"], {
        cwd: repoRoot,
        env: { ...process.env },
        stdout: "pipe",
        stderr: "pipe",
      });

      // Proof the embedding phase is genuinely in flight, not a race against
      // startup: wait for the request to actually reach the mock server.
      await waitUntil(() => requestCount > 0, 15_000, "the first embedding request to reach the mock server");
      expect(fs.existsSync(getIndexRebuildLockPath())).toBe(true);

      const requestCountAtSignal = requestCount;
      const signalledAt = Date.now();
      child.kill("SIGTERM");
      const exitCode = await child.exited;
      const elapsedMs = Date.now() - signalledAt;

      // Interrupted, not a clean success.
      expect(exitCode).not.toBe(0);
      // "~1s" per #956; generous enough to absorb CI scheduling
      // jitter while still catching a run that ignores the signal outright
      // (which would instead run until the mock server's request never
      // returns, i.e. hang past this bound).
      expect(elapsedMs).toBeLessThan(5_000);

      // No further batch was dispatched once the signal landed.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(requestCount).toBe(requestCountAtSignal);

      expect(fs.existsSync(getIndexRebuildLockPath())).toBe(false);
    } finally {
      child?.kill("SIGKILL");
      server.stop(true);
    }
  }, 30_000);
});
