// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import path from "node:path";
import { isBundleSlug } from "../core/asset/asset-ref";
import { samePath } from "../core/common";
import { deriveInstallations } from "../indexer/installations";
import type { SearchSource } from "../indexer/search/search-source";
import { parseRegistryRef } from "./resolve";

/**
 * Given an origin string (from an AssetRef) and the full list of stash
 * sources, return the subset of sources to search.
 *
 * Qualified asset refs use bundle identity only. Install locators and paths are
 * a separate grammar handled by {@link resolveSourcesForLocator}.
 */
export function resolveSourcesForOrigin(origin: string | undefined, allSources: SearchSource[]): SearchSource[] {
  if (!origin) return allSources;

  const installations = deriveInstallations(allSources);
  return allSources.filter((_, index) => installations[index]?.id === origin);
}

/** Resolve the non-asset source locator grammar used by `akm clone`. */
export function resolveSourcesForLocator(locator: string, allSources: SearchSource[]): SearchSource[] {
  const byExactId = allSources.filter((source) => source.registryId === locator);
  if (byExactId.length > 0) return byExactId;

  try {
    const parsed = parseRegistryRef(locator);
    const byParsedId = allSources.filter((s) => s.registryId !== undefined && s.registryId === parsed.id);
    if (byParsedId.length > 0) return byParsedId;
  } catch {
    // Not a registry locator; continue to path matching.
  }

  return allSources.filter((source) => samePath(source.path, locator));
}

/**
 * Check whether an origin refers to something that could be fetched remotely
 * (i.e. it looks like a registry ref but isn't installed locally).
 */
export function isRemoteOrigin(origin: string, allSources: SearchSource[]): boolean {
  if (isBundleSlug(origin)) return false;
  return resolveSourcesForLocator(origin, allSources).length === 0;
}
