// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `experimental.memoryEnrichment`: reflect also proposes a memory's `tags`, the replacement for `akm remember --enrich`.
 * The model's reply is read by the function `--enrich` uses (`parseEnrichTags`).
 * This module holds the rest of what reflect and the proactive lane need.
 */

import { parseFrontmatter } from "../../core/asset/frontmatter";
import type { AssetRef } from "../../core/asset/resolve-ref";
import { lookupAsset } from "../../core/assets/read";
import type { AkmConfig } from "../../core/config/config";
import { isMemoryEnrichmentEnabled } from "../../core/config/experimental";
import type { ImproveEligibleRef } from "../../core/improve-types";
import { parseEnrichTags } from "../remember";

/** The patch fields of a memory under enrichment, after the three every asset has. */
export const ENRICHED_PATCH_FIELDS = ["tags"] as const;

/** A memory's tags are missing: none, or an empty list. */
function untagged(tags: unknown): boolean {
  return Array.isArray(tags) ? tags.length === 0 : !tags;
}

/** Reflect also fills this asset's tags: a memory that has none, with the setting on. */
export function enrichesMemory(
  config: AkmConfig,
  parsedRef: AssetRef | undefined,
  assetContent: string | undefined,
): boolean {
  return (
    isMemoryEnrichmentEnabled(config) &&
    parsedRef?.type === "memory" &&
    untagged(parseFrontmatter(assetContent ?? "").data.tags)
  );
}

/** The reply schema with `tags` added to its `frontmatterPatch`. */
export function withEnrichedPatch(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = schema.properties as Record<string, { required: string[]; properties: Record<string, unknown> }>;
  const patch = properties.frontmatterPatch;
  if (!patch) return schema;
  return {
    ...schema,
    properties: {
      ...properties,
      frontmatterPatch: {
        ...patch,
        required: [...patch.required, ...ENRICHED_PATCH_FIELDS],
        properties: {
          ...patch.properties,
          tags: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 5 },
        },
      },
    },
  };
}

/** The tags a reply's patch carries: 1-5 of them, as the memory has none. */
export function enrichedPatchFields(fields: Record<string, unknown>): { tags: string[] } {
  const tags = parseEnrichTags(fields.tags).map((t) => t.trim());
  if (tags.length === 0 || tags.length > 5) {
    throw new Error("direct reflect frontmatterPatch.tags must be an array of 1-5 tags: the memory has none");
  }
  return { tags };
}

function isUntaggedMemory(ref: ImproveEligibleRef): boolean {
  const asset = ref.type === "memory" ? lookupAsset(ref.ref) : undefined;
  if (!asset) return false;
  return untagged(asset.entry.frontmatter()?.tags);
}

/** The proactive lane's first-in-line test: untagged memories, with the setting on; otherwise none. */
export function untaggedMemoriesFirst(config: AkmConfig): ((ref: ImproveEligibleRef) => boolean) | undefined {
  return isMemoryEnrichmentEnabled(config) ? isUntaggedMemory : undefined;
}
