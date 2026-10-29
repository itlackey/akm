// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `deriveInstallations`.
 *
 * Bridges the `SearchSource[]` model (the live indexer's source list,
 * `search-source.ts`) onto the durable `BundleInstallation[]` /
 * `BundleComponent[]` model. Called from the indexer
 * (provenance derivation), the proposal repository, and written-asset
 * indexing.
 *
 * Per source → one installation:
 *   - `id`       = `source.registryId` ?? a deterministic slug of `source.path`
 *                  (the `<bundle>` prefix of every ref this installation emits).
 *                  Slugs are made unique WITHIN a derivation batch
 *                  by appending a short path-hash suffix on collision, so two
 *                  sources sharing a basename never mint the same bundle id.
 *   - components = ONE component for the current single-root akm layout
 *                  `{ id, root: source.path, adapter }`. The
 *                  akm layout's type dirs (`knowledge/`, `skills/`, …) are NOT
 *                  separate components — they are type-derived leading path
 *                  segments of the conceptId within the one component.
 *
 * ── The component id == the bundle id (transitional coupling) ──
 *
 * The `akm` adapter's `recognize` derives an item's ref prefix from the
 * component it is handed (`ref = ${c.id}//${conceptId}`, `akm-adapter.ts`), so
 * for the single-component akm layout the component id MUST equal the
 * installation/bundle id for refs to be `bundle//conceptId`. This mirrors the
 * `akm-adapter.test.ts` convention (`component({ id: BUNDLE_ID })`). Splitting
 * component-provenance from the bundle prefix (recognize learning the bundle
 * from the installation) is a downstream contract refinement — nothing in the
 * live path reads `IndexDocument.component` as distinct from `bundle` today.
 *
 * ── Adapter selection (ordered probe) ──
 *
 * The adapter is chosen by the ordered `looksLikeRoot` probe over the built-in
 * adapters (`getAdapters()`), first match wins. The registry is now a STATIC
 * FROZEN map populated at module load, so this probe runs in
 * production with the full 11-family set — no registration call is required
 * first. Array order (`BUILTIN_ADAPTERS`) is the probe precedence, most-specific
 * first, so a `.claude`/dotenv/wiki root is claimed by its tight probe before
 * the loose `akm` stash-shape probe.
 *
 * When NO adapter's probe fires (an empty or not-yet-materialized root), the
 * fallback is **`akm`** (see {@link FALLBACK_ADAPTER_ID}), preserving workspace
 * root behavior. Explicit configured ownership always wins over probing.
 */

import { detectAdapterId } from "../core/adapter/detect-adapter";
import type { BundleInstallation } from "../core/adapter/types";
import { stashDirFor } from "../core/asset/asset-placement";
import { deriveBundleId, deriveBundleIds, slugForPath } from "../core/bundle-id";
import { isSourceWriteActivated } from "../core/write-source";
import type { EntryProvenance } from "../storage/repositories/index-entry-types";
import type { SearchSource } from "./search/search-source";

export { deriveBundleId, deriveBundleIds, slugForPath };

/**
 * The no-probe-match fallback adapter id.
 *
 * The status-quo-preserving default:
 *
 *  - Behavior discipline: the AKM workspace root's own indexing
 *    MUST stay classified `akm`. In this transitional model there is no
 *    depends on either explicit adapter configuration, `akm.looksLikeRoot`
 *    firing (type dirs / `.stash` present), or this fallback. A genuinely empty
 *    root fires no probe; `akm` keeps the implicit workspace root correct.
 *  - Status quo: before the registry was wired, `getAdapters()` was empty in
 *    production so EVERY source fell back here — this preserves that exact
 *    fallback value while the probe now genuinely classifies the non-akm shapes.
 */
const FALLBACK_ADAPTER_ID = "akm";

/**
 * Resolve the adapter id for a component root via the ordered `looksLikeRoot`
 * probe, first match wins; falls back to `akm` when no probe fires.
 */
export { detectAdapterId } from "../core/adapter/detect-adapter";

/**
 * Derive the durable `BundleInstallation[]` from the transitional
 * `SearchSource[]`. Order is preserved (source priority = installation
 * priority). Bundle ids are unique within the returned batch.
 */
export function deriveInstallations(sources: SearchSource[]): BundleInstallation[] {
  const ids = deriveBundleIds(sources);
  const installations: BundleInstallation[] = [];

  for (const [index, source] of sources.entries()) {
    // D-R5 rule 1: when the source carries its config bundle key (a slug-legal
    // registryId), that key IS the installation id — equal by construction to
    // this derivation. A non-slug-legal registryId slugs from the path instead.
    const id = ids[index] as string;

    const writable = isSourceWriteActivated(source);
    const adapter = source.adapterId ?? detectAdapterId(source.path, FALLBACK_ADAPTER_ID);

    installations.push({
      id,
      components: [
        {
          // Single-component akm layout: the component id == the bundle id so
          // the adapter's `ref = ${c.id}//${conceptId}` yields `bundle//…`.
          id,
          adapter,
          root: source.path,
          writable,
        },
      ],
    });
  }

  return installations;
}

/** Canonical bundle ids whose configured component policy permits mutation. */
export function deriveWritableBundleIds(sources: SearchSource[]): Set<string> {
  return new Set(
    deriveInstallations(sources)
      .filter((installation) => installation.components.some((component) => component.writable === true))
      .map((installation) => installation.id),
  );
}

/**
 * Derive the durable `EntryProvenance` for an indexed entry (Chunk-5 flip
 * §14.4): `conceptId` is the D-R2 qualified `<stash-subdir>/<name>` spelling
 * (`stashDirFor(type)` prefix; a foreign type with no placement stash-subdir
 * keeps the bare name), and `item_ref` is `<bundle>//<conceptId>` — the exact
 * spelling `recognize` emits as `IndexDocument.ref`. Shared by the full-index
 * diff-persist writer and the write-path `indexWrittenAssets` fast path so both
 * populate item_ref identically (F4a M-core-2 item 5 — no NULL-item_ref rows).
 */
export function deriveEntryProvenance(
  bundle: { bundleId: string; componentId: string; adapterId: string },
  type: string,
  name: string,
  /**
   * The OWNING adapter's `doc.conceptId`, when the caller has it. Preferred
   * verbatim over the akm `stashDirFor` re-derivation so a non-akm adapter's
   * identity (`pages/foo`, snapshot paths, ...) survives into `item_ref`
   * (D-R3: identity comes from the resolved entry, not a re-derivation).
   */
  adapterConceptId?: string,
): EntryProvenance {
  const typeStashDir = stashDirFor(type);
  const conceptId = adapterConceptId ?? (typeStashDir !== undefined ? `${typeStashDir}/${name}` : name);
  return {
    itemRef: `${bundle.bundleId}//${conceptId}`,
    bundleId: bundle.bundleId,
    componentId: bundle.componentId,
    conceptId,
    adapterId: bundle.adapterId,
  };
}
