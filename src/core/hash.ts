// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Content addressing for text handed to an embedding provider.
 *
 * `hashEmbeddableText` is the ONE hash function every writer of and lookup
 * against provider-bound text must agree on — a stable, deterministic sha256
 * over the exact bytes sent, so a single-byte content change is never
 * confused with unchanged text. Originally lived in
 * `embedding-salvage-repository.ts` (#955); moved here so a pure
 * text-processing module (`src/indexer/units/unit.ts`, #index-units) is not
 * coupled to a storage repository just to reuse it.
 */
import { createHash } from "node:crypto";

export function hashEmbeddableText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
