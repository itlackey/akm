// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #1291 end-to-end: `akm health` checks every configured git-backed bundle for
 * tracked env/secret files with a remote, not just the working stash, and each
 * bundle's own `.gitignore` marker acknowledges its intentional tracking.
 *
 * Integration: spawns real `git` (no network: the remote is never contacted).
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { akmHealth } from "../../../src/commands/health";
import { STASH_GITIGNORE_TRACK_SECRETS_MARKER } from "../../../src/commands/sources/stash-skeleton";
import { makeSandboxDir, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

function git(dir: string, args: string[]): void {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  expect(result.status, `git ${args.join(" ")}: ${result.stderr}`).toBe(0);
}

/** A git bundle with one tracked synthetic secret and a never-contacted remote. */
function exposedBundle(dir: string, gitignore?: string): void {
  fs.mkdirSync(path.join(dir, "secrets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "secrets", "example.key"), "");
  if (gitignore !== undefined) fs.writeFileSync(path.join(dir, ".gitignore"), gitignore);
  git(dir, ["init", "--initial-branch=main"]);
  git(dir, ["add", "-A"]);
  git(dir, [
    "-c",
    "user.name=akm-test",
    "-c",
    "user.email=akm@test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "x",
  ]);
  git(dir, ["remote", "add", "origin", "https://example.org/team/knowledge.git"]);
}

describe("stash-git-exposure across bundles (#1291)", () => {
  test("warns for each exposed bundle and skips one whose .gitignore acknowledges tracking", async () => {
    const storage = withIsolatedAkmStorage();
    const team = makeSandboxDir("akm-exposure-team");
    const acknowledged = makeSandboxDir("akm-exposure-private");
    try {
      exposedBundle(storage.stashDir);
      exposedBundle(team.dir);
      exposedBundle(acknowledged.dir, `${STASH_GITIGNORE_TRACK_SECRETS_MARKER}\n`);
      writeSandboxConfig({
        semanticSearchMode: "off",
        defaultBundle: "stash",
        bundles: {
          stash: { path: storage.stashDir },
          team: { path: team.dir },
          acknowledged: { path: acknowledged.dir },
        },
      });

      const result = await akmHealth({ since: "7d" });
      const roots = result.advisories
        .filter((check) => check.name === "stash-git-exposure")
        .map((check) => fs.realpathSync((check.evidence as { bundleRoot: string }).bundleRoot))
        .sort();
      expect(roots).toEqual([fs.realpathSync(storage.stashDir), fs.realpathSync(team.dir)].sort());
    } finally {
      acknowledged.cleanup();
      team.cleanup();
      storage.cleanup();
    }
  }, 60_000);
});
