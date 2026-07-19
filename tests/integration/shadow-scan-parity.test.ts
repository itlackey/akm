// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Chunk 5 F4a M-core-3 — FLIPPED shadow-parity gate (the F4 regression net).
 *
 * Before the flip this file compared two IN-MEMORY streams: the legacy
 * `generateMetadataFlat` `IndexDocument` stream vs the `scanComponent`
 * `IndexDocument` stream. F4a M-core-2 made `scanComponent`-style
 * `akmAdapter.recognize` the LIVE indexer engine and M-core-3 DELETED
 * `generateMetadataFlat`, so there is no legacy stream left to compare against.
 *
 * The gate now asserts the PERSISTED INDEX (built by the real `akmIndex` over
 * the fixture stashes) against the `recognize` stream that produced it — proving
 * the engine swap persists exactly what `recognize` recognizes, with the durable
 * D-R2 identity:
 *
 *   1. same set of ITEMS (no item gained or lost), keyed by `(type, conceptId)`;
 *   2. every item persists with `item_ref == <bundle>//<conceptId>` (D-R2) and a
 *      populated `content_hash` (the diff-persist provenance write, M-core-2);
 *   3. the durable `entry_json` deep-equals `indexDocumentToStashEntry(doc)` —
 *      the exact IndexDocument `recognize` reconstructs — modulo the persist-time
 *      `fileSize` (attached by `attachFileSize`, absent from the doc). This one
 *      equality SUBSUMES the old folded-search-fields and filter/ranking-signal
 *      arms: every one of those surfaces is derived from `entry_json`.
 *
 * Run over `all-types` (every asset type) and `search-filter` (rich curated/
 * belief/scope frontmatter + `.derived` twins).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { registerBuiltinAdapters } from "../../src/core/adapter/adapters";
import { akmAdapter } from "../../src/core/adapter/adapters/akm-adapter";
import { resetAdapterRegistryForTests } from "../../src/core/adapter/registry";
import { scanComponent } from "../../src/core/adapter/scan-component";
import type { BundleComponent, BundleInstallation, IndexDocument } from "../../src/core/adapter/types";
import { getDbPath } from "../../src/core/paths";
import { akmIndex } from "../../src/indexer/indexer";
import { indexDocumentToStashEntry } from "../../src/indexer/scan/doc-to-entry";
import { closeDatabase, openIndexDatabase } from "../../src/storage/repositories/index-connection";
import { type Cleanup, sandboxXdgCacheHome, sandboxXdgConfigHome } from "../_helpers/sandbox";

const STASHES: Array<{ name: string; root: string }> = [
  { name: "all-types", root: path.resolve(__dirname, "../fixtures/stashes/all-types") },
  { name: "search-filter", root: path.resolve(__dirname, "../fixtures/stashes/search-filter") },
];

/** The `recognize` document stream — the engine's own source of truth. */
async function newStream(root: string): Promise<IndexDocument[]> {
  const bundle = "parity";
  const component: BundleComponent = { id: bundle, adapter: "akm", root, writable: true };
  const inst: BundleInstallation = { id: bundle, components: [component], trusted: true };
  const docs: IndexDocument[] = [];
  for await (const doc of scanComponent(inst, component, akmAdapter)) docs.push(doc);
  return docs;
}

/** A persisted `entries` row projected onto the identity + durable columns. */
interface PersistedRow {
  entryType: string;
  conceptId: string;
  itemRef: string | null;
  contentHash: string | null;
  // biome-ignore lint/suspicious/noExplicitAny: entry_json is the durable IndexDocument, compared structurally below.
  entry: any;
}

/** new identity key: type + conceptId (the D-R2 qualified spelling), the ref's distinguishing pair. */
const docKey = (d: IndexDocument): string => `${d.type}:${d.conceptId}`;
const rowKey = (r: PersistedRow): string => `${r.entryType}:${r.conceptId}`;

for (const { name, root } of STASHES) {
  describe(`persisted-index parity — ${name}`, () => {
    let cleanup: Cleanup = () => {};
    let docs: IndexDocument[] = [];
    let rows: PersistedRow[] = [];

    beforeAll(async () => {
      resetAdapterRegistryForTests();
      registerBuiltinAdapters();
      docs = await newStream(root);

      // Build the live index over the fixture in a sandboxed XDG home so the
      // real `akmIndex` engine (recognize → diff-persist) writes to a temp DB.
      const cache = sandboxXdgCacheHome();
      const cfg = sandboxXdgConfigHome(cache.cleanup);
      cleanup = cfg.cleanup;
      const dbPath = getDbPath();
      for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        try {
          fs.unlinkSync(f);
        } catch {
          /* ignore */
        }
      }
      await akmIndex({ stashDir: root, full: true });

      const db = openIndexDatabase();
      try {
        rows = (
          db.prepare("SELECT entry_type, concept_id, item_ref, content_hash, entry_json FROM entries").all() as Array<{
            entry_type: string;
            concept_id: string;
            item_ref: string | null;
            content_hash: string | null;
            entry_json: string;
          }>
        ).map((r) => ({
          entryType: r.entry_type,
          conceptId: r.concept_id,
          itemRef: r.item_ref,
          contentHash: r.content_hash,
          entry: JSON.parse(r.entry_json),
        }));
      } finally {
        closeDatabase(db);
      }
    });

    afterAll(() => {
      cleanup();
      cleanup = () => {};
    });

    test("same item set (no item gained or lost)", () => {
      expect(rows.length).toBe(docs.length);
      expect(new Set(rows.map(rowKey))).toEqual(new Set(docs.map(docKey)));
    });

    test("each item persists with item_ref = <bundle>//<conceptId> (D-R2) and a content_hash", () => {
      const rowByKey = new Map(rows.map((r) => [rowKey(r), r]));
      // All rows share ONE bundle prefix (single-source fixture).
      const bundles = new Set(rows.map((r) => r.itemRef?.split("//")[0]));
      expect(bundles.size).toBe(1);
      for (const d of docs) {
        const r = rowByKey.get(docKey(d));
        expect(r, `no persisted row for ${docKey(d)}`).toBeDefined();
        if (!r) continue;
        // item_ref's suffix is exactly the conceptId (proves the D-R2 identity).
        expect(r.itemRef).toBe(`${r.itemRef?.split("//")[0]}//${d.conceptId}`);
        expect(r.contentHash, `content_hash for ${docKey(d)}`).toBeTruthy();
      }
    });

    test("persisted entry_json deep-equals recognize→IndexDocument (minus persist-time fileSize)", () => {
      const expectedByKey = new Map(docs.map((d) => [docKey(d), indexDocumentToStashEntry(d)]));
      let asserted = 0;
      for (const r of rows) {
        const expected = expectedByKey.get(rowKey(r));
        expect(expected, `no recognize doc for ${rowKey(r)}`).toBeDefined();
        if (!expected) continue;
        const persisted = { ...r.entry };
        // fileSize is attached at persist time by attachFileSize; the doc-derived
        // IndexDocument never carries it. Strip it for the structural comparison.
        persisted.fileSize = undefined;
        delete persisted.fileSize;
        expect(persisted, `entry_json for ${rowKey(r)}`).toEqual(expected);
        asserted += 1;
      }
      expect(asserted).toBe(docs.length);
    });
  });
}
