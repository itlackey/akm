// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The synchronous `recognizeMatch` arbitration — a cycle-free LEAF (not in
 * `adapters/akm-adapter.ts`)
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

import type { FileContext, MatchResult } from "./directory/file-context";
import {
  directoryMatcher,
  extensionMatcher,
  looseMarkdownMatcher,
  type PathFileContext,
  parentDirHintMatcher,
  smartMdMatcher,
} from "./directory/matchers";

/**
 * Every matcher in registration order (the order breaks ties: of equal specificity the later one wins), the Markdown
 * matcher last. It has a path-only form ({@link looseMarkdownMatcher}) and a content form ({@link smartMdMatcher}).
 * (There is no `wiki` matcher — the wiki asset-type is retired; LLM Wiki content is served by the first-class
 * `llm-wiki` adapter, not the akm adapter. There is no YAML workflow-program matcher: Markdown workflow sources are
 * path-owned by residence under `workflows/`, with Markdown frontmatter as an additional signal.)
 */
function arbitrate<F extends PathFileContext>(file: F, markdown: (file: F) => MatchResult | null): MatchResult | null {
  let winner: MatchResult | null = null;
  for (const result of [extensionMatcher(file), directoryMatcher(file), parentDirHintMatcher(file), markdown(file)]) {
    if (result !== null && (winner === null || result.specificity >= winner.specificity)) winner = result;
  }
  return winner;
}

/**
 * The type a file's path gives it: the folder rules, `SKILL.md`, a script extension; any other `.md` is knowledge. No
 * content is read, so this is what identity and the write gates use.
 */
export function recognizeMatchByPath(file: PathFileContext): MatchResult | null {
  return arbitrate(file, looseMarkdownMatcher);
}

/**
 * The type the index records for a file: {@link recognizeMatchByPath}, except that a loose Markdown file is typed by
 * its content (`type: workflow`, `agent:`, `$ARGUMENTS`, `model:`) as the matchers did before the adapter refactor.
 * Synchronous reproduction of `file-context.ts#runMatchers`'s arbitration, minus its `ensureBuiltinsRegistered()`
 * dynamic import. Returns null when no matcher claims the file.
 */
export function recognizeMatch(file: FileContext): MatchResult | null {
  return arbitrate(file, smartMdMatcher);
}
