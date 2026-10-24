// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS6 characterization test for the `akm config` command family. Pins the full
 * JSON envelope (stdout payload shape + the {ok:false,code} error envelope on
 * stderr / exit code) for the representative subcommands
 * list/get/set/unset/path, proving the extraction of the family from
 * cli.ts into src/commands/config-cli.ts is byte-identical. The leaf handlers
 * were migrated onto `defineJsonCommand`, which emits the same JSON envelope
 * (stdout/stderr/exit-code) as the inline form.
 *
 * `config enable`/`config disable` (a hardcoded skills.sh registry toggle)
 * were removed in 0.9.0 (C4) — use `akm registry add|remove`, the general
 * mechanism. See tests/integration/cli-errors.test.ts ("R-032: citty CLIError
 * family exits 2, not 1") for the real-subprocess exit-code check that the
 * removed subcommands now fail as unknown (the in-process harness here does
 * not reproduce citty's unknown-subcommand exit code).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runCliStatus as runCli } from "../_helpers/cli";
import { type Cleanup, sandboxStashDir, writeSandboxConfig } from "../_helpers/sandbox";

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

describe("akm config — JSON envelope snapshot (WS6)", () => {
  test("config list: success envelope carries config v2 engine/strategy semantics", async () => {
    const { stdout, status } = await runCli(["config", "list"]);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.semanticSearchMode).toBe("off");
    expect(env.configVersion).toBe("0.9.0");
    expect(env.profiles).toBeUndefined();
    // #918: every success envelope carries ok:true, matching the {ok:false,...}
    // shape a failure throws before output() is reached.
    expect(env.ok).toBe(true);
  });

  test("config get: returns the requested key value", async () => {
    const { stdout, status } = await runCli(["config", "get", "semanticSearchMode"]);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env).toBe("off");
  });

  test("config set: persists and dumps the merged config", async () => {
    const { stdout, status } = await runCli(["config", "set", "semanticSearchMode", "auto"]);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.semanticSearchMode).toBe("auto");
    // #918: `ok: true` alongside the config dump so a caller branching on
    // `.ok` no longer reads a successful set as a failure.
    expect(env.ok).toBe(true);
  });

  test("config unset: persists and dumps the merged config with ok:true", async () => {
    await runCli(["config", "set", "--silent", "semanticSearchMode", "auto"]);
    const { stdout, status } = await runCli(["config", "unset", "semanticSearchMode"]);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.ok).toBe(true);
    expect(env.semanticSearchMode).toBe("off"); // falls back to DEFAULT_CONFIG
  });

  test("config set --silent: suppresses the post-write dump entirely (empty stdout, exit 0)", async () => {
    const { stdout, status } = await runCli(["config", "set", "semanticSearchMode", "auto", "--silent"]);
    expect(status).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  test("config unset --silent: suppresses the post-write dump entirely (empty stdout, exit 0)", async () => {
    await runCli(["config", "set", "--silent", "semanticSearchMode", "auto"]);
    const { stdout, status } = await runCli(["config", "unset", "semanticSearchMode", "--silent"]);
    expect(status).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  test("config path --all: success envelope carries config/bundle/cache/index paths", async () => {
    const { stdout, status } = await runCli(["config", "path", "--all"]);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(typeof env.config).toBe("string");
    expect(typeof env.bundle).toBe("string");
    expect(typeof env.cache).toBe("string");
    expect(typeof env.index).toBe("string");
    expect(env.ok).toBe(true);
  });
});
