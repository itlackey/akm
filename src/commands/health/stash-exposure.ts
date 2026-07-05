// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `stash-git-exposure` surfaces advisory for `akm health` (08-F1).
 *
 * Versioning the stash is a supported use case (private-remote backup), so a
 * tracked `env/`/`secrets/` directory is NOT wrong by itself. The leak moment
 * is when secret assets are git-TRACKED **and** a remote is configured — only
 * then can a `git push` exfiltrate tokens/keys. Warn on exactly that
 * combination; stay silent on the tracked-but-no-remote opt-in so the advisory
 * catches the exposure without nagging the intentional backup.
 */

import { spawnSync } from "node:child_process";
import type { HealthCheckResult } from "./types";

/** Injectable git seam — real implementation shells out; tests supply a fake. */
export type GitRunner = (stashDir: string, args: string[]) => { ok: boolean; stdout: string };

const realGit: GitRunner = (stashDir, args) => {
  const result = spawnSync("git", ["-C", stashDir, ...args], { encoding: "utf8", timeout: 5_000 });
  return { ok: result.status === 0, stdout: (result.stdout ?? "").trim() };
};

/**
 * Build the `stash-git-exposure` advisory, or `undefined` when there is nothing
 * to warn about (not a git repo, no tracked env/secret assets, or no remote).
 */
export function collectStashExposureAdvisory(
  stashDir: string,
  git: GitRunner = realGit,
): HealthCheckResult | undefined {
  // Not a git work tree → nothing to expose.
  if (!git(stashDir, ["rev-parse", "--is-inside-work-tree"]).ok) return undefined;

  const tracked = git(stashDir, ["ls-files", "--", "env", "secrets"]);
  if (!tracked.ok || tracked.stdout.length === 0) return undefined; // no secret assets tracked

  const remotes = git(stashDir, ["remote"]);
  if (!remotes.ok || remotes.stdout.length === 0) return undefined; // no push target → no leak path

  const trackedFiles = tracked.stdout.split("\n").filter(Boolean);
  const preview =
    trackedFiles.slice(0, 5).join(", ") + (trackedFiles.length > 5 ? `, +${trackedFiles.length - 5} more` : "");
  return {
    name: "stash-git-exposure",
    kind: "deterministic",
    status: "warn",
    confidence: "high",
    message:
      `${trackedFiles.length} env/secret file(s) are git-tracked AND a remote is configured — ` +
      `a 'git push' can leak tokens/keys (${preview}). ` +
      "Run 'git rm --cached' on them (a .gitignore rule alone does NOT untrack already-tracked " +
      "files) and then add env/+secrets/ to .gitignore to prevent recurrence (akm init scaffolds it).",
    evidence: { trackedSecretFiles: trackedFiles },
  };
}
