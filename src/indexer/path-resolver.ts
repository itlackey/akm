// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type BundleRef, makeBundleRef, parseBundleRef } from "../core/asset/asset-ref";
import { type Asset, findAsset } from "../core/assets/read";
import { materialiseBundleDir } from "../core/bundle-at-dir";
import { deriveBundleIds } from "../core/bundle-id";
import { safeRealpath } from "../core/common";
import { lookupBundleRef } from "./indexer";
import { deriveInstallations } from "./installations";
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
  const installations = deriveInstallations(allSources);
  const sources = options.writableBundleIds
    ? allSources.filter((_, index) => {
        const bundleId = installations[index]?.id;
        return bundleId !== undefined && options.writableBundleIds?.has(bundleId);
      })
    : allSources;
  const bundle = options.honorOrigin !== false ? parsed.bundle : undefined;
  if (options.stashDir !== undefined) materialiseBundleDir(options.stashDir);
  return deriveBundleIds([...sources])
    .filter((id) => bundle === undefined || id === bundle)
    .map((id) => findAsset(makeBundleRef(id, parsed.conceptId)))
    .find((found) => found !== undefined);
}

/** The file of the asset `ref` names on disk; null when none holds it, or no file does (a keyring's or vault's). */
function resolveViaDisk(ref: string, options: ResolveAssetPathOptions): string | null {
  // asset-io: base the file a ref resolves to, which improve and schema repair read
  const file = findAssetOnDisk(ref, options)?.entry.file;
  return file === undefined ? null : safeRealpath(file);
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
