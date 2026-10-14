// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Two hosts share one bare remote (a filesystem-kind git bundle on each). `saveGitStash`
 * (`akm sync`) fetches before it pushes, so a remote that another host moved is brought in:
 * fast-forward when it can, a plain `git merge` otherwise. A merge that conflicts is aborted,
 * the local commit stays, and only the push is skipped.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitStashPushError, saveGitStash } from "../../../src/sources/providers/git";

const tempDirs: string[] = [];

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

function configure(cwd: string): void {
  git(cwd, "config", "user.email", "test@akm.local");
  git(cwd, "config", "user.name", "akm test");
}

function commitFile(cwd: string, file: string, content: string, subject: string): void {
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, "add", file);
  git(cwd, "commit", "-m", subject);
}

/** A bare remote seeded with `shared.md`, and hosts A and B cloned from it. */
function setup(): { remote: string; a: string; b: string } {
  const remote = tempDir("akm-two-host-remote-");
  git(remote, "init", "--bare", "--initial-branch=main");
  const seed = tempDir("akm-two-host-seed-");
  git(seed, "init", "--initial-branch=main");
  configure(seed);
  git(seed, "remote", "add", "origin", remote);
  commitFile(seed, "shared.md", "one\ntwo\nthree\n", "seed");
  git(seed, "push", "-u", "origin", "main");
  const a = tempDir("akm-two-host-a-");
  const b = tempDir("akm-two-host-b-");
  for (const host of [a, b]) {
    git(host, "clone", remote, ".");
    configure(host);
  }
  return { remote, a, b };
}

const syncA = (a: string, file: string, content: string) => {
  fs.writeFileSync(path.join(a, file), content);
  return saveGitStash(undefined, "host A sync", true, { repoDir: a, paths: [file] });
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("saveGitStash across two hosts", () => {
  test("B pushed first: A fetches, merges, and pushes, so both hosts converge", () => {
    const { remote, a, b } = setup();
    commitFile(b, "from-b.md", "b\n", "host B change");
    git(b, "push", "origin", "main");

    const result = syncA(a, "from-a.md", "a\n");

    expect(result).toMatchObject({ committed: true, pushed: true, skipped: false });
    expect(result.reason).toBeUndefined();
    expect(fs.readFileSync(path.join(a, "from-b.md"), "utf8")).toBe("b\n");
    expect(git(remote, "rev-parse", "main")).toBe(git(a, "rev-parse", "HEAD"));
    const subjects = git(remote, "log", "--format=%s", "main");
    expect(subjects).toContain("host A sync");
    expect(subjects).toContain("host B change");

    // B picks A's change up with its own sync, which has nothing to commit.
    const second = saveGitStash(undefined, "host B sync", true, { repoDir: b });
    expect(second).toMatchObject({ committed: false, pushed: false });
    expect(fs.readFileSync(path.join(b, "from-a.md"), "utf8")).toBe("a\n");
  });

  test("a different file edited on both hosts merges cleanly", () => {
    const { remote, a, b } = setup();
    commitFile(b, "b-only.md", "b\n", "host B change");
    git(b, "push", "origin", "main");
    commitFile(a, "a-local.md", "a\n", "host A earlier commit");

    const result = syncA(a, "run.md", "run\n");

    expect(result).toMatchObject({ committed: true, pushed: true });
    expect(git(remote, "rev-parse", "main")).toBe(git(a, "rev-parse", "HEAD"));
    expect(git(remote, "log", "--format=%s", "main")).toContain("host A earlier commit");
  });

  test("fast-forward only: a clean host B receives A's push without committing anything", () => {
    const { remote, a, b } = setup();
    commitFile(a, "from-a.md", "a\n", "host A change");
    git(a, "push", "origin", "main");
    const before = git(b, "rev-parse", "HEAD");

    const result = saveGitStash(undefined, "host B sync", true, { repoDir: b });

    expect(result).toMatchObject({ committed: false, pushed: false, skipped: false });
    expect(result.output).toContain("fast-forward");
    expect(git(b, "rev-parse", "HEAD")).toBe(git(remote, "rev-parse", "main"));
    expect(git(b, "rev-parse", "HEAD")).not.toBe(before);
    expect(git(b, "status", "--porcelain")).toBe("");
  });

  test("conflicting edit: the merge is aborted, the local commit stays, only the push is skipped", () => {
    const { remote, a, b } = setup();
    commitFile(b, "shared.md", "one\nTWO FROM B\nthree\n", "host B edits shared");
    git(b, "push", "origin", "main");
    const remoteBefore = git(remote, "rev-parse", "main");

    const result = syncA(a, "shared.md", "one\nTWO FROM A\nthree\n");

    expect(result).toMatchObject({ committed: true, pushed: false, skipped: false });
    expect(result.reason).toContain("not pushed:");
    expect(result.reason).toContain("conflict");
    expect(result.reason).toContain("shared.md");
    expect(git(a, "log", "-1", "--format=%s")).toBe("host A sync");
    expect(git(a, "rev-parse", "HEAD")).toBe(result.commit as string);
    expect(fs.readFileSync(path.join(a, "shared.md"), "utf8")).toBe("one\nTWO FROM A\nthree\n");
    expect(git(a, "status", "--porcelain")).toBe("");
    expect(fs.existsSync(path.join(a, ".git", "MERGE_HEAD"))).toBe(false);
    expect(git(remote, "rev-parse", "main")).toBe(remoteBefore);
  });

  test("the remote cannot be fetched: commits and skips the push, saying so", () => {
    const { remote, a } = setup();
    git(a, "remote", "set-url", "origin", path.join(remote, "missing"));

    const result = syncA(a, "run.md", "run\n");

    expect(result).toMatchObject({ committed: true, pushed: false, skipped: false });
    expect(result.reason).toContain("not pushed:");
    expect(result.reason).toContain("fetch");
  });

  test("--no-push does not touch the remote", () => {
    const { remote, a, b } = setup();
    commitFile(b, "from-b.md", "b\n", "host B change");
    git(b, "push", "origin", "main");
    fs.writeFileSync(path.join(a, "run.md"), "run\n");

    const result = saveGitStash(undefined, "host A sync", true, { repoDir: a, paths: ["run.md"], push: false });

    expect(result).toMatchObject({ committed: true, pushed: false });
    expect(fs.existsSync(path.join(a, "from-b.md"))).toBe(false);
    expect(git(remote, "log", "-1", "--format=%s", "main")).toBe("host B change");
  });

  describe("a clean tree with a commit made earlier and never pushed", () => {
    test("is pushed, and reported as pushed", () => {
      const { remote, a } = setup();
      commitFile(a, "earlier.md", "x\n", "committed outside akm sync");

      const result = saveGitStash(undefined, "host A sync", true, { repoDir: a });

      expect(result).toMatchObject({ committed: false, pushed: true, skipped: false });
      expect(result.output).toBeTruthy();
      expect(git(remote, "rev-parse", "main")).toBe(git(a, "rev-parse", "HEAD"));
      expect(git(a, "status", "-sb")).not.toContain("ahead");
    });

    test("is pushed with the paths-scoped form the improve and accept callers use", () => {
      const { remote, a } = setup();
      commitFile(a, "earlier.md", "x\n", "committed outside akm sync");

      const result = saveGitStash(undefined, "host A sync", true, { repoDir: a, paths: ["nothing-changed.md"] });

      expect(result).toMatchObject({ committed: false, pushed: true });
      expect(git(remote, "rev-parse", "main")).toBe(git(a, "rev-parse", "HEAD"));
    });

    test("is pushed after a merge brings in another host's commit", () => {
      const { remote, a, b } = setup();
      commitFile(b, "from-b.md", "b\n", "host B change");
      git(b, "push", "origin", "main");
      commitFile(a, "earlier.md", "x\n", "committed outside akm sync");

      const result = saveGitStash(undefined, "host A sync", true, { repoDir: a });

      expect(result).toMatchObject({ committed: false, pushed: true });
      expect(git(remote, "rev-parse", "main")).toBe(git(a, "rev-parse", "HEAD"));
      expect(git(remote, "log", "--format=%s", "main")).toContain("committed outside akm sync");
    });

    test("--no-push (push: false) leaves it unpushed", () => {
      const { remote, a } = setup();
      const remoteBefore = git(remote, "rev-parse", "main");
      commitFile(a, "earlier.md", "x\n", "committed outside akm sync");

      const result = saveGitStash(undefined, "host A sync", true, { repoDir: a, push: false });

      expect(result).toMatchObject({ committed: false, pushed: false });
      expect(git(remote, "rev-parse", "main")).toBe(remoteBefore);
    });

    test("a read-only bundle leaves it unpushed", () => {
      const { remote, a } = setup();
      const remoteBefore = git(remote, "rev-parse", "main");
      commitFile(a, "earlier.md", "x\n", "committed outside akm sync");

      const result = saveGitStash(undefined, "host A sync", false, { repoDir: a });

      expect(result).toMatchObject({ committed: false, pushed: false });
      expect(git(remote, "rev-parse", "main")).toBe(remoteBefore);
    });

    test("a branch with no upstream is left alone", () => {
      const { remote, a } = setup();
      const remoteBefore = git(remote, "rev-parse", "main");
      commitFile(a, "earlier.md", "x\n", "committed outside akm sync");
      git(a, "branch", "--unset-upstream");

      const result = saveGitStash(undefined, "host A sync", true, { repoDir: a });

      expect(result).toMatchObject({ committed: false, pushed: false, skipped: false });
      expect(git(remote, "rev-parse", "main")).toBe(remoteBefore);
    });

    test("a detached HEAD is left alone and does not throw", () => {
      const { remote, a } = setup();
      const remoteBefore = git(remote, "rev-parse", "main");
      commitFile(a, "earlier.md", "x\n", "committed outside akm sync");
      git(a, "checkout", "--detach");

      const result = saveGitStash(undefined, "host A sync", true, { repoDir: a });

      expect(result).toMatchObject({ committed: false, pushed: false, skipped: false });
      expect(git(remote, "rev-parse", "main")).toBe(remoteBefore);
    });

    test("a rejected push throws GitStashPushError naming the unpushed head", () => {
      const { remote, a } = setup();
      const hook = path.join(remote, "hooks", "pre-receive");
      fs.writeFileSync(hook, "#!/bin/sh\necho rejected >&2\nexit 1\n", { mode: 0o755 });
      commitFile(a, "earlier.md", "x\n", "committed outside akm sync");

      let error: unknown;
      try {
        saveGitStash(undefined, "host A sync", true, { repoDir: a });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(GitStashPushError);
      expect((error as GitStashPushError).commit).toBe(git(a, "rev-parse", "HEAD"));
      // Nothing was committed by this call, so callers must not report a new commit.
      expect((error as GitStashPushError).committedNow).toBe(false);
    });
  });

  test("a clean tree that is not ahead pushes nothing", () => {
    const { remote, a } = setup();
    const remoteBefore = git(remote, "rev-parse", "main");

    const result = saveGitStash(undefined, "host A sync", true, { repoDir: a });

    expect(result).toMatchObject({ committed: false, pushed: false, skipped: false });
    expect(git(remote, "rev-parse", "main")).toBe(remoteBefore);
  });
});
