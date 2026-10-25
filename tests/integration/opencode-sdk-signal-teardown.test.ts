// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Killing a dispatching `akm` command must end it by the signal, however busy
 * the embedded OpenCode is. A command with no SIGINT/SIGTERM handler of its
 * own dies on the signal without running `exit` hooks, so an embedded host
 * that was never closed must not keep the command alive or change how it ends.
 * This runs the real CLI (`akm agent --prompt`) on the real SDK against a
 * loopback model that never answers, signals the CLI while it is blocked in
 * dispatch, and proves it still ended by the signal itself.
 *
 * Integration-scoped (ORG-03/06): spawns the real CLI.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  type IsolatedAkmStorage,
  makeSandboxDir,
  type SandboxedDir,
  withIsolatedAkmStorage,
  writeSandboxConfig,
} from "../_helpers/sandbox";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");

let storage: IsolatedAkmStorage;
let fakeDir: SandboxedDir;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  fakeDir = makeSandboxDir("akm-sdk-signal");
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
  test.skipIf(process.platform === "win32")(
    `a dispatching command killed by ${signal} ends by the signal with its embedded OpenCode open`,
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
      // The CLI as `bun src/cli.ts` runs it, on the real embedded OpenCode (which fetches no model catalog).
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

        cli.kill(signal);
        const outcome = await Promise.race([
          ended,
          new Promise((resolve) => setTimeout(() => resolve("still running"), 10_000)),
        ]);
        // The open host must not change how the command ends: it still dies by the signal itself.
        expect(outcome).toBe(signal);
      } finally {
        if (cli.exitCode === null && cli.signalCode === null) cli.kill("SIGKILL");
        model.stop(true);
      }
    },
    90_000,
  );
}
