// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A live process that is not the test process, to stand in for "another akm holds this lock". A lock that names the
 * test's own PID is stale (this process has not acquired it), so tests of a held lock need a different live PID.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { processIdentity } from "../../src/core/file-lock";

export interface LiveHolder {
  pid: number;
  /** A lock payload naming this holder, with the identity a real holder would have recorded. */
  payload(extra?: Record<string, unknown>): string;
  /** Kill the holder and resolve once it has exited, so its PID reads as dead. */
  stop(): Promise<void>;
}

const running = new Set<ChildProcess>();

/** Spawn a sleeping child; it exits on its own after two minutes if a test never stops it. */
export function spawnLiveHolder(): LiveHolder {
  const child = spawn("sleep", ["120"], { stdio: "ignore" });
  child.unref();
  running.add(child);
  const pid = child.pid;
  if (pid === undefined) throw new Error("could not spawn a lock holder");
  return {
    pid,
    payload: (extra = {}) =>
      JSON.stringify({ pid, startedAt: new Date().toISOString(), ...processIdentity(pid), ...extra }),
    stop: () => {
      running.delete(child);
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGKILL");
      return exited;
    },
  };
}

export function stopLiveHolders(): void {
  for (const child of running) child.kill("SIGKILL");
  running.clear();
}
