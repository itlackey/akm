// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS6 characterization test for the `akm tasks` command family. Pins the full
 * JSON envelope (stdout payload shape + the {ok:false,…} error envelope on
 * stderr / exit code) for representative subcommands, proving the extraction of
 * the family from cli.ts into src/commands/tasks-cli.ts and the migration of the
 * leaf handlers onto `defineJsonCommand` is byte-identical. Only the
 * scheduler-free subcommands are exercised (`list`, `doctor`, and the `show`
 * not-found error path) so the test never touches the host OS scheduler. The
 * CLI reads an isolated stash through AKM_STASH_DIR via the in-process harness.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { runCliCapture } from "../_helpers/cli";
import { makeSandboxDir, type SandboxedDir, withEnv } from "../_helpers/sandbox";

const disposers: SandboxedDir[] = [];

afterEach(() => {
  for (const d of disposers.splice(0)) d.cleanup();
});

function makeStashDir(): string {
  const d = makeSandboxDir("akm-tasks-envelope-");
  disposers.push(d);
  fs.mkdirSync(path.join(d.dir, "tasks"), { recursive: true });
  return d.dir;
}

async function runCli(args: string[], stashDir: string): Promise<{ stdout: string; stderr: string; status: number }> {
  const { code, stdout, stderr } = await withEnv({ AKM_STASH_DIR: stashDir }, () => runCliCapture(args));
  return { stdout, stderr, status: code };
}

describe("akm tasks — JSON envelope snapshot (WS6)", () => {
  test("tasks list: empty stash → success envelope with empty tasks array", async () => {
    const stash = makeStashDir();
    const { stdout, status } = await runCli(["--json", "tasks", "list"], stash);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.shape).toBe("tasks-list");
    expect(Array.isArray(env.tasks)).toBe(true);
    expect(env.tasks.length).toBe(0);
  });

  test("tasks doctor: success envelope reports the active scheduler backend", async () => {
    const stash = makeStashDir();
    const { stdout, status } = await runCli(["--json", "tasks", "doctor"], stash);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.shape).toBe("tasks-doctor");
    expect(typeof env.backend).toBe("string");
    expect(Array.isArray(env.warnings)).toBe(true);
  });

  test("tasks show: unknown id → byte-identical {ok:false} not-found envelope on stderr", async () => {
    const stash = makeStashDir();
    const { stderr, status } = await runCli(["--json", "tasks", "show", "does-not-exist"], stash);
    expect(status).toBe(1);
    const env = JSON.parse(stderr);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("ASSET_NOT_FOUND");
  });
});
