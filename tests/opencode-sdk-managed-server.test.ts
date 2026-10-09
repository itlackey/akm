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
} from "../src/integrations/harnesses/opencode-sdk/sdk-runner";

const cleanups: Array<() => void> = [];

afterEach(() => {
  __setServeCommand(null);
  __setTestServer(null);
  closeServer();
  for (const fn of cleanups.splice(0)) fn();
});

/** Write a fake `opencode serve` script; returns its argv. */
function fakeServe(opts: {
  ignoreSigterm: boolean;
  pidFile: string;
  handshakeLine?: string | null;
  exitCode?: number;
}): string[] {
  const dir = mkdtempSync(join(tmpdir(), "akm-fake-serve-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, "serve.ts");
  writeFileSync(
    script,
    [
      `require("node:fs").writeFileSync(${JSON.stringify(opts.pidFile)}, String(process.pid));`,
      opts.ignoreSigterm ? `process.on("SIGTERM", () => {});` : "",
      opts.handshakeLine === null
        ? ""
        : `console.log(${JSON.stringify(opts.handshakeLine ?? "opencode server listening on http://127.0.0.1:1")});`,
      typeof opts.exitCode === "number" ? `process.exit(${opts.exitCode});` : `setInterval(() => {}, 1000);`,
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
  const profile = { name: "sdk-test", bin: "unused", args: [], platform: "opencode-sdk", opencodeVersion: 1 };
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
  // escalation), never block on the stubborn child's death: assert the
  // observable result instead of a wall-clock bound (which would race the
  // scheduler under CI load) — the child ignores SIGTERM and only dies via
  // the ~2s SIGKILL escalation polled below, so if closeServer() were
  // blocking on that death, control would not return to this line until
  // the child was already gone. Finding it still alive right here proves
  // the call returned without waiting.
  closeServer();
  expect(pidAlive(pid)).toBe(true);

  // …and the child, which ignores SIGTERM, must die by SIGKILL within the
  // grace window (2s) plus slack.
  expect(await pollUntil(() => !pidAlive(pid), 5_000)).toBe(true);
}, 15_000);

test("a cooperative serve child exits on SIGTERM without needing the escalation", async () => {
  const pidFile = join(mkdtempSync(join(tmpdir(), "akm-serve-pid2-")), "pid");
  cleanups.push(() => rmSync(join(pidFile, ".."), { recursive: true, force: true }));
  __setServeCommand(fakeServe({ ignoreSigterm: false, pidFile }));

  const profile = { name: "sdk-test", bin: "unused", args: [], platform: "opencode-sdk", opencodeVersion: 1 };
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

test("managed serve startup failure: malformed listening line is structured and reaped", async () => {
  const pidFile = join(mkdtempSync(join(tmpdir(), "akm-serve-pid3-")), "pid");
  cleanups.push(() => rmSync(join(pidFile, ".."), { recursive: true, force: true }));
  __setServeCommand(
    fakeServe({
      ignoreSigterm: false,
      pidFile,
      handshakeLine: "opencode server listening on not-a-url",
    }),
  );

  const profile = { name: "sdk-test", bin: "unused", args: [], platform: "opencode-sdk", opencodeVersion: 1 };
  const result = await runOpencodeSdk(profile as never, "ping", { timeoutMs: 3_000 });

  expect(result.ok).toBe(false);
  expect(result.reason).toBe("spawn_failed");
  expect(result.error).toContain("Failed to parse the OpenCode server url");
  const pid = Number(require("node:fs").readFileSync(pidFile, "utf8"));
  expect(await pollUntil(() => !pidAlive(pid), 2_000)).toBe(true);
}, 15_000);

test("managed serve startup failure: early child exit is structured", async () => {
  const pidFile = join(mkdtempSync(join(tmpdir(), "akm-serve-pid4-")), "pid");
  cleanups.push(() => rmSync(join(pidFile, ".."), { recursive: true, force: true }));
  __setServeCommand(fakeServe({ ignoreSigterm: false, pidFile, handshakeLine: null, exitCode: 42 }));

  const profile = { name: "sdk-test", bin: "unused", args: [], platform: "opencode-sdk", opencodeVersion: 1 };
  const result = await runOpencodeSdk(profile as never, "ping", { timeoutMs: 3_000 });

  expect(result.ok).toBe(false);
  expect(result.reason).toBe("spawn_failed");
  expect(result.error).toContain("OpenCode server exited with code 42");
}, 15_000);

test("managed serve startup failure: listening timeout kills a stubborn child", async () => {
  const pidFile = join(mkdtempSync(join(tmpdir(), "akm-serve-pid5-")), "pid");
  cleanups.push(() => rmSync(join(pidFile, ".."), { recursive: true, force: true }));
  __setServeCommand(fakeServe({ ignoreSigterm: true, pidFile, handshakeLine: null }));

  const profile = { name: "sdk-test", bin: "unused", args: [], platform: "opencode-sdk", opencodeVersion: 1 };
  const result = await runOpencodeSdk(profile as never, "ping", { timeoutMs: 3_000 });

  expect(result.ok).toBe(false);
  expect(result.reason).toBe("timeout");
  expect(result.error).toContain("server startup");
  const pid = Number(require("node:fs").readFileSync(pidFile, "utf8"));
  expect(await pollUntil(() => !pidAlive(pid), 4_000)).toBe(true);
}, 15_000);

test("a permission request on the real event stream is rejected, the dispatch completes, and the stream is closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "akm-fake-serve-perm-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const logFile = join(dir, "log.jsonl");
  const script = join(dir, "serve.ts");
  // A minimal OpenCode server: the prompt raises a permission request on the
  // /event stream and answers only once the reply route has been called.
  writeFileSync(
    script,
    `
const fs = require("node:fs");
const log = (o) => fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(o) + "\\n");
let sse; let replied; const repliedP = new Promise((r) => { replied = r; });
const server = Bun.serve({ port: 0, async fetch(req) {
  const url = new URL(req.url);
  if (url.pathname === "/event") {
    log({ event: "subscribed", directory: url.searchParams.get("directory") });
    req.signal.addEventListener("abort", () => log({ event: "closed" }));
    return new Response(new ReadableStream({ start(c) { sse = c; c.enqueue(new TextEncoder().encode('data: {"type":"server.connected","properties":{}}\\n\\n')); } }), { headers: { "content-type": "text/event-stream" } });
  }
  if (req.method === "POST" && url.pathname === "/session") return Response.json({ id: "ses_1" });
  if (req.method === "POST" && url.pathname === "/session/ses_1/message") {
    sse.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ type: "permission.asked", properties: { id: "per_1", sessionID: "ses_1", permission: "external_directory", patterns: ["/tmp/*"] } }) + '\\n\\n'));
    await repliedP;
    return Response.json({ info: {}, parts: [{ type: "text", text: "done" }] });
  }
  if (req.method === "POST" && url.pathname === "/session/ses_1/permissions/per_1") {
    log({ event: "reply", body: await req.json() });
    replied();
    return Response.json(true);
  }
  return new Response("not found", { status: 404 });
} });
console.log("opencode server listening on http://127.0.0.1:" + server.port);
`,
  );
  __setServeCommand([process.execPath, script]);

  const profile = { name: "sdk-test", bin: "unused", args: [], platform: "opencode-sdk", opencodeVersion: 1 };
  const result = await runOpencodeSdk(profile as never, "ping", { timeoutMs: 10_000, cwd: dir });

  expect(result.ok).toBe(true);
  expect(result.stdout).toBe("done");
  expect(result.stderr).toBe("permission requested: external_directory (/tmp/*); auto-rejecting");
  expect(
    await pollUntil(() => {
      try {
        return require("node:fs").readFileSync(logFile, "utf8").includes('"closed"');
      } catch {
        return false;
      }
    }, 3_000),
  ).toBe(true);
  const events = require("node:fs")
    .readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .map((l: string) => JSON.parse(l));
  expect(events).toEqual([
    { event: "subscribed", directory: dir },
    { event: "reply", body: { response: "reject" } },
    { event: "closed" },
  ]);
}, 20_000);
