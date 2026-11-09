// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `task add`, `enable` and `disable` leave the OS scheduler right: the first enabled task installs the one entry, the
 * last disabled one removes it, and a task that cannot be scheduled is refused before anything is written. The
 * backend is an in-memory fake; nothing reaches a crontab.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmTasksAdd, akmTasksDisable, akmTasksEnable, type TaskSyncDeps } from "../../src/commands/tasks/tasks";
import { loadConfig } from "../../src/core/config/config";
import { ConfigError } from "../../src/core/errors";
import { isSchedulerRefEnabled } from "../../src/tasks/activation-config";
import type { DispatchEntry, SchedulerBackend } from "../../src/tasks/backends/types";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let installed: DispatchEntry | undefined;
let writes: number;

/** The default installation's environment: only HOME resolves the locations. */
const sync = (): TaskSyncDeps => ({
  backend: {
    name: "cron",
    inspect: () => ({ ...(installed ? { entry: installed } : {}), legacy: [] }),
    apply(change) {
      writes += 1;
      if (change.entry === null) installed = undefined;
      else if (change.entry !== undefined) installed = change.entry;
    },
  } satisfies SchedulerBackend,
  launcher: () => ({ argv: ["/opt/akm"] }),
  env: { HOME: "/home/nobody", PATH: "/usr/bin:/bin" },
});

function writeTask(id: string, schedule: string): void {
  fs.writeFileSync(
    path.join(storage.stashDir, "tasks", `${id}.yml`),
    `version: 4\nrun: 'true'\nschedule: "${schedule}"\n`,
  );
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({ bundles: { stash: { path: storage.stashDir, writable: true } }, defaultBundle: "stash" });
  fs.mkdirSync(path.join(storage.stashDir, "tasks"), { recursive: true });
  installed = undefined;
  writes = 0;
});

afterEach(() => {
  storage.cleanup();
});

describe("the entry follows the enabled list", () => {
  test("task add installs the entry on a host that has none", async () => {
    const result = await akmTasksAdd({ id: "nightly", schedule: "0 3 * * *", command: "true" }, { sync: sync() });

    expect(result.sync?.entry).toBe("installed");
    expect(installed).toEqual({ launcher: ["/opt/akm"], path: "/usr/bin:/bin" });
  });

  test("task add --disabled on a host with no enabled task installs nothing", async () => {
    const result = await akmTasksAdd(
      { id: "quiet", schedule: "0 3 * * *", command: "true", disabled: true },
      { sync: sync() },
    );

    expect(result.sync?.entry).toBe("absent");
    expect(installed).toBeUndefined();
  });

  test("task enable installs the entry; enabling a second task leaves it alone", async () => {
    writeTask("a", "@daily");
    writeTask("b", "@daily");

    expect((await akmTasksEnable("a", { sync: sync() })).sync?.entry).toBe("installed");
    expect((await akmTasksEnable("b", { sync: sync() })).sync?.entry).toBe("unchanged");
    expect(writes).toBe(1);
  });

  test("task disable removes the entry only when the last enabled task goes", async () => {
    writeTask("a", "@daily");
    writeTask("b", "@daily");
    await akmTasksEnable("a", { sync: sync() });
    await akmTasksEnable("b", { sync: sync() });

    expect((await akmTasksDisable("a", { sync: sync() })).sync?.entry).toBe("unchanged");
    expect(installed).toBeDefined();
    expect((await akmTasksDisable("b", { sync: sync() })).sync?.entry).toBe("removed");
    expect(installed).toBeUndefined();
  });

  test("the result keeps the activation fields beside the sync", async () => {
    writeTask("a", "@daily");
    expect(await akmTasksEnable("a", { sync: sync() })).toMatchObject({
      ref: "stash//tasks/a",
      enabled: true,
      changed: true,
      sync: { backend: "cron" },
    });
  });
});

describe("a task that cannot be scheduled is refused before anything is written", () => {
  test("enable refuses a schedule the grammar rejects, and neither the config nor the OS changes", async () => {
    writeTask("reboot", "@reboot");

    await expect(akmTasksEnable("reboot", { sync: sync() })).rejects.toMatchObject({ code: "INVALID_FLAG_VALUE" });

    expect(isSchedulerRefEnabled(loadConfig(), "stash//tasks/reboot")).toBe(false);
    expect(writes).toBe(0);
  });

  test("enable refuses a task with one good and one bad schedule entry", async () => {
    fs.writeFileSync(
      path.join(storage.stashDir, "tasks", "mixed.yml"),
      ["version: 4", "run: 'true'", "schedule:", '  - cron: "0 3 * * *"', '  - cron: "0 9 * * 1-5,7"'].join("\n"),
    );
    // `7` is not a day of week in this grammar.
    await expect(akmTasksEnable("mixed", { sync: sync() })).rejects.toMatchObject({ code: "INVALID_FLAG_VALUE" });
    expect(isSchedulerRefEnabled(loadConfig(), "stash//tasks/mixed")).toBe(false);
  });
});

describe("a host whose OS scheduler is unavailable still saves the change", () => {
  /** What `crontab` missing from PATH does: `inspect` throws a ConfigError. */
  const noCrontab = (error: Error = new ConfigError("the `crontab` binary was not found on PATH")): TaskSyncDeps => ({
    ...sync(),
    backend: {
      name: "cron",
      inspect() {
        throw error;
      },
      apply() {
        throw error;
      },
    } satisfies SchedulerBackend,
  });

  test("task add saves the task and enables it, and warns instead of failing", async () => {
    const result = await akmTasksAdd({ id: "nightly", schedule: "0 3 * * *", command: "true" }, { sync: noCrontab() });

    expect(result.sync).toBeUndefined();
    expect(result.warnings).toEqual([
      "Task saved, but the OS scheduler was not updated: the `crontab` binary was not found on PATH. Fix that, then run `akm task sync`.",
    ]);
    expect(fs.existsSync(path.join(storage.stashDir, "tasks", "nightly.yml"))).toBe(true);
    expect(isSchedulerRefEnabled(loadConfig(), "stash//tasks/nightly")).toBe(true);
  });

  test("task enable keeps the activation and warns", async () => {
    writeTask("a", "@daily");

    const result = await akmTasksEnable("a", { sync: noCrontab() });

    expect(result).toMatchObject({ ref: "stash//tasks/a", enabled: true, changed: true });
    expect(result.sync).toBeUndefined();
    expect(result.warnings?.[0]).toContain("`akm task sync`");
    expect(isSchedulerRefEnabled(loadConfig(), "stash//tasks/a")).toBe(true);
  });

  test("task disable keeps the change and warns", async () => {
    writeTask("a", "@daily");
    await akmTasksEnable("a", { sync: sync() });

    const result = await akmTasksDisable("a", { sync: noCrontab() });

    expect(result.sync).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
    expect(isSchedulerRefEnabled(loadConfig(), "stash//tasks/a")).toBe(false);
  });

  test("an error that is not a ConfigError still propagates", async () => {
    writeTask("a", "@daily");
    await expect(akmTasksEnable("a", { sync: noCrontab(new Error("disk on fire")) })).rejects.toThrow("disk on fire");
  });
});
