// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { ChildProcess } from "node:child_process";
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

/** The running children, each with whether it leads its own process group. @type {Map<ChildProcess, boolean>} */
const live = new Map();
let tracking = false;
let untracked = false;

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
    const result = spawn.apply(this, args);
    if (!untracked && this.pid) {
      live.set(this, Boolean(args[0]?.detached) && process.platform !== "win32");
      this.once("exit", () => live.delete(this));
    }
    return result;
  };
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
    // A detached child leads its own process group, which also holds what it started.
    if (live.get(child)) process.kill(-(/** @type {number} */ (child.pid)), signal);
    else child.kill(signal);
  } catch {
    /* already gone */
  }
}

/** @param {ChildProcess} child */
const name = (child) => [path.basename(child.spawnfile), ...child.spawnargs.slice(1, 2)].join(" ");

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves when no tracked child is running, or after `ms`. @param {number} ms */
async function drained(ms) {
  const end = Date.now() + ms;
  while (live.size && Date.now() < end) await sleep(25);
}

/**
 * Called when the grace period is over: terminates what still runs (the process group, SIGTERM then SIGKILL), waits
 * for the exits, and says on stderr which operations had to be stopped.
 */
async function terminate() {
  if (!live.size) return;
  console.error(
    `Shutdown: stopped ${[...live.keys()].map(name).join(", ")} after the ${SHUTDOWN_GRACE_MS / 1000} s allowance.`,
  );
  for (const child of [...live.keys()]) signal(child, "SIGTERM");
  await drained(TERMINATE_MS);
  for (const child of [...live.keys()]) signal(child, "SIGKILL");
  await drained(KILLED_MS);
}

export { drained, outliving, terminate, track };
