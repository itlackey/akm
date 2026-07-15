// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests for the stale-index hint on search. Reads serve the existing index
 * as-is (no read-triggered reindex), so when the index was last built more
 * than a week ago the search response carries an actionable warning pointing
 * at `akm index` — the escape hatch for installs with no improve cron whose
 * hand-edited files would otherwise silently never appear.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AkmConfig } from "../../../src/core/config/config";
import { getDbPath } from "../../../src/core/paths";
import { closeDatabase, openExistingDatabase, setMeta } from "../../../src/indexer/db/db";
import { akmIndex } from "../../../src/indexer/indexer";
import { searchLocal } from "../../../src/indexer/search/db-search";
import {
  type Cleanup,
  sandboxEnvDir,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
} from "../../_helpers/sandbox";

let stashDir = "";
let cleanup: Cleanup = () => {};

function runSearch() {
  const config: AkmConfig = { semanticSearchMode: "off" };
  return searchLocal({
    query: "seed",
    searchType: "any",
    limit: 5,
    stashDir,
    sources: [{ path: stashDir }],
    config,
  });
}

function backdateBuiltAt(days: number): void {
  const db = openExistingDatabase(getDbPath());
  try {
    setMeta(db, "builtAt", new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString());
  } finally {
    closeDatabase(db);
  }
}

beforeEach(async () => {
  const stash = sandboxStashDir();
  stashDir = stash.dir;
  let chain = sandboxXdgConfigHome(stash.cleanup).cleanup;
  chain = sandboxXdgCacheHome(chain).cleanup;
  chain = sandboxEnvDir("akm-stale-hint-data", "AKM_DATA_DIR", chain).cleanup;
  chain = sandboxEnvDir("akm-stale-hint-state", "AKM_STATE_DIR", chain).cleanup;
  cleanup = chain;
  const memoryPath = path.join(stashDir, "memories", "seed.md");
  fs.writeFileSync(memoryPath, "---\ndescription: seed memory\n---\n\n# seed\n\nBody.\n", "utf8");
  await akmIndex({ stashDir });
});

afterEach(() => {
  cleanup();
});

describe("search stale-index hint", () => {
  test("fresh index: no hint", async () => {
    const result = await runSearch();
    expect((result.warnings ?? []).join(" ")).not.toContain("last built");
  });

  test("index built >7 days ago: warning names the age and akm index", async () => {
    backdateBuiltAt(8);
    const result = await runSearch();
    const combined = (result.warnings ?? []).join(" ");
    expect(combined).toContain("last built 8 day(s) ago");
    expect(combined).toContain("akm index");
  });

  test("index built <7 days ago: no hint", async () => {
    backdateBuiltAt(6);
    const result = await runSearch();
    expect((result.warnings ?? []).join(" ")).not.toContain("last built");
  });
});
