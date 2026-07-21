// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Adapter dispatch through the PRODUCTION index path (owner ruling 2026-07-21):
 * the live indexer's per-dir drain now resolves `adapterForId(component.adapter)`
 * per component instead of hardcoding the `akm` adapter (spec §4 / §14.2).
 *
 *   1. A component whose DETECTED adapter is `llm-wiki` gets recognized by the
 *      llm-wiki adapter — the persisted entries carry llm-wiki's OWN open types
 *      (`wiki-source`/`concept`/`entity`/…), which the `akm` adapter would NEVER
 *      emit. This is the regression the completion fixes: before dispatch, the
 *      wiki root was probed as `llm-wiki` (adapter_id provenance) but STILL
 *      recognized by `akm`.
 *   2. The `akm` fixture stash still indexes unchanged (the full existing battery
 *      is the akm regression net; this pins the dispatch default stays `akm`).
 *   3. Unknown-adapter-id skip contract (§4): `adapterForId` returns `undefined`
 *      for an unknown id — the exact condition the production loop keys on to skip
 *      the component with a warning. (The condition is unreachable via the current
 *      probe-only `deriveInstallations`, which only ever yields a built-in id or
 *      the `akm` fallback; the branch is defensive for the future config-driven
 *      adapter id, so it is pinned at the `adapterForId` contract level.)
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { registerBuiltinAdapters } from "../../../src/core/adapter/adapters";
import { adapterForId, resetAdapterRegistryForTests } from "../../../src/core/adapter/registry";
import { getDbPath } from "../../../src/core/paths";
import { akmIndex } from "../../../src/indexer/indexer";
import { closeDatabase, openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { type Cleanup, sandboxXdgCacheHome, sandboxXdgConfigHome } from "../../_helpers/sandbox";

const LLM_WIKI_ROOT = path.resolve(__dirname, "../../fixtures/bundles/llm-wiki");

/** Persisted `(entry_type, adapter_id, concept_id)` rows for the indexed stash. */
interface Row {
  entryType: string;
  adapterId: string | null;
  conceptId: string;
}

function readEntries(): Row[] {
  const db = openIndexDatabase();
  try {
    return (
      db.prepare("SELECT entry_type, adapter_id, concept_id FROM entries").all() as Array<{
        entry_type: string;
        adapter_id: string | null;
        concept_id: string;
      }>
    ).map((r) => ({ entryType: r.entry_type, adapterId: r.adapter_id, conceptId: r.concept_id }));
  } finally {
    closeDatabase(db);
  }
}

function freshDb(): void {
  const dbPath = getDbPath();
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
}

describe("indexer dispatch — a detected llm-wiki component is recognized by the llm-wiki adapter", () => {
  let cleanup: Cleanup = () => {};
  let rows: Row[] = [];

  beforeAll(async () => {
    resetAdapterRegistryForTests();
    registerBuiltinAdapters();
    const cache = sandboxXdgCacheHome();
    const cfg = sandboxXdgConfigHome(cache.cleanup);
    cleanup = cfg.cleanup;
    freshDb();
    await akmIndex({ stashDir: LLM_WIKI_ROOT, full: true });
    rows = readEntries();
  });

  afterAll(() => {
    cleanup();
    cleanup = () => {};
  });

  test("the wiki root indexes some entries (dispatch actually ran the walk)", () => {
    expect(rows.length).toBeGreaterThan(0);
  });

  test("persisted entry types are llm-wiki's OWN types — never an akm classification", () => {
    const types = new Set(rows.map((r) => r.entryType));
    // llm-wiki's recognize emits `wiki-source` for raw/ and the page `pageKind`
    // (concept/entity/note) for pages/ — none of which is an akm placement type.
    expect(types.has("wiki-source")).toBe(true);
    expect([...types].some((t) => ["concept", "entity", "note"].includes(t))).toBe(true);
    // The akm adapter would have classified these markdown files as `knowledge`
    // (its md fallback); dispatch to llm-wiki means it never does.
    expect(types.has("knowledge")).toBe(false);
  });

  test("every persisted row carries the llm-wiki adapter provenance", () => {
    for (const r of rows) expect(r.adapterId).toBe("llm-wiki");
  });

  test("the reserved root files (schema/index/log) and README are abstained (not concepts)", () => {
    const concepts = new Set(rows.map((r) => r.conceptId));
    for (const reserved of ["schema", "index", "log", "README"]) {
      expect(concepts.has(reserved)).toBe(false);
    }
  });
});

describe("indexer dispatch — unknown adapter id skip contract (§4)", () => {
  beforeAll(() => {
    resetAdapterRegistryForTests();
    registerBuiltinAdapters();
  });

  test("adapterForId returns undefined for an unknown id (the production skip+warn condition)", () => {
    expect(adapterForId("no-such-adapter")).toBeUndefined();
    // A known id still resolves — the loop dispatches it rather than skipping.
    expect(adapterForId("llm-wiki")).toBeDefined();
    expect(adapterForId("akm")).toBeDefined();
  });
});
