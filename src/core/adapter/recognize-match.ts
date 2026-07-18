// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The synchronous `recognizeMatch` arbitration — akm 0.9.0 Chunk 5, milestone
 * M-b, relocated here from `adapters/akm-adapter.ts` so it is a cycle-free LEAF
 * that BOTH the `akm` adapter AND the indexer metadata pass can import without
 * either importing the other.
 *
 * Before this move `indexer/passes/metadata.ts` imported `recognizeMatch` FROM
 * `akm-adapter.ts`; that indexer→adapter edge is what prevented the adapter from
 * ever reusing the metadata assembly (`buildEntryFromFile`) — it would have
 * closed a metadata ↔ adapter cycle. Hoisting the pure arbitration into this
 * leaf (imported by both, importing neither) severs that edge, so the adapter's
 * `recognize` can share the one metadata pipeline (parity by construction).
 *
 * The logic is unchanged: a synchronous reproduction of
 * `file-context.ts#runMatchers` (`:242-265`) minus its
 * `ensureBuiltinsRegistered()` dynamic import. It runs every builtin matcher in
 * registration order, collects the non-null `MatchResult`s, and returns the
 * highest-specificity one (ties broken by the later-registered matcher — higher
 * index — winning). Returns null when no matcher claims the file.
 */

import type { AssetMatcher, FileContext, MatchResult } from "../../indexer/walk/file-context";
import {
  directoryMatcher,
  extensionMatcher,
  parentDirHintMatcher,
  smartMdMatcher,
  workflowProgramMatcher,
} from "../../indexer/walk/matchers";

/**
 * The five builtin matchers, in registration order. The array index IS the
 * registration index `runMatchers` uses for tie-breaking. (The `wiki` matcher
 * was removed in chunk 4 — the wiki asset-type is retired; LLM Wiki content is
 * served by the first-class `llm-wiki` adapter, not the akm adapter.)
 */
const AKM_MATCHERS: readonly AssetMatcher[] = [
  extensionMatcher,
  directoryMatcher,
  parentDirHintMatcher,
  smartMdMatcher,
  workflowProgramMatcher,
];

/**
 * Synchronous reproduction of `file-context.ts#runMatchers`'s arbitration
 * (`:242-265`), minus its `ensureBuiltinsRegistered()` dynamic import. Runs
 * every builtin matcher in registration order, collects the non-null
 * `MatchResult`s, and returns the highest-specificity one (ties broken by the
 * later-registered matcher — higher index — winning). Returns null when no
 * matcher claims the file.
 */
export function recognizeMatch(file: FileContext): MatchResult | null {
  const hits: Array<{ result: MatchResult; index: number }> = [];
  for (let i = 0; i < AKM_MATCHERS.length; i++) {
    const result = AKM_MATCHERS[i](file);
    if (result !== null) hits.push({ result, index: i });
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => {
    const specDiff = b.result.specificity - a.result.specificity;
    if (specDiff !== 0) return specDiff;
    return b.index - a.index;
  });
  return hits[0].result;
}
