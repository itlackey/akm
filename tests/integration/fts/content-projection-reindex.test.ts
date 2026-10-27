// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * akm#1260: the content projection's version is part of every directory's
 * index fingerprint, so an index written by an older projection is
 * re-projected by an ordinary incremental `akm index`, unchanged files
 * included. Without it, an upgrade's post-install `akm index` would keep the
 * old indexed text for every file nobody edits.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmSearch } from "../../../src/commands/read/search";
import { saveConfig } from "../../../src/core/config/config";
import { getDbPath } from "../../../src/core/paths";
import { akmIndex } from "../../../src/indexer/indexer";
import { computeDirFingerprint } from "../../../src/indexer/passes/dir-staleness";
import { CONTENT_PROJECTION_VERSION } from "../../../src/indexer/passes/metadata";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import {
  type Cleanup,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  withEnv,
} from "../../_helpers/sandbox";

let cleanup: Cleanup = () => {};

beforeEach(() => {
  const cacheResult = sandboxXdgCacheHome();
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  cleanup = sandboxStashDir(cfgResult.cleanup).cleanup;
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
});

function stashWithFencedName(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-projection-reindex-"));
  fs.mkdirSync(path.join(dir, "knowledge"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "knowledge", "provider-errors.md"),
    [
      "---",
      "description: Handling provider failures at startup",
      "---",
      "# Provider failures",
      "",
      "Startup checks the configured provider.",
      "",
      "```ts",
      "throw new QuokkaInitFailure(code)",
      "```",
      "",
    ].join("\n"),
  );
  return dir;
}

/**
 * Make every directory's stored state what the previous projection's release wrote: its fingerprint hash and
 * variant computed with `+content1`. The files are untouched, so only the projection version differs.
 */
function markIndexAsPreviousProjection(): number {
  const db = openIndexDatabase(getDbPath());
  try {
    const rows = db.prepare("SELECT dir_path, index_variant FROM index_dir_state").all() as Array<{
      dir_path: string;
      index_variant: string;
    }>;
    const update = db.prepare("UPDATE index_dir_state SET file_set_hash = ?, index_variant = ? WHERE dir_path = ?");
    for (const row of rows) {
      const previous = row.index_variant.replace(`+content${CONTENT_PROJECTION_VERSION}`, "+content1");
      const files = fs.readdirSync(row.dir_path).map((name) => path.join(row.dir_path, name));
      update.run(computeDirFingerprint(row.dir_path, files, previous).fileSetHash, previous, row.dir_path);
    }
    return rows.length;
  } finally {
    closeDatabase(db);
  }
}

describe("content projection version (akm#1260)", () => {
  test("an incremental index re-projects unchanged directories written by the previous projection", async () => {
    const stashDir = stashWithFencedName();
    await withEnv({ AKM_BUNDLE_DIR: stashDir }, async () => {
      saveConfig({ semanticSearchMode: "off" });
      await akmIndex({ stashDir, full: true });
      const found = await akmSearch({ query: "QuokkaInitFailure", source: "local" });
      expect(found.hits.map((hit) => hit.name)).toContain("provider-errors");

      // Unchanged files on the current projection: an incremental run skips them.
      const unchanged = await akmIndex({ stashDir });
      expect(unchanged.mode).toBe("incremental");
      expect(unchanged.directoriesScanned).toBe(0);

      // The same files under an index the previous projection wrote: the variant differs, so they are re-projected.
      expect(markIndexAsPreviousProjection()).toBeGreaterThan(0);
      const upgraded = await akmIndex({ stashDir });
      expect(upgraded.mode).toBe("incremental");
      expect(upgraded.directoriesScanned).toBeGreaterThan(0);
      const after = await akmSearch({ query: "QuokkaInitFailure", source: "local" });
      expect(after.hits.map((hit) => hit.name)).toContain("provider-errors");

      // And once only: the next run is back to skipping them.
      const settled = await akmIndex({ stashDir });
      expect(settled.directoriesScanned).toBe(0);
    });
  });
});
