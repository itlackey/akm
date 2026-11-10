// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import * as tasksModule from "../../src/commands/tasks/tasks";
import { saveConfig } from "../../src/core/config/config";
import { makeSandboxDir, withIsolatedAkmStorage } from "../_helpers/sandbox";

describe("task asset mutations honor write-target resolution", () => {
  test("rejects a writable OKF target before writing a task", async () => {
    // The working bundle is AKM_BUNDLE_DIR when set; this test works from the configured defaultBundle.
    const iso = withIsolatedAkmStorage({}, { bundle: false });
    const target = makeSandboxDir("akm-task-okf-target");
    try {
      saveConfig({
        semanticSearchMode: "off",
        defaultBundle: "target",
        bundles: {
          target: {
            path: target.dir,
            components: { main: { root: ".", adapter: "okf", writable: true } },
          },
        },
      });

      await expect(
        tasksModule.akmTasksAdd({ id: "vendor-task", schedule: "0 2 * * *", command: "echo vendor" }),
      ).rejects.toThrow(/adapter "okf".*does not support AKM asset writes/i);
      expect(fs.existsSync(path.join(target.dir, "tasks", "vendor-task.yml"))).toBe(false);
    } finally {
      iso.cleanup();
      target.cleanup();
    }
  });

  test("add writes to defaultBundle instead of the primary stash", async () => {
    // The working bundle is AKM_BUNDLE_DIR when set; this test works from the configured defaultBundle.
    const iso = withIsolatedAkmStorage({}, { bundle: false });
    const target = makeSandboxDir("akm-task-target");
    try {
      saveConfig({
        semanticSearchMode: "off",
        defaultBundle: "target",
        bundles: { target: { path: target.dir, writable: true } },
      });

      const result = await tasksModule.akmTasksAdd({
        id: "nightly",
        schedule: "0 2 * * *",
        command: "echo nightly",
      });

      expect(result.bundleDir).toBe(target.dir);
      expect(fs.existsSync(path.join(target.dir, "tasks", "nightly.yml"))).toBe(true);
      expect(fs.existsSync(path.join(iso.stashDir, "tasks", "nightly.yml"))).toBe(false);
    } finally {
      iso.cleanup();
      target.cleanup();
    }
  });
});
