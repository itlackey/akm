// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS6 characterization test for the observability command cluster
 * (`akm log`). Pins the JSON envelope (stdout payload shape, the
 * {ok:false,code} error envelope on stderr, and exit codes) for representative
 * subcommands, proving the extraction from cli.ts into
 * src/commands/observability-cli.ts is byte-identical.
 *
 * `log` was migrated onto `defineJsonCommand`, which emits the same JSON
 * envelope (stdout/stderr/exit-code) as the inline form.
 *
 * 0.9.0 CLI overhaul (S3): `log` was a group with `list`/`tail` subcommands;
 * `tail` is dropped and `log` is now the leaf command (today's `list`
 * surface, unchanged). The `lessons`/`lesson` group (`coverage`, `strength`)
 * is dropped entirely along with its envelope tests below.
 *
 * `log tail` was intentionally not exercised here — it followed the events
 * table via a polling loop and would have made this snapshot
 * non-deterministic.
 *
 * Agent guidance is available through both `akm hints` (full by default,
 * preserving its original contract) and `akm help agents` (short by default).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runCliStatus as runCli } from "../_helpers/cli";
import { type Cleanup, sandboxStashDir, sandboxXdgDataHome, writeSandboxConfig } from "../_helpers/sandbox";

let stashCleanup: Cleanup = () => {};

beforeEach(() => {
  // Chain sandboxXdgDataHome onto sandboxStashDir so `index.db` (which lives
  // under XDG_DATA_HOME, see src/core/paths.ts:getDataDir) is isolated
  // per-test too — not just AKM_BUNDLE_DIR.
  const stash = sandboxStashDir();
  const data = sandboxXdgDataHome(stash.cleanup);
  stashCleanup = data.cleanup;
  writeSandboxConfig({ semanticSearchMode: "off" });
});

afterEach(() => {
  stashCleanup();
  stashCleanup = () => {};
});

describe("akm observability cluster — JSON envelope snapshot (WS6)", () => {
  test("log: success envelope carries events array + totalCount + nextOffset", async () => {
    const { stdout, status } = await runCli(["log"]);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(Array.isArray(env.events)).toBe(true);
    expect(typeof env.totalCount).toBe("number");
    expect(typeof env.nextOffset).toBe("number");
  });

  test("help agents: prints the short embedded guide to stdout (exit 0)", async () => {
    const { stdout, status } = await runCli(["help", "agents"]);
    expect(status).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
    expect(stdout).toMatch(/akm/i);
  });

  test("help agents --full: prints the complete guide, longer than the short one (exit 0)", async () => {
    const short = await runCli(["help", "agents"]);
    const full = await runCli(["help", "agents", "--full"]);
    expect(full.status).toBe(0);
    expect(full.stdout.length).toBeGreaterThan(short.stdout.length);
  });

  test("hints: prints the complete guide, with --detail brief selecting the short guide", async () => {
    const full = await runCli(["hints"]);
    const short = await runCli(["hints", "--detail", "brief"]);
    expect(full.status).toBe(0);
    expect(short.status).toBe(0);
    expect(full.stdout.length).toBeGreaterThan(short.stdout.length);
  });
});
