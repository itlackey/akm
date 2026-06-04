// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { RenderContext } from "./file-context";
import type { StashEntry } from "./metadata";

export interface MetadataContext {
  rendererName: string;
  renderContext: RenderContext;
}

export interface MetadataContributor {
  name: string;
  appliesTo(ctx: MetadataContext): boolean;
  contribute(entry: StashEntry, ctx: MetadataContext): void;
}

const contributors: MetadataContributor[] = [];
let builtinsPromise: Promise<void> | undefined;

async function ensureBuiltinMetadataContributorsRegistered(): Promise<void> {
  if (!builtinsPromise) {
    builtinsPromise = (async () => {
      await import("../output/renderers.js");
      await import("../workflows/renderer.js");
    })();
  }
  return builtinsPromise;
}

export function registerMetadataContributor(contributor: MetadataContributor): void {
  contributors.push(contributor);
}

export async function getMetadataContributors(): Promise<MetadataContributor[]> {
  await ensureBuiltinMetadataContributorsRegistered();
  return [...contributors];
}

export async function applyMetadataContributors(entry: StashEntry, ctx: MetadataContext): Promise<void> {
  const activeContributors = await getMetadataContributors();
  for (const contributor of activeContributors) {
    if (!contributor.appliesTo(ctx)) continue;
    contributor.contribute(entry, ctx);
  }
}
