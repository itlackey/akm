// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Coverage for the in-process CLI harness itself (tests/_helpers/cli.ts).
//
// Verifies the three things the harness must get right: capturing stdout on a
// success path, capturing a non-zero exit code + stderr on an error path, and
// isolating back-to-back runs within a single test (no singleton leakage).
//
// The preload (tests/_preload.ts) sandboxes HOME, the XDG dirs, and the AKM dir
// overrides per test, so these runs never touch real user config. Env/temp-dir
// mutation goes through the allowlisted sandbox helpers to satisfy the
// test-isolation lint.

import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { runCliCapture } from "./_helpers/cli";
import { makeSandboxDir, makeStashDir, type SandboxedDir, withEnv } from "./_helpers/sandbox";

const disposers: SandboxedDir[] = [];
afterEach(() => {
  for (const d of disposers) d.cleanup();
  disposers.length = 0;
});

describe("in-process CLI harness", () => {
  test("captures --help stdout and exit 0", async () => {
    const { code, stdout } = await runCliCapture(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("akm");
  });

  test("captures --version stdout and exit 0", async () => {
    const { code, stdout } = await runCliCapture(["--version"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/\d+\.\d+/);
  });

  test("captures stdout and exit 0 for a known-good invocation", async () => {
    // `config path` is a read-only success path that prints to stdout and
    // exits 0; it exercises the success branch of the harness.
    const { code, stdout } = await runCliCapture(["config", "path"]);
    expect(code).toBe(0);
    expect(stdout).toContain("config.json");
  });

  test("captures stderr and a non-zero exit for a known-bad invocation", async () => {
    // `show` with a bare token whose leading segment names no asset type: under
    // the 0.9.0 ref grammar (Chunk-5 flip F1b) a colon-less token is a valid
    // short conceptId, so it fails as a NOT-FOUND (no such concept) rather than
    // an arg-parse error — the "same UX as an unknown type" the resolver
    // guarantees. Either way the harness must capture a structured error
    // envelope and a non-zero exit.
    const { code, stderr } = await runCliCapture(["show", "invalid-ref-no-colon"]);
    expect(code).not.toBe(0);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("ASSET_NOT_FOUND");
  });

  test("maps a UsageError to exit code 2", async () => {
    const { code, stderr } = await runCliCapture(["health", "--detail", "verbose"]);
    expect(code).toBe(2);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.code).toBe("INVALID_DETAIL_VALUE");
  });

  test("back-to-back runs in one test do not leak singleton state", async () => {
    // First run with no stash -> ConfigError envelope on stderr.
    //
    // The "no stash" condition must be constructed explicitly, not inherited
    // from the ambient environment. `resolveStashDir` falls back to the
    // platform default `$HOME/akm` when neither `AKM_STASH_DIR` nor a config
    // `stashDir` is set; under the suite-wide preload sandbox, `HOME` is a
    // SHARED per-process directory. If any earlier test in the sequential suite
    // creates `$HOME/akm` (e.g. by resolving the default stash dir without
    // overriding HOME), this run would resolve that empty dir and exit 0 with
    // empty results instead of `STASH_DIR_NOT_FOUND` — an order-dependent
    // flake. Point HOME (and the matching XDG_CONFIG_HOME, so no leaked config
    // supplies a stashDir) at a fresh empty dir so the missing-stash branch is
    // exercised deterministically regardless of suite ordering.
    const freshHome = makeSandboxDir("akm-harness-home");
    disposers.push(freshHome);
    const noStash = await withEnv(
      { HOME: freshHome.dir, XDG_CONFIG_HOME: path.join(freshHome.dir, "config"), AKM_STASH_DIR: undefined },
      () => runCliCapture(["search", "test"]),
    );
    expect(noStash.code).not.toBe(0);
    expect(noStash.stderr).toContain("STASH_DIR_NOT_FOUND");

    // Second run, same test, with a valid stash dir -> must succeed, proving the
    // config cache was reset between runs rather than reusing the first run's
    // resolved (missing) stash.
    const stash = makeStashDir();
    disposers.push(stash);
    const withStash = await withEnv({ AKM_STASH_DIR: stash.dir }, () => runCliCapture(["search", "test"]));
    expect(withStash.code).toBe(0);
    expect(withStash.stderr).not.toContain("STASH_DIR_NOT_FOUND");
  });
});
