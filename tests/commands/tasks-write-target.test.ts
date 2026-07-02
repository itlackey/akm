// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import * as tasksModule from "../../src/commands/tasks/tasks";
import { saveConfig } from "../../src/core/config/config";
import { _setBackendsForTests, type TaskBackend } from "../../src/tasks/backends";
import { makeSandboxDir, withIsolatedAkmStorage } from "../_helpers/sandbox";
import { overrideSeam } from "../_helpers/seams";

const backendState = {
  installCalls: [] as string[],
  uninstallCalls: [] as string[],
  failInstallFor: new Set<string>(),
};

function resetBackendState(): void {
  backendState.installCalls = [];
  backendState.uninstallCalls = [];
  backendState.failInstallFor.clear();
}

const fakeBackend: TaskBackend = {
  name: "cron",
  install: async (task) => {
    backendState.installCalls.push(task.id);
    if (backendState.failInstallFor.has(task.id)) throw new Error(`install failed for ${task.id}`);
  },
  uninstall: async (id) => {
    backendState.uninstallCalls.push(id);
  },
  setEnabled: async () => {},
  list: async () => [],
};

beforeEach(() => {
  overrideSeam(_setBackendsForTests, {
    selectBackend: () => fakeBackend,
    backendNameForPlatform: () => "cron",
  });
});

afterEach(() => {
  resetBackendState();
});

describe("task asset mutations honor write-target resolution", () => {
  test("add writes to defaultWriteTarget instead of the primary stash", async () => {
    const iso = withIsolatedAkmStorage();
    const target = makeSandboxDir("akm-task-target");
    try {
      saveConfig({
        semanticSearchMode: "off",
        defaultWriteTarget: "target",
        sources: [{ type: "filesystem", name: "target", path: target.dir, writable: true }],
      });

      const result = await tasksModule.akmTasksAdd({
        id: "nightly",
        schedule: "0 2 * * *",
        command: "echo nightly",
      });

      expect(result.stashDir).toBe(target.dir);
      expect(fs.existsSync(path.join(target.dir, "tasks", "nightly.yml"))).toBe(true);
      expect(fs.existsSync(path.join(iso.stashDir, "tasks", "nightly.yml"))).toBe(false);
      expect(backendState.installCalls).toEqual(["nightly"]);
    } finally {
      iso.cleanup();
      target.cleanup();
    }
  });

  test("add preserves scheduler rollback behavior on install failure", async () => {
    const iso = withIsolatedAkmStorage();
    const target = makeSandboxDir("akm-task-target");
    try {
      saveConfig({
        semanticSearchMode: "off",
        defaultWriteTarget: "target",
        sources: [{ type: "filesystem", name: "target", path: target.dir, writable: true }],
      });
      backendState.failInstallFor.add("broken");

      await expect(
        tasksModule.akmTasksAdd({
          id: "broken",
          schedule: "0 2 * * *",
          command: "echo broken",
        }),
      ).rejects.toThrow(/install failed/);

      expect(fs.existsSync(path.join(target.dir, "tasks", "broken.yml"))).toBe(false);
    } finally {
      iso.cleanup();
      target.cleanup();
    }
  });

  test("setEnabled and remove mutate the write target, not the primary stash", async () => {
    const iso = withIsolatedAkmStorage();
    const target = makeSandboxDir("akm-task-target");
    try {
      saveConfig({
        semanticSearchMode: "off",
        defaultWriteTarget: "target",
        sources: [{ type: "filesystem", name: "target", path: target.dir, writable: true }],
      });

      await tasksModule.akmTasksAdd({
        id: "toggle-me",
        schedule: "0 2 * * *",
        command: "echo toggle",
      });

      await tasksModule.akmTasksSetEnabled("toggle-me", false);
      const taskPath = path.join(target.dir, "tasks", "toggle-me.yml");
      expect(fs.readFileSync(taskPath, "utf8")).toContain("enabled: false");

      await tasksModule.akmTasksRemove("toggle-me");
      expect(fs.existsSync(taskPath)).toBe(false);
      expect(backendState.uninstallCalls).toEqual(["toggle-me"]);
    } finally {
      iso.cleanup();
      target.cleanup();
    }
  });
});
