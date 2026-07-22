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
 * per component root, and `recognize()` is the single source of truth for what
 * a file IS. The open OKF `type` lives on the emitted `IndexDocument`, never on
 * the adapter — so there is deliberately NO per-`type` → adapter mapping here.
 *
 * QUERY-TIME SAFETY (normative §14.3 / D11 — "adapters/registry never run at
 * query time"): this module is imported only from install/index-time modules;
 * the search path (`indexer/search/**`) does not import it, and importing the
 * frozen list pulls the concrete adapters into no query-time graph.
 */

import { BUILTIN_ADAPTERS } from "./adapters";
import type { BundleAdapter } from "./bundle-adapter";

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

/** Look up an adapter by its own `id` (matches `BundleComponent.adapter`); `undefined` for an unknown id (spec §4 — caller skips + warns). */
export function adapterForId(id: string): BundleAdapter | undefined {
  return BY_ID.get(id);
}

/**
 * DEPRECATED no-op retained for test back-compat only. The registry is a static
 * frozen map (normative §12.6) populated at module load, so there is nothing to
 * reset — `getAdapters()` / `adapterForId()` are always the full built-in set.
 * New code MUST NOT depend on this.
 */
export function resetAdapterRegistryForTests(): void {
  // intentionally empty — the registry is static; see the doc comment above.
}
