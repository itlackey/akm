// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The adapter registry: the one list of adapter ids akm has. The ordered built-in list ({@link BUILTIN_ADAPTERS}) is
 * defined in `./adapters` and is static and frozen at module load, so there is no registration step and no load-order
 * dependency; this module exposes read-only lookups over it.
 *
 * It is keyed by `adapter.id` only. An adapter is a format family: one per bundle root, and `recognize()` says what a
 * file is. The open OKF `type` lives on the emitted `IndexDocument`, never on the adapter, so there is deliberately no
 * per-type to adapter mapping.
 *
 * Consumers: the asset facade (`core/assets/bundle.ts`, through {@link requireAdapter} and {@link bundleOf}), the
 * `looksLikeRoot` probe in `detect-adapter.ts` (array order is probe precedence), the bundle-root probe in
 * `provider-utils.ts`, the indexer, and `akm lint`.
 */

import { ConfigError } from "../errors";
import { BUILTIN_ADAPTERS } from "./adapters";
import type { BundleAdapter } from "./bundle-adapter";
import { SecretManagerAdapterBase } from "./secret-manager-adapter";
import type { Bundle } from "./types";

export { BUILTIN_ADAPTERS } from "./adapters";

/** `adapter.id -> adapter`, frozen at module load from the static built-in list. */
const BY_ID: ReadonlyMap<string, BundleAdapter> = new Map(BUILTIN_ADAPTERS.map((a) => [a.id, a]));

/**
 * Every built-in adapter, in the §1.2 install-time probe order (array order ==
 * probe precedence; see `./adapters` for the ordering rationale). Returns a
 * fresh array each call so callers may sort/filter it without disturbing the
 * frozen registry.
 */
export function getAdapters(): BundleAdapter[] {
  return [...BUILTIN_ADAPTERS];
}

/** Look up an adapter by its own `id` ; `undefined` for an unknown id (the caller skips + warns). */
export function adapterForId(id: string): BundleAdapter | undefined {
  return BY_ID.get(id);
}

/** The id of every built-in adapter, in probe order. */
export function adapterIds(): string[] {
  return BUILTIN_ADAPTERS.map((adapter) => adapter.id);
}

/**
 * The adapter `bundle` names, or a `ConfigError` listing the ids akm has. With `location` (whether the bundle is
 * configured with one), also refused when the bundle is not addressed the way the adapter needs: a store adapter
 * without a `location`, or a directory adapter with one.
 */
export function requireAdapter(bundle: string, id: string, address?: { location: boolean }): BundleAdapter {
  const adapter = BY_ID.get(id);
  if (!adapter) {
    throw new ConfigError(
      `Bundle "${bundle}" names adapter "${id}", which akm does not have. Expected one of: ${adapterIds().join(", ")}.`,
      "INVALID_CONFIG_FILE",
    );
  }
  if (address && adapter.addressedBy === "location" && !address.location) {
    throw new ConfigError(
      `Bundle "${bundle}" uses adapter "${id}", which reads a store named by \`location\`, but the bundle has none: give it a \`location\` in place of its path, git, website or npm, or use an adapter that reads a directory.`,
      "INVALID_CONFIG_FILE",
    );
  }
  if (address && adapter.addressedBy === "root" && address.location) {
    throw new ConfigError(
      `Bundle "${bundle}" uses adapter "${id}", which reads a directory, but the bundle has a \`location\`: use a \`path\` (or git, website, npm) instead, or an adapter that reads a store (${locationAdapterIds().join(", ")}).`,
      "INVALID_CONFIG_FILE",
    );
  }
  return adapter;
}

/** The ids of the adapters whose bundles are named by `location`. */
function locationAdapterIds(): string[] {
  return BUILTIN_ADAPTERS.filter((adapter) => adapter.addressedBy === "location").map((adapter) => adapter.id);
}

/** Forget what the adapters read of their stores. The CLI calls it per command and Desktop per request: a store changes between them. */
export function clearAdapterCaches(): void {
  for (const adapter of BUILTIN_ADAPTERS) if (adapter instanceof SecretManagerAdapterBase) adapter.clearCache();
}

/** The bundle its adapter is called with: its id (its config name), and its `location` when it is a store, else its root. */
export function bundleOf(source: { name: string; path: string; location?: string }): Bundle {
  return {
    id: source.name,
    ...(source.location ? { location: source.location } : { root: source.path }),
  };
}
