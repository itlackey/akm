/**
 * Stash provider factory map.
 *
 * Maps stash source type identifiers (e.g. "filesystem", "git", "website") to
 * factory functions that create SourceProvider instances from a SourceConfigEntry.
 *
 * "Stash providers" are runtime data sources for the search and show commands —
 * distinct from the stash-discovery registries (registry-factory.ts) and the
 * installed-stash operations (installed-stashes.ts).
 */

import { createProviderRegistry } from "./create-provider-registry";
import type { SourceProviderFactory } from "./source-provider";

// ── Factory map ─────────────────────────────────────────────────────────────

const registry = createProviderRegistry<SourceProviderFactory>();

export function registerSourceProvider(type: string, factory: SourceProviderFactory): void {
  registry.register(type, factory);
}

export function resolveSourceProviderFactory(type: string): SourceProviderFactory | null {
  return registry.resolve(type);
}

/**
 * Resolve all non-filesystem stash providers from config.
 * Filesystem entries are excluded — they are handled by resolveSourceEntries().
 */
export function resolveSourceProviders(
  config: import("./config").AkmConfig,
): import("./source-provider").LiveSourceProvider[] {
  const providers: import("./source-provider").LiveSourceProvider[] = [];

  for (const entry of config.sources ?? config.stashes ?? []) {
    if (entry.enabled === false) continue;
    const factory = registry.resolve(entry.type);
    if (factory) {
      providers.push(factory(entry));
    }
  }

  return providers;
}
