// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `search` config section (graph-boost tuning). Extracted verbatim from the
 * former `config-schema.ts` monolith — no behavior change.
 */
import { z } from "zod";
import { httpUrl, nonEmptyString, nonNegativeNumber, positiveInt, symbolicOrWarnApiKey } from "./primitives";

// ── Search ──────────────────────────────────────────────────────────────────

const SearchGraphBoostSchema = z
  .object({
    directBoostPerEntity: nonNegativeNumber.optional(),
    directBoostCap: nonNegativeNumber.optional(),
    hopBoostPerEntity: nonNegativeNumber.optional(),
    hopBoostCap: nonNegativeNumber.optional(),
    /** Hard-capped at 3; values > 3 hard-error so users see the typo. */
    maxHops: positiveInt.max(3).optional(),
    /** Only "blend" is exercised; "off"/"multiply" were never set in practice and were removed. */
    confidenceMode: z.enum(["blend"]).default("blend").optional(),
    /** Range [0, 1]; values > 1 hard-error (no silent clamp). */
    confidenceWeight: z.number().finite().min(0).max(1).default(0.2).optional(),
  })
  .passthrough();

/**
 * `search.curateRerank` (#951) — an optional cross-encoder rerank pass over
 * `akm curate`'s already-selected candidates.
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
    /** How many of curate's already-ranked candidates to send to the reranker. Default 8. */
    topN: positiveInt.max(50).optional(),
  })
  .passthrough();

export const SearchConfigSchema = z
  .object({
    minScore: nonNegativeNumber.optional(),
    defaultExcludeTypes: z.array(nonEmptyString).optional(),
    graphBoost: SearchGraphBoostSchema.optional(),
    curateRerank: CurateRerankConfigSchema.optional(),
  })
  .passthrough();
