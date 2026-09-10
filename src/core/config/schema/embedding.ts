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
    /**
     * Per-document token cap applied BEFORE batching (default 512,
     * `DEFAULT_MAX_INPUT_TOKENS` in `src/llm/embedders/remote.ts`, #956).
     * The materializer truncates a document's embedded text to
     * this cap (head only, unicode-safe) instead of skipping it outright, so
     * one oversized entry can no longer fail a whole batch. Distinct from
     * `maxTokens` below, which bounds a whole HTTP REQUEST (many documents);
     * this bounds one DOCUMENT.
     */
    maxInputTokens: positiveInt.optional(),
    /**
     * Client-side per-request token budget — how many documents' estimated
     * tokens fit in one HTTP request (default `DEFAULT_TOKEN_BUDGET` = 6000
     * in `src/llm/embedders/remote.ts`). With the 512-token `maxInputTokens`
     * cap above, a request carries about 11 documents by default.
     */
    maxTokens: positiveInt.optional(),
    batchSize: positiveInt.optional(),
    chunkSize: positiveInt.optional(),
    /**
     * Ollama's `num_ctx` ONLY (#956) — sent verbatim as
     * `options.num_ctx` on the native `/api/embed` request. It no longer also
     * feeds the client-side request token budget (`maxTokens` above): the two
     * used to share this one field, so setting it for the server's context
     * window silently changed request batching too.
     */
    contextLength: positiveInt.optional(),
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
     * (`resolveEmbeddingConcurrency`, `src/llm/embedders/remote.ts`). Set it
     * only for an endpoint that genuinely serves parallel requests (llama.cpp
     * `--parallel N`, vLLM) — request SIZE (`batchSize`, `maxTokens`/
     * `contextLength`) remains the first throughput lever.
     */
    concurrency: positiveInt.max(16).optional(),
  })
  .passthrough();
