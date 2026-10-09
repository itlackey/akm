// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Killing a dispatching `akm` command must not leave the `opencode serve` child
 * it started running. A command with no SIGINT/SIGTERM handler of its own dies
 * on the signal without running `exit` hooks, so the SDK runner's exit backstop
 * never closed the server it had cached: a scheduler timeout or a plain
 * `kill <pid>` orphaned `opencode serve`. This runs the real CLI
 * (`akm agent --prompt`) against a fake server that never answers, signals the
 * CLI while it is blocked in dispatch, and proves the server is gone and the
 * CLI still ended by the signal itself.
 *
 * Integration-scoped (ORG-03/06): spawns the real CLI and its child.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
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

/** True while something accepts connections on `port`; a killed server's socket is closed, a zombie's too. */
function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test.skipIf(process.platform === "win32")(
    `a dispatching command killed by ${signal} closes the opencode server it started`,
    async () => {
      const pidFile = path.join(fakeDir.dir, "serve.pid");
      const portFile = path.join(fakeDir.dir, "serve.port");
      const requestedFile = path.join(fakeDir.dir, "serve.requested");
      const serve = path.join(fakeDir.dir, "serve.js");
      const bin = path.join(fakeDir.dir, "opencode");
      // A minimal `opencode serve`: speaks the handshake, then never answers a request, so the CLI stays blocked in
      // dispatch until it is signalled. Its first request proves the CLI is past server startup.
      fs.writeFileSync(
        serve,
        [
          `const fs = require("node:fs");`,
          `const arg = (name) => process.argv.find((a) => a.startsWith("--" + name + "=")).split("=")[1];`,
          `const server = Bun.serve({`,
          `  hostname: arg("hostname"),`,
          `  port: Number(arg("port")),`,
          `  fetch() {`,
          `    fs.writeFileSync(${JSON.stringify(requestedFile)}, "1");`,
          `    return new Promise(() => {});`,
          `  },`,
          `});`,
          `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
          `fs.writeFileSync(${JSON.stringify(portFile)}, String(server.port));`,
          `console.log("opencode server listening on http://127.0.0.1:" + server.port);`,
        ].join("\n"),
      );
      fs.writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(serve)} "$@"\n`, {
        mode: 0o755,
      });
      writeSandboxConfig({
        engines: { fake: { kind: "agent", platform: "opencode-sdk", opencodeVersion: 1, bin } },
        defaults: { engine: "fake" },
      });

      const cli = spawn(
        process.execPath,
        [path.join(REPO_ROOT, "src/cli.ts"), "agent", "--engine", "fake", "--prompt", "hi"],
        {
          cwd: REPO_ROOT,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
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
          "the CLI to dispatch to the fake server",
          () => {
            if (cli.exitCode !== null) throw new Error(`the CLI exited ${cli.exitCode} before dispatching\n${output}`);
            return fs.existsSync(requestedFile);
          },
          30_000,
        );
        const port = Number(fs.readFileSync(portFile, "utf8"));
        expect(await listening(port)).toBe(true);

        cli.kill(signal);
        const outcome = await Promise.race([
          ended,
          new Promise((resolve) => setTimeout(() => resolve("still running"), 10_000)),
        ]);
        // Closing the server must not change how the command ends: it still dies by the signal itself.
        expect(outcome).toBe(signal);
        await waitFor("the fake server to be gone", async () => !(await listening(port)));
      } finally {
        if (cli.exitCode === null && cli.signalCode === null) cli.kill("SIGKILL");
        // A server that still accepts connections is still running, so its pid is safe to kill.
        if (fs.existsSync(portFile) && (await listening(Number(fs.readFileSync(portFile, "utf8"))))) {
          try {
            process.kill(Number(fs.readFileSync(pidFile, "utf8")), "SIGKILL");
          } catch {
            // already gone
          }
        }
      }
    },
    90_000,
  );
}
