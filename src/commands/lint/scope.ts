// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import type { BundleSourceRef } from "../../core/adapter/types";
import { stalePathRoots } from "../../core/asset/stale-path";
import type { AkmConfig } from "../../core/config/config";
import { bundleLintSkip } from "./bundle-skip";
import { type MovedRefs, type ReadMoves, readMovedRefs } from "./moved-refs";

/** What the base checks need to know about the bundle a file sits in, however the file's text was obtained. */
export interface LintScope {
  stashRoot: string;
  /** The other configured bundles' roots, for cross-bundle ref resolution. */
  extraStashRoots: string[];
  /** Bundle id to root, so a qualified ref is checked in the bundle it names. */
  bundleRoots: ReadonlyMap<string, string>;
  /** The refs the index recorded as moved; read the first time a ref that did not resolve asks. */
  moves: MovedRefs;
  /** Roots that make an absolute path judgeable for `stale-path`. */
  stalePathRoots: string[];
  /** The bundle's `lint.skip` rules for a bundle-relative path. */
  bundleSkip: (relPath: string) => string[];
}

/** The root of each configured bundle by its id, for the checks that look a qualified ref up in the bundle it names. */
function bundleRootsOf(sources: readonly BundleSourceRef[]): ReadonlyMap<string, string> {
  return new Map(sources.flatMap((source) => (source.registryId ? [[source.registryId, source.path] as const] : [])));
}

/**
 * The scope of the configured bundle at `root` among the configured `sources` (none for a file outside every bundle).
 * `readMoves` is how the caller reads the recorded moves.
 */
export function lintScope(
  root: string,
  cfg: AkmConfig,
  sources: readonly BundleSourceRef[],
  readMoves: ReadMoves,
): LintScope {
  return {
    stashRoot: root,
    // asset-io: bundle-root root probe
    extraStashRoots: sources.map((source) => source.path).filter((p) => p !== root && fs.existsSync(p)),
    bundleRoots: bundleRootsOf(sources),
    moves: readMovedRefs(readMoves),
    stalePathRoots: stalePathRoots(cfg, root),
    bundleSkip: bundleLintSkip(cfg, root),
  };
}
