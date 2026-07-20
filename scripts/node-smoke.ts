#!/usr/bin/env bun
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Node smoke test (#465 / #560).
//
// The runtime boundary (src/runtime.ts + src/storage/database.ts) makes akm
// theoretically Node-capable, but `bun test` can only run under Bun. This
// script is the missing coverage: it drives the BUILT `dist/` under **node**
// (`node dist/cli-node.mjs`) through a representative end-to-end CLI sequence
// that exercises every Node branch of the runtime boundary:
//
//   • better-sqlite3 driver       — init / remember / index / search / show / health
//   • SQLite FTS + embeddings     — index then search returns the hit
//   • readStdin (Node iterator)   — `remember -` with piped stdin
//   • spawnSync + writeResponse-  — `setup --yes` downloads ripgrep and runs
//     ToFile + spawn adapter        `rg --version`, plus agent detection
//   • getDirname (fileURLToPath)  — `--version` (reads package.json via boundary)
//   • text-import loader hook     — any command (cli.js eagerly loads .md assets)
//
// It runs against a throwaway HOME / XDG / stash so it is fully isolated and
// deterministic, and exits non-zero on the first failed step so CI fails loudly.
//
// Prereqs (the build + CI matrix wire these up): `bun run build` has produced
// dist/, and `better-sqlite3` is installed & compiled for the active Node.
//
// Usage:  node — NOT bun — runs this indirectly via the spawned CLI; the script
// itself is launched with bun (`bun scripts/node-smoke.ts`) but every assertion
// shells out to `node`.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const cliEntry = path.join(repoRoot, "dist", "cli-node.mjs");
const nodeBin = process.env.AKM_SMOKE_NODE ?? "node";

// Fail fast with a clear message if the build artifact is missing.
{
  const fs = await import("node:fs");
  if (!fs.existsSync(cliEntry)) {
    console.error(`node-smoke: missing build artifact ${cliEntry} — run \`bun run build\` first.`);
    process.exit(1);
  }
}

const root = mkdtempSync(path.join(tmpdir(), "akm-node-smoke-"));
const home = path.join(root, "home");
const stash = path.join(root, "stash");

const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  HOME: home,
  USERPROFILE: home,
  XDG_DATA_HOME: path.join(home, ".local", "share"),
  XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_CACHE_HOME: path.join(home, ".cache"),
  // Keep output machine-parseable and avoid interactive/TTY branches.
  AKM_OUTPUT: "json",
  NO_COLOR: "1",
  CI: "1",
};

let stepNo = 0;
let failures = 0;

interface StepOptions {
  /** Substring that MUST appear in stdout for the step to pass. */
  expect?: string;
  /** Data to pipe to the CLI's stdin (exercises readStdin). */
  stdin?: string;
  /** Allow a non-zero exit (e.g. search with no provider still exits 0; default requires 0). */
  allowNonZero?: boolean;
  /** Exit codes that count as success (in addition to 0). E.g. `akm health` exits 4
   *  (EXIT_HEALTH_WARN) on a minimal fresh stash — a valid outcome, not a crash. */
  allowExitCodes?: number[];
  /** Per-step timeout (ms). */
  timeoutMs?: number;
}

function step(label: string, args: string[], opts: StepOptions = {}): string {
  stepNo++;
  const tag = `[${stepNo}] ${label}`;
  const res = spawnSync(nodeBin, [cliEntry, ...args], {
    env,
    input: opts.stdin,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${res.stdout ?? ""}`;
  const err = `${res.stderr ?? ""}`;
  const code = res.status;

  let ok = true;
  const problems: string[] = [];
  if (res.error) {
    ok = false;
    problems.push(`spawn error: ${res.error.message}`);
  }
  const allowedCodes = new Set<number>([0, ...(opts.allowExitCodes ?? [])]);
  if (!opts.allowNonZero && code !== null && !allowedCodes.has(code)) {
    ok = false;
    problems.push(`exit code ${code} (expected ${[...allowedCodes].join(" or ")})`);
  }
  if (opts.expect && !out.includes(opts.expect)) {
    ok = false;
    problems.push(`stdout missing expected substring ${JSON.stringify(opts.expect)}`);
  }
  // A Node-branch regression in the runtime boundary surfaces as these messages
  // even when the command still prints a result — treat them as hard failures.
  for (const marker of [
    "appendEvent failed",
    "ERR_MODULE_NOT_FOUND",
    "ERR_UNKNOWN_FILE_EXTENSION",
    "Bun is not defined",
  ]) {
    if (err.includes(marker) || out.includes(marker)) {
      ok = false;
      problems.push(`runtime-boundary marker in output: ${marker}`);
    }
  }

  if (ok) {
    console.log(`  PASS ${tag}`);
  } else {
    failures++;
    console.error(`  FAIL ${tag}`);
    for (const p of problems) console.error(`       - ${p}`);
    if (err.trim()) console.error(`       stderr: ${err.trim().split("\n").slice(0, 6).join("\n               ")}`);
    if (out.trim()) console.error(`       stdout: ${out.trim().split("\n").slice(0, 6).join("\n               ")}`);
  }
  return out;
}

console.log(`node-smoke: driving ${cliEntry}`);
console.log(`node-smoke: runtime = ${spawnSync(nodeBin, ["--version"], { encoding: "utf8" }).stdout?.trim()}`);
console.log(`node-smoke: temp root = ${root}`);

try {
  // getDirname / package.json resolution via the boundary + text-import hook.
  step("version", ["--version"], { expect: "." });
  // better-sqlite3 open + config write.
  step("init", ["init", "--dir", stash], { expect: '"created": true' });
  // SQLite write path (was broken by the better-sqlite3 `readonly:undefined` bug).
  step("remember", ["remember", "node smoke widget memory alpha"], { expect: '"ok": true' });
  // readStdin Node branch.
  step("remember-stdin", ["remember", "-"], { stdin: "piped stdin memory beta\n", expect: '"ok": true' });
  // FTS index build over SQLite.
  step("index", ["index"], { expect: '"shape": "index"', timeoutMs: 180_000 });
  // Search reads the index back and returns the remembered hit.
  const searchOut = step("search", ["search", "widget"], { expect: "node-smoke", allowNonZero: true });
  if (!searchOut.includes("node-smoke")) {
    // Non-fatal warning surface — keyword search may rank differently; the hard
    // gate is that search ran without a boundary error (checked above).
    console.error("       note: 'widget' hit not found by ref-name match; checking it executed cleanly only.");
  }
  // Read a single asset back out of the stash.
  step("show", ["show", "memories/node-smoke-widget-memory-alpha"], { expect: '"type": "memory"' });
  // Health aggregates DB + artifacts; touches detection.
  // health exits 0 (ok) or 4 (EXIT_HEALTH_WARN) — a minimal fresh stash often
  // reports `status: "warn"` (e.g. semantic search not ready), which is a valid,
  // non-error outcome. Both prove the SQLite/runtime boundary works under Node.
  step("health", ["health"], { expect: '"shape": "health"', allowExitCodes: [4] });
  // spawnSync + writeResponseToFile (ripgrep download) + spawn agent detection.
  step("setup", ["setup", "--yes"], { expect: '"shape": "setup"', timeoutMs: 180_000 });
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\nnode-smoke: ${failures} step(s) FAILED under node.`);
  process.exit(1);
}
console.log(`\nnode-smoke: all ${stepNo} steps passed under node.`);
