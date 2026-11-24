// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Temp git-repo fixtures for the worktree integration suites. Real `git` only
 * — callers gate on `isGitAvailable()` and skip when it is absent.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Run a git command in `cwd`; throws on a non-zero exit, returns stdout. */
export function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 15_000 });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout ?? "";
}

export interface MakeGitRepoOptions {
  /** mkdtemp prefix for the repo dir (helps attribute leftovers to a suite). */
  prefix?: string;
  /** Called with the new repo dir so the suite can schedule its removal. */
  register?: (dir: string) => void;
  /**
   * Init here instead of a fresh mkdtemp dir (created if absent). For a suite
   * whose repo has to live at a path it already owns — an isolated storage
   * sandbox it cleans up wholesale.
   */
  dir?: string;
}

/** Init a temp git repo with one committed file (`README.md`). */
export function makeGitRepo(options: MakeGitRepoOptions = {}): string {
  const dir = options.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), options.prefix ?? "akm-git-repo-"));
  fs.mkdirSync(dir, { recursive: true });
  options.register?.(dir);
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@akm.invalid"]);
  git(dir, ["config", "user.name", "akm-test"]);
  // A developer or CI runner with `commit.gpgsign = true` in their own git
  // config would otherwise fail every fixture commit here.
  git(dir, ["config", "commit.gpgsign", "false"]);
  // From git 2.47 a commit ends by starting `git maintenance run --auto` detached: it can still hold
  // `.git/objects/maintenance.lock` after the commit returns, so a test that then removes or rewrites `.git` races it
  // (an ENOENT from `rmSync(".git")` on CI). No fixture commit may leave a git process running behind it.
  git(dir, ["config", "maintenance.auto", "false"]);
  fs.writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-q", "-m", "fixture"]);
  return dir;
}
