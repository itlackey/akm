import type { RegistryProviderFactory } from "./registry-provider";

// ── Factory map ─────────────────────────────────────────────────────────────

const providers = new Map<string, RegistryProviderFactory>();

export function registerProvider(type: string, factory: RegistryProviderFactory): void {
  providers.set(type, factory);
}

export function resolveProviderFactory(type: string): RegistryProviderFactory | null {
  return providers.get(type) ?? null;
}
