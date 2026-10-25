// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Killing a dispatching `akm agent` command must not leave the CLI harness it
 * spawned (and that harness's own children) running. The CLI engines
 * (`opencode run`, `claude`, `codex`) are spawned in their own process group by
 * the managed-subprocess primitive; a timeout reaped that group, but a SIGTERM
 * or SIGINT to akm itself killed akm and left the group behind. This runs the
 * real CLI against a fake harness that starts a grandchild and never finishes,
 * signals the CLI while it is blocked in dispatch, and proves neither process
 * survives and the CLI still ended by the signal itself.
 *
 * Integration-scoped (ORG-03/06): spawns the real CLI and its children.
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
  fakeDir = makeSandboxDir("akm-cli-signal");
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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // A zombie still answers signal 0; it is not running.
  try {
    return !/^[ZX]/.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1] ?? "");
  } catch {
    return false;
  }
}

// Every CLI harness shares the one spawn path; OpenCode gets the full signal matrix, Claude and Codex one case each.
const CASES: ReadonlyArray<{
  platform: "opencode" | "claude" | "codex";
  signal: "SIGTERM" | "SIGINT";
  ignoresTerm: boolean;
}> = [
  { platform: "opencode", signal: "SIGTERM", ignoresTerm: false },
  { platform: "opencode", signal: "SIGINT", ignoresTerm: false },
  { platform: "opencode", signal: "SIGTERM", ignoresTerm: true },
  { platform: "claude", signal: "SIGTERM", ignoresTerm: false },
  { platform: "codex", signal: "SIGTERM", ignoresTerm: false },
];

for (const { platform, signal, ignoresTerm } of CASES) {
  test.skipIf(process.platform === "win32")(
    `a dispatching command killed by ${signal} leaves no ${platform} CLI process behind${ignoresTerm ? " (harness ignores SIGTERM)" : ""}`,
    async () => {
      const leaderPidFile = path.join(fakeDir.dir, "leader.pid");
      const childPidFile = path.join(fakeDir.dir, "child.pid");
      const bin = path.join(fakeDir.dir, platform);
      // A fake harness CLI: answers --version, otherwise records its pid, starts a grandchild, and never finishes.
      fs.writeFileSync(
        bin,
        [
          "#!/bin/sh",
          `[ "$1" = "--version" ] && { echo 1.18.34; exit 0; }`,
          ignoresTerm ? `trap '' TERM` : "",
          `echo $$ > ${JSON.stringify(leaderPidFile)}`,
          `sleep 300 &`,
          `echo $! > ${JSON.stringify(childPidFile)}`,
          `while :; do sleep 1; done`,
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      writeSandboxConfig({
        harnesses: { fake: { platform, bin } },
      });

      const cli = spawn(
        process.execPath,
        [path.join(REPO_ROOT, "src/cli.ts"), "agent", "--harness", "fake", "--prompt", "hi"],
        { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] },
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

      let leader = 0;
      let child = 0;
      try {
        await waitFor(
          "the CLI to dispatch to the fake harness",
          () => {
            if (cli.exitCode !== null) throw new Error(`the CLI exited ${cli.exitCode} before dispatching\n${output}`);
            return fs.existsSync(childPidFile) && fs.readFileSync(childPidFile, "utf8").trim() !== "";
          },
          30_000,
        );
        leader = Number(fs.readFileSync(leaderPidFile, "utf8"));
        child = Number(fs.readFileSync(childPidFile, "utf8"));
        expect(alive(leader)).toBe(true);
        expect(alive(child)).toBe(true);

        cli.kill(signal);
        const outcome = await Promise.race([
          ended,
          new Promise((resolve) => setTimeout(() => resolve("still running"), 20_000)),
        ]);
        // Cleaning up must not change how the command ends: it still dies by the signal itself.
        expect(outcome).toBe(signal);
        await waitFor("the harness and its child to be gone", () => !alive(leader) && !alive(child), 10_000);
      } finally {
        if (cli.exitCode === null && cli.signalCode === null) cli.kill("SIGKILL");
        for (const pid of [leader, child]) {
          if (pid > 0 && alive(pid)) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              // already gone
            }
          }
        }
      }
    },
    90_000,
  );
}
