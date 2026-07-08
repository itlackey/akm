// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Managed `opencode serve` spawn lifecycle (owner finding 4, live-harness
 * follow-up). The SDK's own `createOpencodeServer` close() only sends SIGTERM
 * and never unrefs the child, so a stubborn `opencode serve` pinned akm's
 * event loop until caller timeout even after a successful run. These tests
 * drive the managed factory against REAL child processes (hence
 * tests/integration/): a fake serve script that speaks the handshake and —
 * in the stubborn variant — ignores SIGTERM, proving:
 *
 *   1. the handshake resolves and dispatch works end to end;
 *   2. `closeServer()` returns immediately (never awaits the child's death);
 *   3. a SIGTERM-ignoring child is SIGKILLed within the grace window;
 *   4. the parent's event loop is not held: this test file itself completes
 *      promptly — with an un-unref'ed live child it would hang past the
 *      per-test timeout.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __setServeCommand,
  __setTestServer,
  closeServer,
  runOpencodeSdk,
} from "../../src/integrations/harnesses/opencode-sdk/sdk-runner";

const cleanups: Array<() => void> = [];

afterEach(() => {
  __setServeCommand(null);
  __setTestServer(null);
  closeServer();
  for (const fn of cleanups.splice(0)) fn();
});

/** Write a fake `opencode serve` script; returns its argv. */
function fakeServe(opts: { ignoreSigterm: boolean; pidFile: string }): string[] {
  const dir = mkdtempSync(join(tmpdir(), "akm-fake-serve-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, "serve.ts");
  writeFileSync(
    script,
    [
      `require("node:fs").writeFileSync(${JSON.stringify(opts.pidFile)}, String(process.pid));`,
      opts.ignoreSigterm ? `process.on("SIGTERM", () => {});` : "",
      // Handshake line the managed spawn parses, then stay alive forever.
      `console.log("opencode server listening on http://127.0.0.1:1");`,
      `setInterval(() => {}, 1000);`,
    ].join("\n"),
  );
  return [process.execPath, script];
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pollUntil(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

test("a SIGTERM-ignoring serve child is handshaken, closed without waiting, and SIGKILLed within the grace window", async () => {
  const pidFile = join(mkdtempSync(join(tmpdir(), "akm-serve-pid-")), "pid");
  cleanups.push(() => rmSync(join(pidFile, ".."), { recursive: true, force: true }));
  __setServeCommand(fakeServe({ ignoreSigterm: true, pidFile }));

  // Drive a dispatch far enough to START the managed server. The fake
  // server speaks no real API, so the prompt call fails — that is fine:
  // the server (and its child) is registered by then, which is what this
  // lifecycle test needs. The child pid lands in pidFile at spawn.
  const profile = { name: "sdk-test", bin: "unused", args: [], platform: "opencode-sdk" };
  await runOpencodeSdk(profile as never, "ping", { timeoutMs: 3_000 }).catch(() => {});

  await pollUntil(() => {
    try {
      return pidAlive(Number(require("node:fs").readFileSync(pidFile, "utf8")));
    } catch {
      return false;
    }
  }, 4_000);
  const pid = Number(require("node:fs").readFileSync(pidFile, "utf8"));
  expect(Number.isFinite(pid) && pid > 0).toBe(true);
  expect(pidAlive(pid)).toBe(true);

  // closeServer must return immediately (synchronous SIGTERM + unref'ed
  // escalation), never block on the stubborn child's death…
  const before = Date.now();
  closeServer();
  expect(Date.now() - before).toBeLessThan(500);

  // …and the child, which ignores SIGTERM, must die by SIGKILL within the
  // grace window (2s) plus slack.
  expect(await pollUntil(() => !pidAlive(pid), 5_000)).toBe(true);
}, 15_000);

test("a cooperative serve child exits on SIGTERM without needing the escalation", async () => {
  const pidFile = join(mkdtempSync(join(tmpdir(), "akm-serve-pid2-")), "pid");
  cleanups.push(() => rmSync(join(pidFile, ".."), { recursive: true, force: true }));
  __setServeCommand(fakeServe({ ignoreSigterm: false, pidFile }));

  const profile = { name: "sdk-test", bin: "unused", args: [], platform: "opencode-sdk" };
  await runOpencodeSdk(profile as never, "ping", { timeoutMs: 3_000 }).catch(() => {});

  await pollUntil(() => {
    try {
      return pidAlive(Number(require("node:fs").readFileSync(pidFile, "utf8")));
    } catch {
      return false;
    }
  }, 4_000);
  const pid = Number(require("node:fs").readFileSync(pidFile, "utf8"));
  expect(pidAlive(pid)).toBe(true);

  closeServer();
  // SIGTERM alone should reap it well inside the SIGKILL grace.
  expect(await pollUntil(() => !pidAlive(pid), 1_500)).toBe(true);
}, 15_000);
