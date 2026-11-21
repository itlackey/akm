// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * An update that moves nothing reports the recorded install time: `installedAt` is the last real install, never
 * the time a check ran.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readLockfile } from "../../src/integrations/lockfile";
import { getLockfilePath } from "../../src/core/paths";
import { runCliCapture } from "../_helpers/cli";
import { type GitDaemon, startGitDaemon } from "../_helpers/git-daemon";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let daemon: GitDaemon;

function git(args: string[]): void {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
}

async function bundle<T>(...args: string[]): Promise<T> {
  const result = await runCliCapture(["bundle", ...args, "--format=json"]);
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as T;
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

describe("bundle update of a writable git bundle with no upstream change", () => {
  test("reports the lock's installedAt twice and leaves akm.lock byte for byte", async () => {
    await bundle("add", `git+${daemon.baseUrl}/remote.git`, "--name", "gb", "--writable");
    const recorded = readLockfile().find((entry) => entry.id === "gb")?.installedAt;
    expect(recorded).toBeDefined();
    const lockBefore = fs.readFileSync(getLockfilePath(), "utf8");

    for (let run = 0; run < 2; run++) {
      await Bun.sleep(20);
      const result = await bundle<{ processed: Array<{ installed: { installedAt: string } }> }>("update", "gb");
      expect(result.processed[0]?.installed.installedAt).toBe(recorded as string);
    }

    expect(fs.readFileSync(getLockfilePath(), "utf8")).toBe(lockBefore);
  }, 60_000);
});
