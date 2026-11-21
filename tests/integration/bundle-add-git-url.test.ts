// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** A URL is never a registry id: `akm bundle add git://host:port/repo.git` adds a git bundle. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../../src/core/config/config";
import { readLockfile } from "../../src/integrations/lockfile";
import { runCliCapture } from "../_helpers/cli";
import { type GitDaemon, startGitDaemon } from "../_helpers/git-daemon";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let daemon: GitDaemon;

function git(args: string[]): void {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  const seed = path.join(storage.root, "seed");
  git(["init", "--initial-branch=main", seed]);
  git(["-C", seed, "config", "user.name", "AKM Test"]);
  git(["-C", seed, "config", "user.email", "akm@example.test"]);
  git(["-C", seed, "config", "commit.gpgsign", "false"]);
  fs.mkdirSync(path.join(seed, "knowledge"), { recursive: true });
  fs.writeFileSync(path.join(seed, "knowledge", "note.md"), "---\ndescription: a note\n---\n\n# A note\n");
  git(["-C", seed, "add", "-A"]);
  git(["-C", seed, "commit", "-m", "seed"]);
  git(["clone", "--bare", seed, path.join(storage.root, "remote.git")]);
  daemon = startGitDaemon(storage.root, "remote.git");
});

afterEach(() => {
  daemon.stop();
  storage.cleanup();
});

describe("akm bundle add <git:// URL>", () => {
  test("adds a git bundle without --provider", async () => {
    const result = await runCliCapture(["bundle", "add", `${daemon.baseUrl}/remote.git`, "--name", "gb"]);

    expect(result.code, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stderr).not.toContain("registry search result");
    expect(loadConfig().bundles?.gb).toBeDefined();
    expect(readLockfile().find((entry) => entry.id === "gb")?.source).toBe("git");
  }, 60_000);
});
