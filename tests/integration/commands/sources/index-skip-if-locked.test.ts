// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm index --skip-if-locked` (index-redesign B5a): the flag is now
 * deprecated and has no effect — index runs no longer take a rebuild lock
 * (every write is a short, idempotent, content-addressed transaction, so two
 * concurrent runs converge instead of contending), so there is nothing left
 * to "skip" for. It is kept only so existing scripts do not fail on an
 * unknown flag: passing it prints one deprecation warning and the run
 * proceeds exactly as an ordinary `akm index` would.
 *
 * The prior version of this file (pre-B5a) planted a rebuild-lock sentinel
 * and asserted the flag skipped the run at exit 0 without touching the DB —
 * that mechanism is gone (`src/indexer/index-rebuild-lock.ts`, deleted), so
 * those tests are deleted rather than adapted; there is no lock left to hold
 * or skip around.
 *
 * Integration-scoped (ORG-03/06): drives the real CLI via `runCliCapture`,
 * which opens a real index.db.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { saveConfig } from "../../../../src/core/config/config";
import { runCliCapture } from "../../../_helpers/cli";
import { type Cleanup, withIsolatedAkmStorage } from "../../../_helpers/sandbox";

let cleanup: Cleanup = () => {};

beforeEach(() => {
  const storage = withIsolatedAkmStorage();
  cleanup = storage.cleanup;
  saveConfig({ semanticSearchMode: "off" });
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
});

describe("akm index --skip-if-locked (deprecated, no effect)", () => {
  test("prints one deprecation warning and still indexes normally", async () => {
    const result = await runCliCapture(["index", "--full", "--skip-if-locked", "--format=json"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/--skip-if-locked is deprecated and has no effect/);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.skipped).toBeUndefined();
    expect(typeof parsed.totalEntries).toBe("number");
  });

  test("without the flag, no deprecation warning is printed", async () => {
    const result = await runCliCapture(["index", "--full", "--format=json"]);

    expect(result.code).toBe(0);
    expect(result.stderr).not.toMatch(/--skip-if-locked/);
  });
});
