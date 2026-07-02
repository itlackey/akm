// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm completions --install` — real-subprocess test.
 *
 * Lives in tests/integration because it spawns the actual CLI: it asserts the
 * install-path message emitted via `warn()` → stderr, which the in-process
 * harness does not surface under the suite-wide test preload. Real spawns are
 * banned from the unit suite (scripts/lint-tests-isolation.ts) — a stalled
 * synchronous spawn blocks the whole runtime past every JS-level timeout,
 * which is exactly how the 2026-07-02 release run lost a unit shard to two
 * 300s hard-kills.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { makeSandboxDir, type SandboxedDir } from "../_helpers/sandbox";

const disposers: SandboxedDir[] = [];

function makeTempDir(): string {
  const d = makeSandboxDir("akm-completions-install-");
  disposers.push(d);
  return d.dir;
}

afterAll(() => {
  for (const d of disposers) d.cleanup();
  disposers.length = 0;
});

describe("completions --install", () => {
  test("writes completion file to XDG_DATA_HOME path", () => {
    const xdgData = makeTempDir();
    const result = spawnSync("bun", ["./src/cli.ts", "completions", "--install"], {
      encoding: "utf8",
      timeout: 10_000,
      cwd: path.resolve(import.meta.dir, "..", ".."),
      env: {
        ...process.env,
        AKM_STASH_DIR: undefined,
        HOME: makeTempDir(),
        XDG_CACHE_HOME: makeTempDir(),
        XDG_CONFIG_HOME: makeTempDir(),
        XDG_DATA_HOME: xdgData,
      },
    });

    expect(result.status).toBe(0);
    const expectedPath = path.join(xdgData, "bash-completion", "completions", "akm");
    expect(result.stderr).toContain(expectedPath);
    expect(fs.existsSync(expectedPath)).toBe(true);

    const content = fs.readFileSync(expectedPath, "utf8");
    expect(content).toStartWith("#!/bin/bash");
    expect(content).toContain("complete -F _akm akm");
  });
});
