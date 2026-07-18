// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The installation/component scan path — akm 0.9.0 Chunk 5, milestone M-b.
 *
 * Materializes the `IndexDocument` stream the spec's scan loop drains
 * (spec line 254): for each installation → each component → `scanComponent`
 * (core walk × `adapter.recognize`, or the adapter's `index()` override) →
 * DRAIN the full document stream. ADDITIVE — M-c makes this the live indexer's
 * document source in place of the per-dir `generateMetadataFlat` loop; here it
 * backs the shadow-parity proof only.
 *
 * "Drain the full document stream (any scan error aborts before the first
 * write)" (spec §4, indexer.ts:718-723 async-scan/sync-transaction split): this
 * module is the async SCAN half — it collects every document into memory and
 * only returns once every component drained without error, so a caller's write
 * transaction sees an all-or-nothing document set (last-known-good by
 * construction). A component whose adapter id is unknown is skipped with a
 * warning (spec §12.6 "unknown adapter id ⇒ component skipped with a warning"),
 * never a hard failure that would strand the other bundles.
 */

import { adapterForId } from "../../core/adapter/registry";
import { scanComponent } from "../../core/adapter/scan-component";
import type { BundleInstallation, IndexDocument } from "../../core/adapter/types";
import { warn } from "../../core/warn";
import { deriveInstallations } from "../installations";
import type { SearchSource } from "../search/search-source";

/**
 * Drain one component's document stream — the adapter's `index()` override when
 * present (spec §2: "full-component scan for non-per-file layouts"), else the
 * core `scanComponent` walk × `recognize`. Choosing between the two is the
 * caller's job (scan-component.ts header), and this is that caller.
 */
async function drainComponent(
  inst: BundleInstallation,
  component: BundleInstallation["components"][number],
): Promise<IndexDocument[]> {
  const adapter = adapterForId(component.adapter);
  if (!adapter) {
    warn(
      `[scan] component "${component.id}" of bundle "${inst.id}" uses unknown adapter "${component.adapter}" — skipped.`,
    );
    return [];
  }
  const stream = adapter.index ? adapter.index(inst, component) : scanComponent(inst, component, adapter);
  const docs: IndexDocument[] = [];
  for await (const doc of stream) docs.push(doc);
  return docs;
}

/**
 * Materialize the full `IndexDocument` stream for a set of installations, in
 * installation-then-component order (installation priority preserved). Fully
 * drained before returning — the all-or-nothing contract above.
 */
export async function materializeInstallationDocuments(installations: BundleInstallation[]): Promise<IndexDocument[]> {
  const docs: IndexDocument[] = [];
  for (const inst of installations) {
    for (const component of inst.components) {
      docs.push(...(await drainComponent(inst, component)));
    }
  }
  return docs;
}

/**
 * Convenience: derive installations from the transitional `SearchSource[]`
 * (M-a) and materialize their documents. This is the shadow-scan entry point
 * the parity harness drives against `generateMetadataFlat`.
 */
export async function scanSourcesToDocuments(sources: SearchSource[]): Promise<IndexDocument[]> {
  return materializeInstallationDocuments(deriveInstallations(sources));
}
