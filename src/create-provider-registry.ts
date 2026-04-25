/**
 * Generic factory-map utility.
 *
 * Creates a lightweight registry that maps string keys to factory functions.
 * Both registry-factory.ts (registry discovery) and source-provider-factory.ts
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
