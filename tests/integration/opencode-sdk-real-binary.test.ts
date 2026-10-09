// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The OpenCode wire adapters against REAL `opencode serve` binaries (#1049).
 *
 * Integration-scoped (ORG-03/06): spawns real server processes. Gated on
 * `AKM_OPENCODE_V2_BIN` (an OpenCode 2 binary, qualified at 2.0.26) and
 * `AKM_OPENCODE_V1_BIN` (OpenCode 1, qualified at 1.18.34); each suite skips
 * cleanly when its variable is unset, and the cross-major checks need both.
 * No model is needed: nothing here waits for a model answer. A run with no
 * credentials ends in a provider failure or in the abort the test sends, and the
 * assertions are on the session, the permission and abort endpoints, the
 * readiness and authentication handshake, and cleanup (no leaked child).
 *
 *   AKM_OPENCODE_V2_BIN=/path/to/opencode2 AKM_OPENCODE_V1_BIN=/path/to/opencode1 \
 *     bun test tests/integration/opencode-sdk-real-binary.test.ts
 *
 * The suite preload already points HOME and the XDG_* directories at a
 * per-process sandbox, which the spawned servers inherit.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentProfile } from "../../src/integrations/agent/profiles";
import { closeServer, runOpencodeSdk } from "../../src/integrations/harnesses/opencode-sdk/sdk-runner";
import { V1_ADAPTER } from "../../src/integrations/harnesses/opencode-sdk/v1-adapter";
import { V2_ADAPTER } from "../../src/integrations/harnesses/opencode-sdk/v2-adapter";
import type { OpencodeWireAdapter, WireEvent } from "../../src/integrations/harnesses/opencode-sdk/wire";

const V1_BIN = process.env.AKM_OPENCODE_V1_BIN;
const V2_BIN = process.env.AKM_OPENCODE_V2_BIN;

const profileFor = (bin: string, opencodeVersion: 1 | 2): AgentProfile => ({
  name: "opencode-sdk",
  bin,
  args: [],
  stdio: "captured",
  envPassthrough: [],
  parseOutput: "text",
  opencodeVersion,
});

const children: ChildProcess[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await closeServer();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

/** Direct children of this test process (the managed `opencode serve` servers), by pid. */
function childPids(): number[] | null {
  const out = spawnSync("pgrep", ["-P", String(process.pid)], { encoding: "utf8" });
  if (out.error || out.status === 2) return null;
  return out.stdout.split("\n").filter(Boolean).map(Number);
}

const SERVER_ENV_NAMES = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
];

/**
 * A fresh HOME and XDG_* tree. The majors keep incompatible databases under the same
 * directories (OpenCode 1 refuses OpenCode 2's), so each server gets its own.
 */
function isolatedHome(): Record<string, string> {
  const root = tempDir("akm-oc-home-");
  const dirs = {
    HOME: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: path.join(root, "state"),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  return dirs;
}

/** Start a private server with `adapter` the way the runner does, and read its readiness line. */
async function startServer(adapter: OpencodeWireAdapter, bin: string) {
  const env: Record<string, string> = {};
  for (const name of SERVER_ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  const auth = adapter.authorize();
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const argv = adapter.serveArgv(bin, port);
  const proc = spawn(argv[0] as string, argv.slice(1), {
    cwd: tempDir("akm-oc-serve-"),
    env: { ...env, ...isolatedHome(), ...auth.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(proc);
  const verdict = await new Promise<ReturnType<OpencodeWireAdapter["readiness"]>>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`no readiness line within 20s; output: ${output}`)), 20_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      for (const line of output.split("\n")) {
        const v = adapter.readiness(line);
        if (v) {
          clearTimeout(timer);
          resolve(v);
          return;
        }
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", (c: Buffer) => {
      output += c.toString();
    });
    proc.once("exit", () => reject(new Error(`server exited early; output: ${output}`)));
  });
  return { proc, verdict, auth, port };
}

/** Collect decoded events of a subscription until `stop`. */
async function watch(adapter: OpencodeWireAdapter, client: unknown, directory: string) {
  const controller = new AbortController();
  const events: WireEvent[] = [];
  const stream = await adapter.subscribe(client, { directory }, controller.signal);
  const done = (async () => {
    for await (const raw of stream) {
      const event = adapter.decodeEvent(raw);
      if (event) events.push(event);
    }
  })().catch(() => {});
  return {
    events,
    async stop() {
      controller.abort();
      await done;
    },
  };
}

describe.skipIf(!V2_BIN)("OpenCode 2 adapter on the real binary (AKM_OPENCODE_V2_BIN)", () => {
  test("readiness line, akm-chosen password, session in its directory, permission rejection, abort, cleanup", async () => {
    const bin = V2_BIN as string;
    const directory = tempDir("akm-oc2-work-");
    const { proc, verdict, auth } = await startServer(V2_ADAPTER, bin);
    expect(verdict).toBeDefined();
    if (!verdict || "error" in verdict) throw new Error(`unexpected readiness verdict: ${JSON.stringify(verdict)}`);

    // The password is the one akm chose: a request without it is refused.
    expect((await fetch(new URL("/api/server/info", verdict.url))).status).toBe(401);

    const client = await V2_ADAPTER.connect(verdict.url, auth.credentials);
    const sessionId = await V2_ADAPTER.createSession(client, { directory, tools: { bash: false } });
    expect(sessionId).toMatch(/^ses_/);

    const watcher = await watch(V2_ADAPTER, client, directory);
    // The sub-session announcement and the permission request, as the runner sees them.
    const typed = client as import("@opencode/client").OpenCodeClient;
    const session = await typed.session.get({ sessionID: sessionId as string });
    expect(session.location?.directory).toBe(directory);
    expect(session.permissions).toEqual([{ action: "bash", resource: "*", effect: "deny" }]);

    // A session whose rules ask about external directories, as OpenCode's default agent does.
    const asking = await typed.session.create({
      title: "akm",
      location: { directory },
      permissions: [{ action: "external_directory", resource: "*", effect: "ask" }],
    });
    const request = await typed.permission.create({
      sessionID: asking.id,
      action: "external_directory",
      resources: ["/etc/*"],
    });
    expect(request.effect).toBe("ask");
    expect(await until(() => watcher.events.some((e) => e.kind === "permission"), 10_000)).toBe(true);
    const asked = watcher.events.find((e) => e.kind === "permission") as Extract<WireEvent, { kind: "permission" }>;
    expect(asked.sessionId).toBe(asking.id);
    expect(asked.requestId).toBe(request.id);
    expect(asked.description).toContain("external_directory (/etc/*)");
    expect(await typed.permission.list({ sessionID: asking.id })).toHaveLength(1);

    await V2_ADAPTER.rejectPermission(client, asked, { directory });
    // The request is answered: nothing is left pending.
    let pending = await typed.permission.list({ sessionID: asking.id });
    for (let i = 0; i < 40 && pending.length > 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
      pending = await typed.permission.list({ sessionID: asking.id });
    }
    expect(pending).toEqual([]);

    // Abort of an idle session is a harmless no-op that never rejects.
    V2_ADAPTER.abort(client, sessionId as string, { directory });
    await watcher.stop();

    // Cleanup: closing the child ends it.
    const pid = proc.pid as number;
    proc.kill("SIGTERM");
    expect(await until(() => !pidAlive(pid), 10_000)).toBe(true);
  }, 60_000);

  test("a dispatch ends with a kept session and no leaked server", async () => {
    const before = new Set(childPids() ?? []);
    const controller = new AbortController();
    const running = runOpencodeSdk(profileFor(V2_BIN as string, 2), "Reply with the word ok.", {
      cwd: tempDir("akm-oc2-run-"),
      signal: controller.signal,
      timeoutMs: 20_000,
      env: isolatedHome(),
    });
    // Stop the run ourselves after a moment when the provider has not failed it yet; no model is needed either way.
    const timer = setTimeout(() => controller.abort(), 3_000);
    const res = await running;
    clearTimeout(timer);

    expect(res.reason).not.toBe("spawn_failed");
    expect(res.sessionId).toMatch(/^ses_/);
    if (!res.ok) expect(["aborted", "timeout", "non_zero_exit", "llm_rate_limit"]).toContain(res.reason as string);

    await closeServer();
    const leaked = childPids();
    if (leaked) {
      expect(await until(() => (childPids() ?? []).every((pid) => before.has(pid)), 10_000)).toBe(true);
    }
  }, 60_000);

  test("a V1 binary under the V2 adapter fails clearly and names opencodeVersion", async () => {
    if (!V1_BIN) return;
    const res = await runOpencodeSdk(profileFor(V1_BIN, 2), "p", { timeoutMs: 20_000, env: isolatedHome() });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("spawn_failed");
    expect(res.error).toContain('"opencodeVersion": 1');
  }, 40_000);

  test("a V2 binary under the V1 adapter fails clearly and names opencodeVersion", async () => {
    const res = await runOpencodeSdk(profileFor(V2_BIN as string, 1), "p", { timeoutMs: 20_000, env: isolatedHome() });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("spawn_failed");
    expect(res.error).toContain("OpenCode 2");
    expect(res.error).toContain("opencodeVersion");
  }, 40_000);
});

describe.skipIf(!V1_BIN)("OpenCode 1 adapter on the real binary (AKM_OPENCODE_V1_BIN)", () => {
  test("readiness line, session in its directory, event stream, abort, cleanup", async () => {
    const bin = V1_BIN as string;
    const directory = tempDir("akm-oc1-work-");
    const { proc, verdict } = await startServer(V1_ADAPTER, bin);
    if (!verdict || "error" in verdict) throw new Error(`unexpected readiness verdict: ${JSON.stringify(verdict)}`);

    const client = await V1_ADAPTER.connect(verdict.url, undefined);
    const sessionId = await V1_ADAPTER.createSession(client, { directory });
    expect(sessionId).toMatch(/^ses_/);

    // The event stream opens, and a session created in the directory announces itself on it.
    const watcher = await watch(V1_ADAPTER, client, directory);
    const second = await V1_ADAPTER.createSession(client, { directory });
    expect(await until(() => watcher.events.some((e) => e.kind === "session" && e.id === second), 10_000)).toBe(true);

    V1_ADAPTER.abort(client, sessionId as string, { directory });
    await watcher.stop();

    const pid = proc.pid as number;
    proc.kill("SIGTERM");
    expect(await until(() => !pidAlive(pid), 10_000)).toBe(true);
  }, 60_000);

  test("a dispatch ends with a kept session and no leaked server", async () => {
    const before = new Set(childPids() ?? []);
    const controller = new AbortController();
    const running = runOpencodeSdk(profileFor(V1_BIN as string, 1), "Reply with the word ok.", {
      cwd: tempDir("akm-oc1-run-"),
      signal: controller.signal,
      timeoutMs: 20_000,
      env: isolatedHome(),
    });
    const timer = setTimeout(() => controller.abort(), 3_000);
    const res = await running;
    clearTimeout(timer);

    expect(res.reason).not.toBe("spawn_failed");
    expect(res.sessionId).toMatch(/^ses_/);

    await closeServer();
    if (childPids()) {
      expect(await until(() => (childPids() ?? []).every((pid) => before.has(pid)), 10_000)).toBe(true);
    }
  }, 60_000);
});
