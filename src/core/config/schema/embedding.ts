// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Embedding connection config (`embedding`). Extracted verbatim from the former
 * `config-schema.ts` monolith — no behavior change.
 */
import { z } from "zod";
import { positiveInt, symbolicOrWarnApiKey } from "./primitives";

const EmbeddingOllamaOptionsSchema = z
  .object({
    num_ctx: positiveInt.optional(),
  })
  .passthrough();

/**
 * Embedding connection config. Both `endpoint` and `model` are optional:
 *   - Remote: provide `endpoint` (http/https URL) + `model`.
 *   - Local-only: omit `endpoint`/`model`; set `localModel` (or fall back to
 *     {@link DEFAULT_LOCAL_MODEL}).
 *
 * Consumers route via `hasRemoteEndpoint()` which checks for an http(s)
 * endpoint — absent fields take the local path naturally, no sentinels needed.
 */
export const EmbeddingConnectionConfigSchema = z
  .object({
    provider: z.string().optional(),
    endpoint: z.string().optional(),
    model: z.string().optional(),
    apiKey: symbolicOrWarnApiKey("embedding.apiKey").optional(),
    // Bounded to the index schema's own vec-table guard (1–4096,
    // storage/repositories/index-schema.ts) so an out-of-range dimension
    // fails at config validation with a clear message instead of crashing
    // `akm index` when ensureSchema rejects it (§24.2 "Semantic" gate).
    dimension: positiveInt.max(4096).optional(),
    localModel: z.string().min(1).optional(),
    ollamaOptions: EmbeddingOllamaOptionsSchema.optional(),
    /**
     * Per-request timeout in milliseconds for a remote embedding request
     * (default 120_000, `DEFAULT_EMBEDDING_TIMEOUT_MS` in
     * `src/llm/embedders/remote.ts`). The prior fixed 30s cut off a slow
     * local model server on a large token-bounded batch mid-response, with
     * no retry — every batch that hit it was silently dropped (#954).
     */
    timeoutMs: positiveInt.optional(),
    /**
     * Overrides the fixed in-flight request window (#954, added after field
     * evidence from multi-slot local servers). Bounded 1-16. Unset keeps
     * today's default: 1 for a loopback endpoint, 2 for a remote one
     * (`resolveEmbeddingConcurrency`, `src/llm/embedders/remote.ts`), unless
     * the provider's own probed slot count overrides it
     * (`probeProviderLimits`, `src/llm/embedders/provider-limits.ts`, used by
     * `akm index`'s drain queue). Set it only for an endpoint that genuinely
     * serves parallel requests (llama.cpp `--parallel N`, vLLM) — request
     * SIZE, packed against the provider's own probed context window, remains
     * the first throughput lever.
     */
    concurrency: positiveInt.max(16).optional(),
  })
  .passthrough();
