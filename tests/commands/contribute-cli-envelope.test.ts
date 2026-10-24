// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS6 characterization test for the contribution command cluster
 * (`akm agent`, `akm lint`) plus `akm proposal new` (formerly the top-level
 * `akm propose`, moved under `proposal` in the 0.9 CLI overhaul, S8). Pins
 * the JSON envelope (stdout payload shape, the {ok:false,code} usage-error
 * envelope on stderr, and exit codes) for each command, proving the
 * extraction from cli.ts into src/commands/contribute-cli.ts /
 * src/commands/proposal/propose-cli.ts is byte-identical.
 *
 * All three handlers keep the inline `runWithJsonErrors` form (they call
 * `process.exit` conditionally on the result), so the {ok:false} error path
 * still routes through the same envelope. Only deterministic paths are
 * exercised: argument validation (exit 2) and the `lint` happy path on an
 * empty sandbox stash (exit 0). The agent/proposal-new success paths spawn an
 * external agent CLI and are covered by their own behaviour suites.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runCliStatus as runCli } from "../_helpers/cli";
import { type Cleanup, sandboxStashDir, withEnv, writeSandboxConfig } from "../_helpers/sandbox";

let stashCleanup: Cleanup = () => {};

beforeEach(() => {
  const stash = sandboxStashDir();
  stashCleanup = stash.cleanup;
  writeSandboxConfig({ semanticSearchMode: "off" });
});

afterEach(() => {
  stashCleanup();
  stashCleanup = () => {};
});

describe("akm contribution cluster — JSON envelope snapshot (WS6)", () => {
  test("agent (no engine): {ok:false} usage envelope on stderr (exit 2)", async () => {
    // `akm agent` now falls back to an `opencode-sdk` engine when an opencode
    // binary is resolvable, so the no-engine failure is only deterministic with
    // PATH emptied — otherwise this asserts a different outcome on a developer
    // machine that happens to have opencode installed than it does in CI.
    const { stderr, status } = await withEnv({ PATH: "" }, () => runCli(["agent"]));
    expect(status).toBe(2);
    const env = JSON.parse(stderr);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("MISSING_REQUIRED_ARGUMENT");
    expect(env.error).toMatch(/agent has no selected engine/);
  });

  test("lint: success envelope carries fixed/flagged arrays + summary (exit 0)", async () => {
    const { stdout, status } = await runCli(["lint"]);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.ok).toBe(true);
    expect(Array.isArray(env.fixed)).toBe(true);
    expect(Array.isArray(env.flagged)).toBe(true);
    expect(typeof env.summary).toBe("object");
    expect(typeof env.summary.flagged).toBe("number");
  });

  test("proposal new (missing args): {ok:false} usage envelope on stderr (exit 2)", async () => {
    const { stderr, status } = await runCli(["proposal", "new"]);
    expect(status).toBe(2);
    const env = JSON.parse(stderr);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("MISSING_REQUIRED_ARGUMENT");
    expect(env.error).toMatch(/Usage: akm proposal new/);
  });

  test("proposal new (both --task and --file): {ok:false} INVALID_FLAG_VALUE on stderr (exit 2)", async () => {
    const { stderr, status } = await runCli([
      "proposal",
      "new",
      "skill",
      "demo",
      "--task",
      "do a thing",
      "--file",
      "/tmp/does-not-matter.txt",
    ]);
    expect(status).toBe(2);
    const env = JSON.parse(stderr);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("INVALID_FLAG_VALUE");
    expect(env.error).toMatch(/exactly one of --task or --file/);
  });
});
