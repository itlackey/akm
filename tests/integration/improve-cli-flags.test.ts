// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// WHY THIS NEEDS A REAL SUBPROCESS (moved from tests/commands/improve-cli-flags.test.ts):
// `improve --dry-run` runs improve for real, which opens and writes the
// state.db (improve_runs). In-process, a SQLite write lock on state.db is
// already held within the test process (the unit suite keeps DB handles open
// across the run), so the in-process improve aborts with "state DB
// busy/locked after retries" — genuine process-level contention that a fresh
// subprocess does not have. Until the harness grows a way to release/clear
// all state.db handles before an improve-executing call, this test spawns a
// real `bun src/cli.ts` so it gets a clean, uncontended DB. Same documented
// harness gap as the improve-result-to-file subprocess tests.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { type SandboxedDir, makeStashDir as sandboxMakeStashDir } from "../_helpers/sandbox";

const disposers: SandboxedDir[] = [];

function makeStashDir(): string {
  const stash = sandboxMakeStashDir();
  disposers.push(stash);
  return stash.dir;
}

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");

/** Subprocess runner for improve-executing tests (see header comment).
 * Passes env to spawnSync rather than mutating process.env. */
function spawnImprove(args: string[], stashDir: string): { status: number; stdout: string; stderr: string } {
  const data = sandboxMakeStashDir();
  disposers.push(data);
  const result = spawnSync("bun", [cliPath, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      AKM_STASH_DIR: stashDir,
      XDG_DATA_HOME: data.dir,
    },
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

afterEach(() => {
  for (const d of disposers.splice(0)) d.cleanup();
});

describe("improve CLI flags (0.8.0) — subprocess-only", () => {
  test("improve dry-run completes successfully (no cooldown flags needed)", () => {
    const stash = makeStashDir();
    const result = spawnImprove(
      [
        "improve",
        "--dry-run",
        // 0.8.0+ default mode writes JSON to a file; use the legacy escape
        // hatch so this assertion can read `ok` from stdout.
        "--json-to-stdout",
      ],
      stash,
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean };
    expect(parsed.ok).toBe(true);
  });
});
