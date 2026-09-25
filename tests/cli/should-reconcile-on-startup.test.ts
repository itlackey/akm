// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `shouldReconcileOnStartup` (upgrade-B) — same recovery/setup surfaces
 * `shouldBypassConfigStartup` keeps reachable against a broken config are
 * skipped here too, EXCEPT `task run --id ...`: a scheduled run surviving
 * an upgrade with no manual step is the whole point of this feature.
 */

import { describe, expect, test } from "bun:test";
import { shouldReconcileOnStartup } from "../../src/cli";

describe("shouldReconcileOnStartup", () => {
  test("reconciles ahead of an ordinary command", () => {
    expect(shouldReconcileOnStartup(["bun", "cli.ts", "search", "x"])).toBe(true);
    expect(shouldReconcileOnStartup(["bun", "cli.ts", "task", "sync"])).toBe(true);
    expect(shouldReconcileOnStartup(["bun", "cli.ts", "config", "get", "defaultBundle"])).toBe(true);
  });

  test("skips every shouldBypassConfigStartup surface except task run --id", () => {
    for (const args of [
      ["bun", "cli.ts"],
      ["bun", "cli.ts", "--help"],
      ["bun", "cli.ts", "-h"],
      ["bun", "cli.ts", "--version"],
      ["bun", "cli.ts", "-v"],
      ["bun", "cli.ts", "setup"],
      ["bun", "cli.ts", "migrate", "status"],
      ["bun", "cli.ts", "migrate", "apply"],
      ["bun", "cli.ts", "help"],
      ["bun", "cli.ts", "help", "migrate", "0.9.0"],
      ["bun", "cli.ts", "hints"],
      ["bun", "cli.ts", "config", "path"],
    ]) {
      expect(shouldReconcileOnStartup(args)).toBe(false);
    }
  });

  test("reconciles ahead of a scheduled `task run --id`, the one shouldBypassConfigStartup exception", () => {
    expect(shouldReconcileOnStartup(["bun", "cli.ts", "task", "run", "--id", "nightly", "--scheduled"])).toBe(true);
  });

  test("a plain `task run` with no --id reconciles too — it's an ordinary command, not a bypass surface", () => {
    // isTaskRunWithId requires a non-empty --id, so this never reaches
    // shouldBypassConfigStartup's `task run` special case at all; it falls
    // through to the ordinary (non-bypassing) command path, which reconciles.
    expect(shouldReconcileOnStartup(["bun", "cli.ts", "task", "run"])).toBe(true);
  });
});
