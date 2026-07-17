// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `wiki` `BundleAdapter` — akm 0.9.0 chunk-2, WI-2.1 (chunk-2 anchors.md
 * §A.2 row 2, §B rows "wiki").
 *
 * TRANSITIONAL per D2-1 / chunk-2 anchors.md §A.2: Chunk 4 replaces this
 * adapter's identity with `llm-wiki` and retires the `wiki` type token
 * entirely. This WI still owes it parity because the Chunk-0b goldens
 * include it and the chunk-2 gate says "all 14 formats."
 *
 * ── recognize() — ports `classifyByWiki` (matchers.ts:254-260) ──
 *   The legacy matcher walks a whole STASH root and requires an ANCESTOR
 *   dir literally named `wikis`, with at least one more segment after it
 *   (`idx + 1 < ancestorDirs.length` — i.e. `wikis/<space>/<page>.md`, not
 *   `wikis/<page>.md` directly). This adapter's `BundleComponent.root` is
 *   mounted AT the `wikis/` directory itself (matching `directoryList()`
 *   below and the placement convention every WI-2.1 adapter uses — the
 *   component root IS the type's own stash subdirectory), so `file.relPath`
 *   never contains a `"wikis"` segment to look for: it is already relative
 *   to it. The condition is restated in ROOT-RELATIVE terms instead: `.md`
 *   extension, AND at least one directory segment between the component
 *   root and the file (`ancestorDirs.length >= 1`) — the exact translation
 *   of "nested inside a NAMESPACE subdirectory of wikis/, not directly
 *   inside it." Specificity 20 in the old model; irrelevant here
 *   (single-adapter recognize, no per-file competition — see the skill
 *   adapter's header for the same note).
 *
 * ── placeNew() — ports the generic `markdownSpec.toAssetPath` (asset-spec.ts
 *   :63-75, wiki's spec is `{ stashDir: "wikis", ...markdownSpec, ... }`
 *   per asset-spec.ts:151-156) — accepts a conceptId with or without a
 *   trailing `.md`.
 *
 * ── validate() — DefaultLinter-equivalent (D2-3) ──
 *   `wiki` has NO dedicated linter today — `getLinterForType("wikis")` falls
 *   through to the shared `DefaultLinter` instance (lint/registry.ts:39,46),
 *   i.e. base checks only, no extra per-type check. Ported as the shared
 *   `validateChangesWithBaseChecks` helper verbatim — no wiki-specific
 *   logic added (D2-3: "don't add validation where none exists today").
 *   `toc-metadata` (output/renderers.ts:781-785, shared with knowledge) is
 *   NOT folded into `recognize()` here: `IndexDocument` (`../types.ts`) has
 *   no `toc`/heading-outline field to carry it, and the recognition golden
 *   this WI is gated against does not pin any TOC data — flagged for the
 *   maintainer (D2-7 says fold contributors in; there is no field to fold
 *   this one into without extending `IndexDocument`, out of WI-2.1 scope).
 */

import fs from "node:fs";
import path from "node:path";
import type { FileContext } from "../../../indexer/walk/file-context";
import { parseFrontmatter } from "../../asset/frontmatter";
import type { BundleAdapter } from "../bundle-adapter";
import type { BundleComponent, IndexDocument } from "../types";
import { hashContent, nonEmptyString, readTags, validateChangesWithBaseChecks } from "./shared";

function isWikiFile(file: Pick<FileContext, "ext" | "ancestorDirs">): boolean {
  if (file.ext !== ".md") return false;
  // Root-relative translation of classifyByWiki's "wikis/<space>/<page>.md,
  // not wikis/<page>.md" rule — see the file header note above.
  return file.ancestorDirs.length >= 1;
}

export const wikiAdapter: BundleAdapter = {
  id: "wiki",
  version: "0.9.0",
  extensions: [".md"],

  recognize(c: BundleComponent, file: FileContext): IndexDocument | null {
    if (!isWikiFile(file)) return null;
    // markdownSpec.toCanonicalName (asset-spec.ts:65-69): strip a trailing .md.
    const conceptId = file.relPath.endsWith(".md") ? file.relPath.slice(0, -3) : file.relPath;
    const bundle = c.id;
    const content = file.content();
    const parsed = parseFrontmatter(content);
    return {
      ref: `${bundle}//${conceptId}`,
      bundle,
      component: c.id,
      conceptId,
      path: file.absPath,
      hash: hashContent(content),
      adapterId: "wiki",
      type: "wiki",
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
    const withExt = conceptId.endsWith(".md") ? conceptId : `${conceptId}.md`;
    return path.join(c.root, withExt);
  },

  directoryList(): string[] {
    return ["wikis"];
  },

  looksLikeRoot(root: string): boolean {
    return fs.existsSync(path.join(root, "wikis"));
  },
};
