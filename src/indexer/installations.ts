// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { conceptIdFromTypeName } from "../core/asset/resolve-ref";
import { ConfigError } from "../core/errors";
import { isSourceWriteActivated } from "../core/write-source";
import type { EntryProvenance } from "../storage/repositories/index-entry-types";
import type { SearchSource } from "./search/search-source";

export { deriveBundleId, slugForPath } from "../core/bundle-id";

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
