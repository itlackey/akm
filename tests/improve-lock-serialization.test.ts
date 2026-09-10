// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { improveLockPath, releaseImproveLock, tryAcquireImproveLock } from "../src/commands/improve/locks";
import { TransientError } from "../src/core/errors";
import { type Cleanup, withIsolatedAkmStorage } from "./_helpers/sandbox";

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
    const first = tryAcquireImproveLock(lockPath, false);
    expect(first.state).toBe("acquired");
    if (first.state !== "acquired") throw new Error("expected first acquisition");

    const contender = tryAcquireImproveLock(lockPath, true);
    expect(contender.state).toBe("skipped");
    expect(fs.existsSync(lockPath)).toBe(true);

    releaseImproveLock(first.ownership);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("allows a successor only after the owner releases", () => {
    const first = tryAcquireImproveLock(lockPath, false);
    if (first.state !== "acquired") throw new Error("expected first acquisition");
    releaseImproveLock(first.ownership);

    const second = tryAcquireImproveLock(lockPath, false);
    expect(second.state).toBe("acquired");
    if (second.state !== "acquired") throw new Error("expected second acquisition");
    releaseImproveLock(second.ownership);
  });

  // Field follow-up to #948 (dev-team field review 2026-09-10): a losing
  // contender with no `--skip-if-locked` used to throw
  // `ConfigError("INVALID_CONFIG_FILE")` (exit 78) — a config-error code for
  // ordinary, retryable contention between two legitimate `improve` runs.
  // Reclassified to `TransientError`/`IMPROVE_LOCK_HELD` (exit 75), mirroring
  // `MAINTENANCE_BARRIER_BUSY`/`INDEX_DB_CONTENDED` (#956).
  test("a losing contender without --skip-if-locked throws TransientError(IMPROVE_LOCK_HELD), never a ConfigError", () => {
    const first = tryAcquireImproveLock(lockPath, false);
    if (first.state !== "acquired") throw new Error("expected first acquisition");

    try {
      expect(() => tryAcquireImproveLock(lockPath, false)).toThrow(TransientError);
      try {
        tryAcquireImproveLock(lockPath, false);
        throw new Error("expected tryAcquireImproveLock to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(TransientError);
        expect((err as TransientError).code).toBe("IMPROVE_LOCK_HELD");
        expect((err as TransientError).message).toContain("akm improve is already running");
        expect((err as TransientError).hint()).toContain("--skip-if-locked");
      }
    } finally {
      releaseImproveLock(first.ownership);
    }
  });
});
