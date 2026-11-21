// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Finding and rewriting the refs that text spells out. One tokenizer for every rewrite of a ref in content: the 0.10
 * migration's old spellings and `akm lint --fix`'s links to a moved asset both go through {@link rewritePathTokens}.
 */

/** The character before a ref token must not continue a path, a URL or a typed ref. */
export const SPELLING_BEFORE = String.raw`(?<![\w./~:-])`;

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A matched run of path characters: without trailing dots (sentence punctuation), and with a `.md` told apart. */
export function splitRun(run: string): { readonly stem: string; readonly tail: string; readonly md: boolean } {
  const stem = run.replace(/\.+$/, "");
  const md = stem.endsWith(".md");
  return { stem: md ? stem.slice(0, -".md".length) : stem, tail: run.slice(stem.length), md };
}

export interface PathTokenOptions {
  /** Only tokens whose path begins with one of these folders are looked at; every path-like token is when absent. */
  readonly folders?: readonly string[];
}

/**
 * Rewrite every `[bundle//]<path>[.md]` token of `text` that `rewrite` gives a new spelling. `rewrite` receives the
 * bundle (undefined for a bare path) and the path without `.md`, and returns the whole new token without `.md`, or
 * undefined to leave the token as written. Returns the text and how many tokens were rewritten.
 */
export function rewritePathTokens(
  text: string,
  rewrite: (bundleId: string | undefined, stem: string) => string | undefined,
  options: PathTokenOptions = {},
): { readonly text: string; readonly count: number } {
  const start =
    options.folders === undefined
      ? String.raw`[\w][\w./-]*`
      : `(?:${options.folders.map(escapeRegExp).join("|")})/[\\w./-]*`;
  const token = new RegExp(`${SPELLING_BEFORE}(?:([\\w.-]+)//)?(${start})`, "g");
  let count = 0;
  const replaced = text.replace(token, (whole, bundleId: string | undefined, run: string) => {
    const { stem, tail, md } = splitRun(run);
    const to = rewrite(bundleId, stem);
    if (to === undefined) return whole;
    count++;
    return `${to}${md ? ".md" : ""}${tail}`;
  });
  return { text: replaced, count };
}
