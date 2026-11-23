#!/usr/bin/env bun
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Record the reference-compatibility corpus from a pre-refactor tree.
 *
 *   bun scripts/record-reference-compat.ts <rev> [--worktree-dir <dir>]      # e.g. 1f2e58c9
 *
 * Checks `<rev>` out as a temporary git worktree (under `--worktree-dir`, default `$TMPDIR`), runs its `bun src/cli.ts` once to create the
 * 0.10 `state.db` schema, freezes that schema plus the corpus rows as `tests/fixtures/reference-compat/state.sql`,
 * runs every corpus command against a fresh sandbox (own HOME and XDG directories) and writes what it printed to
 * `tests/fixtures/reference-compat/expected.json`. The worktree and the sandboxes are removed afterwards.
 *
 * Recording twice from the same `<rev>` gives byte-identical files. `tests/integration/reference-compat.test.ts`
 * runs the same commands against the working tree and compares. See `tests/fixtures/reference-compat/harness.ts` for
 * the commands and for exactly what is normalised.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSandbox, FIXTURE_DIR, recordStateSql, runCorpus } from "../tests/fixtures/reference-compat/harness";

const repoRoot = path.resolve(import.meta.dir, "..");

function git(args: string[], cwd = repoRoot): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout.trim();
}

function main(): void {
  const args = process.argv.slice(2);
  const flag = args.indexOf("--worktree-dir");
  const worktreeParent = flag >= 0 ? path.resolve(args.splice(flag, 2)[1] ?? "") : os.tmpdir();
  const rev = args[0];
  if (!rev) {
    console.error("usage: bun scripts/record-reference-compat.ts <rev> [--worktree-dir <dir>]");
    process.exit(2);
  }
  const commit = git(["rev-parse", "--verify", `${rev}^{commit}`]);
  // The sandboxes stay under the system temp directory: a scheduler row's length depends on their paths.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "akm-rc-"));
  const treeParent = fs.mkdtempSync(path.join(worktreeParent, "akm-rc-tree-"));
  const worktree = path.join(treeParent, "tree");
  try {
    git(["worktree", "add", "--detach", worktree, commit]);
    // The tree runs with this checkout's dependencies; the recorded commits do not change them.
    fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(worktree, "node_modules"));

    const stateSql = recordStateSql(worktree, path.join(scratch, "state-sandbox"));
    fs.writeFileSync(path.join(FIXTURE_DIR, "state.sql"), stateSql);

    const sandbox = buildSandbox(path.join(scratch, "run-sandbox"), worktree, stateSql);
    const results = runCorpus(sandbox, (id) => process.stderr.write(`  ${id}\n`));
    fs.writeFileSync(
      path.join(FIXTURE_DIR, "expected.json"),
      `${JSON.stringify({ recordedFrom: commit, results }, null, 2)}\n`,
    );
    console.error(`recorded ${Object.keys(results).length} results from ${commit}`);
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", worktree], { cwd: repoRoot });
    spawnSync("git", ["worktree", "prune"], { cwd: repoRoot });
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.rmSync(treeParent, { recursive: true, force: true });
  }
}

main();
