/**
 * Source provider factory map.
 *
 * Maps source kind identifiers (e.g. "filesystem", "git", "website", "npm")
 * to factory functions that build {@link SourceProvider} instances from a
 * {@link SourceConfigEntry}.
 *
 * Distinct from the registry-discovery factory (`registry-factory.ts`).
 * Both share `create-provider-registry.ts` for the underlying string→factory
 * map.
 */

import type { AkmConfig } from "../core/config";
import { createProviderRegistry } from "../registry/create-provider-registry";
import type { SourceProvider, SourceProviderFactory } from "./source-provider";

// ── Factory map ─────────────────────────────────────────────────────────────

const registry = createProviderRegistry<SourceProviderFactory>();

export function registerSourceProvider(type: string, factory: SourceProviderFactory): void {
  registry.register(type, factory);
}

export function resolveSourceProviderFactory(type: string): SourceProviderFactory | null {
  return registry.resolve(type);
}

/**
 * Build a {@link SourceProvider} for every enabled source in the config that
 * has a registered factory.
 */
export function resolveSourceProviders(config: AkmConfig): SourceProvider[] {
  const providers: SourceProvider[] = [];

  for (const entry of config.sources ?? config.stashes ?? []) {
    if (entry.enabled === false) continue;
    const factory = registry.resolve(entry.type);
    if (factory) {
      providers.push(factory(entry));
    }
  }

  return providers;
}
