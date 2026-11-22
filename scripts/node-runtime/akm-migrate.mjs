#!/usr/bin/env node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The signal forwarders go up before anything else runs (the Node-version check, the bun-version probe, the
// spawn), so a signal that arrives at any point reaches the child instead of killing the launcher under the
// runtime's default disposition. `child` starts unset: a signal that arrives before it exists is queued and
// forwarded the moment it does.
let child;
let childExited = false;
const pendingSignals = [];
const forwardSignal = (signal) => {
  if (childExited) return;
  if (!child) {
    pendingSignals.push(signal);
    return;
  }
  try {
    child.kill(signal);
  } catch {
    // Child exited in the race between the check above and here.
  }
};
// `.once`, not `.on`: a persistent listener would still be registered when the `process.kill(process.pid, ...)`
// re-raise below runs, which would suppress the OS default disposition and leave this launcher exiting 0
// instead of reflecting the child's signal.
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.once(signal, () => forwardSignal(signal));
}

if (!process.versions.bun) {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 15)) {
    console.error("The akm-cli npm package requires Node.js >= 22.15 to bootstrap.");
    process.exit(1);
  }
}

const bunProbe = process.versions.bun
  ? { status: 0, stdout: process.versions.bun }
  : spawnSync("bun", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
const [bunMajor = 0] = (bunProbe.status === 0 ? bunProbe.stdout.trim() : "").split(".").map(Number);
const useBun = bunMajor >= 1;
const bunEntry = fileURLToPath(new URL("./scripts/akm-migrate.js", import.meta.url));
const nodeEntry = fileURLToPath(new URL("./scripts/akm-migrate-node.js", import.meta.url));

{
  // The child names the launcher pid, so a `kill <launcher-pid>` forwards to the child instead of orphaning it.
  const env = { ...process.env, AKM_LAUNCHER_PID: String(process.pid) };
  const command = process.versions.bun ? process.execPath : useBun ? "bun" : process.execPath;
  const entry = process.versions.bun || useBun ? bunEntry : nodeEntry;
  const result = await new Promise((resolve) => {
    child = spawn(command, [entry, ...process.argv.slice(2)], {
      stdio: "inherit",
      env,
      // Own process group on POSIX, so the launcher's forward is the only delivery path to the child and not a
      // second copy on top of a group-wide broadcast.
      detached: process.platform !== "win32",
    });
    child.once("exit", () => {
      childExited = true;
    });
    // Forward whatever arrived between the listeners going up and the child existing.
    for (const signal of pendingSignals.splice(0)) forwardSignal(signal);
    child.once("error", (error) => resolve({ error }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  if (result.error) {
    console.error(`akm-migrate launcher could not start its runtime: ${result.error.message}`);
    process.exitCode = 127;
  } else if (result.signal) {
    process.kill(process.pid, result.signal);
  } else {
    process.exitCode = result.code ?? 1;
  }
}
