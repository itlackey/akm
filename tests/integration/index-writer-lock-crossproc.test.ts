// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// INTEGRATION (real subprocess required): try-mode coalescing depends on the
// lock file naming a live FOREIGN pid — the lease probe liveness-checks that
// pid with a signal-0 kill. Using process.pid instead would hit the
// same-process reentrancy branch (covered by the unit tests in
// tests/index-writer-lock.test.ts), not the cross-process contention path.
// The spawned `sleep 5` exists purely to be that live foreign pid. Moved
// here from tests/index-writer-lock.test.ts as part of the spawn-allowlist
// drain.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getIndexWriterLockPath } from "../../src/core/paths";
import { acquireIndexWriterLease } from "../../src/indexer/index-writer-lock";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

describe("index writer lease (cross-process)", () => {
  test("try mode coalesces when another process holds the lease", async () => {
    const lockPath = getIndexWriterLockPath();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const child = spawn("sleep", ["5"], { stdio: "ignore" });
    try {
      if (typeof child.pid !== "number") throw new Error("failed to start holder process");
      fs.writeFileSync(lockPath, JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }), "utf8");
      const result = await acquireIndexWriterLease({ mode: "try", purpose: "background" });
      expect(result).toBeUndefined();
    } finally {
      child.kill("SIGTERM");
    }
  });
});
