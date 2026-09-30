// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A `bun test` run must not leave `opencode serve` children behind. The SDK
 * runner caches the servers it starts and only closes them on an explicit
 * `closeServer()` or from its `process.once("exit")` backstop — and `bun test`
 * never emits `exit` when a run ends normally (bun 1.4.1). Any test that
 * dispatched through the real runner therefore orphaned its server (argv
 * `opencode serve --hostname=127.0.0.1 --port=N`, HOME inside
 * `/tmp/akm-test-suite-*`, reparented to init) on every machine that has the
 * `opencode` binary; CI has none, so it never showed there.
 *
 * `tests/_preload.ts` closes the runner's servers in a global `afterAll`. This
 * runs a real `bun test` of a fixture that completes a dispatch against a fake
 * managed server and never closes it, then proves the server was told to stop.
 *
 * Integration-scoped (ORG-03/06): spawns a real `bun test` and its child.
 */

import { test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { makeSandboxDir } from "../_helpers/sandbox";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const SDK_RUNNER = path.join(REPO_ROOT, "src/integrations/harnesses/opencode-sdk/sdk-runner.ts");

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

test("a bun test run closes the opencode servers its tests started", async () => {
  const sandbox = makeSandboxDir("akm-sdk-teardown");
  const pidFile = path.join(sandbox.dir, "serve.pid");
  const termFile = path.join(sandbox.dir, "serve.sigterm");
  const serve = path.join(sandbox.dir, "serve.js");
  const fixture = path.join(sandbox.dir, "start-server.test.ts");
  // A minimal `opencode serve`: registers its SIGTERM handler, answers the
  // three session calls the runner makes, then speaks the handshake. It stays
  // alive until signalled, so a server that is never closed outlives the run.
  fs.writeFileSync(
    serve,
    [
      `const fs = require("node:fs");`,
      `process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(termFile)}, "SIGTERM"); process.exit(0); });`,
      `const server = Bun.serve({`,
      `  hostname: "127.0.0.1",`,
      `  port: 0,`,
      `  fetch(req) {`,
      `    const { pathname } = new URL(req.url);`,
      `    if (pathname.endsWith("/message")) return Response.json({ info: {}, parts: [{ type: "text", text: "pong" }] });`,
      `    return Response.json(pathname === "/session" ? { id: "s1" } : true);`,
      `  },`,
      `});`,
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      `console.log("opencode server listening on http://127.0.0.1:" + server.port);`,
    ].join("\n"),
  );
  // Completes a dispatch through the real spawn path and never closes the server.
  fs.writeFileSync(
    fixture,
    [
      `import { expect, test } from "bun:test";`,
      `import { __setServeCommand, runOpencodeSdk } from ${JSON.stringify(SDK_RUNNER)};`,
      `test("completes a dispatch and leaves the server cached", async () => {`,
      `  __setServeCommand([process.execPath, ${JSON.stringify(serve)}]);`,
      `  const profile = { name: "sdk-teardown", bin: "unused", args: [], platform: "opencode-sdk" };`,
      `  const result = await runOpencodeSdk(profile as never, "ping", { timeoutMs: 10_000 });`,
      `  expect(result.ok).toBe(true);`,
      `});`,
    ].join("\n"),
  );

  try {
    // cwd = repo root so the child run loads bunfig.toml and its preload, exactly as the suite does.
    const run = Bun.spawnSync([process.execPath, "test", fixture], { cwd: REPO_ROOT, timeout: 30_000 });
    if (run.exitCode !== 0) {
      throw new Error(`fixture run exited ${run.exitCode}\n${run.stdout.toString()}\n${run.stderr.toString()}`);
    }
    await waitForFile(termFile);
  } finally {
    // A server that never saw SIGTERM is still running (only SIGTERM or SIGKILL ends it), so its pid is safe to
    // kill; one that did has exited or is exiting.
    if (fs.existsSync(pidFile) && !fs.existsSync(termFile)) {
      try {
        process.kill(Number(fs.readFileSync(pidFile, "utf8")), "SIGKILL");
      } catch {
        // already gone
      }
    }
    sandbox.cleanup();
  }
}, 60_000);
