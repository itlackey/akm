// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure planner for the `assetContentRefs` step. Before #1432 a ref began with its type's folder, so a file outside
 * that folder was `knowledge/WORK/x`; it is now `WORK/x`. Content that still names the old spelling resolves with a
 * warning. An old spelling is recognized as the resolver does ({@link withoutTypeHead}): a spelling no file holds
 * whose first folder is a stash folder and whose remainder is a live ref, whatever the asset's type is now. This finds
 * the tokens and gives each its new spelling:
 *   - `[bundle//]<folder>/<path>[.md]`, `<type>:<path>` and `wiki:<path>`, in frontmatter and body alike.
 * An old spelling that is now another file's live ref is never rewritten: it would silently change which file the
 * token names. It is listed instead ({@link ShadowedRef}).
 */

import { placementTypes, stashDirFor, stashDirNames } from "../../../src/core/asset/asset-placement";
import { withoutTypeHead } from "../../../src/indexer/lookup/adapter-concept-owner";

export interface ShadowedRef {
  readonly bundleId: string;
  /** The old spelling, which another file now holds as its live ref. */
  readonly from: string;
  /** The ref this file has now. */
  readonly to: string;
}

export interface ContentRefRewriter {
  /** The text with every old-spelling token rewritten, and how many were. */
  rewrite(text: string): { readonly text: string; readonly count: number };
  readonly shadowed: readonly ShadowedRef[];
}

const WIKI_FOLDER = "knowledge/wikis";
const SPELLING_BEFORE = String.raw`(?<![\w./~:-])`;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A matched run of path characters: without trailing dots (sentence punctuation), and with a `.md` told apart. */
function splitRun(run: string): { readonly stem: string; readonly tail: string; readonly md: boolean } {
  const stem = run.replace(/\.+$/, "");
  const md = stem.endsWith(".md");
  return { stem: md ? stem.slice(0, -".md".length) : stem, tail: run.slice(stem.length), md };
}

export function contentRefRewriter(bundles: ReadonlyMap<string, readonly string[]>): ContentRefRewriter {
  const live = new Map([...bundles].map(([bundleId, refs]) => [bundleId, new Set(refs)]));
  const liveIn = (bundleId: string | undefined, ref: string): boolean =>
    bundleId === undefined ? [...live.values()].some((refs) => refs.has(ref)) : live.get(bundleId)?.has(ref) === true;
  // The ref an old spelling names now in `bundleId` (any bundle when undefined), unless some file holds the spelling.
  const newRef = (bundleId: string | undefined, spelling: string): string | undefined => {
    const to = withoutTypeHead(spelling);
    return to !== undefined && !liveIn(bundleId, spelling) && liveIn(bundleId, to) ? to : undefined;
  };
  // A spelling some file holds that is also the old spelling of a live ref: listed, not rewritten.
  const shadowed: ShadowedRef[] = [];
  const spellings = new Set([...live.values()].flatMap((refs) => [...refs]));
  for (const bundleId of live.keys()) {
    for (const from of spellings) {
      const to = withoutTypeHead(from);
      if (to !== undefined && liveIn(bundleId, to)) shadowed.push({ bundleId, from, to });
    }
  }
  shadowed.sort((a, b) => a.bundleId.localeCompare(b.bundleId) || a.from.localeCompare(b.from));

  const folders = [...new Set(stashDirNames())];
  const pathToken = new RegExp(
    `${SPELLING_BEFORE}(?:([\\w.-]+)//)?((?:${folders.map(escapeRegExp).join("|")})/[\\w./-]*)`,
    "g",
  );
  const folderOf = (type: string): string | undefined => (type === "wiki" ? WIKI_FOLDER : stashDirFor(type));
  const typedToken = new RegExp(
    `${SPELLING_BEFORE}(wiki|${placementTypes().map(escapeRegExp).join("|")}):([\\w.][\\w./-]*)`,
    "g",
  );

  return {
    shadowed,
    rewrite(text) {
      let count = 0;
      const replaced = text
        .replace(pathToken, (token, bundleId: string | undefined, run: string) => {
          const { stem, tail, md } = splitRun(run);
          const to = newRef(bundleId, stem);
          if (to === undefined) return token;
          count++;
          return `${bundleId === undefined ? "" : `${bundleId}//`}${to}${md ? ".md" : ""}${tail}`;
        })
        .replace(typedToken, (token, type: string, run: string) => {
          const { stem, tail, md } = splitRun(run);
          const to = newRef(undefined, `${folderOf(type)}/${stem}`);
          if (to === undefined) return token;
          count++;
          return `${to}${md ? ".md" : ""}${tail}`;
        });
      return { text: replaced, count };
    },
  };
}
