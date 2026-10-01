// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `saveGitStash` (the end-of-run sync and `akm sync`) always commits the paths it
 * is given. A branch it cannot push — no upstream, or behind or diverged from it —
 * only skips the push, and the result says why. A branch that is ahead of its
 * upstream (an accept commits locally) is pushed along with the new commit.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveGitStash } from "../../../src/sources/providers/git";

const tempDirs: string[] = [];
let remoteDir = "";
let workDir = "";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  expect(result.status).toBe(0);
  return result.stdout.replace(/\n$/, "");
}

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Commit `file` in `cwd` and return its subject, the way a person (or another machine) would. */
function commitFile(cwd: string, file: string, subject: string): void {
  fs.writeFileSync(path.join(cwd, file), `${subject}\n`);
  git(cwd, "add", file);
  git(cwd, "commit", "-m", subject);
}

function configure(cwd: string): void {
  git(cwd, "config", "user.email", "test@akm.local");
  git(cwd, "config", "user.name", "akm test");
}

/** A work tree on `main` with one pushed seed commit; `track: false` leaves it without an upstream. */
function setup(track: boolean): void {
  remoteDir = tempDir("akm-oos-remote-");
  workDir = tempDir("akm-oos-work-");
  git(remoteDir, "init", "--bare", "--initial-branch=main");
  git(workDir, "init", "--initial-branch=main");
  configure(workDir);
  git(workDir, "remote", "add", "origin", remoteDir);
  commitFile(workDir, "README.md", "seed");
  if (track) git(workDir, "push", "-u", "origin", "main");
}

/** The remote moves on without the work tree, which then fetches (so it knows it is behind). */
function advanceRemote(): void {
  const other = tempDir("akm-oos-other-");
  git(other, "clone", remoteDir, ".");
  configure(other);
  commitFile(other, "elsewhere.md", "pushed from elsewhere");
  git(other, "push", "origin", "main");
  git(workDir, "fetch", "origin");
}

const save = () => {
  fs.writeFileSync(path.join(workDir, "run.md"), "run output\n");
  return saveGitStash(undefined, "end of run", true, { repoDir: workDir, paths: ["run.md"] });
};
const remoteSubject = () => git(remoteDir, "log", "-1", "--format=%s", "main");

beforeEach(() => {
  remoteDir = "";
  workDir = "";
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("saveGitStash with a branch it cannot push", () => {
  test("no upstream: commits and skips the push, saying so", () => {
    setup(false);

    const result = save();

    expect(result).toMatchObject({ committed: true, pushed: false, skipped: false });
    expect(result.reason).toContain("no upstream");
    expect(git(workDir, "log", "-1", "--format=%s")).toBe("end of run");
  });

  test("behind its upstream: commits and skips the push, leaving the remote as it is", () => {
    setup(true);
    advanceRemote();

    const result = save();

    expect(result).toMatchObject({ committed: true, pushed: false, skipped: false });
    expect(result.reason).toContain("behind");
    expect(git(workDir, "log", "-1", "--format=%s")).toBe("end of run");
    expect(remoteSubject()).toBe("pushed from elsewhere");
  });

  test("diverged from its upstream: commits and skips the push", () => {
    setup(true);
    commitFile(workDir, "local.md", "local commit");
    advanceRemote();

    const result = save();

    expect(result).toMatchObject({ committed: true, pushed: false });
    expect(result.reason).toContain("diverged");
    expect(remoteSubject()).toBe("pushed from elsewhere");
  });

  test("ahead of its upstream: pushes the new commit together with the unpushed ones", () => {
    setup(true);
    commitFile(workDir, "local.md", "local commit");

    const result = save();

    expect(result).toMatchObject({ committed: true, pushed: true });
    expect(result.reason).toBeUndefined();
    expect(remoteSubject()).toBe("end of run");
    expect(git(remoteDir, "log", "--format=%s", "main")).toContain("local commit");
  });
});
