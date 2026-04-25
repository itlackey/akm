/**
 * Registry provider factory map.
 *
 * Maps registry provider type identifiers (e.g. "static-index", "skills-sh")
 * to factory functions that create RegistryProvider instances.
 *
 * "Registry" here refers to the kit discovery registries (static index files,
 * skills.sh API) — not to be confused with the source provider factory map in
 * `source-provider-factory.ts` or the installed-source operations in
 * `installed-stashes.ts`.
 *
 * Phase 6 (v1 architecture refactor): factories are now the
 * `RegistryProviderFactory` type owned by `src/registry/providers/types.ts`.
 * The legacy alias in `src/registry-provider.ts` is kept as a thin re-export
 * for transitional callers and will be removed after the dust settles.
 */

import { createProviderRegistry } from "./create-provider-registry";
import type { RegistryProviderFactory } from "./providers/types";

// ── Factory map ─────────────────────────────────────────────────────────────

const registry = createProviderRegistry<RegistryProviderFactory>();

export function registerProvider(type: string, factory: RegistryProviderFactory): void {
  registry.register(type, factory);
}

export function resolveProviderFactory(type: string): RegistryProviderFactory | null {
  return registry.resolve(type);
}

/**
 * Iterate over all registered registry providers. Used by the orchestrator
 * (`src/commands/registry-search.ts`) to fan out queries through the same
 * `RegistryProvider` interface regardless of provider kind.
 */
export function listProviderTypes(): string[] {
  return registry.list();
}
