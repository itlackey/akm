// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The adapter registry — akm 0.9.0 chunk-2, WI-2.1 (decision D2-2,
 * `docs/design/execution/chunk-2/brief.md`).
 *
 * Modeled on `src/core/asset/asset-registry.ts`'s `defaultRendererRegistry`
 * singleton (a plain module-level map + a handful of small mutator/lookup
 * functions — chunk-2 anchors.md §F.1's cited precedent), NOT the spec's
 * aspirational "static frozen `BUILTIN_ADAPTERS` map" (normative spec
 * §12.6): a frozen map can't accommodate later WIs registering their own
 * adapters incrementally, and the plan explicitly gates a *public* plugin
 * ABI as deferred (spec §12.6) — a mutable-at-load-time singleton, built up
 * by each WI's own module calling `registerAdapter`, is the shape that lets
 * WI-2.2..2.5 "register their adapters the same way" without editing this
 * file per WI.
 *
 * ADDITIVE (D2-2 / chunk-2 brief "Additive only"): this module coexists with
 * every live global (`matchers.ts`, `core/asset/asset-registry.ts`,
 * `LINTER_MAP`, `output/renderers.ts`) — nothing here is consulted by any
 * production call site yet. Chunk 3 repoints consumers off the globals onto
 * this registry (manifest chunk id "3").
 *
 * ── Why `registerAdapter` takes an optional second `types` argument ──
 *
 * `BundleAdapter` (`./bundle-adapter.ts`) has no "asset types this adapter
 * recognizes" field — by design, `recognize()` is the single source of
 * truth for what a file IS, and a `BundleComponent` binds ONE adapter to
 * one root ("no per-file competition" — `./types.ts`'s `BundleComponent.id`
 * doc comment). But the chunk-2 census (anchors.md §A.2) groups MULTIPLE
 * legacy asset types under one adapter id (`dotenv` owns `env`+`secret`,
 * `agent-tooling` owns `command`+`agent`, `note` owns `lesson`+`session`+
 * `fact`) — for THOSE adapters, `adapter.id` alone cannot answer "which
 * type(s) does this adapter own," which a reverse `type -> adapter` lookup
 * (`adapterForType`) needs. Rather than mutate the frozen `BundleAdapter`
 * interface (Chunk 1's contract) to carry an owned-types field, the
 * registry accepts the owned types at REGISTRATION time, defaulting to
 * `[adapter.id]` — exactly right for WI-2.1's three 1:1 adapters
 * (`registerAdapter(skillAdapter)` needs no second argument at all: id
 * "skill" already IS the type it owns), and explicit for later multi-type
 * adapters (`registerAdapter(dotenvAdapter, ["env", "secret"])`). Flagged
 * for the maintainer: this is a deliberate extension beyond the brief's
 * literal `registerAdapter(a: BundleAdapter)` signature, needed because the
 * interface itself has no owned-types field.
 */

import type { FileContext } from "../../indexer/walk/file-context";
import type { BundleAdapter } from "./bundle-adapter";
import type { BundleComponent } from "./types";

interface AdapterEntry {
  adapter: BundleAdapter;
  /** Asset type keys this adapter owns (index-time `IndexDocument.type` values it can emit). */
  types: readonly string[];
}

/** Ordered list of registered adapters (registration order; later re-registration of the same id replaces in place). */
const entries: AdapterEntry[] = [];
/** `adapter.id -> entry` for O(1) id lookup. */
const byId = new Map<string, AdapterEntry>();
/** `type -> entry` for O(1) type lookup. Later registration wins ties (mirrors `registerRenderer`'s "silently replaced" precedent, asset-registry.ts). */
const byType = new Map<string, AdapterEntry>();

/**
 * Register a `BundleAdapter`. `types` defaults to `[adapter.id]` — correct
 * for a 1:1 adapter (skill/wiki/script); multi-type adapters (dotenv,
 * agent-tooling, note — chunk-2 anchors.md §A.2) MUST pass their owned types
 * explicitly. Re-registering the same `adapter.id` replaces the prior entry
 * in place (same replace-on-conflict semantics as
 * `asset-registry.ts#registerTypeRenderer`), so re-importing an adapter
 * module during a test run is idempotent rather than accumulating
 * duplicates in `getAdapters()`.
 */
export function registerAdapter(adapter: BundleAdapter, types: readonly string[] = [adapter.id]): void {
  const entry: AdapterEntry = { adapter, types };
  const existingIndex = entries.findIndex((e) => e.adapter.id === adapter.id);
  if (existingIndex >= 0) entries.splice(existingIndex, 1);
  entries.push(entry);
  byId.set(adapter.id, entry);
  for (const type of types) byType.set(type, entry);
}

/** Snapshot of every registered adapter, in registration order. */
export function getAdapters(): BundleAdapter[] {
  return entries.map((e) => e.adapter);
}

/** Look up an adapter by its own `id` (matches `BundleComponent.adapter`). */
export function adapterForId(id: string): BundleAdapter | undefined {
  return byId.get(id)?.adapter;
}

/** The asset type(s) registered for `adapterId` (empty array if not registered, or registered with no types). */
export function typesForAdapter(adapterId: string): readonly string[] {
  return byId.get(adapterId)?.types ?? [];
}

/** Look up the adapter that owns a given asset `type` (e.g. "env" -> the dotenv adapter). */
export function adapterForType(type: string): BundleAdapter | undefined {
  return byType.get(type)?.adapter;
}

/**
 * Best-effort convenience lookup: the first registered adapter (registration
 * order) whose `recognize(c, file)` claims `file`. This is NOT a production
 * dispatch path — in the target architecture one `BundleComponent` is bound
 * to exactly one adapter (`BundleComponent.id` doc comment: "no per-file
 * competition"), so a real caller already knows which adapter to invoke via
 * `adapterForId(c.adapter)`. `adapterForFile` exists for diagnostics/tests
 * that want to ask "which registered adapter (if any) would claim this
 * file" without pre-selecting a component's adapter — e.g. WI-2.6's
 * conformance suite. Calls `recognize` (which may read the file) on each
 * candidate in turn; callers that already HAVE the resulting `IndexDocument`
 * should not call this a second time.
 */
export function adapterForFile(c: BundleComponent, file: FileContext): BundleAdapter | undefined {
  for (const { adapter } of entries) {
    if (adapter.recognize(c, file) !== null) return adapter;
  }
  return undefined;
}

/**
 * Test-only reset: clears every registered adapter. Mirrors the pattern
 * `deregisterAssetType` (`core/asset/asset-spec.ts`) established for its
 * own registry — module-level singleton state must be resettable so test
 * files that each register their own adapter set don't leak into one
 * another when bun runs multiple test files in one process.
 */
export function resetAdapterRegistryForTests(): void {
  entries.length = 0;
  byId.clear();
  byType.clear();
}
