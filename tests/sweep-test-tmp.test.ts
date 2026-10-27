// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The sweep of dead test runs' sandbox roots (`scripts/sweep-test-tmp.ts`): it
 * removes the roots a lease lists once the process that holds the lease is gone,
 * and nothing else. A directory that looks like a test root by name and age but
 * is on no lease, and a root whose process is still running, are left alone.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerTestRoot, sweepTestTmp } from "../scripts/sweep-test-tmp";
import { makeSandboxDir, withIsolatedAkmStorage } from "./_helpers/sandbox";

const DAY_MS = 24 * 60 * 60 * 1000;

let tmp: string;
let cleanup: () => void;

beforeEach(() => {
  ({ dir: tmp, cleanup } = makeSandboxDir("akm-sweep-fixture"));
});
afterEach(() => cleanup());

const leases = (): string => path.join(tmp, ".akm-test-leases");

/** A directory under the fixture tmp, an hour old or older. */
function oldDir(name: string): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "kept.txt"), "x");
  const old = new Date(Date.now() - 2 * DAY_MS);
  fs.utimesSync(dir, old, old);
  return dir;
}

/** The pid of a process that has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  if (child.pid === undefined) throw new Error("could not start a child process");
  return child.pid;
}

function lease(pid: number, ...dirs: string[]): void {
  fs.mkdirSync(leases(), { recursive: true });
  fs.writeFileSync(path.join(leases(), String(pid)), `${dirs.join("\n")}\n`);
}

describe("sweepTestTmp", () => {
  test("removes the roots a dead process leased, and its lease", () => {
    const first = oldDir("akm-test-suite-dead1");
    const second = oldDir("akm-iso-0-dead2");
    lease(deadPid(), first, second);

    expect(sweepTestTmp(tmp)).toBe(2);

    expect(fs.existsSync(first)).toBe(false);
    expect(fs.existsSync(second)).toBe(false);
    expect(fs.readdirSync(leases())).toEqual([]);
  });

  test("leaves an old akm-* directory that no lease lists, however much it looks like a test root", () => {
    const unrelated = oldDir("akm-review-tools");
    const scratch = oldDir("akm-model-work-abc123");
    const suiteLike = oldDir("akm-test-suite-abc123");
    lease(deadPid(), oldDir("akm-iso-1-dead"));

    expect(sweepTestTmp(tmp)).toBe(1);

    for (const dir of [unrelated, scratch, suiteLike]) expect(fs.existsSync(path.join(dir, "kept.txt"))).toBe(true);
  });

  test("leaves an old root whose process is still running, and keeps its lease", () => {
    const active = oldDir("akm-test-suite-active");
    lease(process.pid, active);

    expect(sweepTestTmp(tmp)).toBe(0);

    expect(fs.existsSync(path.join(active, "kept.txt"))).toBe(true);
    expect(fs.readdirSync(leases())).toEqual([String(process.pid)]);
  });

  test("removes only what a lease names and only directly under the temp dir", () => {
    const outside = makeSandboxDir("akm-outside");
    try {
      const nested = path.join(oldDir("akm-outer"), "inner");
      fs.mkdirSync(nested);
      const file = path.join(tmp, "akm-a-file");
      fs.writeFileSync(file, "x");
      lease(deadPid(), outside.dir, nested, file, path.join(tmp, "akm-absent"), "relative/path", "");

      expect(sweepTestTmp(tmp)).toBe(0);

      for (const kept of [outside.dir, nested, file]) expect(fs.existsSync(kept)).toBe(true);
    } finally {
      outside.cleanup();
    }
  });

  test("a name in the lease directory that is not a process id is not a lease", () => {
    const dir = oldDir("akm-iso-9-x");
    fs.mkdirSync(leases(), { recursive: true });
    fs.writeFileSync(path.join(leases(), "notes"), `${dir}\n`);
    fs.writeFileSync(path.join(leases(), "-5"), `${dir}\n`);

    expect(sweepTestTmp(tmp)).toBe(0);
    expect(fs.existsSync(dir)).toBe(true);
  });

  test("with no leases, or a temp dir that cannot be read, there is nothing to do", () => {
    expect(sweepTestTmp(tmp)).toBe(0);
    expect(sweepTestTmp(path.join(tmp, "absent"))).toBe(0);
  });
});

describe("the roots the test harness creates", () => {
  test("are leased to this process, so a sweep started by another run leaves them alone", () => {
    const leaseFile = path.join(os.tmpdir(), ".akm-test-leases", String(process.pid));
    const listed = (): string[] => fs.readFileSync(leaseFile, "utf8").split("\n");
    const storage = withIsolatedAkmStorage();
    try {
      expect(listed()).toContain(storage.root);
      // The suite root the preload made is listed too: that is what the sandbox's HOME lives in.
      expect(listed()).toContain(path.dirname(process.env.HOME ?? ""));
      expect(fs.existsSync(storage.root)).toBe(true);
    } finally {
      storage.cleanup();
    }
  });

  test("registerTestRoot adds one line per root to the lease of the calling process", () => {
    const leaseFile = path.join(os.tmpdir(), ".akm-test-leases", String(process.pid));
    registerTestRoot(path.join(os.tmpdir(), "akm-registered-for-the-test"));
    expect(fs.readFileSync(leaseFile, "utf8")).toContain("akm-registered-for-the-test\n");
  });
});
