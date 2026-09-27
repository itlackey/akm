// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Registry provider factory map.
 *
 * Maps registry provider type identifiers (e.g. "static-index", "skills-sh")
 * to factory functions that create RegistryProvider instances.
 *
 * "Registry" here refers to the stash discovery registries (static index files,
 * skills.sh API) — not to be confused with the source provider factory map in
 * `sources/provider-factory.ts` or the installed-source operations in
 * `installed-stashes.ts`.
 *
 * Factories use the `RegistryProviderFactory` type owned by
 * `src/registry/providers/types.ts`. Exactly two providers exist
 * (`static-index`, `skills-sh`, each self-registering on import via
 * `./providers/index.ts`), so this is a plain `Map`.
 */

import type { RegistryProviderFactory } from "./providers/types";

// ── Factory map ─────────────────────────────────────────────────────────────

const factories = new Map<string, RegistryProviderFactory>();

export function registerRegistryProvider(type: string, factory: RegistryProviderFactory): void {
  factories.set(type, factory);
}

export function resolveRegistryProviderFactory(type: string): RegistryProviderFactory | null {
  return factories.get(type) ?? null;
}

/** Test-only seam: removes a registration made with {@link registerRegistryProvider}. */
export function unregisterRegistryProvider(type: string): void {
  factories.delete(type);
}
