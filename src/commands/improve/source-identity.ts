// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import path from "node:path";
import { parseAssetRef, refToString } from "../../core/asset/asset-ref";
import type { AkmConfig } from "../../core/config/config";

/** Key durable improve state by source without changing filesystem-facing refs. */
export function durableImproveRef(ref: string, sourceName?: string): string {
  if (!sourceName) return ref;
  const parsed = parseAssetRef(ref);
  return refToString({ ...parsed, origin: parsed.origin ?? sourceName });
}

/** Remove a durable source origin before filesystem/index lookups. */
export function bareImproveRef(ref: string): string {
  const parsed = parseAssetRef(ref);
  return refToString({ type: parsed.type, name: parsed.name });
}

/** Qualified key first, with the pre-cutover bare key as an optional fallback. */
export function improveStateReadRefs(ref: string, sourceName?: string, includeLegacyBare = false): string[] {
  const durable = durableImproveRef(ref, sourceName);
  const bare = bareImproveRef(ref);
  return includeLegacyBare && durable !== bare ? [durable, bare] : [durable];
}

/**
 * Bare improve state predates source-qualified refs and belongs only to the
 * historical local stash. Named sources at any other root must never inherit it.
 */
export function shouldReadLegacyBareImproveState(
  sourceName: string | undefined,
  sourcePath: string | undefined,
  config: AkmConfig,
): boolean {
  if (!sourceName || !sourcePath) return false;
  if (config.stashDir) return path.resolve(sourcePath) === path.resolve(config.stashDir);
  if (sourceName !== "stash") return false;
  if (!config.defaultWriteTarget) return true;
  if (config.defaultWriteTarget !== "stash") return false;
  const configuredStash = config.sources?.find((source) => source.name === "stash");
  return (
    configuredStash?.type === "filesystem" &&
    typeof configuredStash.path === "string" &&
    path.resolve(configuredStash.path) === path.resolve(sourcePath)
  );
}
