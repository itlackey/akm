// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type AssetRef, conceptIdFromTypeName, parseRefInput } from "../../core/asset/resolve-ref";
import { lookup } from "../indexer";
import { deriveInstallations } from "../installations";
import { resolveConceptOwner } from "../lookup/adapter-concept-owner";
import { resolveSourceEntries } from "../search/search-source";

export interface ResolveAssetPathOptions {
  stashDir?: string;
  mode?: "index-only" | "index-first" | "disk-only";
  writableBundleIds?: ReadonlySet<string>;
  honorOrigin?: boolean;
}

function normalizeRef(ref: string | AssetRef): AssetRef {
  // String inputs use the current `[bundle//]conceptId` grammar.
  return typeof ref === "string" ? parseRefInput(ref) : ref;
}

async function resolveViaIndex(ref: AssetRef): Promise<string | null> {
  try {
    const entry = await lookup(ref);
    return entry?.filePath ?? null;
  } catch {
    return null;
  }
}

function resolveViaDisk(ref: AssetRef, options: ResolveAssetPathOptions): string | null {
  const allSources = resolveSourceEntries(options.stashDir);
  const installations = deriveInstallations(allSources);
  const sources = options.writableBundleIds
    ? allSources.filter((_, index) => {
        const bundleId = installations[index]?.id;
        return bundleId !== undefined && options.writableBundleIds?.has(bundleId);
      })
    : allSources;
  const bundle = options.honorOrigin !== false ? ref.origin : undefined;
  return (
    resolveConceptOwner({ bundle, conceptId: conceptIdFromTypeName(ref.type, ref.name) }, sources)?.owner.realPath ??
    null
  );
}

export async function resolveAssetPath(
  ref: string | AssetRef,
  options: ResolveAssetPathOptions = {},
): Promise<string | null> {
  const parsed = normalizeRef(ref);
  const mode = options.mode ?? "index-first";
  if (mode !== "disk-only") {
    const indexed = await resolveViaIndex(parsed);
    if (indexed) return indexed;
    if (mode === "index-only") return null;
  }
  return resolveViaDisk(parsed, options);
}
