// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmTasksSync } from "../src/commands/tasks/tasks";
import { TransientError } from "../src/core/errors";
import type { SchedulerBackend } from "../src/tasks/backends/types";
import { schedulerLockPath, withSchedulerLock } from "../src/tasks/scheduler-lock";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "./_helpers/sandbox";

let storage: IsolatedAkmStorage;

function holdLock(payload: object): void {
  fs.mkdirSync(path.dirname(schedulerLockPath()), { recursive: true });
  fs.writeFileSync(schedulerLockPath(), JSON.stringify(payload), { flag: "wx" });
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({ bundles: { stash: { path: storage.stashDir, writable: true } }, defaultBundle: "stash" });
});

afterEach(() => storage.cleanup());

describe("the scheduler lock", () => {
  test("is held for the duration of the work and released afterwards, even when the work throws", async () => {
    let heldDuring = false;
    await withSchedulerLock(async () => {
      heldDuring = fs.existsSync(schedulerLockPath());
    });
    expect(heldDuring).toBe(true);
    expect(fs.existsSync(schedulerLockPath())).toBe(false);

    await expect(
      withSchedulerLock(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(fs.existsSync(schedulerLockPath())).toBe(false);
  });

  test("is re-entrant within one process", async () => {
    const result = await withSchedulerLock(() => withSchedulerLock(async () => "inner"));
    expect(result).toBe("inner");
    expect(fs.existsSync(schedulerLockPath())).toBe(false);
  });

  test("a live holder makes a scheduler write fail as retryable contention, before reading anything", async () => {
    holdLock({ pid: process.pid });
    let listed = false;
    const backend: SchedulerBackend = {
      name: "cron",
      install() {},
      uninstall() {},
      setEnabled() {},
      list() {
        listed = true;
        return [];
      },
    };

    const failure = await akmTasksSync({ backend }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TransientError);
    expect(failure).toMatchObject({ code: "SCHEDULER_LOCK_HELD" });
    expect(listed).toBe(false);
    expect(fs.existsSync(schedulerLockPath())).toBe(true);
  });

  test("a lock left by a holder that cannot be alive is reclaimed", async () => {
    holdLock({ note: "no pid: the holder cannot be proven alive" });

    const result = await withSchedulerLock(async () => "reclaimed");

    expect(result).toBe("reclaimed");
    expect(fs.existsSync(schedulerLockPath())).toBe(false);
  });
});
