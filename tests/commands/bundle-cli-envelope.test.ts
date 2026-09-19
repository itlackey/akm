// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS6-style characterization test for the `akm bundle` command group
 * (0.9 CLI overhaul, S7): `create` (= old top-level `init`), `list` (= old
 * top-level `list`), and the new `show <name>` single-bundle detail view.
 * Pins the JSON envelope (stdout payload shape + the {ok:false,code} error
 * envelope on stderr / exit code).
 *
 * `create`'s coverage moved here from tests/integration/commands/stash-cli-
 * envelope.test.ts; `list`'s `--kind` coverage moved here from
 * tests/commands/sources-cli-envelope.test.ts. Both are byte-identical moves
 * (payload/shape unchanged for `list`; `create`'s output shape is renamed
 * from `init` to `bundle-create` to match the verb rename).
 *
 * Only deterministic, offline paths are exercised: bundle creation into a
 * temp dir, and the read-only `list`/`show` happy + not-found paths. `add`/
 * `remove`/`update`'s network- and git-touching paths are covered by their
 * own integration tests.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isSkippableBundleUpdateLock } from "../../src/commands/sources/bundle-cli";
import { TransientError, UsageError } from "../../src/core/errors";
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
const createdTmpDirs: string[] = [];

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
  for (const dir of createdTmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("akm bundle group — JSON envelope snapshot (S7)", () => {
  test("update --skip-if-locked recognizes only update-relevant transient lock failures (#976)", () => {
    for (const code of ["INDEX_DB_CONTENDED", "STATE_DB_CONTENDED", "MAINTENANCE_BARRIER_BUSY"] as const) {
      expect(isSkippableBundleUpdateLock(new TransientError("busy", code))).toBe(true);
    }
    expect(isSkippableBundleUpdateLock(new TransientError("busy", "IMPROVE_LOCK_HELD"))).toBe(false);
    expect(isSkippableBundleUpdateLock(new UsageError("bad input"))).toBe(false);
  });

  test("create: success envelope carries bundleDir + created + bundle-create shape (exit 0)", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "akm-bundle-create-"));
    createdTmpDirs.push(parent);
    const stashDir = path.join(parent, "newstash");
    const { stdout, status } = await runCli(["bundle", "create", "--dir", stashDir]);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.bundleDir).toBe(stashDir);
    expect(env.created).toBe(true);
    expect(env.shape).toBe("bundle-create");
    expect(fs.existsSync(path.join(stashDir, "lessons"))).toBe(true);
  });

  test("list: success envelope carries sources array + totalSources + list shape", async () => {
    const { stdout, status } = await runCli(["bundle", "list"]);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(Array.isArray(env.sources)).toBe(true);
    expect(typeof env.totalSources).toBe("number");
    expect(env.shape).toBe("list");
  });

  test("list --kind <valid>: filter is accepted (exit 0, list shape)", async () => {
    const { stdout, status } = await runCli(["bundle", "list", "--kind", "filesystem"]);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.shape).toBe("list");
    expect(Array.isArray(env.sources)).toBe(true);
  });

  test("list --kind <bogus>: parseKindFilter → {ok:false} usage envelope on stderr (exit 2)", async () => {
    const { stderr, status } = await runCli(["bundle", "list", "--kind", "bogus"]);
    expect(status).toBe(2);
    const env = JSON.parse(stderr);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("INVALID_FLAG_VALUE");
    expect(env.error).toMatch(/Invalid --kind value/);
  });

  test("show <name>: not found → {ok:false} not-found envelope on stderr (exit 1)", async () => {
    const { stderr, status } = await runCli(["bundle", "show", "does-not-exist"]);
    expect(status).toBe(1);
    const env = JSON.parse(stderr);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("SOURCE_NOT_FOUND");
  });
});
