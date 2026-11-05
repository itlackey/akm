// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type BundleRef, parseBundleRef } from "../../core/asset/asset-ref";
import { lookupBundleRef } from "../indexer";
import { deriveInstallations } from "../installations";
import { resolveConceptOwner } from "../lookup/adapter-concept-owner";
import { resolveSourceEntries } from "../search/search-source";

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
  return resolveConceptOwner({ bundle, conceptId: ref.conceptId }, sources)?.owner.realPath ?? null;
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
