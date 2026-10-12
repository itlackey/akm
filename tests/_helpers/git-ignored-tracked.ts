// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function git(repoDir: string, ...args: string[]): void {
  const result = spawnSync("git", ["-C", repoDir, "-c", "user.name=test", "-c", "user.email=t@t", ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

/**
 * The shape of a real stash whose `.gitignore` lists `.akm/evals/runs/` after files under it were
 * already committed: tracked files inside an ignored directory, one a `latest` symlink that flips
 * after every eval run. Commits the baseline, then edits the tracked files (the symlink among
 * them) and adds a normal managed file `skills/skill.md`, so the tree holds both kinds of change.
 */
export function seedIgnoredTrackedChanges(repoDir: string): void {
  const runs = path.join(repoDir, ".akm", "evals", "runs");
  fs.mkdirSync(path.join(runs, "run-1"), { recursive: true });
  fs.mkdirSync(path.join(runs, "run-2"), { recursive: true });
  fs.writeFileSync(path.join(runs, "run-1", "report.md"), "one\n");
  fs.writeFileSync(path.join(runs, "run-2", "report.md"), "two\n");
  fs.symlinkSync("run-1", path.join(runs, "latest"));
  fs.writeFileSync(path.join(repoDir, ".gitignore"), ".akm/evals/runs/\n.akm/evals/runs/latest\n");
  git(repoDir, "add", "-f", ".gitignore", ".akm/evals/runs");
  git(repoDir, "commit", "-m", "baseline");

  fs.rmSync(path.join(runs, "latest"));
  fs.symlinkSync("run-2", path.join(runs, "latest"));
  fs.writeFileSync(path.join(runs, "run-1", "report.md"), "one, edited\n");
  fs.mkdirSync(path.join(repoDir, "skills"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "skills", "skill.md"), "# Test\n");
}
