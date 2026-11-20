// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm index` while another build holds the rebuild lock: it skips (exit 0, nothing built) with or without the
 * deprecated `--skip-if-locked`, which is ignored with a warning.
 * Integration-scoped (ORG-03/06): drives the real CLI via `runCliCapture`,
 * which opens a real index.db.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { saveConfig } from "../../../../src/core/config/config";
import { processIdentity } from "../../../../src/core/file-lock";
import { getIndexRebuildLockPath } from "../../../../src/core/paths";
import { runCliCapture } from "../../../_helpers/cli";
import { type LiveHolder, spawnLiveHolder, stopLiveHolders } from "../../../_helpers/live-holder";
import { type Cleanup, withIsolatedAkmStorage } from "../../../_helpers/sandbox";

let cleanup: Cleanup = () => {};

let holder: LiveHolder;

function plantHeldRebuildLock(): string {
  holder = spawnLiveHolder();
  const lockPath = getIndexRebuildLockPath();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, holder.payload(), "utf8");
  return lockPath;
}

beforeEach(() => {
  const storage = withIsolatedAkmStorage();
  cleanup = storage.cleanup;
  saveConfig({ semanticSearchMode: "off" });
});

afterEach(() => {
  stopLiveHolders();
  cleanup();
  cleanup = () => {};
});

describe("akm index — held rebuild lock", () => {
  test("skips gracefully (exit 0) without indexing when the rebuild lock is held", async () => {
    const lockPath = plantHeldRebuildLock();

    const result = await runCliCapture(["index", "--full", "--skip-if-locked", "--format=json"]);

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.skipped).toEqual({
      reason: "lock-held",
      pid: holder.pid,
      launcherPid: null,
      startedAt: expect.any(String),
    });
    // The existing owner's sentinel is untouched.
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid).toBe(holder.pid);
  });

  test("without the flag, a held lock skips the run the same way: exit 0, nothing built, warning shown", async () => {
    const lockPath = plantHeldRebuildLock();

    const result = await runCliCapture(["index", "--full", "--format=json"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/another index run holds the lock/);
    expect(result.stderr).not.toMatch(/deprecated/);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.skipped).toMatchObject({ reason: "lock-held", pid: holder.pid });
    expect(parsed.totalEntries).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid).toBe(holder.pid);
  });

  test("--skip-if-locked is warned about once as deprecated", async () => {
    const result = await runCliCapture(["index", "--full", "--skip-if-locked", "--format=json"]);

    expect(result.code).toBe(0);
    expect(result.stderr.match(/--skip-if-locked is deprecated/g)).toHaveLength(1);
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

  test("a lock naming this process's own pid, which it never acquired, is reclaimed", async () => {
    const lockPath = getIndexRebuildLockPath();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date(0).toISOString() }), "utf8");

    const result = await runCliCapture(["index", "--full", "--skip-if-locked", "--format=json"]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).skipped).toBeUndefined();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test.skipIf(processIdentity(process.pid) === undefined)(
    "a lock whose pid is alive again under a different start time is reclaimed",
    async () => {
      const lockPath = plantHeldRebuildLock();
      fs.writeFileSync(lockPath, holder.payload({ startTime: "1" }), "utf8");

      const result = await runCliCapture(["index", "--full", "--skip-if-locked", "--format=json"]);

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).skipped).toBeUndefined();
      expect(fs.existsSync(lockPath)).toBe(false);
    },
  );

  test("no lock is left behind after a normal run", async () => {
    const result = await runCliCapture(["index", "--full", "--format=json"]);
    expect(result.code).toBe(0);
    expect(fs.existsSync(getIndexRebuildLockPath())).toBe(false);
  });
});
