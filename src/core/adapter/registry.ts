// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The format-family adapter registry — akm 0.9.0 chunk-2, WI-A.
 *
 * Modeled on a plain module-level-map singleton (a map + a handful of small
 * mutator/lookup functions),
 * NOT the spec's aspirational "static frozen `BUILTIN_ADAPTERS` map" (normative
 * §12.6): a frozen map can't accommodate later work-items registering their own
 * adapters incrementally, and the plan gates a *public* plugin ABI as deferred.
 * A mutable-at-load-time singleton, built up by each work-item's own module
 * calling `registerAdapter`, is the shape that lets later WIs register their
 * adapters the same way without editing this file per WI.
 *
 * KEYED BY `adapter.id` ONLY. Adapters are FORMAT FAMILIES (§0.2): one adapter
 * per component root, and `recognize()` is the single source of truth for what
 * a file IS. The open OKF `type` lives on the emitted `IndexDocument`, never on
 * the adapter — so there is deliberately NO per-`type` → adapter mapping here
 * (an earlier draft carried a `type`-index; that reflected a wrong per-type
 * adapter model and is removed).
 *
 * ADDITIVE (chunk-2 "additive only"): this module coexists with the live
 * classification/rendering paths (`matchers.ts`, `output/renderers.ts`) —
 * nothing here is consulted by any production call site yet.
 */

import type { BundleAdapter } from "./bundle-adapter";

/** Registered adapters in registration order; re-registering an id replaces in place. */
const entries: BundleAdapter[] = [];
/** `adapter.id -> adapter` for O(1) id lookup. */
const byId = new Map<string, BundleAdapter>();

/**
 * Register a `BundleAdapter`, keyed by its own `id`. Re-registering the same
 * `adapter.id` replaces the prior entry IN PLACE (replace-on-conflict
 * semantics), so re-importing an adapter module during a test run is idempotent
 * rather than accumulating duplicates in `getAdapters()`.
 */
export function registerAdapter(adapter: BundleAdapter): void {
  const existingIndex = entries.findIndex((e) => e.id === adapter.id);
  if (existingIndex >= 0) entries.splice(existingIndex, 1);
  entries.push(adapter);
  byId.set(adapter.id, adapter);
}

/** Snapshot of every registered adapter, in registration order. */
export function getAdapters(): BundleAdapter[] {
  return [...entries];
}

/** Look up an adapter by its own `id` (matches `BundleComponent.adapter`). */
export function adapterForId(id: string): BundleAdapter | undefined {
  return byId.get(id);
}

/**
 * Test-only reset: clears every registered adapter. Mirrors the resettable
 * module-level singleton pattern the other core registries established, so
 * test files that each register their own adapter set don't leak into one
 * another when bun runs multiple test files in one process.
 */
export function resetAdapterRegistryForTests(): void {
  entries.length = 0;
  byId.clear();
}
