// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { displayRef } from "../../core/asset/resolve-ref";
import { presentationFor } from "../../core/type-presentation";
import type { SourceSearchHit } from "../../sources/types";
import type { Database } from "../../storage/database";
import { getDerivedForParent, getItemRefById } from "../../storage/repositories/index-entries-repository";
import { getRenderer } from "../walk/file-context";
import { attachSearchHitAttribution } from "./search-attribution";

export interface SearchHitContext {
  type: string;
  stashDir: string;
  bundleId: string;
  /**
   * Optional open DB connection for the derived-memory lookup. When absent
   * that step is skipped — keeps unit tests and renderer-only call sites
   * zero-overhead.
   */
  db?: Database;
}

/**
 * Let the hit's type renderer enrich it, then — for a memory, when a DB is
 * open — surface its derived child ({@link surfaceDerivedMemory}).
 */
export async function enrichSearchHit(hit: SourceSearchHit, ctx: SearchHitContext): Promise<void> {
  const rendererName = presentationFor(ctx.type).renderer;
  if (rendererName) {
    const renderer = await getRenderer(rendererName);
    renderer?.enrichSearchHit?.(hit, ctx.stashDir);
  }
  if (ctx.type === "memory" && ctx.db) surfaceDerivedMemory(hit, ctx.db, ctx.bundleId);
}

/**
 * Phase 5A / Advantage D5 — when a parent memory has a `.derived` child
 * indexed (the LLM-distilled lesson surface), rewrite the parent hit to
 * surface the derived child's description / tags AND set `expandTo` to the
 * derived child's ref so callers can fetch it via `akm show <ref>`.
 *
 * The parent ref is preserved on the hit — only the surface text is
 * swapped, so links and provenance still point at the canonical parent.
 */
function surfaceDerivedMemory(hit: SourceSearchHit, db: Database, bundleId: string): void {
  // Never recurse: a `.derived` hit is itself the child surface; leaving
  // it untouched also avoids `<parent>.derived.derived` chains.
  if (hit.name.toLowerCase().endsWith(".derived")) return;

  // Parent ref shape: the 0.9.0 `memories/<name>` conceptId. Re-build from the
  // entry's name so we don't depend on whatever wiki/registry prefix `hit.ref`
  // carries. INTERNAL lookup key into `getDerivedForParent`: the `derived_from`
  // column stores this same conceptId grammar.
  const derived = getDerivedForParent(db, `memories/${hit.name}`, bundleId);
  if (!derived) return;

  // Swap description / tags from the derived child (SourceSearchHit carries no
  // `searchHints`).
  const surfaceFields: Array<"description" | "tags"> = [];
  let surfaceDescription: string | undefined;
  if (typeof derived.entry.description === "string" && derived.entry.description.length > 0) {
    hit.description = derived.entry.description;
    surfaceDescription = derived.entry.description;
    surfaceFields.push("description");
  }
  if (Array.isArray(derived.entry.tags) && derived.entry.tags.length > 0) {
    hit.tags = derived.entry.tags;
    surfaceFields.push("tags");
  }
  // `expandTo` is a user-facing `akm show <ref>` target, so emit the 0.9.0
  // short conceptId grammar (`memories/<name>`).
  hit.expandTo = displayRef({ type: "memory", name: derived.entry.name });
  const childRef = getItemRefById(db, derived.id);
  if (childRef && surfaceFields.length > 0) {
    attachSearchHitAttribution(hit, {
      memoryInference: {
        exposure: "surface",
        childRef,
        surfaceFields,
        ...(surfaceDescription ? { surfaceDescription } : {}),
      },
    });
  }
}
