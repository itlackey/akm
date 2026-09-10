// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm index --skip-if-locked` (#956) — mirrors
 * `tests/integration/commands/improve/improve-skip-if-locked.test.ts`.
 * Integration-scoped (ORG-03/06): drives the real CLI via `runCliCapture`,
 * which opens a real index.db.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { saveConfig } from "../../../../src/core/config/config";
import { getIndexRebuildLockPath } from "../../../../src/core/paths";
import { runCliCapture } from "../../../_helpers/cli";
import { type Cleanup, withIsolatedAkmStorage } from "../../../_helpers/sandbox";

let cleanup: Cleanup = () => {};

function plantHeldRebuildLock(): string {
  const lockPath = getIndexRebuildLockPath();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf8");
  return lockPath;
}

beforeEach(() => {
  const storage = withIsolatedAkmStorage();
  cleanup = storage.cleanup;
  saveConfig({ semanticSearchMode: "off" });
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
});

describe("akm index — skip-if-locked", () => {
  test("skips gracefully (exit 0) without indexing when the rebuild lock is held", async () => {
    const lockPath = plantHeldRebuildLock();

    const result = await runCliCapture(["index", "--full", "--skip-if-locked", "--format=json"]);

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.skipped).toEqual({
      reason: "lock-held",
      pid: process.pid,
      launcherPid: null,
      startedAt: expect.any(String),
    });
    // The existing owner's sentinel is untouched.
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
  });

  test("without the flag, a held lock warns and the run proceeds unlocked (contends)", async () => {
    plantHeldRebuildLock();

    const result = await runCliCapture(["index", "--full", "--format=json"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/another index run is active/);
    expect(result.stderr).toMatch(/--skip-if-locked/);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.skipped).toBeUndefined();
    expect(typeof parsed.totalEntries).toBe("number");
  });

  test("a lock left by a dead pid is reclaimed silently and the run acquires it", async () => {
    const lockPath = getIndexRebuildLockPath();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999_999, startedAt: new Date(0).toISOString() }), "utf8");

    const result = await runCliCapture(["index", "--full", "--skip-if-locked", "--format=json"]);

    expect(result.code).toBe(0);
    expect(result.stderr).not.toMatch(/another index run is active/);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.skipped).toBeUndefined();
    // Released on exit — no sentinel left behind.
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("no lock is left behind after a normal run", async () => {
    const result = await runCliCapture(["index", "--full", "--format=json"]);
    expect(result.code).toBe(0);
    expect(fs.existsSync(getIndexRebuildLockPath())).toBe(false);
  });
});
