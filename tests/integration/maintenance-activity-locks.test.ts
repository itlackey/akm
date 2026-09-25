// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Real files and a real SQLite operation-mutex database (openDatabase, via
// tryAcquireLockSync/releaseLock) — belongs under tests/integration/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { tryAcquireLockSync } from "../../src/core/file-lock";
import { acquireMaintenanceActivitySync, sweepMaintenanceActivityOrphans } from "../../src/core/maintenance-barrier";
import { getMaintenanceBarrierPath } from "../../src/core/paths";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

function activitiesDir(): string {
  return path.join(path.dirname(getMaintenanceBarrierPath()), "maintenance-activities");
}

function listActivityFiles(): string[] {
  try {
    return fs.readdirSync(activitiesDir());
  } catch {
    return [];
  }
}

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

describe("acquireMaintenanceActivitySync: mutex sidecar leak", () => {
  test("acquire then release leaves no per-acquisition .operations.sensitive sidecar", () => {
    const release = acquireMaintenanceActivitySync("state-db");
    release();

    const leaked = listActivityFiles().filter((name) => name.endsWith(".lock.operations.sensitive"));
    expect(leaked).toEqual([]);
  });

  test("repeated acquire/release cycles never grow past one shared mutex file", () => {
    for (let i = 0; i < 25; i++) {
      const release = acquireMaintenanceActivitySync("state-db");
      release();
    }

    const sidecars = listActivityFiles().filter((name) => name.endsWith(".operations.sensitive"));
    // Exactly the one shared mutex file for the whole directory, not one per
    // acquisition (25 acquisitions would have leaked 25 under the old code).
    expect(sidecars).toEqual([".activities.operations.sensitive"]);
  });
});

describe("sweepMaintenanceActivityOrphans", () => {
  test("removes a pre-fix per-acquisition sidecar whose lock file is gone", () => {
    const dir = activitiesDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const orphanSidecar = path.join(dir, ".state-db-123-deadbeef.lock.operations.sensitive");
    fs.writeFileSync(orphanSidecar, "");

    const result = sweepMaintenanceActivityOrphans();

    expect(fs.existsSync(orphanSidecar)).toBe(false);
    expect(result.removed).toBe(1);
  });

  test("leaves a sidecar whose lock file still exists", () => {
    const dir = activitiesDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const lockPath = path.join(dir, "state-db-123-deadbeef.lock");
    fs.writeFileSync(lockPath, String(process.pid));
    const sidecar = path.join(dir, ".state-db-123-deadbeef.lock.operations.sensitive");
    fs.writeFileSync(sidecar, "");

    const result = sweepMaintenanceActivityOrphans();

    expect(fs.existsSync(sidecar)).toBe(true);
    expect(result.removed).toBe(0);
  });

  test("reclaims an activity lock file whose owner pid has died", () => {
    const dir = activitiesDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const lockPath = path.join(dir, "state-db-999999-deadbeef.lock");
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999_999 }));

    const result = sweepMaintenanceActivityOrphans();

    expect(fs.existsSync(lockPath)).toBe(false);
    expect(result.removed).toBe(1);
  });

  test("does not touch a lock file whose owner pid is alive", () => {
    const dir = activitiesDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const lockPath = path.join(dir, "state-db-123-deadbeef.lock");
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid }));

    const result = sweepMaintenanceActivityOrphans();

    expect(fs.existsSync(lockPath)).toBe(true);
    expect(result.removed).toBe(0);
  });

  test("never removes the shared activities mutex file itself", () => {
    const dir = activitiesDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const mutexPath = path.join(dir, ".activities.operations.sensitive");
    // Acquiring anything creates the shared mutex file as a side effect.
    const ownership = tryAcquireLockSync(path.join(dir, "probe.lock"), "1", mutexPath);
    expect(ownership).toBeDefined();

    sweepMaintenanceActivityOrphans();

    expect(fs.existsSync(mutexPath)).toBe(true);
  });

  test("is bounded: caps the number of files removed in one call", () => {
    const dir = activitiesDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const total = 2_010; // just over MAINTENANCE_ACTIVITY_SWEEP_MAX_FILES (2,000)
    for (let i = 0; i < total; i++) {
      fs.writeFileSync(path.join(dir, `.state-db-1-${i}.lock.operations.sensitive`), "");
    }

    const first = sweepMaintenanceActivityOrphans();
    expect(first.scanned).toBe(2_000);
    expect(first.removed).toBe(2_000);
    expect(listActivityFiles().length).toBe(10);

    const second = sweepMaintenanceActivityOrphans();
    expect(second.removed).toBe(10);
    expect(listActivityFiles().length).toBe(0);
  });

  test("is a no-op when the maintenance-activities directory does not exist", () => {
    expect(() => sweepMaintenanceActivityOrphans()).not.toThrow();
    expect(sweepMaintenanceActivityOrphans()).toEqual({ scanned: 0, removed: 0 });
  });
});
