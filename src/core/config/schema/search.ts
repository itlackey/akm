// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `search` config section: default type exclusion and the optional curate
 * reranker.
 */
import { z } from "zod";
import { httpUrl, nonEmptyString, positiveInt, symbolicOrWarnApiKey } from "./primitives";

// ── Search ──────────────────────────────────────────────────────────────────

/**
 * `search.curateRerank` (#951) — an optional cross-encoder rerank pass over
 * `akm curate`'s top fused candidates.
 *
 * Deliberately its own small config arm rather than a third member of the
 * `engines` map (`EngineConfigSchema` in ./engines.ts): that union's "llm" /
 * "agent" kinds are load-bearing all the way through execution-lowering,
 * runner dispatch, and the harness model map (100+ call sites narrow on
 * `engine.kind`). A reranker is neither — it never dispatches an agent or
 * lowers to a chat-completions call — so folding it into that union would
 * force every one of those call sites to account for a kind they can't do
 * anything with. `endpoint` + `model` (+ optional `apiKey`) is the same
 * connection shape as an LLM engine without inheriting that machinery.
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
    apiKey: symbolicOrWarnApiKey("search.curateRerank.apiKey").optional(),
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
