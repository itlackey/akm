// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A program akm runs keeps all of its output when akm's stdout is a pipe or a socket read slowly, and
 * a command that runs after akm in the same pipe keeps its output too.
 *
 * Bun sets O_NONBLOCK on the pipe or socket behind fd 1 when `process.stdout` is first used. A child that
 * inherits it shares that open file description, so its writes to a full pipe fail with EAGAIN and output
 * is lost, and the flag stays set on the caller's pipe after akm exits. Real subprocess tests: the
 * in-process harness cannot show it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type Cleanup, makeSandboxDir, sandboxStashDir, writeSandboxConfig } from "../_helpers/sandbox";

const CLI = path.resolve(import.meta.dir, "../../src/cli.ts");
const LINES = 3_000_000;
const O_NONBLOCK = 0o4000;
const hasPython = process.platform === "linux" && spawnSync("python3", ["--version"]).status === 0;

// Runs `sh -c <command>` with stdout a pipe or a socketpair, reads nothing for 2 s, then counts what arrives.
const READ_LATE = `
import os, socket, subprocess, sys, time
kind, command = sys.argv[1], sys.argv[2]
if kind == "socket":
    reader, writer = socket.socketpair()
    read = lambda n: reader.recv(n)
    writer_fd = writer.fileno()
else:
    r, writer_fd = os.pipe()
    read = lambda n: os.read(r, n)
child = subprocess.Popen(["sh", "-c", command], stdin=subprocess.DEVNULL, stdout=writer_fd, stderr=subprocess.DEVNULL)
os.close(writer_fd)
time.sleep(2)
count = 0
while True:
    chunk = read(1 << 16)
    if not chunk:
        break
    count += chunk.count(b"\\n")
child.wait()
print(count)
`;

let dirs: Cleanup[] = [];
let stashDir = "";
let flagsFile = "";
let driver = "";

beforeEach(() => {
  const stash = sandboxStashDir();
  dirs.push(stash.cleanup);
  stashDir = stash.dir;
  writeSandboxConfig({ semanticSearchMode: "off", experimental: { exec: true } });
  const work = makeSandboxDir("akm-stdio");
  dirs.push(work.cleanup);
  flagsFile = path.join(work.dir, "flags");
  driver = path.join(work.dir, "read-late.py");
  fs.writeFileSync(driver, READ_LATE);
  fs.mkdirSync(path.join(stashDir, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(stashDir, "scripts", "big.sh"),
    `#!/bin/sh\nawk '/flags/ {print $2}' /proc/$$/fdinfo/1 > "${flagsFile}"\nseq 1 ${LINES}\n`,
    { mode: 0o755 },
  );
  fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
  fs.writeFileSync(path.join(stashDir, "env", "e.env"), "A=1\n");
});

afterEach(() => {
  for (const cleanup of dirs.reverse()) cleanup();
  dirs = [];
});

function lineCount(kind: "pipe" | "socket", command: string): number {
  const result = spawnSync("python3", [driver, kind, command], {
    encoding: "utf8",
    env: process.env,
    timeout: 120_000,
  });
  expect(result.status).toBe(0);
  return Number(result.stdout.trim());
}

const akm = (args: string): string => `bun ${CLI} ${args}`;

describe.skipIf(!hasPython)("a slow reader of akm's stdout", () => {
  for (const kind of ["pipe", "socket"] as const) {
    test(`gets every line a script writes, and the script sees a blocking fd 1 (${kind})`, () => {
      expect(lineCount(kind, akm("run scripts/big.sh"))).toBe(LINES);
      const flags = Number.parseInt(fs.readFileSync(flagsFile, "utf8").trim(), 8);
      expect(flags & O_NONBLOCK).toBe(0);
    });

    test(`gets every line of a command run after akm in the same ${kind}`, () => {
      expect(lineCount(kind, `${akm("--version")}; seq 1 ${LINES}`)).toBe(LINES + 1);
    });

    test(`gets every line from akm exec and akm env run (${kind})`, () => {
      expect(lineCount(kind, akm(`exec -- seq 1 ${LINES}`))).toBe(LINES);
      expect(lineCount(kind, akm(`env run env/e -- seq 1 ${LINES}`))).toBe(LINES);
    });
  }
});
