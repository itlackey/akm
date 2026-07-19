// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { RenderContext } from "../walk/file-context";
import type { IndexDocument } from "./metadata";

export interface MetadataContext {
  rendererName: string;
  renderContext: RenderContext;
}

export interface MetadataContributor {
  name: string;
  appliesTo(ctx: MetadataContext): boolean;
  contribute(entry: IndexDocument, ctx: MetadataContext): void;
}

const contributors: MetadataContributor[] = [];

/**
 * Ensure that all built-in indexer contributors are registered.
 *
 * Delegates to the single `initIndexer()` composition root (see
 * `src/indexer/init.ts`). Imported dynamically to keep this a lazy gate and to
 * avoid a static import cycle (init -> renderers -> metadata-contributors).
 * Called on first use of getMetadataContributors; idempotent.
 */
async function ensureBuiltinMetadataContributorsRegistered(): Promise<void> {
  const { initIndexer } = await import("../init.js");
  await initIndexer();
}

export function registerMetadataContributor(contributor: MetadataContributor): void {
  contributors.push(contributor);
}

export async function getMetadataContributors(): Promise<MetadataContributor[]> {
  await ensureBuiltinMetadataContributorsRegistered();
  return [...contributors];
}

export async function applyMetadataContributors(entry: IndexDocument, ctx: MetadataContext): Promise<void> {
  const activeContributors = await getMetadataContributors();
  for (const contributor of activeContributors) {
    if (!contributor.appliesTo(ctx)) continue;
    contributor.contribute(entry, ctx);
  }
}
