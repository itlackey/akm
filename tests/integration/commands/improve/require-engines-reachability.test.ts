// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm improve --require-engines` (#957 field re-test): the flag's static
 * config/credential check let a run through even when the engine's endpoint
 * was completely dead. Field, beta.3: engines pointed at a dead endpoint,
 * then `akm improve --require-engines` sat silent for ~4 minutes, ignoring
 * an external `timeout 30` (SIGTERM) and akm's own `--timeout-ms`, and
 * needed `kill -9` — the documented exit-78 "required engines unavailable"
 * path could never be observed, because nothing ever probed reachability.
 *
 * This spawns the REAL CLI process (`bun src/cli.ts`) against real TCP
 * targets — one that never answers, one that refuses the connection outright
 * — so the reachability probe genuinely has to cross the network. Neither
 * case needs a real asset or a built index: `--require-engines` aborts
 * before any lock/log/index side effect, so an empty stash is enough to
 * prove the probe fires.
 *
 * Integration-scoped (ORG-03/06): spawns a real child process and touches
 * the network.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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

function hangingServer(): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    // Never resolves on its own — only the probe's own bounded timeout can
    // end this request.
    fetch() {
      return new Promise<Response>(() => {});
    },
  });
}

async function spawnImprove(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string; elapsedMs: number }> {
  const startedAt = Date.now();
  const child = Bun.spawn(["bun", "src/cli.ts", "improve", ...args], {
    cwd: repoRoot,
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr, elapsedMs: Date.now() - startedAt };
}

describe("akm improve --require-engines — reachability probe (#957)", () => {
  test("a refusing endpoint aborts fast with exit 78, naming the engine and endpoint", async () => {
    saveConfig({
      semanticSearchMode: "off",
      engines: {
        // Port 1 is privileged and unbound in every dev/CI sandbox — refuses
        // the connection immediately (ECONNREFUSED), no race with a real
        // listener.
        dead: { kind: "llm", endpoint: "http://127.0.0.1:1/v1", model: "dead-model" },
      },
      defaults: { llmEngine: "dead" },
    });

    const result = await spawnImprove(["--require-engines"]);

    expect(result.code).toBe(78);
    expect(result.elapsedMs).toBeLessThan(10_000);
    expect(result.stderr).toContain("--require-engines");
    expect(result.stderr).toContain("dead");
    expect(result.stderr).toContain("http://127.0.0.1:1/v1");
  }, 20_000);

  test("a hanging endpoint aborts within the probe bound with exit 78, never reaching a full run", async () => {
    const server = hangingServer();
    try {
      saveConfig({
        semanticSearchMode: "off",
        engines: {
          hung: { kind: "llm", endpoint: `http://localhost:${server.port}/v1`, model: "hung-model" },
        },
        defaults: { llmEngine: "hung" },
      });

      const result = await spawnImprove(["--require-engines"]);

      expect(result.code).toBe(78);
      // The bounded probe (akm health's own default) ends this in a handful
      // of seconds — nowhere near the multi-minute field hang, and nowhere
      // near the improve run's own much longer per-call defaults.
      expect(result.elapsedMs).toBeLessThan(10_000);
      expect(result.stderr).toContain("--require-engines");
      expect(result.stderr).toContain("hung");
    } finally {
      server.stop(true);
    }
  }, 20_000);
});
