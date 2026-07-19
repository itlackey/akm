// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Chunk 5 M-b — SHADOW-PARITY PROOF (spec line 254, §12.3 pre-flip gate).
 *
 * Asserts that the `scanComponent` `IndexDocument` stream (the installation/
 * component scan loop that M-c makes the live indexer) is EQUIVALENT to the
 * current `generateMetadataFlat` `StashEntry` stream over real fixture stashes,
 * on every axis the flip must preserve:
 *
 *   1. same set of ITEMS (no item gained or lost);
 *   2. same `type` per item;
 *   3. same IDENTITY — the new `bundle//conceptId` maps 1:1 to the old
 *      `stashDir:type:name` (conceptId == the D-R2 qualified
 *      `stashDirFor(type)/canonicalName` spelling, type is carried, so the
 *      pair (type, conceptId) is the bijection key);
 *   4. same FOLDED METADATA SURFACE the ranking/embedding inputs read
 *      (`search-fields.ts:28-33` — name/description/tags/hints/content);
 *   5. same FILTER/RANKING SIGNAL fields (§12.3 filter-behavior parity:
 *      quality/beliefState/scope/currentBeliefRefs/derivedFrom/captureMode/
 *      lessonStrength) — carried first-class or on `documentJson`.
 *
 * This proves the destructive flip (M-c) is safe: the two independently-built
 * pipelines produce the same index. Run over `all-types` (every asset type) and
 * `search-filter` (rich curated/belief/scope frontmatter + `.derived` twins).
 */

import { beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import { registerBuiltinAdapters } from "../../src/core/adapter/adapters";
import { akmAdapter } from "../../src/core/adapter/adapters/akm-adapter";
import { resetAdapterRegistryForTests } from "../../src/core/adapter/registry";
import { scanComponent } from "../../src/core/adapter/scan-component";
import type { BundleComponent, BundleInstallation, IndexDocument } from "../../src/core/adapter/types";
import { stashDirFor } from "../../src/core/asset/asset-placement";
import { generateMetadataFlat, type StashEntry } from "../../src/indexer/passes/metadata";
import { indexDocumentToStashEntry } from "../../src/indexer/scan/doc-to-entry";
import { buildSearchFields } from "../../src/indexer/search/search-fields";
import { walkStashFlat } from "../../src/indexer/walk/walker";

beforeAll(() => {
  resetAdapterRegistryForTests();
  registerBuiltinAdapters();
});

const STASHES: Array<{ name: string; root: string }> = [
  { name: "all-types", root: path.resolve(__dirname, "../fixtures/stashes/all-types") },
  { name: "search-filter", root: path.resolve(__dirname, "../fixtures/stashes/search-filter") },
];

async function oldStream(root: string): Promise<StashEntry[]> {
  const files = walkStashFlat(root).map((f) => f.absPath);
  return (await generateMetadataFlat(root, files)).entries;
}

async function newStream(root: string): Promise<IndexDocument[]> {
  const bundle = "parity";
  const component: BundleComponent = { id: bundle, adapter: "akm", root, writable: true };
  const inst: BundleInstallation = { id: bundle, components: [component], trusted: true };
  const docs: IndexDocument[] = [];
  for await (const doc of scanComponent(inst, component, akmAdapter)) docs.push(doc);
  return docs;
}

/**
 * old identity key, projected into the D-R2 qualified conceptId spelling:
 * `stashDirFor(type)/canonicalName`. Joining old→new on this key ALSO proves
 * the qualified-derivation rule end-to-end (ref-grammar decision D-R2).
 */
const oldIdentity = (e: StashEntry): string => `${e.type}:${stashDirFor(e.type)}/${e.name}`;
/** new identity key: type + conceptId (the D-R2 qualified spelling), the ref's distinguishing pair. */
const newIdentity = (d: IndexDocument): string => `${d.type}:${d.conceptId}`;

/** Reconstruct the search-fields-relevant StashEntry shape from an IndexDocument (first-class + documentJson-carried). */
function entryForSearchFields(doc: IndexDocument): StashEntry {
  const dj = (doc.documentJson ?? {}) as Record<string, unknown>;
  return {
    name: doc.name,
    type: doc.type ?? "",
    description: doc.description,
    tags: doc.tags,
    aliases: doc.aliases,
    searchHints: doc.searchHints,
    examples: dj.examples as string[] | undefined,
    usage: dj.usage as string[] | undefined,
    intent: dj.intent as StashEntry["intent"],
    xrefs: dj.xrefs as string[] | undefined,
    pageKind: dj.pageKind as string | undefined,
    whenToUse: dj.whenToUse as string | undefined,
    toc: dj.toc as StashEntry["toc"],
    parameters: dj.parameters as StashEntry["parameters"],
    bodyOpening: dj.bodyOpening as string | undefined,
  };
}

for (const { name, root } of STASHES) {
  describe(`shadow-scan parity — ${name}`, () => {
    test("same item set (no item gained or lost)", async () => {
      const [olds, news] = await Promise.all([oldStream(root), newStream(root)]);
      expect(news.length).toBe(olds.length);
      expect(new Set(news.map(newIdentity))).toEqual(new Set(olds.map(oldIdentity)));
    });

    test("identity is 1:1 and the ref is bundle//conceptId", async () => {
      const news = await newStream(root);
      // conceptId == the D-R2 qualified spelling (identity axis 3); ref is
      // exactly <bundle>//<conceptId>; the (type, conceptId) pair is unique.
      const keys = news.map(newIdentity);
      expect(new Set(keys).size).toBe(keys.length);
      for (const d of news) expect(d.ref).toBe(`parity//${d.conceptId}`);
    });

    test("same type per item", async () => {
      const [olds, news] = await Promise.all([oldStream(root), newStream(root)]);
      const oldByName = new Map(olds.map((e) => [oldIdentity(e), e]));
      for (const d of news) {
        const e = oldByName.get(newIdentity(d));
        expect(e, `no old entry for ${newIdentity(d)}`).toBeDefined();
        expect(d.type).toBe(e?.type);
      }
    });

    test("same folded search-fields surface (name/description/tags/hints/content)", async () => {
      const [olds, news] = await Promise.all([oldStream(root), newStream(root)]);
      const newByKey = new Map(news.map((d) => [newIdentity(d), d]));
      let asserted = 0;
      for (const e of olds) {
        const d = newByKey.get(oldIdentity(e));
        expect(d, `no new doc for ${oldIdentity(e)}`).toBeDefined();
        if (!d) continue;
        expect(buildSearchFields(entryForSearchFields(d)), `search-fields for ${oldIdentity(e)}`).toEqual(
          buildSearchFields(e),
        );
        asserted += 1;
      }
      expect(asserted).toBe(olds.length);
    });

    test("indexDocumentToStashEntry reconstructs the full StashEntry losslessly (F4a M2 persist input)", async () => {
      // The engine swap persists `entry_json` reconstructed from the IndexDocument.
      // That reconstruction must deep-equal the StashEntry the OLD pipeline stored
      // (every field, not just the search/signal surface) — the goldens + every
      // entry_json reader depend on it. `fileSize` is absent from BOTH (attached
      // at persist time by `attachFileSize`), so a direct deep-equal is exact.
      const [olds, news] = await Promise.all([oldStream(root), newStream(root)]);
      const newByKey = new Map(news.map((d) => [newIdentity(d), d]));
      let asserted = 0;
      for (const e of olds) {
        const d = newByKey.get(oldIdentity(e));
        expect(d, `no new doc for ${oldIdentity(e)}`).toBeDefined();
        if (!d) continue;
        expect(indexDocumentToStashEntry(d), `reconstructed entry for ${oldIdentity(e)}`).toEqual(e);
        asserted += 1;
      }
      expect(asserted).toBe(olds.length);
    });

    test("same filter/ranking signal fields (§12.3 filter parity)", async () => {
      const [olds, news] = await Promise.all([oldStream(root), newStream(root)]);
      const newByKey = new Map(news.map((d) => [newIdentity(d), d]));
      for (const e of olds) {
        const d = newByKey.get(oldIdentity(e));
        if (!d) continue;
        const dj = (d.documentJson ?? {}) as Record<string, unknown>;
        expect(d.quality, `quality ${oldIdentity(e)}`).toBe(e.quality);
        expect(d.beliefState, `beliefState ${oldIdentity(e)}`).toBe(e.beliefState);
        expect(d.currentBeliefRefs, `currentBeliefRefs ${oldIdentity(e)}`).toEqual(e.currentBeliefRefs);
        expect(d.scope, `scope ${oldIdentity(e)}`).toEqual(e.scope as Record<string, string> | undefined);
        expect(d.captureMode, `captureMode ${oldIdentity(e)}`).toBe(e.captureMode);
        expect(d.lessonStrength, `lessonStrength ${oldIdentity(e)}`).toBe(e.lessonStrength);
        expect(d.derivedFrom, `derivedFrom ${oldIdentity(e)}`).toBe(e.derivedFrom);
        // supersededBy (string[]) has no first-class home → rides documentJson.
        expect(dj.supersededBy, `supersededBy ${oldIdentity(e)}`).toEqual(e.supersededBy);
      }
    });
  });
}
