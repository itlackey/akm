// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `deriveInstallations`.
 *
 * Bridges the `SearchSource[]` model (the live indexer's source list,
 * `search-source.ts`) onto the durable `Bundle[]` model. Called from the indexer
 * (provenance derivation), the proposal repository, and written-asset
 * indexing.
 *
 * Per source → one bundle:
 *   - `id`   = `source.bundleId`, the prefix of every ref its adapter emits.
 *   - `root` = `source.path`. The akm layout's type dirs (`knowledge/`,
 *              `skills/`, …) are type-derived leading path segments of the
 *              conceptId within the one bundle.
 *
 * The adapter that reads a bundle is not part of it: {@link bundleAdapterId}
 * (`core/adapter/detect-adapter.ts`) is the one place that says which, the
 * configured id or else the ordered `looksLikeRoot` probe over the built-in
 * adapters (`getAdapters()`, most specific first), falling back to `akm` when no
 * probe fires (an empty or not-yet-materialized root).
 */

import type { Bundle } from "../core/adapter/types";
import { conceptIdFromTypeName } from "../core/asset/resolve-ref";
import { deriveBundleId, deriveBundleIds, slugForPath } from "../core/bundle-id";
import { ConfigError } from "../core/errors";
import { isSourceWriteActivated } from "../core/write-source";
import type { EntryProvenance } from "../storage/repositories/index-entry-types";
import type { SearchSource } from "./search/search-source";

export { deriveBundleId, deriveBundleIds, slugForPath };

/**
 * Derive the durable `Bundle[]` from the transitional `SearchSource[]`. Order is
 * preserved (source priority = bundle priority). Bundle ids are unique within the
 * returned batch.
 */
export function deriveInstallations(sources: readonly SearchSource[]): Bundle[] {
  return sources.map((source) => ({
    id: source.bundleId,
    root: source.path,
    // asset-io: config the bundle's configured location, copied
    ...(source.location !== undefined ? { location: source.location } : {}),
  }));
}

/** The source for `bundleId`; refused when none is configured. */
export function sourceOfBundle(sources: readonly SearchSource[], bundleId: string): SearchSource {
  const source = sources.find((source) => source.bundleId === bundleId);
  if (!source)
    throw new ConfigError(`Bundle "${bundleId}" is not among the configured sources.`, "INVALID_CONFIG_FILE");
  return source;
}

/** Canonical bundle ids whose configured policy permits mutation. */
export function deriveWritableBundleIds(sources: SearchSource[]): Set<string> {
  return new Set(sources.filter(isSourceWriteActivated).map((source) => source.bundleId));
}

/**
 * Derive the durable `EntryProvenance` for an indexed entry: `conceptId` is the owning adapter's, else the one a new asset of this
 * type and name is placed under (`conceptIdFromTypeName`), and `item_ref` is `<bundle>//<conceptId>` — the exact
 * spelling `recognize` emits as `IndexDocument.ref`. Shared by the full-index
 * diff-persist writer and the write-path `indexWrittenAssets` fast path so both
 * populate item_ref identically (no NULL-item_ref rows).
 */
export function deriveEntryProvenance(
  bundle: { bundleId: string; adapterId: string },
  type: string,
  name: string,
  /**
   * The OWNING adapter's `doc.conceptId`, when the caller has it. Preferred
   * verbatim over the akm `stashDirFor` re-derivation so a non-akm adapter's
   * identity (`pages/foo`, snapshot paths, ...) survives into `item_ref`
   * (D-R3: identity comes from the resolved entry, not a re-derivation).
   */
  adapterConceptId?: string,
): EntryProvenance {
  const conceptId = adapterConceptId ?? conceptIdFromTypeName(type, name);
  return {
    itemRef: `${bundle.bundleId}//${conceptId}`,
    bundleId: bundle.bundleId,
    conceptId,
    adapterId: bundle.adapterId,
  };
}
