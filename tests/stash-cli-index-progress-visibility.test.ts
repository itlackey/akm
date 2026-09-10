// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #954: the default `akm index` output format is JSON, and a
 * non-verbose JSON run used to print NOTHING to stderr until the very end —
 * a stalled run looked identical to "no database open, nothing written"
 * (field report). Phase-start messages and the embedding heartbeat now reach
 * stderr via `info()` in non-verbose JSON mode too; text mode keeps the
 * spinner (no stderr line growth); verbose still gets everything, including
 * the high-frequency per-batch `Embedded N/M entries.` line that JSON mode
 * deliberately does NOT surface (that would defeat the point — spam instead
 * of a heartbeat).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { runCliCapture } from "./_helpers/cli";
import { type IsolatedAkmStorage, withEnv, withIsolatedAkmStorage, writeSandboxConfig } from "./_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({ semanticSearchMode: "off" });
  fs.writeFileSync(
    path.join(storage.stashDir, "knowledge", "guide.md"),
    "---\ndescription: A guide\n---\n\nSome content.\n",
  );
});

afterEach(() => storage.cleanup());

test("non-verbose JSON mode (the default) now prints phase-start progress to stderr", async () => {
  const result = await runCliCapture(["index", "--format", "json"]);

  expect(result.code).toBe(0);
  expect(result.stderr).toContain("[index:preflight]");
  expect(result.stderr).toContain("[index:scan]");
});

test("non-verbose text mode still uses the spinner, not stderr progress lines", async () => {
  const result = await runCliCapture(["index", "--format", "text"]);

  expect(result.code).toBe(0);
  expect(result.stderr).not.toContain("[index:preflight]");
});

test("--verbose (AKM_VERBOSE=1) still prints every phase message, unchanged", async () => {
  const result = await withEnv({ AKM_VERBOSE: "1" }, () => runCliCapture(["index", "--format", "json"]));

  expect(result.code).toBe(0);
  expect(result.stderr).toContain("[index:preflight]");
});
