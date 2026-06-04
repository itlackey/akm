// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure graph deduplication utility — no LLM calls, no I/O.
 *
 * Extracted from src/llm/graph-extract.ts so it can be imported by
 * src/indexer/graph-extraction.ts without being replaced by test mocks
 * that stub the LLM layer.
 */

import type { GraphExtraction, GraphRelation } from "../llm/graph-extract";

export type { GraphExtraction, GraphRelation };

function normalizeRelationType(raw: string | undefined): string {
  const normalized = raw?.trim().toLowerCase().replace(/\s+/g, " ") ?? "";
  if (!normalized) return "";
  if (normalized === "use" || normalized === "utilizes") return "uses";
  if (normalized === "depend on" || normalized === "depends") return "depends on";
  if (normalized === "integrates" || normalized === "integration with") return "integrates with";
  return normalized;
}

function normalizeConfidence(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  return Math.max(0, Math.min(1, raw));
}

/**
 * Merge and deduplicate entities and relations from multiple per-asset
 * GraphExtraction results into one canonical graph.
 *
 * Entities are keyed on their lowercased, trimmed form. The first-seen
 * casing is preserved as canonical. Relations are keyed on
 * `(from, to, type)` (all lowercased). Dangling relations — those whose
 * `from` or `to` is absent from the deduplicated entity set — are dropped.
 */
export function deduplicateGraph(
  extractions: GraphExtraction[],
  assetRefs?: string[],
): GraphExtraction & { entitySources: Map<string, string[]>; relationSources: Map<string, string[]> } {
  const entityCanonical = new Map<string, string>();
  const entitySources = new Map<string, string[]>();

  for (let i = 0; i < extractions.length; i++) {
    const ref = assetRefs?.[i] ?? "unknown";
    for (const raw of extractions[i].entities) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const normalized = trimmed.toLowerCase();
      if (!entityCanonical.has(normalized)) {
        entityCanonical.set(normalized, trimmed);
        entitySources.set(normalized, [ref]);
      } else {
        const srcs = entitySources.get(normalized);
        if (srcs && !srcs.includes(ref)) srcs.push(ref);
      }
    }
  }

  const entities: string[] = Array.from(entityCanonical.values());
  const entityNormSet = new Set(entityCanonical.keys());
  const relSeenKey = new Map<string, string[]>();
  const relationIndexByKey = new Map<string, number>();
  const relations: GraphRelation[] = [];

  for (let i = 0; i < extractions.length; i++) {
    const ref = assetRefs?.[i] ?? "unknown";
    for (const rel of extractions[i].relations) {
      const fromNorm = rel.from.trim().toLowerCase();
      const toNorm = rel.to.trim().toLowerCase();
      const typeNorm = normalizeRelationType(rel.type);
      if (!entityNormSet.has(fromNorm) || !entityNormSet.has(toNorm)) continue;
      const key = `${fromNorm}\0${toNorm}\0${typeNorm}`;
      if (!relSeenKey.has(key)) {
        relSeenKey.set(key, [ref]);
        const canonical: GraphRelation = {
          from: entityCanonical.get(fromNorm) ?? rel.from,
          to: entityCanonical.get(toNorm) ?? rel.to,
        };
        if (typeNorm) canonical.type = typeNorm;
        const confidence = normalizeConfidence(rel.confidence);
        if (confidence !== undefined) canonical.confidence = confidence;
        relationIndexByKey.set(key, relations.length);
        relations.push(canonical);
      } else {
        const srcs = relSeenKey.get(key);
        if (srcs && !srcs.includes(ref)) srcs.push(ref);
        const idx = relationIndexByKey.get(key);
        const nextConfidence = normalizeConfidence(rel.confidence);
        if (idx !== undefined && nextConfidence !== undefined) {
          const current = normalizeConfidence(relations[idx]?.confidence) ?? 0;
          if (nextConfidence > current && relations[idx]) relations[idx].confidence = nextConfidence;
        }
      }
    }
  }

  const relationSources = new Map<string, string[]>(relSeenKey);
  return { entities, relations, entitySources, relationSources };
}
