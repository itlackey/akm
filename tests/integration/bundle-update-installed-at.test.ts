// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * An update that moves nothing reports the recorded install time: `installedAt` is the last real install, never
 * the time a check ran.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getLockfilePath } from "../../src/core/paths";
import { readLockfile } from "../../src/integrations/lockfile";
import { runCliCapture } from "../_helpers/cli";
import { type GitDaemon, seedServedRepo } from "../_helpers/git-daemon";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let daemon: GitDaemon;

async function bundle<T>(...args: string[]): Promise<T> {
  const result = await runCliCapture(["bundle", ...args, "--format=json"]);
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as T;
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  daemon = seedServedRepo(storage.root);
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
