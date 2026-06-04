// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Generic factory-map utility.
 *
 * Creates a lightweight registry that maps string keys to factory functions.
 * Both registry/factory.ts (registry discovery) and sources/provider-factory.ts
 * (source providers) are built on this utility.
 */

export function createProviderRegistry<TFactory>() {
  const map = new Map<string, TFactory>();
  return {
    register(type: string, factory: TFactory): void {
      map.set(type, factory);
    },
    resolve(type: string): TFactory | null {
      return map.get(type) ?? null;
    },
    /** Snapshot of all registered keys. Iteration order matches insertion order. */
    list(): string[] {
      return [...map.keys()];
    },
  };
}
