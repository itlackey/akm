/**
 * Registry provider factory map.
 *
 * Maps registry provider type identifiers (e.g. "static-index", "skills-sh")
 * to factory functions that create RegistryProvider instances.
 *
 * "Registry" here refers to the kit discovery registries (npm, GitHub, static
 * index files) — not to be confused with the stash provider factory map in
 * stash-provider-factory.ts or the installed-kit operations in installed-kits.ts.
 */

import { createProviderRegistry } from "./create-provider-registry";
import type { RegistryProviderFactory } from "./registry-provider";

// ── Factory map ─────────────────────────────────────────────────────────────

const registry = createProviderRegistry<RegistryProviderFactory>();

export function registerProvider(type: string, factory: RegistryProviderFactory): void {
  registry.register(type, factory);
}

export function resolveProviderFactory(type: string): RegistryProviderFactory | null {
  return registry.resolve(type);
}
