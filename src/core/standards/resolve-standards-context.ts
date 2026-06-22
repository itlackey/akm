// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Dispatch resolver for the standards prompt seam — selects which of the two
 * standards features fires for a given write target, mutually exclusively:
 *
 *   - **Feature A — wiki schema**: the target is a wiki page (a ref/path under
 *     `wikis/<name>/`, NOT a `raw/` file and NOT a wiki infra file
 *     `schema.md`/`index.md`/`log.md`). Returns that wiki's `schema.md` body.
 *   - **Feature B — stash standards**: the target is any non-wiki asset.
 *     Returns the concatenated `category: convention`/`meta` fact bodies.
 *   - **Neither fires**: a wiki `raw/` file or a wiki infra file. Returns `""`.
 *
 * The two NEVER both fire. Both underlying readers degrade to `""` on
 * missing/malformed input and never throw, so this resolver never throws.
 */

import { extractWikiNameFromRef, INDEX_MD, LOG_MD, loadWikiSchema, SCHEMA_MD } from "../../wiki/wiki";
import { resolveStashStandards } from "./resolve-stash-standards";

/** Wiki infra files that are not authored pages (relative to the wiki root). */
const WIKI_INFRA_BASENAMES: ReadonlySet<string> = new Set([SCHEMA_MD, INDEX_MD, LOG_MD]);

/**
 * Resolve the standards context for a write target identified by its asset ref.
 *
 * @param ref       Canonical asset ref of the write target (e.g. `skill:foo`,
 *                  `wiki:research/topics/x`). When undefined, the target is a
 *                  non-wiki authoring flow → stash standards.
 * @param stashRoot Stash root directory.
 */
export function resolveStandardsContext(ref: string | undefined, stashRoot: string): string {
  const wikiName = ref ? extractWikiNameFromRef(ref) : undefined;
  if (!wikiName) {
    // Non-wiki asset target → Feature B (stash authoring standards).
    return resolveStashStandards(stashRoot);
  }

  // Wiki target. Extract the page path after `wiki:<name>/`.
  const prefix = `wiki:${wikiName}/`;
  const pagePath = ref?.startsWith(prefix) ? ref.slice(prefix.length) : "";

  // `wiki:<name>` with no page, a `raw/` file, or a wiki infra file → neither
  // feature fires.
  if (!pagePath) return "";
  if (pagePath === "raw" || pagePath.startsWith("raw/")) return "";
  // Infra files (`schema`/`index`/`log`) are only special at the WIKI ROOT.
  // A nested page like `wiki:research/analysis/schema` is a genuine page and
  // must NOT be suppressed, so only check when the page is at root depth.
  if (!pagePath.includes("/")) {
    // Refs drop the `.md` extension; compare against both forms defensively.
    if (WIKI_INFRA_BASENAMES.has(pagePath) || WIKI_INFRA_BASENAMES.has(`${pagePath}.md`)) {
      return "";
    }
  }

  // A genuine wiki page → Feature A (that wiki's schema body).
  return loadWikiSchema(stashRoot, wikiName).body;
}
