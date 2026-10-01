// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * An accepted proposal commits what it wrote, as it happens, whenever its stash
 * is a git repository: a filesystem stash with a `.git` too, which the boundary
 * commit skips. The commit is local (the end-of-run sync pushes), holds exactly
 * the accept's paths, and a failed commit only warns. Retire and cascade paths
 * are covered in proposal-retire.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmProposalAccept } from "../../../src/commands/proposal/proposal";
import { createProposal } from "../../../src/commands/proposal/repository";
import { _setWarnSinkForTests } from "../../../src/core/warn";
import { saveGitStash } from "../../../src/sources/providers/git";
import { makeConfig } from "../../_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

const LESSON = `---\ndescription: Use ripgrep before grep\nwhen_to_use: Searching large repos for patterns\n---\n\nPrefer rg over grep.\n`;

let storage: IsolatedAkmStorage;
const tempDirs: string[] = [];

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  fs.mkdirSync(path.join(storage.stashDir, "lessons"), { recursive: true });
});

afterEach(() => {
  _setWarnSinkForTests(undefined);
  storage.cleanup();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function run(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  expect(result.status).toBe(0);
  return result.stdout.replace(/\n$/, "");
}

const git = (...args: string[]) => run(storage.stashDir, ...args);

/** The stash becomes a git repository with one seed commit, tracking a bare remote when asked. */
function initRepo(options: { remote?: boolean } = {}): string | undefined {
  expect(spawnSync("git", ["init", "--initial-branch=main", storage.stashDir], { encoding: "utf8" }).status).toBe(0);
  git("config", "user.email", "test@akm.local");
  git("config", "user.name", "akm test");
  fs.writeFileSync(path.join(storage.stashDir, "README.md"), "seed\n");
  git("add", "README.md");
  git("commit", "-m", "seed");
  if (!options.remote) return undefined;
  const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-accept-remote-"));
  tempDirs.push(remoteDir);
  expect(spawnSync("git", ["init", "--bare", "--initial-branch=main", remoteDir], { encoding: "utf8" }).status).toBe(0);
  git("remote", "add", "origin", remoteDir);
  git("push", "-u", "origin", "main");
  return remoteDir;
}

function propose(ref: string) {
  return createProposal(storage.stashDir, {
    ref,
    source: "reflect",
    target: { source: "stash", root: storage.stashDir },
    payload: { content: LESSON, frontmatter: { description: "Use ripgrep before grep" } },
  });
}

const accept = (id: string) =>
  akmProposalAccept({ stashDir: storage.stashDir, id, config: makeConfig(storage.stashDir) });

describe("an accept into a stash that is a git repository", () => {
  test("commits exactly the accepted path with the accept's subject, and leaves other work alone", async () => {
    initRepo();
    fs.writeFileSync(path.join(storage.stashDir, "README.md"), "edited\n");
    fs.writeFileSync(path.join(storage.stashDir, "scratch.txt"), "wip\n");
    const proposal = propose("lessons/rg");

    const result = await accept(proposal.id);

    expect(git("log", "-1", "--format=%s")).toBe(`akm accept: reflect ${proposal.id.slice(0, 8)} ${result.ref}`);
    expect(git("show", "--name-only", "--format=", "HEAD")).toBe("lessons/rg.md");
    expect(git("status", "--porcelain").split("\n").sort()).toEqual([" M README.md", "?? scratch.txt"]);
  });

  test("commits locally: the remote only sees the accept once the end-of-run sync pushes it", async () => {
    const remoteDir = initRepo({ remote: true });
    const remoteSubject = () => run(remoteDir as string, "log", "-1", "--format=%s", "main");
    const proposal = propose("lessons/rg");

    const result = await accept(proposal.id);
    const subject = `akm accept: reflect ${proposal.id.slice(0, 8)} ${result.ref}`;
    expect(git("log", "-1", "--format=%s")).toBe(subject);
    expect(remoteSubject()).toBe("seed");

    // The branch is now ahead of its upstream, which must not stop the end-of-run push.
    fs.writeFileSync(path.join(storage.stashDir, "notes.md"), "run output\n");
    const sync = saveGitStash(undefined, "end of run", true, { repoDir: storage.stashDir, paths: ["notes.md"] });

    expect(sync).toMatchObject({ committed: true, pushed: true });
    expect(remoteSubject()).toBe("end of run");
    expect(run(remoteDir as string, "log", "--format=%s", "main")).toContain(subject);
  });

  test("a failed commit warns and the accept stands", async () => {
    initRepo();
    git("checkout", "--detach");
    const warnings: string[] = [];
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warnings.push(args.join(" "));
    });
    const proposal = propose("lessons/rg");

    const result = await accept(proposal.id);

    expect(result.proposal.status).toBe("accepted");
    expect(fs.existsSync(path.join(storage.stashDir, "lessons", "rg.md"))).toBe(true);
    expect(warnings.join("\n")).toContain("could not commit the accept");
    expect(git("log", "-1", "--format=%s")).toBe("seed");
  });
});

describe("an accept into a stash that is not a git repository", () => {
  test("writes the asset and leaves the directory without a repository", async () => {
    const proposal = propose("lessons/rg");

    const result = await accept(proposal.id);

    expect(result.proposal.status).toBe("accepted");
    expect(fs.existsSync(path.join(storage.stashDir, "lessons", "rg.md"))).toBe(true);
    expect(fs.existsSync(path.join(storage.stashDir, ".git"))).toBe(false);
  });
});
