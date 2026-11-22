// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The format-family adapter registry — akm 0.9.0 (§4 / normative §12.6).
 *
 * A STATIC, FROZEN registry per normative §12.6: the ordered built-in adapter
 * list ({@link BUILTIN_ADAPTERS}) is defined in the built-in barrel
 * (`./adapters`) and this module exposes read-only lookups over it. There is NO
 * mutable registration step and NO load-order dependency — `getAdapters()` and
 * `adapterForId()` are populated at MODULE LOAD, so every production call site
 * sees the full set without anyone first calling a registration function. This
 * replaces the earlier mutable module-level singleton, whose "someone must
 * register the built-ins first" contract left the registry empty in production
 * (every source then fell back to `akm`).
 *
 * PRODUCTION CONSUMERS (all install/index-time, never query-time): the ordered
 * `looksLikeRoot` probe in `installations.ts#detectAdapterId`, and the
 * bundle-root probe in `provider-utils.ts#detectStashRoot`.
 *
 * KEYED BY `adapter.id` ONLY. Adapters are FORMAT FAMILIES (§0.2): one adapter
 * per bundle root, and `recognize()` is the single source of truth for what
 * a file IS. The open OKF `type` lives on the emitted `IndexDocument`, never on
 * the adapter — so there is deliberately NO per-`type` → adapter mapping here.
 *
 * QUERY-TIME SAFETY (normative §14.3 / D11 — "adapters/registry never run at
 * query time"): this module is imported only from install/index-time modules;
 * the search path (`indexer/search/**`) does not import it, and importing the
 * frozen list pulls the concrete adapters into no query-time graph.
 */

import { resolveConfiguredSources } from "../config/config-sources";
import type { AkmConfig } from "../config/config-types";
import { ConfigError } from "../errors";
import { BUILTIN_ADAPTERS } from "./adapters";
import type { BundleAdapter } from "./bundle-adapter";
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

/** The adapter `bundle` names, or a `ConfigError` listing the ids akm has. */
export function requireAdapter(bundle: string, id: string): BundleAdapter {
  const adapter = BY_ID.get(id);
  if (!adapter) {
    throw new ConfigError(
      `Bundle "${bundle}" names adapter "${id}", which akm does not have. Expected one of: ${adapterIds().join(", ")}.`,
      "INVALID_CONFIG_FILE",
    );
  }
  return adapter;
}

/** Refuse a config in which a bundle names an adapter akm does not have. */
export function requireConfiguredAdapters(config: AkmConfig): void {
  for (const source of resolveConfiguredSources(config)) {
    if (source.adapterId !== undefined) requireAdapter(source.name, source.adapterId);
  }
}

/** The bundle its adapter is called with: its id (its config name), root, and `location` when it has one. */
export function bundleOf(source: { name: string; path: string; location?: string }): Bundle {
  return {
    id: source.name,
    root: source.path,
    writable: false,
    ...(source.location ? { location: source.location } : {}),
  };
}
