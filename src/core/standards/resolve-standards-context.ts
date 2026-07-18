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
import { resolveTypeConventions, typeConventionRef } from "./resolve-type-conventions";

/** Wiki infra files that are not authored pages (relative to the wiki root). */
const WIKI_INFRA_BASENAMES: ReadonlySet<string> = new Set([SCHEMA_MD, INDEX_MD, LOG_MD]);

/**
 * Extract the asset type from a canonical ref (`[origin//]type:name`) without
 * throwing. Returns `undefined` for refs that have no `type:` prefix. Kept local
 * and lenient — the per-type resolver validates the result against
 * `placementTypes()`, so a bogus prefix here simply yields no convention.
 */
function refType(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  const body = ref.includes("//") ? ref.slice(ref.indexOf("//") + 2) : ref;
  const colon = body.indexOf(":");
  if (colon <= 0) return undefined;
  return body.slice(0, colon).trim() || undefined;
}

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
    // Non-wiki asset target → Feature B (general stash standards) plus the
    // per-type SOFT conventions layer (#646), type-scoped to the write target.
    const general = resolveStashStandards(stashRoot);

    const type = refType(ref);
    // A non-empty body here guarantees `type` is a `placementTypes()`-validated
    // string (the resolver returns "" otherwise).
    const typeConventions = type ? resolveTypeConventions(stashRoot, type) : "";
    if (!typeConventions || !type) return general;

    // Soft, type-scoped guidance — clearly labeled and kept separate from the
    // HARD (validator-enforced) rules that `authoringRulesForType` injects
    // downstream. These facts are advice only; they never weaken the gate.
    const softSection = [
      `# ${typeConventionRef(type)} (soft per-type conventions — guidance, not enforced)`,
      typeConventions,
    ].join("\n");

    return general ? `${general}\n\n${softSection}` : softSection;
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
