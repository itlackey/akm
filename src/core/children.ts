// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The record of the child processes akm starts asynchronously, so that a host running akm in its own process
 * (akm-web) can wait for them on shutdown and stop what is left. Every asynchronous start in `src/` goes through
 * {@link spawnChild}, {@link execFileChild} or, for `Bun.spawn`, {@link recordChild};
 * `tests/integration/architecture/child-registry.test.ts` fails on one that does not. A synchronous start blocks this
 * process until the child exits, so it is never running when a host stops, and is not recorded.
 *
 * The caller decides the process group (`detached`, see `childGroup` in `./subprocess`) unless a host called
 * {@link startChildrenInOwnGroups}; the record notes it.
 */

import { type ChildProcess, type ExecFileException, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** A child akm started, kept while it or anything in the process group it leads still runs. */
export interface StartedChild {
  readonly pid: number;
  /** The program's file name and its first argument, for messages (`akm --version`). */
  readonly name: string;
  /** Whether it leads a process group of its own (POSIX `detached`); then the group is what runs and is signalled. */
  readonly grouped: boolean;
  /** The child itself has exited. What it started may still run in its group. */
  exited: boolean;
}

const started = new Set<StartedChild>();
const listeners = new Set<(child: StartedChild) => void>();
let ownGroups = false;

/**
 * From now on every child starts in a process group of its own on POSIX, whatever its caller asked. A host that stops
 * its children by group (akm-web) needs each child's descendants in that child's group. The command line leaves the
 * caller's choice alone: a child on a terminal shares akm's group so that Ctrl-C reaches it.
 */
export function startChildrenInOwnGroups(): void {
  ownGroups = true;
}

/** The `detached` option a child starts with. */
export function childDetached(requested: boolean | undefined): boolean | undefined {
  return ownGroups && process.platform !== "win32" ? true : requested;
}

/** Records a started child. `exit` settles when the child itself exits. A child that failed to start has no pid. */
export function recordChild(
  pid: number | undefined,
  command: readonly string[],
  detached: boolean | undefined,
  exit: Promise<unknown>,
): void {
  if (!pid) return;
  const child: StartedChild = {
    pid,
    name: [path.basename(command[0] ?? ""), ...command.slice(1, 2)].join(" "),
    grouped: process.platform !== "win32" && detached === true,
    exited: false,
  };
  started.add(child);
  void exit.then(
    () => ended(child),
    () => ended(child),
  );
  for (const listener of listeners) listener(child);
}

function ended(child: StartedChild): void {
  child.exited = true;
  if (!running(child)) started.delete(child);
}

/** `child_process.spawn`, recorded. */
export function spawnChild(file: string, args: readonly string[], options: SpawnOptions): ChildProcess {
  const detached = childDetached(options.detached);
  const child = nodeSpawn(file, args, { ...options, detached });
  recordChild(child.pid, [file, ...args], detached, exitOf(child));
  return child;
}

/** What {@link execFileChild} takes: `child_process.execFile`'s options that akm uses. */
export interface ExecFileChildOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** The child gets SIGTERM after this long, and the error says `killed`. */
  readonly timeout?: number;
  /** More output than this on stdout or stderr ends the child, as `execFile` does. */
  readonly maxBuffer?: number;
}

/**
 * `child_process.execFile` with UTF-8 output, recorded. Built on {@link spawnChild}, since `execFile` does not pass
 * `detached` on and a host's own group would not apply. The callback gets what `execFile`'s does: `code` is the exit
 * code or the error code of a failed start (`ENOENT`), `killed` is set when the timeout or the output limit ended it.
 */
export function execFileChild(
  file: string,
  args: readonly string[],
  options: ExecFileChildOptions,
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
): ChildProcess {
  const child = spawnChild(file, args, { cwd: options.cwd, env: options.env });
  const maxBuffer = options.maxBuffer ?? 1024 * 1024;
  const output = { stdout: "", stderr: "" };
  let failure: ExecFileException | undefined;
  let killed = false;
  let settled = false;
  const stop = () => {
    killed = true;
    child.kill();
  };
  const timer = options.timeout ? setTimeout(stop, options.timeout) : undefined;
  const settle = (error: ExecFileException | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    callback(error, output.stdout, output.stderr);
  };
  for (const stream of ["stdout", "stderr"] as const) {
    child[stream]?.setEncoding("utf8");
    child[stream]?.on("data", (chunk: string) => {
      output[stream] += chunk;
      if (output[stream].length <= maxBuffer || failure) return;
      failure = Object.assign(new RangeError(`${stream} maxBuffer length exceeded`), {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      });
      stop();
    });
  }
  child.once("error", (error) => settle(Object.assign(error, { killed })));
  child.once("close", (code, signal) => {
    if (code === 0 && !failure) return settle(null);
    const command = [file, ...args].join(" ");
    const error: ExecFileException =
      failure ?? Object.assign(new Error(`Command failed: ${command}\n${output.stderr}`), { code: code ?? undefined });
    settle(Object.assign(error, { killed, signal: signal ?? undefined, cmd: command }));
  });
  return child;
}

const exitOf = (child: ChildProcess) => new Promise<void>((resolve) => child.once("exit", () => resolve()));

/**
 * The recorded children that still run: the child itself, or a member of the group it led. The others are dropped.
 */
export function runningChildren(): StartedChild[] {
  for (const child of started) if (!running(child)) started.delete(child);
  return [...started];
}

/** Signals a recorded child: its whole process group when it leads one, otherwise the child alone. */
export function signalChild(child: StartedChild, signal: NodeJS.Signals): void {
  try {
    process.kill(child.grouped ? -child.pid : child.pid, signal);
  } catch {
    /* already gone */
  }
}

/** Calls `listener` with every child recorded from now on. Returns the function that stops it. */
export function onChildStarted(listener: (child: StartedChild) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const running = (child: StartedChild) => !child.exited || (child.grouped && groupRunning(child.pid));

/**
 * Whether a process group has a running member. A process that exited but that nobody waited for still belongs to its
 * group; Linux can tell those apart, and has to where the container's first process never waits for them.
 */
function groupRunning(group: number): boolean {
  try {
    process.kill(-group, 0);
  } catch {
    return false;
  }
  if (process.platform !== "linux") return true;
  try {
    // asset-io: host process table
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        // "pid (name) state parent group …": the name may hold anything, so read after its closing bracket.
        // asset-io: host process table
        const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
        const [state, , pgrp] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (Number(pgrp) === group && state !== "Z") return true;
      } catch {
        /* gone */
      }
    }
    return false;
  } catch {
    return true;
  }
}
