// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `search` config section: default type exclusion and the optional curate
 * reranker.
 */
import { z } from "zod";
import { envReferenceApiKey, httpUrl, nonEmptyString, positiveInt } from "./primitives";

// ── Search ──────────────────────────────────────────────────────────────────

/**
 * `search.curateRerank` (#951) — an optional cross-encoder rerank pass over
 * `akm curate`'s top fused candidates.
 *
 * Deliberately its own small config block rather than a `connections` entry: a
 * reranker never dispatches an agent or lowers to a chat-completions call, and
 * its `endpoint` is the full rerank URL. Its `apiKey` follows the connection
 * rule (`$VAR`, or `credentials.json` under the name `curateRerank`).
 *
 * `curate_rerank` was removed as a dead `llm.features.*` key in 0.8.0 (no
 * implementation ever sent a request); this is a new, real implementation,
 * disabled by default.
 */
export const CurateRerankConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    /** Full URL of the reranker's rerank endpoint, e.g. `http://host:port/rerank`. */
    endpoint: httpUrl.optional(),
    model: nonEmptyString.optional(),
    apiKey: envReferenceApiKey.optional(),
    timeoutMs: positiveInt.optional(),
    /** How many of the top fused search candidates curate sends to the reranker. Default 30. */
    topN: positiveInt.max(50).optional(),
  })
  .passthrough();

export const SearchConfigSchema = z
  .object({
    defaultExcludeTypes: z.array(nonEmptyString).optional(),
    curateRerank: CurateRerankConfigSchema.optional(),
  })
  .passthrough();
