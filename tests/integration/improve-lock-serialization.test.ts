// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  improveLockPath,
  MIN_IMPROVE_LOCK_STALE_MS,
  releaseImproveLock,
  tryAcquireImproveLock,
} from "../../src/commands/improve/locks";
import { type Cleanup, withIsolatedAkmStorage } from "../_helpers/sandbox";

let cleanup: Cleanup = () => {};
let lockPath = "";

beforeEach(() => {
  const storage = withIsolatedAkmStorage();
  lockPath = improveLockPath(path.join(storage.stashDir, ".akm"));
  cleanup = storage.cleanup;
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
  lockPath = "";
});

describe("improve whole-run lock", () => {
  test("serializes contenders and preserves the current owner", () => {
    const first = tryAcquireImproveLock(lockPath, MIN_IMPROVE_LOCK_STALE_MS, false);
    expect(first.state).toBe("acquired");
    if (first.state !== "acquired") throw new Error("expected first acquisition");

    const contender = tryAcquireImproveLock(lockPath, MIN_IMPROVE_LOCK_STALE_MS, true);
    expect(contender.state).toBe("skipped");
    expect(fs.existsSync(lockPath)).toBe(true);

    releaseImproveLock(first.ownership);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("allows a successor only after the owner releases", () => {
    const first = tryAcquireImproveLock(lockPath, MIN_IMPROVE_LOCK_STALE_MS, false);
    if (first.state !== "acquired") throw new Error("expected first acquisition");
    releaseImproveLock(first.ownership);

    const second = tryAcquireImproveLock(lockPath, MIN_IMPROVE_LOCK_STALE_MS, false);
    expect(second.state).toBe("acquired");
    if (second.state !== "acquired") throw new Error("expected second acquisition");
    releaseImproveLock(second.ownership);
  });
});
