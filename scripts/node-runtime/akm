#!/usr/bin/env node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

// A scheduled row sets its environment itself (a cron `VAR=value` prefix, a
// launchd plist's EnvironmentVariables), and the scheduler supplies PATH, so
// runtime selection below needs nothing from it. A row written by 0.9.0 –
// 0.9.17-alpha.6 passes `--scheduler-context <descriptor>` instead; it passes
// through untouched, and the CLI applies it (`consumeSchedulerContextArg` in
// src/cli.ts).

// Node 22.15 added `process.execve`, which this launcher needs on Linux and macOS.
if (!process.versions.bun) {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 15)) {
    console.error("The akm-cli npm package requires Node.js >= 22.15 to bootstrap.");
    process.exit(1);
  }
}

process.env.AKM_LAUNCHER_NODE = process.execPath;
process.env.AKM_LAUNCHER_PATH = fileURLToPath(import.meta.url);
// An inherited pid is not this akm's launcher; only the Windows path below, which has a launcher process, sets it.
delete process.env.AKM_LAUNCHER_PID;

const bunProbe = process.versions.bun
  ? { status: 0, stdout: process.versions.bun }
  : spawnSync("bun", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
const [bunMajor = 0] = (bunProbe.status === 0 ? bunProbe.stdout.trim() : "").split(".").map(Number);
const useBun = bunMajor >= 1;

// `process.execve` takes a path, not a name to look up: the first `bun` on PATH.
function bunOnPath() {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(dir, "bun");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return "bun";
}

const runtime = useBun ? "Bun" : "Node.js";
const cannotStart = (error) => {
  console.error(`akm launcher could not start ${runtime}: ${error.message}`);
  process.exitCode = 127;
};
const bunEntry = fileURLToPath(new URL("./cli.js", import.meta.url));

if (!useBun && !process.versions.bun) {
  // No Bun: the CLI runs in this process, on Node.
  await import("./cli-node.mjs");
} else if (process.platform === "win32") {
  // No process groups or controlling terminal of this kind here: run akm as a child and mirror its end.
  process.env.AKM_LAUNCHER_PID = String(process.pid);
  const command = process.versions.bun ? process.execPath : "bun";
  const child = spawn(command, [bunEntry, ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.once(signal, () => child.kill(signal));
  child.once("error", cannotStart);
  child.once("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
} else {
  if (process.versions.bun) {
    // Already on Bun: the CLI runs in this process (cli.js gates its startup block on this variable).
    process.env.AKM_NODE_ENTRY = "1";
    await import("./cli.js");
  } else {
    // Node starting Bun: replace this process with akm, so the terminal, process group, signals and exit status
    // are akm's own.
    const bunPath = bunOnPath();
    try {
      process.execve(bunPath, [bunPath, bunEntry, ...process.argv.slice(2)], process.env);
    } catch (error) {
      cannotStart(error);
    }
  }
}
