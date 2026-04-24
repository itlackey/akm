/**
 * Stash provider factory map.
 *
 * Maps stash source type identifiers (e.g. "filesystem", "openviking") to
 * factory functions that create StashProvider instances from a StashConfigEntry.
 *
 * "Stash providers" are runtime data sources for the search and show commands —
 * distinct from the stash-discovery registries (registry-factory.ts) and the
 * installed-stash operations (installed-stashes.ts).
 */

import { createProviderRegistry } from "./create-provider-registry";
import type { StashProviderFactory } from "./stash-provider";

// ── Factory map ─────────────────────────────────────────────────────────────

const registry = createProviderRegistry<StashProviderFactory>();

export function registerStashProvider(type: string, factory: StashProviderFactory): void {
  registry.register(type, factory);
}

export function resolveStashProviderFactory(type: string): StashProviderFactory | null {
  return registry.resolve(type);
}

/**
 * Resolve all non-filesystem stash providers from config.
 * Filesystem entries are excluded — they are handled by resolveStashSources().
 */
export function resolveStashProviders(
  config: import("./config").AkmConfig,
): import("./stash-provider").LiveStashProvider[] {
  const providers: import("./stash-provider").LiveStashProvider[] = [];

  for (const entry of config.stashes ?? []) {
    if (entry.enabled === false) continue;
    const factory = registry.resolve(entry.type);
    if (factory) {
      providers.push(factory(entry));
    }
  }

  return providers;
}
