// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The synchronous `recognizeMatch` arbitration: a cycle-free LEAF that BOTH the
 * `akm` adapter AND the indexer metadata pass import, so neither imports the
 * other. An indexer→adapter import edge would close a metadata ↔ adapter cycle
 * and keep the adapter's `recognize` from sharing the one metadata pipeline.
 *
 * It runs every builtin matcher in registration order, collects the non-null
 * `MatchResult`s, and returns the highest-specificity one (ties broken by the
 * later-registered matcher — higher index — winning). Returns null when no
 * matcher claims the file.
 */

import type { AssetMatcher, FileContext, MatchResult } from "../../indexer/walk/file-context";
import { directoryMatcher, extensionMatcher, parentDirHintMatcher, smartMdMatcher } from "../../indexer/walk/matchers";

/**
 * The four builtin matchers, in registration order. The array index IS the
 * registration index used for tie-breaking. There is no `wiki` or YAML
 * workflow-program matcher: LLM Wiki content is served by the first-class
 * `llm-wiki` adapter, not the akm adapter, and peer Markdown and
 * GitHub-shaped `.yml` workflow sources are both path-owned by residence under
 * `workflows/` (with Markdown frontmatter as an additional signal), while
 * source IR owns their distinct parse/compile semantics.
 */
const AKM_MATCHERS: readonly AssetMatcher[] = [
  extensionMatcher,
  directoryMatcher,
  parentDirHintMatcher,
  smartMdMatcher,
];

function winningMatch(hits: Array<{ result: MatchResult; index: number }>): MatchResult | null {
  if (hits.length === 0) return null;
  hits.sort((a, b) => {
    const specDiff = b.result.specificity - a.result.specificity;
    if (specDiff !== 0) return specDiff;
    return b.index - a.index;
  });
  return hits[0]!.result;
}

/**
 * Runs every builtin matcher in registration order, collects the non-null
 * `MatchResult`s, and returns the highest-specificity one (ties broken by the
 * later-registered matcher — higher index — winning). Returns null when no
 * matcher claims the file.
 */
export function recognizeMatch(file: FileContext): MatchResult | null {
  const hits: Array<{ result: MatchResult; index: number }> = [];
  for (let i = 0; i < AKM_MATCHERS.length; i++) {
    const result = AKM_MATCHERS[i]!(file);
    if (result !== null) hits.push({ result, index: i });
  }
  return winningMatch(hits);
}
