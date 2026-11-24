// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The renderers `akm show` and search present an asset with, by name. */

import type { FileContext, MatchResult } from "../core/adapter/types";
import type { ShowResponse, SourceSearchHit } from "../sources/types";

// ── RenderContext / AssetRenderer ────────────────────────────────────────────

/**
 * Extended FileContext that carries the winning MatchResult and all
 * stash search paths. Passed to AssetRenderer methods.
 */
export interface RenderContext extends FileContext {
  matchResult: MatchResult;
  stashDirs: string[];
  origin?: string;
  defaultBundle?: string;
}

/**
 * Defines how a particular asset type is presented in show, search, and
 * metadata extraction operations.
 */
export interface AssetRenderer {
  /** Unique renderer name (must match MatchResult.renderer) */
  name: string;
  /** Build the full ShowResponse for the `akm show` command */
  buildShowResponse(ctx: RenderContext): ShowResponse;
  /** Optionally enrich a SourceSearchHit with renderer-specific fields */
  enrichSearchHit?(hit: SourceSearchHit, stashDir: string): void;
}

// ── Registry ─────────────────────────────────────────────────────────────────

/** Renderer lookup by name. */
const renderers = new Map<string, AssetRenderer>();

/**
 * Ensure that all built-in indexer contributors are registered.
 *
 * Delegates to the single `initIndexer()` composition root (see
 * `src/indexer/init.ts`). Imported dynamically to keep this a lazy gate and to
 * avoid a static import cycle (init -> renderers -> file-context). Called on
 * first use of getRenderer/getAllRenderers; idempotent.
 */
async function ensureBuiltinsRegistered(): Promise<void> {
  const { initIndexer } = await import("../indexer/init.js");
  await initIndexer();
}

/**
 * Register an AssetRenderer.
 *
 * If a renderer with the same name already exists it is silently replaced.
 */
export function registerRenderer(renderer: AssetRenderer): void {
  renderers.set(renderer.name, renderer);
}

/**
 * Look up a renderer by name.
 */
export async function getRenderer(name: string): Promise<AssetRenderer | undefined> {
  await ensureBuiltinsRegistered();
  return renderers.get(name);
}

/**
 * Return all registered renderers (snapshot, safe to iterate).
 */
export async function getAllRenderers(): Promise<AssetRenderer[]> {
  await ensureBuiltinsRegistered();
  return Array.from(renderers.values());
}

/**
 * Build a RenderContext by merging a FileContext with its winning MatchResult
 * and the list of stash search paths.
 */
export function buildRenderContext(
  ctx: FileContext,
  match: MatchResult,
  stashDirs: string[],
  origin?: string,
  defaultBundle?: string,
): RenderContext {
  return {
    ...ctx,
    matchResult: match,
    stashDirs,
    origin,
    defaultBundle,
  };
}
