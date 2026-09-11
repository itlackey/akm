// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Index-redesign B5g: `buildSearchFields.content` used to carry parameter
 * names/descriptions into the old per-entry `entries_fts.content` column, so
 * a search for a parameter name matched even when the name appeared nowhere
 * in the asset's own Markdown body. No unit carried that text after the
 * redesign — `toUnitSource`'s card unit was name/description/tags/hints
 * only — so that match silently stopped working. `toUnitSource` now appends
 * one line per parameter (index-redesign B5g, `src/indexer/units/unit.ts`)
 * to close the gap.
 *
 * Drives `akmSearch` against a real `index.db` (via `seedUnitsForAllEntries`,
 * which runs the real `toUnitSource`/`deriveUnits` pipeline this test is
 * pinning — not hand-seeded synthetic unit text), so this is
 * integration-scoped (ORG-03/06).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmSearch } from "../../../src/commands/read/search";
import { resetConfigCache, saveConfig } from "../../../src/core/config/config";
import { getDbPath } from "../../../src/core/paths";
import { deriveEntryProvenance } from "../../../src/indexer/installations";
import type { IndexDocument } from "../../../src/indexer/passes/metadata";
import { buildSearchText } from "../../../src/indexer/search/search-fields";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { upsertEntry } from "../../../src/storage/repositories/index-entries-repository";
import { setMeta } from "../../../src/storage/repositories/index-meta-repository";
import {
  type Cleanup,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
  sandboxXdgStateHome,
} from "../../_helpers/sandbox";
import { seedUnitsForAllEntries } from "../../_helpers/seed-units";

describe("card unit parameters — akm search finds a parameter name (index-redesign B5g)", () => {
  let stashDir = "";
  let envCleanup: Cleanup = () => {};

  beforeEach(() => {
    const cacheResult = sandboxXdgCacheHome();
    const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
    const dataResult = sandboxXdgDataHome(cfgResult.cleanup);
    const stateResult = sandboxXdgStateHome(dataResult.cleanup);
    const stashResult = sandboxStashDir(stateResult.cleanup);
    stashDir = stashResult.dir;
    envCleanup = stashResult.cleanup;

    resetConfigCache();
    saveConfig({
      semanticSearchMode: "off",
      bundles: { stash: { path: stashDir } },
      defaultBundle: "stash",
      registries: [],
    });
  });

  afterEach(() => {
    envCleanup();
    envCleanup = () => {};
    resetConfigCache();
  });

  test("a parameter name absent from the markdown body is found via the card unit", async () => {
    fs.mkdirSync(path.join(stashDir, "commands"), { recursive: true });
    const filePath = path.join(stashDir, "commands", "retry-runner.md");
    // The markdown body deliberately never mentions "retryBudget" — the only
    // place that string exists is the parameter's name, so a hit here can
    // only have come from the card unit's parameters line, not a fragment.
    fs.writeFileSync(filePath, "---\ntype: command\ndescription: Runs a bounded retry loop.\n---\nRuns the loop.\n");

    const dbPath = getDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = openIndexDatabase(dbPath);
    try {
      const entry: IndexDocument = {
        name: "retry-runner",
        type: "command",
        description: "Runs a bounded retry loop.",
        parameters: [{ name: "retryBudget", description: "How many retries are allowed before giving up." }],
      };
      const searchText = buildSearchText(entry);
      const provenance = deriveEntryProvenance(
        { bundleId: "stash", componentId: "stash", adapterId: "akm" },
        "command",
        "retry-runner",
      );
      upsertEntry(db, filePath, entry, searchText, provenance);
      // Runs the real toUnitSource/deriveUnits pipeline (unit.ts) this test
      // pins, then persists units_fts — the path akm index itself writes
      // through, minus the file walk this test bypasses by inserting the
      // entry directly.
      seedUnitsForAllEntries(db);
      setMeta(db, "stashDir", stashDir);
      setMeta(db, "builtAt", new Date().toISOString());
      setMeta(db, "stashDirs", JSON.stringify([stashDir]));
      setMeta(db, "hasEmbeddings", "0");
    } finally {
      closeDatabase(db);
    }

    const result = await akmSearch({ query: "retryBudget", source: "local", limit: 10 });
    const hit = result.hits.find((h) => "name" in h && h.name === "retry-runner");
    expect(hit).toBeDefined();
    if (hit && "matchedUnit" in hit) {
      expect(hit.matchedUnit?.kind).toBe("card");
      expect(hit.matchedUnit?.fragmentId).toBeNull();
    }
  });

  test("without the parameter, the same query finds nothing (the fixture, not the query, is the reason it matches above)", async () => {
    fs.mkdirSync(path.join(stashDir, "commands"), { recursive: true });
    const filePath = path.join(stashDir, "commands", "no-params-runner.md");
    fs.writeFileSync(filePath, "---\ntype: command\ndescription: Runs a bounded retry loop.\n---\nRuns the loop.\n");

    const dbPath = getDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = openIndexDatabase(dbPath);
    try {
      const entry: IndexDocument = {
        name: "no-params-runner",
        type: "command",
        description: "Runs a bounded retry loop.",
      };
      const searchText = buildSearchText(entry);
      const provenance = deriveEntryProvenance(
        { bundleId: "stash", componentId: "stash", adapterId: "akm" },
        "command",
        "no-params-runner",
      );
      upsertEntry(db, filePath, entry, searchText, provenance);
      seedUnitsForAllEntries(db);
      setMeta(db, "stashDir", stashDir);
      setMeta(db, "builtAt", new Date().toISOString());
      setMeta(db, "stashDirs", JSON.stringify([stashDir]));
      setMeta(db, "hasEmbeddings", "0");
    } finally {
      closeDatabase(db);
    }

    const result = await akmSearch({ query: "retryBudget", source: "local", limit: 10 });
    expect(result.hits.some((h) => "name" in h && h.name === "no-params-runner")).toBe(false);
  });
});
