// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Integration tests for `akm remember` stdin handling (issue #169).
 *
 * These tests live in tests/integration/ because they NEED real subprocesses:
 * both pipe a body to the CLI via spawnSync's `input`, and the thing under
 * test is the CLI's process.stdin read path. The in-process harness
 * (tests/_helpers/cli.ts runCliCapture) has no stdin support, so these cannot
 * be expressed there without weakening the assertions.
 *
 * Covers:
 * - Zero-flag stdin remember writes captureMode: hot + beliefState: asserted
 * - stdin is read when `--format json` is present (flag value not consumed as body)
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseFrontmatter } from "../../src/core/asset/frontmatter";

const CLI = path.join(__dirname, "..", "..", "src", "cli.ts");
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function freshDirs(options?: { stashDir?: string }) {
  const stashDir = options?.stashDir ?? makeTempDir("akm-rmfm-stash-");
  return {
    stashDir,
    env: {
      AKM_STASH_DIR: stashDir,
      XDG_CACHE_HOME: makeTempDir("akm-rmfm-cache-"),
      XDG_CONFIG_HOME: makeTempDir("akm-rmfm-config-"),
      XDG_DATA_HOME: makeTempDir("akm-rmfm-data-"),
      XDG_STATE_HOME: makeTempDir("akm-rmfm-state-"),
    } satisfies Record<string, string>,
  };
}

/** Subprocess runner: pipes `input` to the CLI's stdin (the path under test). */
function spawnRunCli(args: string[], options?: { stashDir?: string; input?: string }) {
  const { stashDir, env } = freshDirs(options);
  const result = spawnSync("bun", [CLI, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    input: options?.input,
    env: { ...process.env, ...env },
  });
  return { stashDir, result };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("remember stdin", () => {
  test("stdin zero-flag path also writes captureMode: hot + beliefState: asserted", () => {
    const { result } = spawnRunCli(["remember"], { input: "VPN needed for staging deploys" });
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout) as { ref: string; path: string };
    const content = fs.readFileSync(json.path, "utf8");
    expect(content.startsWith("---")).toBe(true);
    const parsed = parseFrontmatter(content);
    expect(parsed.data.captureMode).toBe("hot");
    expect(parsed.data.beliefState).toBe("asserted");
    expect(Object.keys(parsed.data).sort()).toEqual(["beliefState", "captureMode"]);
  });

  test("reads stdin when --format json is present", () => {
    const { result } = spawnRunCli(["remember", "--name", "from-stdin", "--format", "json"], { input: "stdin body" });
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout) as { path: string };
    expect(fs.readFileSync(json.path, "utf8")).toContain("stdin body");
    expect(fs.readFileSync(json.path, "utf8")).not.toContain("\njson");
  });
});
