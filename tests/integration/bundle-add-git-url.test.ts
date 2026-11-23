// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** A URL is never a registry id: `akm bundle add git://host:port/repo.git` adds a git bundle. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../../src/core/config/config";
import { readLockfile } from "../../src/integrations/lockfile";
import { runCliCapture } from "../_helpers/cli";
import { type GitDaemon, seedServedRepo } from "../_helpers/git-daemon";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let daemon: GitDaemon;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  daemon = seedServedRepo(storage.root);
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
