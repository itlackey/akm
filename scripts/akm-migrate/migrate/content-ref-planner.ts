// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure planner for the `assetContentRefs` step. Before #1432 a ref began with its type's folder, so a file outside
 * that folder was `knowledge/WORK/x`; it is now `WORK/x`. Content that still names the old spelling resolves with a
 * warning. This finds the tokens and gives each its new spelling:
 *   - `[bundle//]<folder>/<path>[.md]`, `<type>:<path>` and `wiki:<path>`, in frontmatter and body alike.
 * An old spelling that is now another file's live ref is never rewritten: it would silently change which file the
 * token names. It is listed instead ({@link ShadowedRef}).
 */

import { placementTypes, stashDirFor } from "../../../src/core/asset/asset-placement";
import { legacyRefMove } from "../../../src/indexer/legacy-refs";

/** One recognized asset: its type and its ref (`refForFile`). */
export interface RefDocument {
  readonly type: string;
  readonly ref: string;
}

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

/** The old spelling of every ref that moved ({@link legacyRefMove}), without its bundle: old spelling -> ref. */
function movedRefs(bundleId: string, documents: readonly RefDocument[]): Map<string, string> {
  const moved = new Map<string, string>();
  for (const { type, ref } of documents) {
    const move = legacyRefMove(bundleId, type, ref);
    if (move) moved.set(move.oldItemRef.slice(`${bundleId}//`.length), ref);
  }
  return moved;
}

export function contentRefRewriter(bundles: ReadonlyMap<string, readonly RefDocument[]>): ContentRefRewriter {
  const live = new Map([...bundles].map(([bundleId, documents]) => [bundleId, new Set(documents.map((d) => d.ref))]));
  const liveAnywhere = (spelling: string): boolean => [...live.values()].some((refs) => refs.has(spelling));
  const shadowed: ShadowedRef[] = [];
  // Per bundle: old spelling -> new ref, for a bundle-qualified token. `anywhere`: the same for a token without one,
  // which only an old spelling no bundle holds as a live ref can take (the runtime reads it across every bundle).
  const qualified = new Map<string, Map<string, string>>();
  const anywhere = new Map<string, string>();
  for (const [bundleId, documents] of bundles) {
    const own = new Map<string, string>();
    for (const [from, to] of movedRefs(bundleId, documents)) {
      if (live.get(bundleId)?.has(from)) {
        shadowed.push({ bundleId, from, to });
        continue;
      }
      own.set(from, to);
      if (liveAnywhere(from)) shadowed.push({ bundleId, from, to });
      else anywhere.set(from, to);
    }
    qualified.set(bundleId, own);
  }
  shadowed.sort((a, b) => a.bundleId.localeCompare(b.bundleId) || a.from.localeCompare(b.from));

  const folders = [...new Set(placementTypes().flatMap((type) => stashDirFor(type) ?? []))];
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
          const to = bundleId === undefined ? anywhere.get(stem) : qualified.get(bundleId)?.get(stem);
          if (to === undefined) return token;
          count++;
          return `${bundleId === undefined ? "" : `${bundleId}//`}${to}${md ? ".md" : ""}${tail}`;
        })
        .replace(typedToken, (token, type: string, run: string) => {
          const { stem, tail, md } = splitRun(run);
          const to = anywhere.get(`${folderOf(type)}/${stem}`);
          if (to === undefined) return token;
          count++;
          return `${to}${md ? ".md" : ""}${tail}`;
        });
      return { text: replaced, count };
    },
  };
}
