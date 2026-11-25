// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type BundleRef, makeBundleRef, parseBundleRef } from "../core/asset/asset-ref";
import { type Asset, findAsset } from "../core/assets/read";
import { indexedPathOf } from "../core/assets/type";
import { bundleAt } from "../core/bundle-at-dir";
import { safeRealpath } from "../core/common";
import { lookupBundleRef } from "./indexer";
import { resolveSourceEntries } from "./search/search-source";

export interface ResolveAssetPathOptions {
  stashDir?: string;
  mode?: "index-only" | "index-first" | "disk-only";
  writableBundleIds?: ReadonlySet<string>;
  honorOrigin?: boolean;
}

async function resolveViaIndex(ref: BundleRef): Promise<string | null> {
  try {
    const entry = await lookupBundleRef(ref);
    return entry?.filePath ?? null;
  } catch {
    return null;
  }
}

/**
 * The asset `ref` names on disk: in the first of the sources, in order (the named directory's bundle first), that holds
 * it; with `honorOrigin: false` the ref's own bundle is not required.
 */
export function findAssetOnDisk(ref: string, options: ResolveAssetPathOptions = {}): Asset | undefined {
  const parsed = parseBundleRef(ref);
  const allSources = resolveSourceEntries(options.stashDir);
  const { writableBundleIds } = options;
  const sources = writableBundleIds
    ? allSources.filter((source) => writableBundleIds.has(source.bundleId))
    : allSources;
  const bundle = options.honorOrigin !== false ? parsed.bundle : undefined;
  const held = options.stashDir === undefined ? undefined : bundleAt(options.stashDir);
  return sources
    .filter((source) => bundle === undefined || source.bundleId === bundle)
    .map((source) => findAsset(makeBundleRef(source.bundleId, parsed.conceptId), held))
    .find((found) => found !== undefined);
}

/** The file of the asset `ref` names on disk; null when none holds it, or no file does (a keyring's or vault's). */
function resolveViaDisk(ref: string, options: ResolveAssetPathOptions): string | null {
  const found = findAssetOnDisk(ref, options);
  const file = found && indexedPathOf(found);
  return file ? safeRealpath(file) : null;
}

export async function resolveAssetPath(ref: string, options: ResolveAssetPathOptions = {}): Promise<string | null> {
  const parsed = parseBundleRef(ref);
  const mode = options.mode ?? "index-first";
  if (mode !== "disk-only") {
    const indexed = await resolveViaIndex(parsed);
    if (indexed) return indexed;
    if (mode === "index-only") return null;
  }
  return resolveViaDisk(ref, options);
}
