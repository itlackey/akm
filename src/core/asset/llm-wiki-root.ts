// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";

/** The directory of an LLM Wiki that holds its pages, next to its root `schema.md`. */
export const LLM_WIKI_PAGES_DIR = "pages";

/** True when `root` is an LLM Wiki: a root `schema.md` plus a `pages/` directory. The one probe the `llm-wiki` adapter and lint share. */
export function looksLikeLlmWikiRoot(root: string): boolean {
  try {
    if (!fs.existsSync(path.join(root, "schema.md"))) return false;
    return fs.statSync(path.join(root, LLM_WIKI_PAGES_DIR)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Whether a file whose bundle-relative directories are `ancestorDirs` sits inside an LLM Wiki of the bundle at `root`: the
 * bundle root or an ancestor is a wiki root. A wiki keeps its own schema and log and is written by the wiki's own process,
 * so its files are not authored akm assets.
 */
export function isInLlmWiki(root: string, ancestorDirs: readonly string[]): boolean {
  for (let i = 0; i <= ancestorDirs.length; i++) {
    if (looksLikeLlmWikiRoot(path.join(root, ...ancestorDirs.slice(0, i)))) return true;
  }
  return false;
}
