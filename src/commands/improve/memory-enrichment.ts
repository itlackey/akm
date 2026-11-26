// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `experimental.memoryEnrichment`: reflect also proposes a memory's `tags`, the replacement for `akm remember --enrich`.
 * The model's reply is read by the function `--enrich` uses (`parseEnrichTags`).
 * This module holds the rest of what reflect and the proactive lane need.
 */

import type { AssetRef } from "../../core/asset/resolve-ref";
import { lookupAsset } from "../../core/assets/read";
import type { AkmConfig } from "../../core/config/config";
import { isMemoryEnrichmentEnabled } from "../../core/config/experimental";
import type { ImproveEligibleRef } from "../../core/improve-types";
import { parseEnrichTags } from "../remember";

/** The patch fields of a memory under enrichment, after the three every asset has. */
export const ENRICHED_PATCH_FIELDS = ["tags"] as const;

/** Reflect also fills this asset's tags: a memory, with the setting on. */
export function enrichesMemory(config: AkmConfig, parsedRef: AssetRef | undefined): boolean {
  return isMemoryEnrichmentEnabled(config) && parsedRef?.type === "memory";
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
          tags: { type: ["array", "null"], items: { type: "string" } },
        },
      },
    },
  };
}

/** The tags a reply's patch carries; an empty list is none. */
export function enrichedPatchFields(fields: Record<string, unknown>): { tags?: string[] } {
  const tags = parseEnrichTags(fields.tags).map((t) => t.trim());
  return tags.length > 0 ? { tags } : {};
}

/** Tags the memory already has are the author's: only missing ones are filled. */
export function dropKnownEnrichment(changes: Record<string, unknown>, sourceFm: Record<string, unknown>): void {
  if (Array.isArray(sourceFm.tags) ? sourceFm.tags.length > 0 : sourceFm.tags) delete changes.tags;
}

function isUntaggedMemory(ref: ImproveEligibleRef): boolean {
  const asset = ref.type === "memory" ? lookupAsset(ref.ref) : undefined;
  if (!asset) return false;
  const tags = asset.entry.frontmatter()?.tags;
  return Array.isArray(tags) ? tags.length === 0 : !tags;
}

/** The proactive lane's first-in-line test: untagged memories, with the setting on; otherwise none. */
export function untaggedMemoriesFirst(config: AkmConfig): ((ref: ImproveEligibleRef) => boolean) | undefined {
  return isMemoryEnrichmentEnabled(config) ? isUntaggedMemory : undefined;
}
