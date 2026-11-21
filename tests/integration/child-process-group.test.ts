// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * What a script akm runs is stopped by `--timeout` and by a signal to akm.
 *
 * Without a controlling terminal (cron, systemd, CI) the script runs in its own session and group, so the
 * whole tree stops. On a terminal it stays in akm's group: Ctrl-C reaches it from the terminal, SIGTERM to
 * akm is forwarded, and it can read `/dev/tty`. Real subprocess tests: the signals and the terminal are
 * the subject.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type Cleanup, makeSandboxDir, sandboxStashDir, writeSandboxConfig } from "../_helpers/sandbox";

const CLI = path.resolve(import.meta.dir, "../../src/cli.ts");
const posix = process.platform === "linux";
const hasScript = posix && spawnSync("script", ["--version"]).status === 0;

let cleanups: Cleanup[] = [];
let work = "";
let env: NodeJS.ProcessEnv = {};
const started: ChildProcess[] = [];

beforeEach(() => {
  const stash = sandboxStashDir();
  cleanups.push(stash.cleanup);
  writeSandboxConfig({ semanticSearchMode: "off" });
  const dir = makeSandboxDir("akm-group");
  cleanups.push(dir.cleanup);
  work = dir.dir;
  env = {
    ...process.env,
    MARK: path.join(work, "mark"),
    AKM_PID: path.join(work, "akm-pid"),
    BG: path.join(work, "bg"),
    GROUPS_FILE: path.join(work, "groups"),
    TTY_IN: path.join(work, "tty-in"),
  };
  fs.mkdirSync(path.join(stash.dir, "scripts"), { recursive: true });
  // A background sleep and a foreground sleep: the background one ignores SIGINT, as a shell's jobs do.
  fs.writeFileSync(
    path.join(stash.dir, "scripts", "slp.sh"),
    [
      "#!/bin/bash",
      `trap 'echo int > "$MARK"' INT`,
      `trap 'echo term > "$MARK"; exit 0' TERM`,
      'echo $PPID > "$AKM_PID"',
      'echo "$(ps -o pgid= -p $$) $(ps -o pgid= -p $PPID)" > "$GROUPS_FILE"',
      "sleep 25 &",
      'echo $! > "$BG"',
      "sleep 25",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(stash.dir, "scripts", "tty.sh"),
    [
      "#!/bin/bash",
      `trap 'echo int > "$MARK"; exit 0' INT`,
      `trap 'echo term > "$MARK"; exit 0' TERM`,
      'echo $PPID > "$AKM_PID"',
      'echo "$(ps -o pgid= -p $$) $(ps -o pgid= -p $PPID)" > "$GROUPS_FILE"',
      "sleep 25 &",
      'echo $! > "$BG"',
      'read -r line </dev/tty && echo "$line" > "$TTY_IN"',
      "wait",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
});

afterEach(() => {
  for (const child of started.splice(0)) if (child.exitCode === null && child.pid) tryKill(child.pid, "SIGKILL");
  for (const file of ["bg", "akm-pid"]) {
    const pid = readPid(file);
    if (pid) tryKill(pid, "SIGKILL");
  }
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups = [];
});

function tryKill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

function readPid(file: string): number | undefined {
  try {
    const pid = Number(fs.readFileSync(path.join(work, file), "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

async function until(condition: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (condition()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return condition();
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const mark = (): string =>
  fs.existsSync(env.MARK as string) ? fs.readFileSync(env.MARK as string, "utf8").trim() : "";

/** `bun cli.ts <args>` with no controlling terminal: its own session, stdin /dev/null. */
function akmWithoutTerminal(args: string[]): { child: ChildProcess; exited: Promise<number | null> } {
  const child = spawn("bun", [CLI, ...args], { env, detached: true, stdio: ["ignore", "ignore", "ignore"] });
  started.push(child);
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  return { child, exited };
}

describe.skipIf(!posix)("without a controlling terminal", () => {
  test("--timeout stops the script and what it started, within the grace periods", async () => {
    const t0 = Date.now();
    const { exited } = akmWithoutTerminal(["run", "--timeout", "2s", "scripts/slp.sh"]);
    await exited;
    expect(Date.now() - t0).toBeLessThan(2_000 + 5_000 + 5_000 + 3_000);
    // SIGINT first: the script's INT trap ran.
    expect(mark()).toBe("int");
    const bg = readPid("bg") as number;
    expect(await until(() => !alive(bg), 2_000)).toBe(true);
  }, 30_000);

  test("SIGTERM to akm leaves no survivor", async () => {
    const { exited } = akmWithoutTerminal(["run", "scripts/slp.sh"]);
    expect(await until(() => readPid("bg") !== undefined, 15_000)).toBe(true);
    const akmPid = readPid("akm-pid") as number;
    const bg = readPid("bg") as number;
    const [scriptGroup, akmGroup] = fs
      .readFileSync(env.GROUPS_FILE as string, "utf8")
      .trim()
      .split(/\s+/);
    expect(scriptGroup).not.toBe(akmGroup);
    process.kill(akmPid, "SIGTERM");
    await exited;
    expect(await until(() => !alive(bg), 10_000)).toBe(true);
    expect(alive(akmPid)).toBe(false);
  }, 30_000);
});

/** `bun cli.ts <args>` on a pseudo-terminal; `write` feeds the terminal. */
function akmOnTerminal(args: string[]): { child: ChildProcess; exited: Promise<void> } {
  const child = spawn("script", ["-qec", `bun ${CLI} ${args.join(" ")}`, "/dev/null"], {
    env,
    stdio: ["pipe", "ignore", "ignore"],
  });
  started.push(child);
  return { child, exited: new Promise<void>((resolve) => child.once("exit", () => resolve())) };
}

describe.skipIf(!hasScript)("on a terminal", () => {
  test("the script stays in akm's group and can read /dev/tty", async () => {
    const { child, exited } = akmOnTerminal(["run", "scripts/tty.sh"]);
    expect(await until(() => readPid("bg") !== undefined, 15_000)).toBe(true);
    const [scriptGroup, akmGroup] = fs
      .readFileSync(env.GROUPS_FILE as string, "utf8")
      .trim()
      .split(/\s+/);
    expect(scriptGroup).toBe(akmGroup);
    child.stdin?.write("hello\n");
    expect(await until(() => fs.existsSync(env.TTY_IN as string), 5_000)).toBe(true);
    expect(fs.readFileSync(env.TTY_IN as string, "utf8").trim()).toBe("hello");
    child.stdin?.write("\x03");
    await exited;
  }, 30_000);

  test("Ctrl-C stops the script and what it started", async () => {
    const { child, exited } = akmOnTerminal(["run", "scripts/tty.sh"]);
    expect(await until(() => readPid("bg") !== undefined, 15_000)).toBe(true);
    const bg = readPid("bg") as number;
    child.stdin?.write("\x03");
    await exited;
    expect(mark()).toBe("int");
    expect(await until(() => !alive(bg), 5_000)).toBe(true);
  }, 30_000);

  test("SIGTERM to akm reaches the script's TERM trap", async () => {
    const { exited } = akmOnTerminal(["run", "scripts/tty.sh"]);
    expect(await until(() => readPid("akm-pid") !== undefined, 15_000)).toBe(true);
    process.kill(readPid("akm-pid") as number, "SIGTERM");
    await exited;
    expect(mark()).toBe("term");
  }, 30_000);
});
