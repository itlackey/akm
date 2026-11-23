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

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { makeLauncherDist } from "../_helpers/launcher-dist";
import { realNodeExecutable } from "../_helpers/node-runtime";
import { type Cleanup, makeSandboxDir, sandboxStashDir, writeSandboxConfig } from "../_helpers/sandbox";

const CLI = path.resolve(import.meta.dir, "../../src/cli.ts");
const posix = process.platform === "linux" || process.platform === "darwin";
const hasPython = posix && spawnSync("python3", ["--version"]).status === 0;

// Runs a program on a new pseudo-terminal, as its controlling terminal, and feeds it this process's stdin;
// exits with the program's status when the program exits. Not script(1): on macOS Bun gives the
// child a socket for stdin, and BSD script refuses one.
const ON_TERMINAL = `
import os, pty, select, sys
pid, master = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
if os.environ.get("PTY_PID_FILE"):
    open(os.environ["PTY_PID_FILE"], "w").write(str(pid))
reading = [0, master]
while True:
    done, status = os.waitpid(pid, os.WNOHANG)
    if done:
        sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status))
    for fd in select.select(reading, [], [], 0.05)[0]:
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b""
        if fd == 0:
            if data:
                os.write(master, data)
            else:
                reading.remove(0)
        elif not data:
            reading.remove(master)
`;

let cleanups: Cleanup[] = [];
let work = "";
let env: NodeJS.ProcessEnv = {};
const started: ChildProcess[] = [];

beforeEach(() => {
  const stash = sandboxStashDir();
  cleanups.push(stash.cleanup);
  writeSandboxConfig({ semanticSearchMode: "off", experimental: { exec: true } });
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
    PTY_PID_FILE: path.join(work, "pty-pid"),
    JOBS: path.join(work, "jobs"),
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
  // Handles Ctrl-C and goes on, as a shell at its prompt does.
  fs.writeFileSync(
    path.join(stash.dir, "scripts", "carry-on.sh"),
    [
      "#!/bin/bash",
      `trap 'echo caught > "$MARK"' INT`,
      'echo $PPID > "$AKM_PID"',
      "sleep 2",
      "sleep 2",
      "exit 7",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(stash.dir, "scripts", "sig.sh"), '#!/bin/sh\nkill -"$1" $$\nsleep 5\n', { mode: 0o755 });
  fs.writeFileSync(path.join(stash.dir, "scripts", "envdump.sh"), "#!/bin/sh\nenv\n", { mode: 0o755 });
  fs.writeFileSync(path.join(work, "fake-harness"), '#!/bin/sh\ncat > /dev/null\nenv > "$HARNESS_ENV"\necho reply\n', {
    mode: 0o755,
  });
  fs.writeFileSync(path.join(stash.dir, "scripts", "sl6.sh"), "#!/bin/sh\nsleep 6\n", { mode: 0o755 });
  fs.writeFileSync(
    path.join(stash.dir, "scripts", "tick.sh"),
    ["#!/bin/bash", 'echo $$ > "$BG"', "while true; do sleep 0.2; done", ""].join("\n"),
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

// Skipped on Windows, which has no process groups or controlling terminal.
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
  return onTerminal(["bun", CLI, ...args]);
}

function onTerminal(argv: string[]): { child: ChildProcess; exited: Promise<void> } {
  const child = spawn("python3", ["-c", ON_TERMINAL, ...argv], {
    env,
    stdio: ["pipe", "ignore", "ignore"],
  });
  started.push(child);
  return { child, exited: new Promise<void>((resolve) => child.once("exit", () => resolve())) };
}

// Skipped only where python3 is missing.
describe.skipIf(!hasPython)("on a terminal", () => {
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

  test("Ctrl-C that the script handles keeps akm waiting; akm exits with the script's status", async () => {
    const { child } = akmOnTerminal(["run", "scripts/carry-on.sh"]);
    const status = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    expect(await until(() => readPid("akm-pid") !== undefined, 15_000)).toBe(true);
    const akmPid = readPid("akm-pid") as number;
    child.stdin?.write("\x03");
    expect(await until(() => mark() === "caught", 5_000)).toBe(true);
    // akm did not die of the Ctrl-C while the script carried on.
    expect(alive(akmPid)).toBe(true);
    // The terminal driver exits with the script's status.
    expect(await status).toBe(7);
  }, 30_000);

  test("SIGTERM with an own-group and a shared child live reaches both", async () => {
    // A captured child is always in its own group; an uncaptured one on a terminal shares akm's.
    const program = path.join(work, "mixed.ts");
    const subprocessModule = path.resolve(import.meta.dir, "../../src/core/subprocess");
    fs.writeFileSync(
      program,
      `import fs from "node:fs";
import { runManagedSubprocess } from ${JSON.stringify(subprocessModule)};
fs.writeFileSync(${JSON.stringify(env.AKM_PID)}, String(process.pid));
const own = runManagedSubprocess(["sh", "-c", 'echo $$ > "$BG"; exec sleep 25'], { capture: true, timeoutMs: null, graceMs: 500 });
const shared = runManagedSubprocess(["sh", "-c", 'trap "echo term > \\"$MARK\\"; exit 0" TERM; echo $$ > "$SHARED_PID"; sleep 25 & wait'], { capture: false, timeoutMs: null, graceMs: 500 });
await Promise.all([own, shared]);
`,
    );
    env.SHARED_PID = path.join(work, "shared-pid");
    const { exited } = onTerminal(["bun", program]);
    expect(await until(() => readPid("bg") !== undefined && readPid("shared-pid") !== undefined, 15_000)).toBe(true);
    const own = readPid("bg") as number;
    const shared = readPid("shared-pid") as number;
    process.kill(readPid("akm-pid") as number, "SIGTERM");
    await exited;
    expect(mark()).toBe("term");
    expect(await until(() => !alive(own) && !alive(shared), 5_000)).toBe(true);
  }, 30_000);

  test("SIGTERM to akm reaches the script's TERM trap", async () => {
    const { exited } = akmOnTerminal(["run", "scripts/tty.sh"]);
    expect(await until(() => readPid("akm-pid") !== undefined, 15_000)).toBe(true);
    process.kill(readPid("akm-pid") as number, "SIGTERM");
    await exited;
    expect(mark()).toBe("term");
  }, 30_000);
});

// The installed launcher (the real script beside a `cli.js` that runs this checkout), started by real Node and by Bun. On Linux and macOS it
// replaces itself with akm, so the terminal, the process group and every signal are akm's own.
const launcherDist = makeLauncherDist();
const LAUNCHER = launcherDist.launcher;
afterAll(() => launcherDist.cleanup());
const runtimes: Array<[string, () => string]> = [
  ["node", realNodeExecutable],
  ["bun", () => "bun"],
];

describe.skipIf(!posix || !hasPython)("the installed launcher", () => {
  for (const [runtimeName, runtime] of runtimes) {
    const viaLauncher = (args: string[]): string[] => [runtime(), LAUNCHER, ...args];

    describe(`under ${runtimeName}`, () => {
      test("scripts keep the terminal and akm is the process the terminal started", async () => {
        const { child, exited } = onTerminal(viaLauncher(["run", "scripts/tty.sh"]));
        expect(await until(() => readPid("bg") !== undefined, 15_000)).toBe(true);
        const [scriptGroup, akmGroup] = fs
          .readFileSync(env.GROUPS_FILE as string, "utf8")
          .trim()
          .split(/\s+/);
        expect(scriptGroup).toBe(akmGroup);
        expect(readPid("akm-pid")).toBe(readPid("pty-pid"));
        child.stdin?.write("hello\n");
        expect(await until(() => fs.existsSync(env.TTY_IN as string), 5_000)).toBe(true);
        child.stdin?.write("\x03");
        await exited;
      }, 30_000);

      test("akm exec gives an interactive shell the terminal (job control) and keeps it alive through Ctrl-C", async () => {
        const marker = path.join(work, "shell-alive");
        const { child, exited } = onTerminal(viaLauncher(["exec", "--", "bash", "--norc", "-i"]));
        await new Promise((r) => setTimeout(r, 2_000));
        child.stdin?.write("\x03");
        await new Promise((r) => setTimeout(r, 500));
        // `m` is in $- only when the shell has job control, which needs a controlling terminal.
        child.stdin?.write(`case $- in *m*) echo jobcontrol;; *) echo nojobcontrol;; esac > ${marker}\nexit\n`);
        await exited;
        expect(fs.readFileSync(marker, "utf8").trim()).toBe("jobcontrol");
      }, 30_000);

      test("Ctrl-Z stops the script itself and the shell's prompt returns", async () => {
        const { child, exited } = onTerminal(["bash", "--norc", "-i"]);
        child.stdin?.write(`${viaLauncher(["run", "scripts/tick.sh"]).join(" ")}\n`);
        expect(await until(() => readPid("bg") !== undefined, 15_000)).toBe(true);
        const script = readPid("bg") as number;
        const state = (): string => {
          try {
            return fs.readFileSync(`/proc/${script}/stat`, "utf8").replace(/^.*\) /, "")[0] ?? "";
          } catch {
            return "";
          }
        };
        child.stdin?.write("\x1a");
        // /proc/<pid>/stat state T: the script, not only the launcher, is stopped.
        const stopped = process.platform !== "linux" || (await until(() => state() === "T", 5_000));
        expect(stopped).toBe(true);
        child.stdin?.write(`jobs > "$JOBS"\n`);
        expect(
          await until(
            () => fs.existsSync(env.JOBS as string) && fs.readFileSync(env.JOBS as string, "utf8").includes("Stopped"),
            5_000,
          ),
        ).toBe(true);
        child.stdin?.write("kill -9 %1\n");
        await new Promise((r) => setTimeout(r, 500));
        child.stdin?.write("exit\nexit\n");
        await exited;
      }, 30_000);

      test("kill -TERM <akm> runs the script's TERM trap", async () => {
        const { exited } = onTerminal(viaLauncher(["run", "scripts/tty.sh"]));
        expect(await until(() => readPid("bg") !== undefined, 15_000)).toBe(true);
        process.kill(readPid("pty-pid") as number, "SIGTERM");
        await exited;
        expect(mark()).toBe("term");
      }, 30_000);

      test("off a terminal, kill -QUIT runs the ladder and leaves no orphan", async () => {
        // akm ends by SIGQUIT, which dumps core: core dumps off, so its exit does not wait on the host's core handler.
        const child = spawn(
          "/bin/sh",
          ["-c", 'ulimit -c 0 && exec "$@"', "sh", runtime(), LAUNCHER, "run", "scripts/slp.sh"],
          {
            env,
            detached: true,
            stdio: ["ignore", "ignore", "ignore"],
          },
        );
        started.push(child);
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        expect(await until(() => readPid("bg") !== undefined, 15_000)).toBe(true);
        const bg = readPid("bg") as number;
        expect(readPid("akm-pid")).toBe(child.pid as number);
        process.kill(child.pid as number, "SIGQUIT");
        await exited;
        expect(child.signalCode).toBe("SIGQUIT");
        expect(mark()).toBe("int");
        expect(await until(() => !alive(bg), 5_000)).toBe(true);
      }, 30_000);

      test("two Ctrl-C half a second apart orphan nothing", async () => {
        const { child, exited } = onTerminal(viaLauncher(["run", "scripts/tty.sh"]));
        expect(await until(() => readPid("bg") !== undefined, 15_000)).toBe(true);
        const bg = readPid("bg") as number;
        child.stdin?.write("\x03");
        await new Promise((r) => setTimeout(r, 500));
        child.stdin?.write("\x03");
        await exited;
        expect(await until(() => !alive(bg), 5_000)).toBe(true);
      }, 30_000);

      test("programs akm starts do not inherit the launcher's AKM_LAUNCHER_* variables", () => {
        const harnessEnv = path.join(work, "harness-env");
        writeSandboxConfig({
          experimental: { exec: true },
          harnesses: { fake: { platform: "claude", bin: path.join(work, "fake-harness") } },
        });
        const run = (args: string[]) =>
          spawnSync(runtime(), [LAUNCHER, ...args], { env: { ...env, HARNESS_ENV: harnessEnv }, encoding: "utf8" });
        const script = run(["run", "scripts/envdump.sh"]);
        const exec = run(["exec", "--", "env"]);
        const harness = run(["exec", "--harness", "fake", "--prompt", "p"]);
        expect(harness.stdout).toContain("reply");
        for (const [name, text] of [
          ["run", script.stdout],
          ["exec", exec.stdout],
          ["harness", fs.readFileSync(harnessEnv, "utf8")],
        ]) {
          expect(text, name).toContain("PATH=");
          expect(text, name).not.toContain("AKM_LAUNCHER_");
        }
      }, 30_000);

      test("akm ends by the signal its script died of", () => {
        for (const name of ["TERM", "INT", "KILL"]) {
          const result = spawnSync(runtime(), [LAUNCHER, "run", "scripts/sig.sh", name], { env, encoding: "utf8" });
          expect(result.signal).toBe(`SIG${name}` as NodeJS.Signals);
        }
      }, 30_000);

      test("a shell loop around akm run stops at one Ctrl-C", async () => {
        const loop = path.join(work, "loop");
        const started = Date.now();
        const { child, exited } = onTerminal([
          "bash",
          "-c",
          `for i in 1 2 3; do ${viaLauncher(["run", "scripts/sl6.sh"]).join(" ")}; echo next $i >> ${loop}; done`,
        ]);
        await new Promise((r) => setTimeout(r, 2_500));
        child.stdin?.write("\x03");
        await exited;
        expect(Date.now() - started).toBeLessThan(8_000);
        expect(fs.existsSync(loop)).toBe(false);
      }, 30_000);
    });
  }
});
