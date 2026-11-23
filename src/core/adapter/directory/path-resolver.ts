// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import path from "node:path";
import { lookupBundleRef } from "../../../indexer/indexer";
import { deriveInstallations, sourceOfBundle } from "../../../indexer/installations";
import { resolveSourceEntries } from "../../../indexer/search/search-source";
import { type BundleRef, makeBundleRef, parseBundleRef } from "../../asset/asset-ref";
import { findAsset } from "../../assets/read";
import { materialiseBundleDir } from "../../bundle-at-dir";
import { deriveBundleIds } from "../../bundle-id";
import { safeRealpath } from "../../common";

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

function resolveViaDisk(ref: BundleRef, options: ResolveAssetPathOptions): string | null {
  const allSources = resolveSourceEntries(options.stashDir);
  const installations = deriveInstallations(allSources);
  const sources = options.writableBundleIds
    ? allSources.filter((_, index) => {
        const bundleId = installations[index]?.id;
        return bundleId !== undefined && options.writableBundleIds?.has(bundleId);
      })
    : allSources;
  const bundle = options.honorOrigin !== false ? ref.bundle : undefined;
  // The first of the sources, in order (the named directory's bundle first), that holds the ref.
  if (options.stashDir !== undefined) materialiseBundleDir(options.stashDir);
  const asset = deriveBundleIds([...sources])
    .filter((id) => bundle === undefined || id === bundle)
    .map((id) => findAsset(makeBundleRef(id, ref.conceptId)))
    .find((found) => found !== undefined);
  // An asset no file holds answers a path that leads nowhere, as it always has (phase 5 moves this caller off paths).
  return asset
    ? safeRealpath(asset.entry.file ?? path.join(sourceOfBundle(sources, asset.bundle).path, asset.entry.key))
    : null;
}

export async function resolveAssetPath(ref: string, options: ResolveAssetPathOptions = {}): Promise<string | null> {
  const parsed = parseBundleRef(ref);
  const mode = options.mode ?? "index-first";
  if (mode !== "disk-only") {
    const indexed = await resolveViaIndex(parsed);
    if (indexed) return indexed;
    if (mode === "index-only") return null;
  }
  return resolveViaDisk(parsed, options);
}
