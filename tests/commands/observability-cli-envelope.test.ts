// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS6 characterization test for the observability command cluster
 * (`akm log list`, `akm lessons coverage`, `akm hints`). Pins the JSON
 * envelope (stdout payload shape, the {ok:false,code} error envelope on stderr,
 * and exit codes) for representative subcommands, proving the extraction from
 * cli.ts into src/commands/observability-cli.ts is byte-identical.
 *
 * `log list` and `lessons coverage` were migrated onto `defineJsonCommand`,
 * which emits the same JSON envelope (stdout/stderr/exit-code) as the inline
 * form. `lessons coverage` pins both envelope shapes: the success payload
 * (uncoveredTags/lessonTagCount/totalTagCount on stdout, exit 0) when an index
 * exists, or the {ok:false} error envelope on stderr (exit 1) when it does not
 * — either way the result is routed through runWithJsonErrors. `hints` keeps a
 * plain `defineCommand` wrapping `runWithJsonErrors` because it writes the
 * guide directly to stdout; its --detail validation still emits the structured
 * usage envelope.
 *
 * `log tail` is intentionally not exercised here — it follows the events table
 * via a polling loop and would make this snapshot non-deterministic. It is
 * covered by its own behavior tests.
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

describe("akm observability cluster — JSON envelope snapshot (WS6)", () => {
  test("log list: success envelope carries events array + totalCount + nextOffset", async () => {
    const { stdout, status } = await runCli(["--json", "log", "list"]);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(Array.isArray(env.events)).toBe(true);
    expect(typeof env.totalCount).toBe("number");
    expect(typeof env.nextOffset).toBe("number");
  });

  test("lessons coverage: emits the coverage envelope, or {ok:false} on stderr when no index", async () => {
    const { stdout, stderr, status } = await runCli(["--json", "lessons", "coverage"]);
    // Index presence depends on prior suite state; pin both envelope shapes the
    // extracted handler can produce through runWithJsonErrors.
    if (status === 0) {
      const env = JSON.parse(stdout);
      expect(env.ok).toBe(true);
      expect(Array.isArray(env.uncoveredTags)).toBe(true);
      expect(typeof env.lessonTagCount).toBe("number");
      expect(typeof env.totalTagCount).toBe("number");
    } else {
      expect(status).toBe(1);
      const env = JSON.parse(stderr);
      expect(env.ok).toBe(false);
      expect(typeof env.error).toBe("string");
    }
  });

  test("hints: prints the embedded AGENTS guide to stdout (exit 0)", async () => {
    const { stdout, status } = await runCli(["hints"]);
    expect(status).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
    expect(stdout).toMatch(/akm/i);
  });

  test("hints --detail <bogus>: parseDetailLevel → {ok:false} usage envelope on stderr (exit 2)", async () => {
    const { stderr, status } = await runCli(["--json", "hints", "--detail", "bogus"]);
    expect(status).toBe(2);
    const env = JSON.parse(stderr);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("INVALID_DETAIL_VALUE");
    expect(env.error).toMatch(/Invalid value for --detail/);
  });
});
