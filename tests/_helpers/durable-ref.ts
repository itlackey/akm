// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared test helper for the WI-8.5a durable-spelling flip: the fully-qualified
 * `<bundle>//<conceptId>` item_ref that `createProposal` (and every durable-state
 * writer) now stores, and that the indexer mints for an accepted asset.
 *
 * The bundle id is the write-target stash's installation id — the SAME
 * `deriveInstallations` derivation the index write path uses — so a test asserting
 * the stored `proposals.ref` / `events.ref` / entry `item_ref` sources its
 * expected spelling here rather than a legacy `type:name` literal.
 */

import { deriveEntryProvenance, deriveInstallations, slugForPath } from "../../src/indexer/installations";

/** The durable `<bundle>//<conceptId>` item_ref for `type`/`name` in `stashDir`. */
export function durableItemRef(stashDir: string, type: string, name: string): string {
  const bundleId = deriveInstallations([{ path: stashDir, writable: true }])[0]?.id ?? slugForPath(stashDir);
  return deriveEntryProvenance({ bundleId, componentId: bundleId, adapterId: "akm" }, type, name).itemRef;
}
