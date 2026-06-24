// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { makeSandboxDir, type SandboxedDir } from "../_helpers/sandbox";

// KEPT AS A SUBPROCESS (genuine process boundary): `akm completions --install`
// emits its install-path message via warn() → console.error, which the in-process
// runCliCapture harness does not surface under the suite-wide test preload. A real
// subprocess faithfully exercises the user-visible stderr message, so this single
// test lives in the integration tier. The script-content + unsupported-shell tests
// run in-process in tests/completions.test.ts.

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

const xdgCache = makeTempDir();
const xdgConfig = makeTempDir();
const isolatedHome = makeTempDir();

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
        HOME: isolatedHome,
        XDG_CACHE_HOME: xdgCache,
        XDG_CONFIG_HOME: xdgConfig,
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
