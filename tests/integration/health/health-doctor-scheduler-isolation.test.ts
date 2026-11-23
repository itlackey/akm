// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A test run never reads the developer's crontab: bare `akm doctor` reports an empty scheduler in the sandbox,
 * whatever the host's `crontab` holds.
 */

import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

const CLI = path.resolve(import.meta.dir, "../../../src/cli.ts");
setDefaultTimeout(120_000);
let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({ semanticSearchMode: "off" });
});
afterEach(() => storage.cleanup());

test.skipIf(process.platform !== "linux")(
  "the crontab a spawned akm reads is the sandbox's, and doctor reports no bindings",
  () => {
    const env = { ...process.env, NO_COLOR: "1", BUN_TEST: undefined, AKM_EVENT_SOURCE: undefined };
    const which = spawnSync("sh", ["-c", "command -v crontab"], { encoding: "utf8", env });
    expect(which.stdout.trim().startsWith(process.env.TMPDIR ?? "/tmp")).toBe(true);
    const doctor = spawnSync("bun", [CLI, "doctor", "--no-probe", "--format", "json"], { encoding: "utf8", env });
    expect(JSON.parse(doctor.stdout).scheduler.bindings).toEqual([]);
  },
);
