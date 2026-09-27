// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Search reads index.db only. It used to load improve's salience scores from
 * state.db (#692 removed that, along with a hot-path wait on the maintenance
 * barrier), and ranking no longer uses any usage signal, so a search must not
 * create or open state.db.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getStateDbPath } from "../../src/core/state-db";
import { akmIndex } from "../../src/indexer/indexer";
import { searchLocal } from "../../src/indexer/search/db-search";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

describe("search and state.db", () => {
  let storage: IsolatedAkmStorage;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
  });

  afterEach(() => storage.cleanup());

  /** Seed one searchable lesson asset and build the real index for it. */
  async function seedAndIndex(): Promise<void> {
    const lessonPath = path.join(storage.stashDir, "lessons", "hot.md");
    fs.writeFileSync(lessonPath, "---\ndescription: a hot lesson\n---\n\n# hot\n\nBody text about hot.\n", "utf8");
    await akmIndex({ stashDir: storage.stashDir });
  }

  function search() {
    return searchLocal({
      query: "hot",
      searchType: "any",
      limit: 5,
      stashDir: storage.stashDir,
      sources: [{ path: storage.stashDir }],
      config: { semanticSearchMode: "off" },
    });
  }

  test("default search never creates state.db (stronger form: it touches state.db not at all)", async () => {
    await seedAndIndex();
    const dbPath = getStateDbPath();
    // akmIndex itself legitimately touches state.db (index-run bookkeeping,
    // unrelated to search/ranking) via `withStateDb`, so a fresh sandbox is
    // not guaranteed to still be state.db-less after indexing. Force absence
    // right before the search call — that isolates the property this test
    // actually cares about: SEARCH, not indexing, must not create it.
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
    expect(fs.existsSync(dbPath)).toBe(false);

    const result = await search();
    expect(result.hits.length).toBeGreaterThan(0);

    expect(fs.existsSync(dbPath)).toBe(false);
  });
});
