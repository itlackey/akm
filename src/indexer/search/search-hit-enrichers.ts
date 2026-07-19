// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { displayRef } from "../../core/asset/resolve-ref";
import type { RendererRegistry } from "../../core/type-presentation";
import type { SourceSearchHit } from "../../sources/types";
import type { Database } from "../../storage/database";
import { getDerivedForParent } from "../../storage/repositories/index-entries-repository";
import { getRenderer } from "../walk/file-context";

export interface SearchHitContext {
  type: string;
  stashDir: string;
  rendererRegistry: RendererRegistry;
  /**
   * Optional open DB connection. Required for enrichers that perform DB
   * lookups (e.g. {@link derivedMemoryEnricher}). When absent those enrichers
   * are skipped — keeps the default-safe path zero-overhead for unit tests
   * and renderer-only call sites.
   */
  db?: Database;
}

export interface SearchHitEnricher {
  name: string;
  appliesTo(ctx: SearchHitContext): boolean;
  enrich(hit: SourceSearchHit, ctx: SearchHitContext): void | Promise<void>;
}

const rendererSearchHitEnricher: SearchHitEnricher = {
  name: "renderer-search-hit-enricher",
  appliesTo(ctx) {
    return ctx.rendererRegistry.rendererNameFor(ctx.type) !== undefined;
  },
  async enrich(hit, ctx) {
    const rendererName = ctx.rendererRegistry.rendererNameFor(ctx.type);
    if (!rendererName) return;
    const renderer = await getRenderer(rendererName);
    renderer?.enrichSearchHit?.(hit, ctx.stashDir);
  },
};

/**
 * Phase 5A / Advantage D5 — derived-memory enricher.
 *
 * When a parent memory has a `.derived` child indexed (the LLM-distilled
 * lesson surface), this enricher rewrites the parent hit to surface the
 * derived child's description / searchHints / tags AND sets `expandTo` to
 * the derived child's ref so callers can fetch it via `akm show <ref>`.
 *
 * The parent ref is preserved on the hit — only the surface text is
 * swapped, so links and provenance still point at the canonical parent.
 *
 * Skipped for:
 *  - non-memory hits
 *  - memory hits that are themselves derived children (name ends with
 *    `.derived`) — we never recurse parent→child→grandchild
 *  - contexts without an open DB connection
 */
export const derivedMemoryEnricher: SearchHitEnricher = {
  name: "derived-memory-enricher",
  appliesTo(ctx) {
    return ctx.type === "memory" && ctx.db !== undefined;
  },
  enrich(hit, ctx) {
    if (!ctx.db) return;
    // Never recurse: a `.derived` hit is itself the child surface; leaving
    // it untouched also avoids `<parent>.derived.derived` chains.
    if (hit.name.toLowerCase().endsWith(".derived")) return;

    // Parent ref shape: `memory:<name>`. Re-build from the entry's name
    // so we don't depend on whatever wiki/registry prefix `hit.ref` carries.
    // INTERNAL lookup key into `getDerivedForParent` (derived_from stores the
    // legacy spelling until the Chunk-8 re-key) — deliberately stays the legacy
    // `type:name` spelling, built inline.
    const parentRef = `memory:${hit.name}`;
    const derived = getDerivedForParent(ctx.db, parentRef);
    if (!derived) return;

    // Swap description / searchHints / tags from the derived child.
    // The parent ref itself is preserved — only the surface text is swapped.
    if (typeof derived.entry.description === "string" && derived.entry.description.length > 0) {
      hit.description = derived.entry.description;
    }
    if (Array.isArray(derived.entry.searchHints) && derived.entry.searchHints.length > 0) {
      // We don't have a `searchHints` field on SourceSearchHit today — it's
      // only used inside ranking. The plan says to swap when present; we
      // record it onto the hit only if a future renderer surfaces it. For
      // now, treat as advisory (no-op when SearchHit lacks the field).
    }
    if (Array.isArray(derived.entry.tags) && derived.entry.tags.length > 0) {
      hit.tags = derived.entry.tags;
    }
    // F4b output-spelling flip: `expandTo` is a user-facing `akm show <ref>`
    // target, so emit the 0.9.0 short conceptId grammar (`memories/<name>`).
    hit.expandTo = displayRef({ type: "memory", name: derived.entry.name });
  },
};

/**
 * Registry of additional enrichers — populated by
 * {@link registerSearchHitEnricher} and consumed in addition to
 * {@link defaultSearchHitEnrichers} when `enrichSearchHit` is invoked
 * without an explicit enricher list.
 *
 * Kept module-local so callers must use `registerSearchHitEnricher` rather
 * than mutating the array directly.
 */
const additionalEnrichers: SearchHitEnricher[] = [];

export const defaultSearchHitEnrichers: SearchHitEnricher[] = [rendererSearchHitEnricher, derivedMemoryEnricher];

/**
 * Register an additional enricher to be applied alongside the defaults.
 *
 * Idempotent on `name`: subsequent calls with the same name replace the
 * previously-registered enricher (so tests can re-register cleanly without
 * stacking duplicates).
 */
export function registerSearchHitEnricher(enricher: SearchHitEnricher): void {
  const existingIndex = additionalEnrichers.findIndex((e) => e.name === enricher.name);
  if (existingIndex >= 0) {
    additionalEnrichers[existingIndex] = enricher;
  } else {
    additionalEnrichers.push(enricher);
  }
}

/**
 * Test-only: clear the registered-enrichers list. Not part of the public API.
 */
export function _resetRegisteredSearchHitEnrichers(): void {
  additionalEnrichers.length = 0;
}

export async function enrichSearchHit(
  hit: SourceSearchHit,
  ctx: SearchHitContext,
  enrichers: SearchHitEnricher[] = [...defaultSearchHitEnrichers, ...additionalEnrichers],
): Promise<void> {
  for (const enricher of enrichers) {
    if (!enricher.appliesTo(ctx)) continue;
    await enricher.enrich(hit, ctx);
  }
}
