// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { parseBundleRef } from "../../core/asset/asset-ref";
import { displayRef } from "../../core/asset/resolve-ref";
import { presentationFor } from "../../core/type-presentation";
import type { SourceSearchHit } from "../../sources/types";
import type { Database } from "../../storage/database";
import { getDerivedForParent, getItemRefById } from "../../storage/repositories/index-entries-repository";
import type { IndexDocument } from "../passes/metadata";
import { getRenderer } from "../walk/file-context";
import { attachSearchHitAttribution } from "./search-attribution";

export interface SearchHitContext {
  type: string;
  stashDir: string;
  bundleId: string;
  /** Existing indexed metadata provenance; filename text is only a fallback. */
  descriptionSource?: IndexDocument["source"];
  /**
   * Optional open DB connection for the derived-memory lookup. When absent
   * that step is skipped — keeps unit tests and renderer-only call sites
   * zero-overhead.
   */
  db?: Database;
  /** A derived surface must satisfy the parent search's existing recall policy. */
  eligible?: (row: { id: number; entry: IndexDocument; filePath: string }) => boolean;
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
  if (ctx.type === "memory" && ctx.db) surfaceDerivedMemory(hit, ctx.db, ctx);
}

/**
 * Phase 5A / Advantage D5 — when a parent memory has a `.derived` child
 * indexed (the LLM-distilled lesson surface), fill missing parent metadata
 * from the derived child's description / tags AND set `expandTo` to the
 * derived child's ref so callers can fetch it via `akm show <ref>`.
 *
 * The parent ref is preserved on the hit — only the surface text is
 * filled, so links and provenance still point at the canonical parent.
 */
function surfaceDerivedMemory(hit: SourceSearchHit, db: Database, ctx: SearchHitContext): void {
  // Never recurse: a `.derived` hit is itself the child surface; leaving
  // it untouched also avoids `<parent>.derived.derived` chains.
  if (hit.name.toLowerCase().endsWith(".derived")) return;

  // Parent ref shape: the 0.9.0 `memories/<name>` conceptId. Re-build from the
  // entry's name so we don't depend on whatever wiki/registry prefix `hit.ref`
  // carries. INTERNAL lookup key into `getDerivedForParent`: the `derived_from`
  // column stores this same conceptId grammar.
  const derived = getDerivedForParent(db, `memories/${hit.name}`, ctx.bundleId);
  if (!derived || (ctx.eligible && !ctx.eligible(derived))) return;

  // Fields fall back independently. Preserve authored qualifications and tags;
  // the index already identifies non-authored filename descriptions.
  const surfaceFields: Array<"description" | "tags"> = [];
  let surfaceDescription: string | undefined;
  if ((!hit.description?.trim() || ctx.descriptionSource === "filename") && derived.entry.description?.trim()) {
    hit.description = derived.entry.description;
    surfaceDescription = derived.entry.description;
    surfaceFields.push("description");
  }
  if (!hit.tags?.some((tag) => tag.trim()) && derived.entry.tags?.some((tag) => tag.trim())) {
    hit.tags = derived.entry.tags;
    surfaceFields.push("tags");
  }
  // Retain the parent's bundle qualification so expansion resolves the same child.
  hit.expandTo = displayRef({ type: "memory", name: derived.entry.name, bundleId: parseBundleRef(hit.ref).bundle });
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
