// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `tracked-secrets` rule. Versioning a bundle is supported, so a tracked
 * `env/` or `secrets/` file is not wrong by itself. The leak moment is a
 * tracked file in a bundle that has a remote: only then can a `git push`
 * send tokens or keys away. Lint flags exactly that, one finding per tracked
 * file so each can be untracked or skipped (`lint.skip`) on its own.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { LintIssue } from "./types";

/** Injectable git seam: the real one shells out; tests supply a fake. */
export type GitRunner = (bundleRoot: string, args: string[]) => { ok: boolean; stdout: string };

const realGit: GitRunner = (bundleRoot, args) => {
  const result = spawnSync("git", ["-C", bundleRoot, ...args], { encoding: "utf8", timeout: 5_000 });
  return { ok: result.status === 0, stdout: (result.stdout ?? "").trim() };
};

/**
 * One finding per `env/` or `secrets/` file the git repository at `bundleRoot`
 * tracks, when the repository has a remote. Empty for a bundle without its own
 * `.git` (unless a `git` seam is given), without a remote, or with nothing tracked.
 */
export function trackedSecretIssues(bundleRoot: string, git: GitRunner = realGit): LintIssue[] {
  if (git === realGit && !fs.existsSync(path.join(bundleRoot, ".git"))) return [];
  if (!git(bundleRoot, ["rev-parse", "--is-inside-work-tree"]).ok) return [];
  const tracked = git(bundleRoot, ["ls-files", "--", "env", "secrets"]);
  if (!tracked.ok || tracked.stdout.length === 0) return [];
  const remotes = git(bundleRoot, ["remote"]);
  if (!remotes.ok || remotes.stdout.length === 0) return [];
  return tracked.stdout
    .split("\n")
    .filter(Boolean)
    .map((file) => ({
      file,
      issue: "tracked-secrets",
      detail: "tracked by git in a bundle with a remote, so a push can leak it",
      fixed: false,
    }));
}
