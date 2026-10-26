// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Killing a dispatching `akm` command must end it by the signal, however busy
 * its OpenCode process is, and must not leave that process behind. A command with
 * no SIGINT/SIGTERM handler of its own dies on the signal without running `exit`
 * hooks, so akm's runtime (a child process group) is ended by the spawn path's own
 * signal guard (`src/core/subprocess.ts`), not by anything the runtime closes.
 * This runs the real CLI (`akm agent --prompt`) on the real OpenCode binary against
 * a loopback model that never answers, signals the CLI while it is blocked in
 * dispatch, and proves it still ended by the signal itself and that no OpenCode
 * process of its run is left. The suite is skipped, with a message, when the
 * binary cannot be fetched.
 *
 * Integration-scoped (ORG-03/06): spawns the real CLI.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getCacheDir } from "../../src/core/paths";
import { fetchSharedOpencode, linkSharedOpencode } from "../_helpers/opencode-binary";
import {
  type IsolatedAkmStorage,
  makeSandboxDir,
  type SandboxedDir,
  withIsolatedAkmStorage,
  writeSandboxConfig,
} from "../_helpers/sandbox";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");

const unavailable = await fetchSharedOpencode();
if (unavailable)
  console.warn(`[opencode-runtime-signal-teardown] skipped: the OpenCode binary is not available: ${unavailable}`);

let storage: IsolatedAkmStorage;
let fakeDir: SandboxedDir;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  linkSharedOpencode(getCacheDir());
  fakeDir = makeSandboxDir("akm-runtime-signal");
});

afterEach(() => {
  fakeDir.cleanup();
  storage.cleanup();
});

async function waitFor(what: string, check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test.skipIf(process.platform === "win32" || unavailable !== undefined)(
    `a dispatching command killed by ${signal} ends by the signal and leaves no OpenCode process`,
    async () => {
      // A model that accepts a request and never answers, so the CLI stays blocked in dispatch until it is signalled.
      let requested = false;
      const model = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(req) {
          if (req.method === "GET") return Response.json({ object: "list", data: [{ id: "fake-model" }] });
          requested = true;
          return new Promise<Response>(() => {});
        },
      });
      // The CLI as `bun src/cli.ts` runs it, on the real OpenCode binary (which fetches no model catalog).
      const entry = path.join(fakeDir.dir, "entry.ts");
      fs.writeFileSync(
        entry,
        [`import { runCli } from ${JSON.stringify(path.join(REPO_ROOT, "src/cli.ts"))};`, `await runCli();`].join("\n"),
      );
      writeSandboxConfig({
        connections: {
          local: { endpoint: `http://127.0.0.1:${model.port}/v1/chat/completions`, models: { fast: "fake-model" } },
        },
      });

      const cli = spawn(process.execPath, [entry, "agent", "--connection", "local", "--prompt", "hi"], {
        cwd: REPO_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      cli.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });
      cli.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });
      const ended = new Promise<NodeJS.Signals | number | null>((resolve) => {
        cli.once("exit", (code, exitSignal) => resolve(exitSignal ?? code));
      });

      try {
        await waitFor(
          "the CLI to dispatch to the model",
          () => {
            if (cli.exitCode !== null) throw new Error(`the CLI exited ${cli.exitCode} before dispatching\n${output}`);
            return requested;
          },
          30_000,
        );

        // The processes of this run are the ones started from this test's own cache directory.
        const survivors = (): string => spawnSync("pgrep", ["-f", getCacheDir()], { encoding: "utf8" }).stdout.trim();
        expect(survivors()).not.toBe("");
        cli.kill(signal);
        const outcome = await Promise.race([
          ended,
          new Promise((resolve) => setTimeout(() => resolve("still running"), 10_000)),
        ]);
        // The open OpenCode process must not change how the command ends: it still dies by the signal itself.
        expect(outcome).toBe(signal);
        // And its run's OpenCode processes (the run, and the server it started) are gone.
        await waitFor("the run's OpenCode processes to end", () => survivors() === "", 20_000);
      } finally {
        if (cli.exitCode === null && cli.signalCode === null) cli.kill("SIGKILL");
        model.stop(true);
      }
    },
    90_000,
  );
}
