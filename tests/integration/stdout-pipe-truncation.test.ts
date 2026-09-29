// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Regression: a result document larger than the 64 KiB pipe buffer must reach
 * a piped stdout intact.
 *
 * FIELD REPORT: `akm config get … | python3 -c …` and `akm search … | head`
 * returned exactly 65,536 bytes — the Linux pipe-buffer size — while the same
 * command with `--output <file>` wrote the complete document. Reproduced on a
 * globally-installed 0.9.15 running under Bun.
 *
 * ROOT CAUSE: on Bun, once `process.stdout` has been materialized as a
 * Node-compat stream — which the CLI does unconditionally (`--help` /
 * `hints` write through it, `src/output/context.ts` reads `isTTY`) —
 * `console.log(bigString)` issues a SINGLE `write(2)` on a non-blocking fd 1
 * and silently discards whatever the kernel did not accept. A pipe accepts at
 * most one buffer's worth (65,536 bytes on Linux), so everything past that is
 * lost. `process.stdout.write()` on the same fd handles the short write
 * correctly, and both runtimes keep the process alive until the write drains.
 * Node's `console.log` is unaffected; the CLI now uses `writeStdout()`
 * (src/output/stdout.ts) on both document paths so neither runtime can
 * truncate.
 *
 * WHY A SHELL PIPELINE AND NOT `spawnSync(cli)` DIRECTLY: the truncation needs
 * a real `pipe(2)` on the child's fd 1. Bun's `child_process` wires a spawned
 * child's stdio to a socketpair, whose buffer is large enough to swallow the
 * whole document in one write — so a direct spawn CANNOT observe this bug (it
 * returned the full document even against the broken build). `/bin/sh -c '… |
 * cat'` gives the CLI the same real pipe a user's `| python3` does, which
 * reproduces deterministically: without the fix every case below returns
 * exactly 65,536 bytes.
 *
 * Integration-scoped (ORG-03/06): spawns real child processes.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { makeSandboxDir, makeStashDir, type SandboxedDir } from "../_helpers/sandbox";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const BUN_ENTRY = path.join(REPO_ROOT, "src", "cli.ts");
/** Built by `bun run build`; absent in a plain checkout, so the Node case self-skips. */
const NODE_ENTRY = path.join(REPO_ROOT, "dist", "cli-node.mjs");

/** Linux pipe-buffer size — the exact byte count the field report truncated at. */
const PIPE_BUFFER_BYTES = 65_536;
const REF = "knowledge/pipe-truncation-fixture.md";

/** A body big enough that the rendered envelope clears 64 KiB with room to spare. */
const FIXTURE_BODY =
  `${"Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor. ".repeat(40)}\n`.repeat(30);

// Every akm directory is passed to the CHILD's env only — `process.env` in the
// test process is never touched, so the preload's leaked-env tripwire stays
// quiet while a single `beforeAll` fixture serves all four cases.
let stash: SandboxedDir;
let xdg: SandboxedDir;
let childEnv: Record<string, string>;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

interface PipedRun {
  stdout: string;
  stderr: string;
}

/**
 * Run the CLI with stdout connected to a real `pipe(2)` (see the file header
 * for why this cannot be a direct `spawnSync` of the CLI) and return every
 * byte that survived the pipe.
 */
function runPiped(runtime: string, entry: string, args: string[]): PipedRun {
  const command = [runtime, entry, ...args].map(shellQuote).join(" ");
  const result = spawnSync("/bin/sh", ["-c", `${command} | cat`], {
    cwd: REPO_ROOT,
    env: childEnv,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

/** The same command's document written straight to a file — the untruncated reference. */
function runToFile(args: string[]): string {
  const target = path.join(xdg.dir, `expected-${Math.random().toString(36).slice(2)}.txt`);
  const result = spawnSync("bun", [BUN_ENTRY, ...args, "--output", target], {
    cwd: REPO_ROOT,
    env: childEnv,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (!fs.existsSync(target)) throw new Error(`--output produced no file. stderr: ${result.stderr}`);
  return fs.readFileSync(target, "utf8");
}

beforeAll(() => {
  stash = makeStashDir();
  xdg = makeSandboxDir("akm-pipe-trunc");
  childEnv = {
    ...process.env,
    AKM_BUNDLE_DIR: stash.dir,
    XDG_DATA_HOME: path.join(xdg.dir, "data"),
    XDG_CACHE_HOME: path.join(xdg.dir, "cache"),
    XDG_CONFIG_HOME: path.join(xdg.dir, "config"),
    XDG_STATE_HOME: path.join(xdg.dir, "state"),
    NO_COLOR: "1",
    CI: "1",
  } as Record<string, string>;

  fs.writeFileSync(
    path.join(stash.dir, "knowledge", "pipe-truncation-fixture.md"),
    `---\nname: Pipe Truncation Fixture\ntype: knowledge\nupdated: 2026-01-01\n---\n\n# Pipe Truncation Fixture\n\n${FIXTURE_BODY}`,
  );
  const indexed = spawnSync("bun", [BUN_ENTRY, "index"], {
    cwd: REPO_ROOT,
    env: childEnv,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (indexed.status !== 0) throw new Error(`fixture index failed: ${indexed.stderr}`);
});

afterAll(() => {
  stash?.cleanup();
  xdg?.cleanup();
});

// `/bin/sh` and `cat` are the pipe harness; neither exists on Windows.
describe.skipIf(process.platform === "win32")("large result documents survive a piped stdout", () => {
  test("`show --detail full` is not truncated at the pipe buffer under bun", () => {
    const args = ["show", REF, "--detail", "full"];
    const { stdout, stderr } = runPiped("bun", BUN_ENTRY, args);

    expect(stdout.length).toBeGreaterThan(PIPE_BUFFER_BYTES);
    expect(stdout.length).not.toBe(PIPE_BUFFER_BYTES);
    // A truncated document is not parseable — this is what the field report hit.
    const parsed = JSON.parse(stdout) as { ok?: boolean; shape?: string };
    expect(parsed.ok).not.toBe(false);
    expect(stderr).not.toContain("Unhandled rejection");
  });

  test("piped stdout is byte-identical to the same document written with --output", () => {
    const args = ["show", REF, "--detail", "full"];
    // Guards the fix against changing output formats: the bytes a pipe gets and
    // the bytes `--output` writes must stay the same document.
    expect(runPiped("bun", BUN_ENTRY, args).stdout).toBe(runToFile(args));
  });

  test("a jsonl line longer than the pipe buffer survives intact", () => {
    // `--format jsonl` has its own writer (`outputJsonl`) and always goes to
    // stdout — `--output` is not an escape hatch there, so it needs its own case.
    const { stdout } = runPiped("bun", BUN_ENTRY, ["show", REF, "--detail", "full", "--format", "jsonl"]);

    expect(stdout.length).toBeGreaterThan(PIPE_BUFFER_BYTES);
    const lines = stdout.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    expect(() => JSON.parse(lines[0] as string)).not.toThrow();
  });

  // Node's `console.log` never truncated; this proves the fix did not regress
  // the runtime that was already correct. Needs `bun run build` for dist/.
  test.skipIf(!fs.existsSync(NODE_ENTRY))("`show --detail full` is not truncated under node", () => {
    const { stdout } = runPiped("node", NODE_ENTRY, ["show", REF, "--detail", "full"]);

    expect(stdout.length).toBeGreaterThan(PIPE_BUFFER_BYTES);
    expect(() => JSON.parse(stdout)).not.toThrow();
  });
});
