// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

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

/** How often what has ended is dropped from the record while the server runs. */
const PRUNE_MS = 5_000;

/**
 * akm-cli's record of the children it starts (host tools, the akm CLI, git, harness runs). The server passes it in, so
 * a launcher that only reads the constants above does not load akm-cli.
 * @typedef {typeof import("akm-cli/workspace").children} Children
 */

/** @type {Children | undefined} */
let registry;
/** Set when termination begins: from then on, whatever a running operation starts next is stopped as it starts. */
let terminating = false;

/**
 * Starts every child in a process group of its own, so it can be found and stopped with what it started after it has
 * exited, and stops what starts once termination has begun. A child started outside akm-cli's record (the browser
 * opener, which is meant to outlive the server) is left alone.
 * @param {Children} children
 */
function track(children) {
  if (registry) return;
  registry = children;
  children.startChildrenInOwnGroups();
  children.onChildStarted((child) => {
    if (terminating) children.signalChild(child, "SIGKILL");
  });
  // A group is known by its leader's process id, which the system may hand out again once the group is empty: an
  // ended group must not stay on record until shutdown.
  setInterval(() => children.runningChildren(), PRUNE_MS).unref();
}

const live = () => registry?.runningChildren() ?? [];

/** @param {ReturnType<typeof live>} children */
const names = (children) => children.map((child) => child.name).join(", ");

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves when nothing this process started is running, or after `ms`. @param {number} ms */
async function drained(ms) {
  const end = Date.now() + ms;
  while (live().length && Date.now() < end) await sleep(25);
}

/**
 * Called when the grace period is over: terminates what still runs (each process group, SIGTERM then SIGKILL), waits
 * until nothing of it is left, and says on stderr which operations had to be stopped. A command an operation starts
 * after this point (its next step, once the current one is stopped) gets SIGKILL as it starts.
 */
async function terminate() {
  terminating = true;
  const left = live();
  if (!registry || !left.length) return;
  console.error(`Shutdown: stopped ${names(left)} after the ${SHUTDOWN_GRACE_MS / 1000} s allowance.`);
  for (const child of left) registry.signalChild(child, "SIGTERM");
  await drained(TERMINATE_MS);
  for (const child of live()) registry.signalChild(child, "SIGKILL");
  await drained(KILLED_MS);
  const remaining = live();
  if (remaining.length) console.error(`Shutdown: could not stop ${names(remaining)}.`);
}

export { drained, terminate, track };
