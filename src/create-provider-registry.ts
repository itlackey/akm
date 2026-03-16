/**
 * Generic factory-map utility.
 *
 * Creates a lightweight registry that maps string keys to factory functions.
 * Both registry-factory.ts (kit discovery) and stash-provider-factory.ts
 * (stash source providers) are built on this utility.
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
  };
}
