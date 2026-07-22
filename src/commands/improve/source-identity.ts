// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import path from "node:path";
import type { AkmConfig } from "../../core/config/config";
import { primaryBundlePath } from "../../core/config/config";

// ── Durable improve-state keys (Chunk-8 WI-8.5c — collapsed to the item_ref) ──
//
// Every improve ref is now the new grammar (a SHORT conceptId), and the durable
// state key is the resolved index entry's `item_ref` when the planner supplied
// one, else the conceptId `ref` itself (`preparation.ts`
// `salienceWriteKey`/`outcomeWriteKey` = `itemRef ?? ref`). The pre-flip
// source-qualified / legacy-bare dual-key machinery (and its dependency on the
// retired dual-grammar stored-ref parser) is gone.

/**
 * The durable improve-state key for a ref with no resolved `item_ref` — the
 * conceptId `ref` itself. (`sourceName` is retained for call-site compatibility;
 * the pre-flip source-qualification it drove is gone.)
 */
export function durableImproveRef(ref: string, _sourceName?: string): string {
  return ref;
}

/** The conceptId for a stored key: strip a `bundle//` prefix if present. */
export function bareImproveRef(ref: string): string {
  const boundary = ref.indexOf("//");
  return boundary >= 0 ? ref.slice(boundary + 2) : ref;
}

/**
 * The durable read key-set for improve state, collapsed onto the write key
 * (`preparation.ts` `salienceWriteKey`/`outcomeWriteKey` = `itemRef ?? ref`).
 * Because that write key is the `item_ref` for a provenance-bearing entry but
 * the bare conceptId `ref` for a provenance-absent one, an asset's durable rows
 * can carry EITHER spelling across runs — so the reader probes both, item_ref
 * first, deduped. The `sourceName`/`includeLegacyBare` parameters are retained
 * for call-site compatibility but no longer widen the set (the retired
 * source-qualified / legacy-bare arms).
 */
export function improveStateReadRefs(
  ref: string,
  _sourceName?: string,
  _includeLegacyBare = false,
  itemRef?: string,
): string[] {
  return itemRef !== undefined && itemRef !== ref ? [itemRef, ref] : [ref];
}

/**
 * Bare improve state predates source-qualified refs and belongs only to the
 * historical local stash. Named sources at any other root must never inherit it.
 */
export function shouldReadLegacyBareImproveState(
  sourceName: string | undefined,
  sourcePath: string | undefined,
  config: AkmConfig,
): boolean {
  if (!sourceName || !sourcePath) return false;
  // 0.9.0 (spec §10.1 / Decision C): the historical local stash is the primary
  // bundle (`defaultBundle`). A named source at any other root must never
  // inherit the pre-source-qualified bare improve state. This defaultBundle-path
  // equivalence preserves the pre-cutover behavior for a migrated workspace,
  // whose `stashDir` became the defaultBundle's filesystem `path`.
  const primaryPath = primaryBundlePath(config);
  if (!primaryPath) return false;
  return path.resolve(sourcePath) === path.resolve(primaryPath);
}
