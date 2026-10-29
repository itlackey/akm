// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A harness runs in the directory akm runs it in, and `PWD` names that directory too, as it does for a program a
 * person starts after `cd <dir>`. OpenCode takes its directory from `PWD` before its working directory, so a `PWD`
 * left as the directory akm was started in made an `opencode` harness's shell and file tools work there instead.
 * Integration: it runs `akm agent --cwd` against a fake `opencode` that records the `PWD` and working directory
 * it started with (a shell script would hide the bug: a shell resets a `PWD` that is not its directory).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { runCliCapture } from "../../_helpers/cli";
import { harnessCalls, writeFakeHarness } from "../../_helpers/engine-stubs";
import {
  type IsolatedAkmStorage,
  makeSandboxDir,
  type SandboxedDir,
  withIsolatedAkmStorage,
  writeSandboxConfig,
} from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let bins: SandboxedDir;
let work: SandboxedDir;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  bins = makeSandboxDir("akm-harness-cwd-bin");
  work = makeSandboxDir("akm-harness-cwd-work");
});

afterEach(() => {
  work.cleanup();
  bins.cleanup();
  storage.cleanup();
});

describe("an opencode harness run with --cwd", () => {
  test("starts in that directory and with PWD naming it, not the directory akm was started in", async () => {
    const bin = writeFakeHarness(bins.dir, "opencode", ["done"]);
    writeSandboxConfig({ harnesses: { oc: { platform: "opencode", bin } } });

    const result = await runCliCapture(["agent", "--prompt", "work", "--harness", "oc", "--cwd", work.dir]);

    expect(result.code).toBe(0);
    const [call] = harnessCalls(bin);
    expect(fs.realpathSync(call?.cwd ?? "")).toBe(fs.realpathSync(work.dir));
    expect(call?.env.PWD).toBe(work.dir);
  });
});
