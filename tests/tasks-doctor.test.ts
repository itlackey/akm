// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** `akm task doctor` reports the scheduler entry, the log directory, and tasks that cannot run. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { akmTasksDoctor } from "../src/commands/tasks/tasks";
import { resetConfigCache, saveConfig } from "../src/core/config/config";
import { getTaskLogDir } from "../src/core/paths";
import {
  type Cleanup,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
} from "./_helpers/sandbox";

let cleanup: Cleanup = () => {};

beforeEach(() => {
  const dataResult = sandboxXdgDataHome();
  const cacheResult = sandboxXdgCacheHome(dataResult.cleanup);
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  const stashResult = sandboxStashDir(cfgResult.cleanup);
  cleanup = stashResult.cleanup;
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
  resetConfigCache();
});

describe("tasks doctor", () => {
  test("reports the task log directory and no history directory (run history lives in state.db)", async () => {
    saveConfig({ semanticSearchMode: "off" });
    resetConfigCache();

    const result = await akmTasksDoctor();

    expect(result.logDir).toBe(getTaskLogDir());
    expect(result).not.toHaveProperty("historyDir");
  });
});

describe("tasks doctor without a default bundle", () => {
  beforeEach(() => {
    saveConfig({ semanticSearchMode: "off" });
    resetConfigCache();
  });

  test("succeeds when nothing is enabled", async () => {
    saveConfig({ semanticSearchMode: "off" });
    resetConfigCache();
    const result = await akmTasksDoctor();
    expect(result.warnings.filter((warning) => warning.includes("cannot run"))).toEqual([]);
  });

  test("succeeds and warns naming an enabled ref", async () => {
    saveConfig({ semanticSearchMode: "off", scheduler: { enabled: ["stash//tasks/ok"] } });
    resetConfigCache();
    const result = await akmTasksDoctor();
    expect(
      result.warnings.some((warning) => warning.includes("stash//tasks/ok") && warning.includes("cannot run")),
    ).toBe(true);
  });
});
