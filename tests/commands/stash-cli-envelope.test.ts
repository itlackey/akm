// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS6 characterization test for the stash-lifecycle command cluster
 * (`akm index`, `akm import`, `akm info`).
 * Pins the JSON envelope (stdout payload shape + the {ok:false,code} error
 * envelope on stderr / exit code) for representative subcommands, proving the
 * extraction from cli.ts into src/commands/stash-cli.ts is byte-identical.
 *
 * `import` and `info` were migrated onto
 * `defineJsonCommand`, which emits the same JSON envelope (stdout/stderr/
 * exit-code) as the inline `runWithJsonErrors` + `output` form. `index` keeps a
 * plain `defineCommand` (spinner / AbortController / signal handlers) — its
 * removed-flag usage error still routes through the same envelope.
 *
 * Only deterministic, offline paths are exercised: the read-only `info` happy
 * path, and argument-validation errors (exit 2). The `index` build and
 * `import` ingest happy paths touch the indexer/filesystem and are covered by
 * their own behaviour suites.
 *
 * 0.9 CLI overhaul (S7): `init` moved to `akm bundle create` — its envelope
 * coverage moved to tests/commands/bundle-cli-envelope.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runCliStatus as runCli } from "../_helpers/cli";
import {
  type Cleanup,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
  writeSandboxConfig,
} from "../_helpers/sandbox";

let envCleanup: Cleanup = () => {};

beforeEach(() => {
  const dataResult = sandboxXdgDataHome();
  const cacheResult = sandboxXdgCacheHome(dataResult.cleanup);
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  const stashResult = sandboxStashDir(cfgResult.cleanup);
  envCleanup = stashResult.cleanup;
  writeSandboxConfig({ semanticSearchMode: "off" });
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
});

describe("akm stash-lifecycle cluster — JSON envelope snapshot (WS6)", () => {
  test("info: success envelope carries version + assetTypes array (exit 0)", async () => {
    const { stdout, status } = await runCli(["info"]);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(typeof env.version).toBe("string");
    expect(Array.isArray(env.assetTypes)).toBe(true);
    expect(typeof env.schemaVersion).toBe("number");
  });

  test("index --enrich (removed flag): {ok:false} usage envelope on stderr (exit 2)", async () => {
    const { stderr, status } = await runCli(["index", "--enrich"]);
    expect(status).toBe(2);
    const env = JSON.parse(stderr);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("INVALID_FLAG_VALUE");
    expect(env.error).toMatch(/--enrich` has been removed/);
  });

  test("index --re-enrich (removed flag): {ok:false} usage envelope on stderr (exit 2)", async () => {
    const { stderr, status } = await runCli(["index", "--re-enrich"]);
    expect(status).toBe(2);
    const env = JSON.parse(stderr);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("INVALID_FLAG_VALUE");
    expect(env.error).toMatch(/--re-enrich` has been removed/);
  });

  test("import --name with '/': assertFlatAssetName → {ok:false} usage envelope on stderr (exit 2)", async () => {
    const { stderr, status } = await runCli(["import", "-", "--name", "nested/bad"]);
    expect(status).toBe(2);
    const env = JSON.parse(stderr);
    expect(env.ok).toBe(false);
    expect(typeof env.code).toBe("string");
  });
});
