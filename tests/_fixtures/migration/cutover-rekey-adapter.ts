// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-8.2 — the RekeyFn-shaped adapter that drives the REAL cutover re-key engine
 * (`src/migrate/legacy/three-db-cutover.ts#rekeyStateDb`) against the Chunk-0b
 * property harness. The generator supplies the ground-truth `RekeyModel`; this
 * adapter builds the old-ref → item_ref map from it (exactly the shape
 * `buildCutoverRefMap` produces from a live index) and calls `rekeyStateDb`.
 *
 * The real cutover collapses every legacy spelling onto the fully-qualified
 * `bundle//conceptId` `item_ref`, NOT the legacy `origin//type:name` canonical
 * form the 0b reference impls use. `checkRekeyInvariants` is therefore called
 * with `{ keyFor: cutoverKeyFor }` so it checks against the cutover's own merged
 * spelling — the reference-impl / merge-property suites keep the default
 * `canonicalRef` and are untouched (§15.3: extend, never rewrite).
 */

import { TYPE_DIRS } from "../../../src/migrate/legacy/legacy-layout";
import { rekeyStateDb } from "../../../src/migrate/legacy/three-db-cutover";
import { bareRef, type LogicalAssetKey, qualifiedRef, type RekeyFn, type RekeyModel } from "./rekey-model";

/**
 * The fully-qualified `bundle//conceptId` `item_ref` a logical asset's spellings
 * collapse onto — the cutover's merge target and the harness's `keyFor`. The
 * bundle is the model's origin; the conceptId is `<stash-subdir>/<name>` (frozen
 * `TYPE_DIRS`), with the `.derived` twin marker appended to the tail.
 */
export function cutoverKeyFor(key: LogicalAssetKey): string {
  const stashSubdir = TYPE_DIRS[key.type] ?? key.type;
  const conceptId = `${stashSubdir}/${key.name}${key.derived ? ".derived" : ""}`;
  return `${key.origin}//${conceptId}`;
}

/** Build the old-ref → item_ref map from the model's logical assets (both spellings → the one item_ref). */
export function buildRefMapFromModel(model: RekeyModel): Map<string, string> {
  const map = new Map<string, string>();
  for (const asset of model.assets) {
    const target = cutoverKeyFor(asset.key);
    map.set(bareRef(asset.key), target);
    map.set(qualifiedRef(asset.key), target);
  }
  return map;
}

/** The 0b-contract `(dbPath, model) => void` adapter over the real `rekeyStateDb`. */
export const cutoverRekeyFn: RekeyFn = (dbPath, model) => {
  rekeyStateDb(dbPath, buildRefMapFromModel(model));
};
