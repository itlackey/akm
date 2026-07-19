// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `deriveInstallations` — akm 0.9.0 Chunk 5, milestone M-a.
 *
 * Bridges the transitional `SearchSource[]` model (the live indexer's source
 * list, `search-source.ts`) onto the durable `BundleInstallation[]` /
 * `BundleComponent[]` model (spec §1.1) that the `scanComponent` scan loop
 * consumes (spec line 254). ADDITIVE: nothing in the live indexer calls this
 * yet — M-b wires it into a shadow scan path for the parity proof, M-c makes it
 * the live indexer's installation source.
 *
 * Per source → one installation:
 *   - `id`       = `source.registryId` ?? a deterministic slug of `source.path`
 *                  (the `<bundle>` prefix of every ref this installation emits,
 *                  spec §1.3). Slugs are made unique WITHIN a derivation batch
 *                  by appending a short path-hash suffix on collision, so two
 *                  sources sharing a basename never mint the same bundle id.
 *   - `trusted`  = `source.writable === true`. 0.9.0 ships no first-class trust
 *                  record (spec §1.3 — "no new trust machinery"); the writable
 *                  primary/config stashes are the user's own and count as
 *                  trusted, read-only registry caches do not. Nothing consumes
 *                  `trusted` in the live path yet (installation grants nothing,
 *                  History D8) — this is the Tier-A placeholder mapping.
 *   - components = ONE component for the current single-root akm layout
 *                  (spec §1.2 rule 5): `{ id, root: source.path, adapter }`. The
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
 * ── Adapter selection (spec §1.2 ordered probe) ──
 *
 * The adapter is chosen by the ordered `looksLikeRoot` probe over the
 * registered adapters (`getAdapters()`), first match wins. `registerBuiltinAdapters`
 * registers them most-specific-first (`llm-wiki` → `okf` → `akm`), so the probe
 * order is that registration order. When NO adapter's probe fires (an empty or
 * not-yet-materialized root), the fallback is **`akm`** — the AKM workspace's
 * own adapter is the config-default for a workspace stash (spec §12.6 "akm … is
 * the config-default for the AKM workspace root and is NOT part of the §1.2
 * auto-probe order"). `getAdapters()` MUST be populated (call
 * `registerBuiltinAdapters()` first) or every source falls back to `akm`.
 */

import crypto from "node:crypto";
import path from "node:path";
import { isSourceWriteActivated } from "../core/activation-policy";
import { getAdapters } from "../core/adapter/registry";
import type { BundleInstallation } from "../core/adapter/types";
import { stashDirFor } from "../core/asset/asset-placement";
import type { EntryProvenance } from "../storage/repositories/index-entry-types";
import type { SearchSource } from "./search/search-source";

/** The workspace-stash fallback adapter id (spec §12.6). */
const FALLBACK_ADAPTER_ID = "akm";

/**
 * Deterministic, filesystem-safe bundle slug from a source path. Sanitizes the
 * path's basename to the ref bundle-slug charset (spec §1.3: no `/`, `:`, `.`,
 * `#`); an empty result (e.g. a root path) falls back to a short path hash.
 * Pure function of the resolved path — the same path always slugs the same.
 */
export function slugForPath(sourcePath: string): string {
  const resolved = path.resolve(sourcePath);
  const base = path
    .basename(resolved)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (base.length > 0) return base;
  return `bundle-${shortHash(resolved)}`;
}

/** First 8 hex chars of the sha256 of the input — a stable disambiguator. */
function shortHash(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 8);
}

/**
 * Resolve the adapter id for a component root via the ordered `looksLikeRoot`
 * probe (spec §1.2), first match wins; falls back to `akm` when no probe fires.
 */
function detectAdapterId(root: string): string {
  for (const adapter of getAdapters()) {
    try {
      if (adapter.looksLikeRoot?.(root) === true) return adapter.id;
    } catch {
      // A probe that throws (unreadable root, race) does not claim the root —
      // fall through to the next adapter, ultimately to the akm fallback.
    }
  }
  return FALLBACK_ADAPTER_ID;
}

/**
 * Derive the durable `BundleInstallation[]` from the transitional
 * `SearchSource[]`. Order is preserved (source priority = installation
 * priority). Bundle ids are unique within the returned batch.
 */
export function deriveInstallations(sources: SearchSource[]): BundleInstallation[] {
  const usedIds = new Set<string>();
  const installations: BundleInstallation[] = [];

  for (const source of sources) {
    const preferred = source.registryId && source.registryId.length > 0 ? source.registryId : slugForPath(source.path);
    const id = ensureUniqueId(preferred, source.path, usedIds);
    usedIds.add(id);

    const writable = isSourceWriteActivated(source);
    const adapter = detectAdapterId(source.path);

    installations.push({
      id,
      trusted: writable,
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
): EntryProvenance {
  const typeStashDir = stashDirFor(type);
  const conceptId = typeStashDir !== undefined ? `${typeStashDir}/${name}` : name;
  return {
    itemRef: `${bundle.bundleId}//${conceptId}`,
    bundleId: bundle.bundleId,
    componentId: bundle.componentId,
    conceptId,
    adapterId: bundle.adapterId,
  };
}

/**
 * Guarantee a batch-unique id. The preferred id (registryId or path slug) is
 * used as-is when free; on collision a short path-hash suffix disambiguates
 * (deterministic in the resolved path), and the unlikely second-order collision
 * appends a numeric counter.
 */
function ensureUniqueId(preferred: string, sourcePath: string, used: Set<string>): string {
  if (!used.has(preferred)) return preferred;
  const suffixed = `${preferred}-${shortHash(path.resolve(sourcePath))}`;
  if (!used.has(suffixed)) return suffixed;
  let n = 2;
  while (used.has(`${suffixed}-${n}`)) n++;
  return `${suffixed}-${n}`;
}
