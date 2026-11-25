// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** Requests in flight and running operations get this long to finish on shutdown. */
export const SHUTDOWN_GRACE_MS = 10_000;
/** What is still running after the grace period gets SIGTERM, then SIGKILL after this long. */
const TERMINATE_MS = 2_000;
/** After SIGKILL, how long the exits are awaited. */
const KILLED_MS = 1_000;
/** The most a shutdown takes. A launcher waits this long, plus a margin, before it kills the server itself. */
export const SHUTDOWN_BOUND_MS = SHUTDOWN_GRACE_MS + TERMINATE_MS + KILLED_MS;
/** What a launcher adds to the bound before it force-kills the server. */
export const SHUTDOWN_MARGIN_MS = 2_000;
/** How long a launcher waits for the server to exit on its own. */
export const SHUTDOWN_WAIT_MS = SHUTDOWN_BOUND_MS + SHUTDOWN_MARGIN_MS;

/** How often what has ended is dropped from `live` while the server runs. */
const PRUNE_MS = 5_000;

/**
 * Where there are process groups, every child gets one of its own: what it starts stays in that group, so it can be
 * found and stopped after the child itself has exited.
 */
const grouped = process.platform !== "win32";

/** The children this process started whose process group (on Windows: the child itself) still runs. @type {Set<ChildProcess>} */
const live = new Set();
let tracking = false;
let untracked = false;
/** Set when termination begins: from then on, whatever a running operation starts next is stopped as it starts. */
let terminating = false;

/**
 * Whether a process group has a running member. A process that exited but that nobody waited for still belongs to its
 * group; Linux can tell those apart, and has to where the container's first process never waits for them.
 * @param {number} group
 */
function groupRunning(group) {
  try {
    process.kill(-group, 0);
  } catch {
    return false;
  }
  if (process.platform !== "linux") return true;
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        // "pid (name) state parent group …": the name may hold anything, so read after its closing bracket.
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

/** Whether the child, or anything in the group it led, still runs. @param {ChildProcess} child */
const running = (child) =>
  (child.exitCode === null && child.signalCode === null) ||
  (grouped && groupRunning(/** @type {number} */ (child.pid)));

function prune() {
  for (const child of live) if (!running(child)) live.delete(child);
}

/**
 * Every child this process starts, whoever starts it (host tools, the akm CLI, git, harness runs inside akm-cli):
 * they all go through `ChildProcess.prototype.spawn`. A child started while `untracked` (the browser opener, which is
 * meant to outlive the server) is left out.
 */
function track() {
  if (tracking) return;
  tracking = true;
  const proto = /** @type {any} */ (ChildProcess.prototype);
  const spawn = proto.spawn;
  /** @this {ChildProcess} @param {any[]} args */
  proto.spawn = function (...args) {
    const mine = !untracked;
    if (mine && grouped && args[0]) args[0].detached = true;
    const result = spawn.apply(this, args);
    if (mine && this.pid) {
      live.add(this);
      this.once("exit", () => {
        if (!running(this)) live.delete(this);
      });
      if (terminating) signal(this, "SIGKILL");
    }
    return result;
  };
  // A group is known by its leader's process id, which the system may hand out again once the group is empty: an
  // ended group must not stay here until shutdown.
  setInterval(prune, PRUNE_MS).unref();
}

/** Runs `start` (which spawns a child) without tracking what it starts. @param {() => void} start */
function outliving(start) {
  untracked = true;
  try {
    start();
  } finally {
    untracked = false;
  }
}

/** @param {ChildProcess} child @param {NodeJS.Signals} signal */
function signal(child, signal) {
  try {
    if (grouped) process.kill(-(/** @type {number} */ (child.pid)), signal);
    else child.kill(signal);
  } catch {
    child.kill(signal);
  }
}

/** @param {ChildProcess} child */
const name = (child) => [path.basename(child.spawnfile), ...child.spawnargs.slice(1, 2)].join(" ");

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const names = () => [...live].map(name).join(", ");

/** Resolves when nothing this process started is running, or after `ms`. @param {number} ms */
async function drained(ms) {
  const end = Date.now() + ms;
  for (prune(); live.size && Date.now() < end; prune()) await sleep(25);
}

/**
 * Called when the grace period is over: terminates what still runs (each process group, SIGTERM then SIGKILL), waits
 * until nothing of it is left, and says on stderr which operations had to be stopped. A command an operation starts
 * after this point (its next step, once the current one is stopped) gets SIGKILL as it starts.
 */
async function terminate() {
  terminating = true;
  prune();
  if (!live.size) return;
  console.error(`Shutdown: stopped ${names()} after the ${SHUTDOWN_GRACE_MS / 1000} s allowance.`);
  for (const child of live) signal(child, "SIGTERM");
  await drained(TERMINATE_MS);
  for (const child of live) signal(child, "SIGKILL");
  await drained(KILLED_MS);
  if (live.size) console.error(`Shutdown: could not stop ${names()}.`);
}

export { drained, outliving, terminate, track };
