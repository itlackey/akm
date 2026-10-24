// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The format-family adapter registry.
 *
 * A STATIC, FROZEN registry: the ordered built-in adapter
 * list ({@link BUILTIN_ADAPTERS}) is defined in the built-in barrel
 * (`./adapters`) and this module exposes read-only lookups over it. There is NO
 * mutable registration step and NO load-order dependency — `getAdapters()` and
 * `adapterForId()` are populated at MODULE LOAD, so every production call site
 * sees the full set without anyone first calling a registration function.
 *
 * PRODUCTION CONSUMERS (all install/index-time, never query-time): the ordered
 * `looksLikeRoot` probe in `installations.ts#detectAdapterId`, and the
 * bundle-root probe in `provider-utils.ts#detectStashRoot`.
 *
 * KEYED BY `adapter.id` ONLY. Adapters are FORMAT FAMILIES: one adapter
 * per component root, and `recognize()` is the single source of truth for what
 * a file IS. The open OKF `type` lives on the emitted `IndexDocument`, never on
 * the adapter — so there is deliberately NO per-`type` → adapter mapping here.
 *
 * QUERY-TIME SAFETY (adapters/registry never run at query time): this module
 * is imported only from install/index-time modules;
 * the search path (`indexer/search/**`) does not import it, and importing the
 * frozen list pulls the concrete adapters into no query-time graph.
 */

import { BUILTIN_ADAPTERS } from "./adapters";
import type { BundleAdapter } from "./bundle-adapter";

export { BUILTIN_ADAPTERS } from "./adapters";

/** `adapter.id -> adapter`, frozen at module load from the static built-in list. */
const BY_ID: ReadonlyMap<string, BundleAdapter> = new Map(BUILTIN_ADAPTERS.map((a) => [a.id, a]));

/**
 * Every built-in adapter, in install-time probe order (array order ==
 * probe precedence; see `./adapters` for the ordering rationale). Returns a
 * fresh array each call so callers may sort/filter it without disturbing the
 * frozen registry.
 */
export function getAdapters(): BundleAdapter[] {
  return [...BUILTIN_ADAPTERS];
}

/** Look up an adapter by its own `id` (matches `BundleComponent.adapter`); `undefined` for an unknown id (the caller skips + warns). */
export function adapterForId(id: string): BundleAdapter | undefined {
  return BY_ID.get(id);
}
