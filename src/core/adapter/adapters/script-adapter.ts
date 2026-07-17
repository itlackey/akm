// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `script` `BundleAdapter` — akm 0.9.0 chunk-2, WI-2.1 (chunk-2
 * anchors.md §A.2 row 3, §B rows "script").
 *
 * ── recognize() — ports `classifyByExtension`'s script branch (matchers.ts
 *   :159-161) + the `scripts/` dir-hint rule (matchers.ts:43-46) ──
 *   Both branches require `SCRIPT_EXTENSIONS.has(ext)` (`core/recognition-
 *   util.ts` — the same 16-extension set both the pure-extension matcher
 *   AND the `scripts/` `DirTypeRule.test` check); the dir-hint branch adds
 *   NOTHING a bare extension check doesn't already cover (it only changes
 *   which specificity number wins in the old cross-matcher arbitration,
 *   irrelevant to a single-adapter `recognize` — see the skill adapter's
 *   header for the same note). So `recognize` collapses to one condition:
 *   `SCRIPT_EXTENSIONS.has(file.ext)`.
 *
 * ── placeNew() — ports `scriptSpec.toAssetPath` (asset-spec.ts:77-81) ──
 *   Identity join, `<componentRoot>/<conceptId>` — unlike `markdownSpec`,
 *   the conceptId already carries its own extension (`scriptSpec.
 *   toCanonicalName` keeps the extension, asset-spec.ts:79).
 *
 * ── validate() — DefaultLinter-equivalent (D2-3) ──
 *   `script` has NO dedicated linter today — `getLinterForType("scripts")`
 *   falls through to `DefaultLinter` (lint/registry.ts:46), base checks
 *   only. Ported as the shared `validateChangesWithBaseChecks` helper
 *   verbatim, matching the lint golden's `perType.script.linterUsed:
 *   "DefaultLinter"` dispatch exactly. `script-comment-metadata`'s
 *   `applyScriptMetadata` (output/renderers.ts:726-734,
 *   `extractDescriptionFromComments`) is NOT folded into `recognize()`:
 *   that helper lives in `indexer/passes/metadata.ts`, and importing it
 *   would add a new `core/adapter -> indexer/passes` edge into a module
 *   already on the cycle-ratchet baseline — an unforced risk for a
 *   description-only enrichment the recognition golden does not pin.
 *   Flagged for the maintainer (D2-7 says fold contributors in; this one is
 *   deferred for cycle-safety, not dropped by oversight).
 */

import fs from "node:fs";
import path from "node:path";
import type { FileContext } from "../../../indexer/walk/file-context";
import { parseFrontmatter } from "../../asset/frontmatter";
import { SCRIPT_EXTENSIONS } from "../../recognition-util";
import type { BundleAdapter } from "../bundle-adapter";
import type { BundleComponent, IndexDocument } from "../types";
import { hashContent, nonEmptyString, readTags, validateChangesWithBaseChecks } from "./shared";

export const scriptAdapter: BundleAdapter = {
  id: "script",
  version: "0.9.0",
  extensions: [...SCRIPT_EXTENSIONS],

  recognize(c: BundleComponent, file: FileContext): IndexDocument | null {
    if (!SCRIPT_EXTENSIONS.has(file.ext)) return null;
    // scriptSpec.toCanonicalName (asset-spec.ts:79): identity, extension kept.
    const conceptId = file.relPath;
    const bundle = c.id;
    const content = file.content();
    // parseFrontmatter is a harmless no-op for non-frontmatter script bytes
    // (regex requires a leading "---\n" block; ordinary script source
    // returns {data: {}, frontmatter: null, content: <raw>}), matching how
    // the goldens-lint-output.test.ts test harness treats every non-task
    // subdir uniformly (parseFrontmatter(raw) regardless of file kind).
    const parsed = parseFrontmatter(content);
    return {
      ref: `${bundle}//${conceptId}`,
      bundle,
      component: c.id,
      conceptId,
      path: file.absPath,
      hash: hashContent(content),
      adapterId: "script",
      type: "script",
      name: conceptId,
      description: nonEmptyString(parsed.data.description),
      tags: readTags(parsed.data.tags),
      updated: nonEmptyString(parsed.data.updated),
      content: parsed.content,
    };
  },

  validate(c, changes, ctx) {
    return validateChangesWithBaseChecks(c, changes, ctx);
  },

  placeNew(c: BundleComponent, conceptId: string): string {
    return path.join(c.root, conceptId);
  },

  directoryList(): string[] {
    return ["scripts"];
  },

  looksLikeRoot(root: string): boolean {
    return fs.existsSync(path.join(root, "scripts"));
  },
};
