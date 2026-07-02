// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Real-subprocess entrypoint test for the global `--shape` pre-execution gate.
 *
 * WHY THIS NEEDS A REAL SUBPROCESS: `--shape summary` is rejected for every
 * non-`show` command by an early, pre-execution gate in the guarded startup
 * block of src/cli.ts (before any command runs). The in-process harness
 * (tests/_helpers/cli.ts `runCliCapture`) intentionally skips that startup
 * block, so it only enforces the later, post-execution `shapeForCommand()`
 * gate — by which point a write command like `remember` would already have
 * run. This test asserts the write did NOT happen, which only holds for the
 * real subprocess entry point, so it lives in tests/integration/ on spawnSync.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type Cleanup, withIsolatedAkmStorage } from "../_helpers/sandbox";

const CLI = path.join(import.meta.dir, "..", "..", "src", "cli.ts");

let cleanup: Cleanup = () => {};

afterEach(() => {
  cleanup();
  cleanup = () => {};
});

function useStorage(): ReturnType<typeof withIsolatedAkmStorage> {
  const storage = withIsolatedAkmStorage();
  cleanup = storage.cleanup;
  return storage;
}

// The spawn passes `...process.env` on purpose: withIsolatedAkmStorage mutates
// process.env (AKM_* / XDG dirs) for the current process, and the subprocess
// must inherit those mutations to run against the isolated sandbox storage.
function runEntrypointSpawn(args: string[]) {
  return spawnSync("bun", [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env },
    timeout: 30_000,
  });
}

describe("entrypoint global --shape=summary pre-execution gate", () => {
  test("rejects global --shape=summary before non-show commands before they run", () => {
    const storage = useStorage();

    const result = runEntrypointSpawn(["--format=json", "--shape=summary", "remember", "do not write"]);

    expect(result.status).toBe(2);
    const error = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(error.code).toBe("INVALID_SHAPE_VALUE");
    expect(fs.readdirSync(path.join(storage.stashDir, "memories"))).toEqual([]);
  });
});
