// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Identity of the embedding vectors actually OBSERVED on a run — as opposed
 * to a config-derived fingerprint. Keys on what the server (or local model)
 * actually reported plus the observed vector width, so a gateway/transport
 * change that keeps returning the same underlying model can be told apart
 * from a genuine model change without relying on the operator's config
 * string alone (#955).
 *
 * Moved out of `materialize-embeddings.ts` (docs/plans/index-redesign-contract.md,
 * B4) so both it (the entry-embedding canary/pass) and `drain.ts` (the
 * unit-embedding queue) import the same function instead of diverging
 * copies. `materialize-embeddings.ts` itself is otherwise untouched by B4 —
 * B5 deletes it once the unit queue replaces it.
 */
import type { EmbeddingConnectionConfig } from "../core/config/config";
import { DETERMINISTIC_EMBED_MODEL_ID, isDeterministicEmbedEnabled } from "../llm/embedders/deterministic";
import { DEFAULT_LOCAL_MODEL } from "../llm/embedders/local";

/**
 * Returns `undefined` when nothing was actually observed this call (no
 * vector to measure yet) — there is nothing to key an identity on.
 */
export function deriveObservedEmbeddingIdentity(
  embedding: EmbeddingConnectionConfig | undefined,
  observedModel: string | undefined,
  observedVectorLen: number | undefined,
): string | undefined {
  if (isDeterministicEmbedEnabled()) {
    return `deterministic:${DETERMINISTIC_EMBED_MODEL_ID}`;
  }
  if (observedVectorLen === undefined) return undefined;
  if (embedding?.endpoint) {
    return `remote:${observedModel ?? embedding.model ?? "unknown"}|${observedVectorLen}`;
  }
  return `local:${embedding?.localModel ?? DEFAULT_LOCAL_MODEL}|${observedVectorLen}`;
}
