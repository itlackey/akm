// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Real-subprocess entrypoint test for the removed global `--shape` flag.
 *
 * `--shape` (0.10 folded `agent` into `--detail agent`) is an ordinary unknown
 * flag now. It must fail before any command runs, so a write command like
 * `remember` leaves nothing behind; that only holds for the real subprocess
 * entry point, so it lives in tests/integration/ on spawnSync.
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

describe("entrypoint removed --shape flag", () => {
  test("is an unknown flag (exit 2) and the write does not happen", () => {
    const storage = useStorage();

    const result = runEntrypointSpawn(["--format=json", "--shape=summary", "remember", "write me anyway"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("UNKNOWN_FLAG");
    const memories = path.join(storage.stashDir, "memories");
    expect(fs.existsSync(memories) ? fs.readdirSync(memories) : []).toEqual([]);
  });
});
