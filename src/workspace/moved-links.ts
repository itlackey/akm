// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Links to assets that were renamed or moved on disk: which assets of a bundle still link to the old ref, with the
 * new ref, and the rewrite of exactly those links. Both are `akm lint`'s `missing-ref` pass: the list is its
 * findings that carry a new ref, the rewrite is its `fixMovedRefs` fix, so they never disagree with the CLI.
 */

import path from "node:path";
import { akmLint } from "../commands/lint";
import { detectAdapterId } from "../core/adapter/detect-adapter";
import { type AkmConfig, loadConfig } from "../core/config/config";
import { UsageError } from "../core/errors";
import { inspectWriteTarget } from "../core/write-source";
import { indexWrittenAssets } from "../indexer/index-written-assets";
import { resolveSourceEntries } from "../indexer/search/search-source";
import { interactive } from "./lease";

/** The akm bundles the sweep covers: lint reads other adapters' bundles through their own validators. */
function akmBundles(config: AkmConfig, bundle?: string) {
  return resolveSourceEntries(undefined, config).flatMap((source) => {
    if (!source.registryId || source.unresolved || (bundle !== undefined && source.registryId !== bundle)) return [];
    return (source.adapterId ?? detectAdapterId(source.path)) === "akm" ? [{ name: source.registryId, source }] : [];
  });
}

/** Per bundle, the links that name an old ref of an asset that moved: where, what is written, and where it points now. */
export async function movedLinks(input: { bundle?: string } = {}) {
  const config = loadConfig();
  const bundles = [];
  for (const { name, source } of akmBundles(config, input.bundle || undefined)) {
    const found = await akmLint({ dir: source.path, rule: "missing-ref", config });
    bundles.push({
      bundle: name,
      writable: source.writable === true,
      writeBlocker: inspectWriteTarget(config, name).blocker,
      links: found.flagged.flatMap((issue) =>
        issue.movedFrom !== undefined && issue.movedTo !== undefined
          ? [{ ref: issue.ref ?? issue.file, file: issue.file, from: issue.movedFrom, to: issue.movedTo }]
          : [],
      ),
    });
  }
  return { bundles, total: bundles.reduce((sum, bundle) => sum + bundle.links.length, 0) };
}

/** Rewrite the links to moved refs in one bundle, and nothing else. A read-only bundle is refused. */
export async function updateMovedLinks(input: { bundle: string }) {
  const config = loadConfig();
  const name = typeof input.bundle === "string" ? input.bundle.trim() : "";
  const found = akmBundles(config, name || undefined)[0];
  if (!name || !found) throw new UsageError(`"${name}" is not a bundle of akm assets.`, "INVALID_FLAG_VALUE");
  return interactive("ui-moved-links", async () => {
    const result = await akmLint({ dir: found.source.path, fixMovedRefs: true, config });
    const fixed = result.fixed.filter((issue) => issue.movedTo !== undefined);
    const files = [...new Set(fixed.map((issue) => issue.file))];
    await indexWrittenAssets(
      found.source.path,
      files.map((file) => path.join(found.source.path, file)),
      { bundleId: name },
    );
    return { bundle: name, rewritten: fixed.length, files };
  });
}
