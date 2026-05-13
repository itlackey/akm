import type { RendererRegistry } from "../core/asset-registry";
import type { SourceSearchHit } from "../sources/types";
import { getRenderer } from "./file-context";

export interface SearchHitContext {
  type: string;
  stashDir: string;
  rendererRegistry: RendererRegistry;
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

export const defaultSearchHitEnrichers: SearchHitEnricher[] = [rendererSearchHitEnricher];

export async function enrichSearchHit(
  hit: SourceSearchHit,
  ctx: SearchHitContext,
  enrichers: SearchHitEnricher[] = defaultSearchHitEnrichers,
): Promise<void> {
  for (const enricher of enrichers) {
    if (!enricher.appliesTo(ctx)) continue;
    await enricher.enrich(hit, ctx);
  }
}
