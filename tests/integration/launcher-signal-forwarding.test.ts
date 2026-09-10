// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #956: the published launcher (`scripts/node-runtime/akm`) used
 * to `spawn` its Bun/Node child with no signal handling at all — a
 * `kill <launcher-pid>` (a scheduler timeout, a supervisor, an operator) left
 * the child running as an orphan, still holding whatever lock it had. This
 * spawns the REAL launcher script against a fake child entry (mirrors
 * `tests/integration/scheduler-context-launcher.test.ts`'s fixture pattern)
 * and sends SIGTERM only to the launcher's own pid (no shared foreground
 * process group here, since the test spawns it directly) — so a passing
 * assertion proves the launcher's own forwarding code moved the signal, not
 * incidental OS group delivery.
 *
 * Integration-scoped (ORG-03/06): spawns real child processes.
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
  // A fake child entry: announces it is alive (readyFile), then records the
  // FIRST signal it receives and its own view of the launcher pid (proving
  // AKM_LAUNCHER_PID reached it) before exiting 0. Never resolves on its own
  // otherwise, so it stays alive until signaled or killed.
  fs.writeFileSync(
    path.join(dist, "cli.js"),
    [
      'import fs from "node:fs";',
      `fs.writeFileSync(${JSON.stringify(readyFile)}, String(process.pid));`,
      'process.once("SIGTERM", () => {',
      `  fs.writeFileSync(${JSON.stringify(signalFile)}, JSON.stringify({ signal: "SIGTERM", launcherPid: process.env.AKM_LAUNCHER_PID }));`,
      "  process.exit(0);",
      "});",
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

describe("launcher signal forwarding (#956)", () => {
  test("SIGTERM to the launcher forwards to the child, which the launcher then exits alongside", async () => {
    const sandbox = makeSandboxDir("akm-launcher-signal-");
    try {
      const fixture = launcherFixture(sandbox.dir);
      const launcherProc = spawn(process.execPath, [fixture.launcher, "sentinel"], {
        stdio: ["ignore", "ignore", "ignore"],
        env: process.env,
      });

      await waitFor(() => fs.existsSync(fixture.readyFile));
      // Sent only to the launcher's own pid — no shared foreground process
      // group here, so nothing but the launcher's own forwarding code can
      // move this to the child.
      launcherProc.kill("SIGTERM");

      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        launcherProc.once("exit", (code, signal) => resolve({ code, signal }));
      });

      // The child exited cleanly (0) once signaled, so the launcher reports
      // that same code rather than a signal of its own.
      expect(exit.code).toBe(0);
      expect(exit.signal).toBeNull();

      await waitFor(() => fs.existsSync(fixture.signalFile));
      const received = JSON.parse(fs.readFileSync(fixture.signalFile, "utf8")) as {
        signal: string;
        launcherPid: string | undefined;
      };
      expect(received.signal).toBe("SIGTERM");
      expect(received.launcherPid).toBe(String(launcherProc.pid));
    } finally {
      sandbox.cleanup();
    }
  }, 15000);

  test("SIGINT to the whole foreground-style process group does not skip the child's graceful shutdown", async () => {
    // Reproduces the terminal scenario directly: the launcher is spawned as
    // the leader of its OWN new process group (`detached: true` from here,
    // standing in for a shell putting the launcher in the terminal's
    // foreground group) and, per the #956 fix, spawns ITS OWN child into a
    // separate process group in turn. A negative-pid kill targets the whole
    // group — mechanically what a terminal's Ctrl-C does — and lands only on
    // the launcher's group. Before the fix, the child shared that group and
    // got the raw broadcast directly AND the launcher's forwarded copy
    // microseconds later; the child's `process.once(SIGINT, ...)` handler had
    // already unregistered for the first copy, so the second fell through to
    // the runtime's default disposition and killed it before its (here,
    // deliberately async) graceful-shutdown cleanup — releasing a lock,
    // finishing in-flight work — ever completed.
    const sandbox = makeSandboxDir("akm-launcher-signal-group-");
    try {
      const dist = path.join(sandbox.dir, "package", "dist");
      const launcher = path.join(dist, "akm");
      const readyFile = path.join(sandbox.dir, "ready.txt");
      const startedFile = path.join(sandbox.dir, "started.txt");
      const doneFile = path.join(sandbox.dir, "done.txt");
      fs.mkdirSync(dist, { recursive: true });
      fs.copyFileSync(path.resolve("scripts/node-runtime/akm"), launcher);
      // A fake child entry whose SIGINT handler mimics a real graceful
      // shutdown with async cleanup: it records that shutdown started, waits
      // (standing in for e.g. releasing the rebuild lock), THEN writes a
      // completion marker before exiting. A second signal landing on top
      // would kill it via the runtime's default disposition between the two
      // markers — so `started.txt` existing without `done.txt` means the
      // graceful shutdown got cut short.
      fs.writeFileSync(
        path.join(dist, "cli.js"),
        [
          'import fs from "node:fs";',
          `fs.writeFileSync(${JSON.stringify(readyFile)}, String(process.pid));`,
          'process.once("SIGINT", () => {',
          `  fs.writeFileSync(${JSON.stringify(startedFile)}, "1");`,
          "  setTimeout(() => {",
          `    fs.writeFileSync(${JSON.stringify(doneFile)}, "1");`,
          "    process.exit(0);",
          "  }, 300);",
          "});",
          "await new Promise(() => {});",
        ].join("\n"),
      );

      const launcherProc = spawn(process.execPath, [launcher, "sentinel"], {
        stdio: ["ignore", "ignore", "ignore"],
        env: process.env,
        detached: true,
      });

      await waitFor(() => fs.existsSync(readyFile));
      // A negative pid targets the whole process group the launcher leads —
      // the same mechanism a terminal uses for Ctrl-C.
      process.kill(-(launcherProc.pid as number), "SIGINT");

      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        launcherProc.once("exit", (code, signal) => resolve({ code, signal }));
      });
      expect(exit.code).toBe(0);
      expect(exit.signal).toBeNull();

      await waitFor(() => fs.existsSync(startedFile));
      await waitFor(() => fs.existsSync(doneFile));
    } finally {
      sandbox.cleanup();
    }
  }, 15000);

  test("launcher exits with the forwarded signal, not code 0, when the child has no handler of its own", async () => {
    // Round-2 regression: the forwarding listeners were originally
    // registered with `process.on`, which (per Node/Bun) suppresses a
    // signal's default process-terminating disposition for as long as ANY
    // listener stays registered for it — including at the
    // `process.kill(process.pid, result.signal)` re-raise this launcher
    // does after the child exits. That swallowed the re-raise and made the
    // launcher always report a clean exit 0, even though the child actually
    // died from the forwarded signal. This fixture's child registers NO
    // signal handler of its own (the ordinary case: search, curate,
    // remember, health, etc. none install a SIGTERM listener), so it dies
    // directly from the forwarded SIGTERM's default disposition, and the
    // launcher must reflect that back rather than falling through to 0.
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

      const launcherProc = spawn(process.execPath, [launcher, "sentinel"], {
        stdio: ["ignore", "ignore", "ignore"],
        env: process.env,
      });

      await waitFor(() => fs.existsSync(readyFile));
      launcherProc.kill("SIGTERM");

      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        launcherProc.once("exit", (code, signal) => resolve({ code, signal }));
      });

      // Before the `.once` fix this was `{ code: 0, signal: null }` — a
      // false clean exit — even though the child was actually killed by the
      // forwarded SIGTERM.
      expect(exit.signal).toBe("SIGTERM");
    } finally {
      sandbox.cleanup();
    }
  }, 15000);
});
