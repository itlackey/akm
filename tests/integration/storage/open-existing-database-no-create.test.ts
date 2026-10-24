// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `openExistingDatabase()` must honor its name: opening a MISSING index.db
 * must throw — never create a schema-less file (or its parent dir) as a side
 * effect.
 *
 * Regression for the curate→proposal shard failure (runbook §24.2 "Test
 * harness" gate): `akm curate`'s fire-and-forget usage-event telemetry ran
 * `withIndexDb` → `openExistingDatabase` with no index present, which used to
 * create an empty, schema-less `index.db` at the shared data dir. Any later
 * proposal acceptance in the same process then found the file existing,
 * failed `getEntryCount` ("no such table: entries"), and
 * `indexWrittenAssets` returned false — turning proposal finalization into a
 * file-order-dependent hard failure. The two-file shard repro was
 * `tests/curate-logic.test.ts` before
 * `tests/commands/proposal/adapter-precommit-check.test.ts`; this suite pins
 * the same sequence in-process, order-independently.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getDbPath } from "../../../src/core/paths";
import { indexWrittenAssets } from "../../../src/indexer/index-written-assets";
import { openExistingDatabase } from "../../../src/storage/repositories/index-connection";
import { TELEMETRY_BUSY_TIMEOUT_MS, withIndexDb } from "../../../src/storage/repositories/index-db";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

describe("openExistingDatabase on a missing index.db", () => {
  let storage: IsolatedAkmStorage;
  beforeEach(() => {
    storage = withIsolatedAkmStorage();
  });
  afterEach(() => storage.cleanup());

  test("throws and leaves neither the file nor its parent dir behind", () => {
    const dbPath = getDbPath();
    expect(fs.existsSync(dbPath)).toBe(false);

    expect(() => openExistingDatabase()).toThrow(/index/i);

    expect(fs.existsSync(dbPath)).toBe(false);
    expect(fs.existsSync(path.dirname(dbPath))).toBe(false);
  });

  test("read-path telemetry no-ops without creating a schema-less index.db, and a later write-path index still fail-opens", async () => {
    const dbPath = getDbPath();

    // The curate/search/show telemetry idiom: fire-and-forget withIndexDb,
    // errors swallowed by the caller.
    try {
      withIndexDb((db) => db.prepare("SELECT id FROM entries LIMIT 1").all(), {
        busyTimeoutMs: TELEMETRY_BUSY_TIMEOUT_MS,
      });
    } catch {
      // fire-and-forget: dropped, exactly as logCurateEvent does
    }
    expect(fs.existsSync(dbPath)).toBe(false);

    // The second half of the original failure: with no index.db present the
    // write path must take its documented fail-open skip (return true) — not
    // find a schema-less leftover and report failure.
    const lesson = path.join(storage.stashDir, "lessons", "regression.md");
    fs.writeFileSync(lesson, "---\ndescription: shard regression pin\n---\n\nBody.\n");
    await expect(indexWrittenAssets(storage.stashDir, [lesson])).resolves.toBe(true);
    expect(fs.existsSync(dbPath)).toBe(false);
  });
});
