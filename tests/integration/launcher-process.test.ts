// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The published launcher (`scripts/node-runtime/akm`) on Linux and macOS replaces itself with akm (`process.execve`):
 * one process, so the signals, the process group and the exit status are akm's own and nothing is forwarded. These
 * tests run the REAL launcher against a fake `cli.js` and signal the launcher's own pid. On Windows the launcher runs akm as a
 * child and mirrors its end; that path is exercised with the platform reported as `win32`.
 *
 * Integration-scoped: spawns real child processes.
 */

import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { makeSandboxDir } from "../_helpers/sandbox";

function launcherFixture(root: string): { launcher: string; readyFile: string; signalFile: string } {
  const dist = path.join(root, "package", "dist");
  const launcher = path.join(dist, "akm");
  const readyFile = path.join(root, "ready.txt");
  const signalFile = path.join(root, "signal.json");
  fs.mkdirSync(dist, { recursive: true });
  fs.copyFileSync(path.resolve("scripts/node-runtime/akm"), launcher);
  // A fake child entry: registers its handler, then announces it is alive (readyFile), so the test
  // never signals a child with no handler yet. The handler records the signal and the child's view of
  // AKM_LAUNCHER_PID, then exits 0. Otherwise it stays alive until signaled or killed.
  fs.writeFileSync(
    path.join(dist, "cli.js"),
    [
      'import fs from "node:fs";',
      'process.once("SIGTERM", () => {',
      `  fs.writeFileSync(${JSON.stringify(signalFile)}, JSON.stringify({ signal: "SIGTERM", launcherPid: process.env.AKM_LAUNCHER_PID }));`,
      "  process.exit(0);",
      "});",
      `fs.writeFileSync(${JSON.stringify(readyFile)}, String(process.pid));`,
      "await new Promise(() => {});",
    ].join("\n"),
  );
  return { launcher, readyFile, signalFile };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const posix = process.platform === "linux" || process.platform === "darwin";

function exited(proc: ReturnType<typeof spawn>) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    proc.once("exit", (code, signal) => resolve({ code, signal })),
  );
}

describe.skipIf(!posix)("the launcher replaces itself with akm", () => {
  test("the child is the launcher's own process: same pid, no AKM_LAUNCHER_PID, SIGTERM reaches it once", async () => {
    const sandbox = makeSandboxDir("akm-launcher-execve-");
    try {
      const fixture = launcherFixture(sandbox.dir);
      const launcherProc = spawn(process.execPath, [fixture.launcher, "sentinel"], {
        stdio: ["ignore", "ignore", "ignore"],
        env: process.env,
      });
      await waitFor(() => fs.existsSync(fixture.readyFile));
      expect(fs.readFileSync(fixture.readyFile, "utf8")).toBe(String(launcherProc.pid));
      launcherProc.kill("SIGTERM");
      expect(await exited(launcherProc)).toEqual({ code: 0, signal: null });
      const received = JSON.parse(fs.readFileSync(fixture.signalFile, "utf8")) as {
        signal: string;
        launcherPid: string | undefined;
      };
      expect(received.signal).toBe("SIGTERM");
      expect(received.launcherPid).toBeUndefined();
    } finally {
      sandbox.cleanup();
    }
  }, 15000);

  test("SIGINT to the whole process group reaches the child once, so its graceful shutdown completes", async () => {
    const sandbox = makeSandboxDir("akm-launcher-signal-group-");
    try {
      const dist = path.join(sandbox.dir, "package", "dist");
      const launcher = path.join(dist, "akm");
      const readyFile = path.join(sandbox.dir, "ready.txt");
      const doneFile = path.join(sandbox.dir, "done.txt");
      fs.mkdirSync(dist, { recursive: true });
      fs.copyFileSync(path.resolve("scripts/node-runtime/akm"), launcher);
      fs.writeFileSync(
        path.join(dist, "cli.js"),
        [
          'import fs from "node:fs";',
          'process.once("SIGINT", () => {',
          `  setTimeout(() => { fs.writeFileSync(${JSON.stringify(doneFile)}, "1"); process.exit(0); }, 300);`,
          "});",
          `fs.writeFileSync(${JSON.stringify(readyFile)}, String(process.pid));`,
          "await new Promise(() => {});",
        ].join("\n"),
      );
      const launcherProc = spawn(process.execPath, [launcher, "sentinel"], {
        stdio: ["ignore", "ignore", "ignore"],
        env: process.env,
        detached: true,
      });
      await waitFor(() => fs.existsSync(readyFile));
      process.kill(-(launcherProc.pid as number), "SIGINT");
      expect(await exited(launcherProc)).toEqual({ code: 0, signal: null });
      expect(fs.existsSync(doneFile)).toBe(true);
    } finally {
      sandbox.cleanup();
    }
  }, 15000);

  test("a child with no handler dies of the signal itself", async () => {
    const sandbox = makeSandboxDir("akm-launcher-signal-nohandler-");
    try {
      const dist = path.join(sandbox.dir, "package", "dist");
      const launcher = path.join(dist, "akm");
      const readyFile = path.join(sandbox.dir, "ready.txt");
      fs.mkdirSync(dist, { recursive: true });
      fs.copyFileSync(path.resolve("scripts/node-runtime/akm"), launcher);
      fs.writeFileSync(
        path.join(dist, "cli.js"),
        [
          'import fs from "node:fs";',
          `fs.writeFileSync(${JSON.stringify(readyFile)}, String(process.pid));`,
          "await new Promise(() => {});",
        ].join("\n"),
      );
      const launcherProc = spawn(process.execPath, [launcher, "sentinel"], { stdio: ["ignore", "ignore", "ignore"] });
      await waitFor(() => fs.existsSync(readyFile));
      launcherProc.kill("SIGTERM");
      expect((await exited(launcherProc)).signal).toBe("SIGTERM");
    } finally {
      sandbox.cleanup();
    }
  }, 15000);

  test("a child's exit status is the launcher's", async () => {
    const sandbox = makeSandboxDir("akm-launcher-status-");
    try {
      const dist = path.join(sandbox.dir, "package", "dist");
      fs.mkdirSync(dist, { recursive: true });
      fs.copyFileSync(path.resolve("scripts/node-runtime/akm"), path.join(dist, "akm"));
      fs.writeFileSync(path.join(dist, "cli.js"), "process.exit(3);\n");
      const launcherProc = spawn(process.execPath, [path.join(dist, "akm")], { stdio: "ignore" });
      expect(await exited(launcherProc)).toEqual({ code: 3, signal: null });
    } finally {
      sandbox.cleanup();
    }
  }, 15000);
});

describe("on Windows the launcher runs akm as a child and mirrors its end", () => {
  test("it names itself in AKM_LAUNCHER_PID and passes the exit status through", async () => {
    const sandbox = makeSandboxDir("akm-launcher-win32-");
    try {
      const dist = path.join(sandbox.dir, "package", "dist");
      fs.mkdirSync(dist, { recursive: true });
      const launcher = path.join(dist, "akm");
      fs.copyFileSync(path.resolve("scripts/node-runtime/akm"), launcher);
      const out = path.join(sandbox.dir, "pid.txt");
      fs.writeFileSync(
        path.join(dist, "cli.js"),
        [
          'import fs from "node:fs";',
          `fs.writeFileSync(${JSON.stringify(out)}, [process.pid, process.env.AKM_LAUNCHER_PID].join(" "));`,
          "process.exit(5);",
        ].join("\n"),
      );
      const proc = spawn(
        process.execPath,
        [
          "-e",
          `Object.defineProperty(process, "platform", { value: "win32" }); await import(${JSON.stringify(`file://${launcher}`)});`,
        ],
        { stdio: "ignore" },
      );
      expect(await exited(proc)).toEqual({ code: 5, signal: null });
      const [childPid, launcherPid] = fs.readFileSync(out, "utf8").split(" ");
      expect(childPid).not.toBe(launcherPid);
      expect(Number(launcherPid)).toBe(proc.pid as number);
    } finally {
      sandbox.cleanup();
    }
  }, 15000);
});
