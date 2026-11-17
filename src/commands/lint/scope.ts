// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import type { BundleSourceRef } from "../../core/adapter/types";
import { isInLlmWiki } from "../../core/asset/llm-wiki-root";
import { stalePathRoots } from "../../core/asset/stale-path";
import type { AkmConfig } from "../../core/config/config";
import { bundleLintSkip } from "./bundle-skip";
import { type MovedRefs, readMovedRefs } from "./moved-refs";

/** What the base checks need to know about the bundle a file sits in, however the file's text was obtained. */
export interface LintScope {
  stashRoot: string;
  /** The other configured bundles' roots, for cross-bundle ref resolution. */
  extraStashRoots: string[];
  /** Bundle id to root, so a qualified ref is checked in the bundle it names. */
  bundleRoots: ReadonlyMap<string, string>;
  /** The refs the index recorded as moved. */
  moves: MovedRefs;
  /** Roots that make an absolute path judgeable for `stale-path`. */
  stalePathRoots: string[];
  /** The bundle's `lint.skip` rules for a bundle-relative path. */
  bundleSkip: (relPath: string) => string[];
  /** Whether a bundle-relative file is inside an LLM Wiki of the bundle; each directory is probed once. */
  inLlmWiki: (relPath: string) => boolean;
}

/** The root of each configured bundle by its id, for the checks that look a qualified ref up in the bundle it names. */
function bundleRootsOf(sources: readonly BundleSourceRef[]): ReadonlyMap<string, string> {
  return new Map(sources.flatMap((source) => (source.registryId ? [[source.registryId, source.path] as const] : [])));
}

/** Whether a bundle-relative file is inside an LLM Wiki of the bundle at `root`; each directory is probed once. */
export function llmWikiPredicate(root: string): (relPath: string) => boolean {
  const byDir = new Map<string, boolean>();
  return (relPath) => {
    const dirs = relPath.split(/[\\/]/).slice(0, -1);
    const key = dirs.join("/");
    let inside = byDir.get(key);
    if (inside === undefined) {
      inside = isInLlmWiki(root, dirs);
      byDir.set(key, inside);
    }
    return inside;
  };
}

/** The scope of the configured bundle at `root` among the configured `sources` (none for a file outside every bundle). */
export function lintScope(root: string, cfg: AkmConfig, sources: readonly BundleSourceRef[]): LintScope {
  return {
    stashRoot: root,
    extraStashRoots: sources.map((source) => source.path).filter((p) => p !== root && fs.existsSync(p)),
    bundleRoots: bundleRootsOf(sources),
    moves: readMovedRefs(),
    stalePathRoots: stalePathRoots(cfg, root),
    bundleSkip: bundleLintSkip(cfg, root),
    inLlmWiki: llmWikiPredicate(root),
  };
}
