// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS6 characterization test for the contribution command cluster
 * (`akm agent`, `akm lint`, `akm propose`). Pins the JSON envelope (stdout
 * payload shape, the {ok:false,code} usage-error envelope on stderr, and exit
 * codes) for each command, proving the extraction from cli.ts into
 * src/commands/contribute-cli.ts is byte-identical.
 *
 * All three handlers keep the inline `runWithJsonErrors` form (they call
 * `process.exit` conditionally on the result), so the {ok:false} error path
 * still routes through the same envelope. Only deterministic paths are
 * exercised: argument validation (exit 2) and the `lint` happy path on an
 * empty sandbox stash (exit 0). The agent/propose success paths spawn an
 * external agent CLI and are covered by their own behaviour suites.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runCliCapture } from "../_helpers/cli";
import { type Cleanup, sandboxStashDir, writeSandboxConfig } from "../_helpers/sandbox";

let stashCleanup: Cleanup = () => {};

async function runCli(args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  const { code, stdout, stderr } = await runCliCapture(args);
  return { status: code, stdout, stderr };
}

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
    const { stderr, status } = await runCli(["--json", "agent"]);
    expect(status).toBe(2);
    const env = JSON.parse(stderr);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("MISSING_REQUIRED_ARGUMENT");
    expect(env.error).toMatch(/agent requires --engine or defaults\.engine/);
  });

  test("lint: success envelope carries fixed/flagged arrays + summary (exit 0)", async () => {
    const { stdout, status } = await runCli(["--json", "lint"]);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.ok).toBe(true);
    expect(Array.isArray(env.fixed)).toBe(true);
    expect(Array.isArray(env.flagged)).toBe(true);
    expect(typeof env.summary).toBe("object");
    expect(typeof env.summary.flagged).toBe("number");
  });

  test("propose (missing args): {ok:false} usage envelope on stderr (exit 2)", async () => {
    const { stderr, status } = await runCli(["--json", "propose"]);
    expect(status).toBe(2);
    const env = JSON.parse(stderr);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("MISSING_REQUIRED_ARGUMENT");
    expect(env.error).toMatch(/Usage: akm propose/);
  });

  test("propose (both --task and --file): {ok:false} INVALID_FLAG_VALUE on stderr (exit 2)", async () => {
    const { stderr, status } = await runCli([
      "--json",
      "propose",
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
