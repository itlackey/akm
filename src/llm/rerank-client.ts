// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * HTTP client for a standalone cross-encoder rerank endpoint (#951).
 *
 * `curate_rerank` was a dead `llm.features.*` key removed in 0.8.0 — no wire
 * call was ever implemented under it. This is the first real implementation:
 * a small, dedicated client (NOT routed through `llm/client.ts`'s chat-
 * completions transport, since a reranker speaks a different, much smaller
 * contract) for the request/response shape a TEI/Cohere-style `/rerank`
 * endpoint accepts:
 *
 *   POST <endpoint>
 *   { "model": "<name>", "query": "<text>", "documents": ["<text>", ...] }
 *
 *   200 OK
 *   { "results": [ { "index": 0, "relevance_score": 0.83 }, ... ] }
 *
 * `results` need not be sorted or complete — {@link rerankDocuments} sorts by
 * `relevance_score` descending and callers treat a missing index as
 * "unscored" (kept in its original relative position, after every scored
 * document). Deliberately independent of `EngineConfigSchema`'s "llm"/"agent"
 * kinds — see the comment on `CurateRerankConfigSchema` in
 * `core/config/schema/search.ts` for why.
 */

import { fetchWithTimeout, readBodyWithByteCap } from "../core/common";
import { resolveSecret } from "../core/config/config";
import { isApiKeyReference } from "../core/config/schema/primitives";
import { redactErrorBody, redactSensitiveText } from "../core/redaction";
import { resolveSecretFromStore } from "../sources/snapshot-fetchers/secret-seam";

/** Mirrors `CurateRerankConfigSchema` (`core/config/schema/search.ts`) — kept as a plain interface here to avoid this transport module depending on the Zod schema module. */
export interface CurateRerankConfig {
  enabled?: boolean;
  endpoint?: string;
  model?: string;
  apiKey?: string;
  timeoutMs?: number;
  topN?: number;
}

const DEFAULT_RERANK_TIMEOUT_MS = 10_000;

export class RerankCallError extends Error {
  readonly code: "network_error" | "provider_error" | "parse_error" | "timeout";
  constructor(message: string, code: RerankCallError["code"]) {
    super(message);
    this.name = "RerankCallError";
    this.code = code;
  }
}

/** One reranked document: its original index into the input `documents` array, and its relevance score. */
export interface RerankResult {
  index: number;
  score: number;
}

interface RerankResponseBody {
  results?: Array<{ index?: number; relevance_score?: number; score?: number }>;
}

/**
 * Call a configured rerank endpoint and return documents ordered by
 * relevance to `query`, most relevant first. Any document the endpoint
 * didn't return a score for keeps its original relative order, appended
 * after every scored document (never dropped).
 *
 * Throws {@link RerankCallError} on any transport/parse failure — callers
 * that want a graceful fallback should use `tryLlmFeature("curate_rerank", ...)`
 * (`llm/feature-gate.ts`), matching every other bounded in-tree LLM/rerank
 * call site.
 */
export async function rerankDocuments(
  config: CurateRerankConfig,
  query: string,
  documents: readonly string[],
): Promise<RerankResult[]> {
  if (!config.endpoint) {
    throw new RerankCallError("search.curateRerank.endpoint is not configured.", "provider_error");
  }
  if (documents.length === 0) return [];

  const resolvedKey =
    config.apiKey && isApiKeyReference(config.apiKey)
      ? resolveSecret(config.apiKey, resolveSecretFromStore)
      : config.apiKey;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (resolvedKey) headers.Authorization = `Bearer ${resolvedKey}`;

  const timeoutMs = config.timeoutMs ?? DEFAULT_RERANK_TIMEOUT_MS;
  const requestBody = JSON.stringify({
    ...(config.model ? { model: config.model } : {}),
    query,
    documents,
  });

  let response: Response;
  try {
    response = await fetchWithTimeout(config.endpoint, { method: "POST", headers, body: requestBody }, timeoutMs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("timed out")) {
      throw new RerankCallError(`Rerank request timed out after ${timeoutMs}ms`, "timeout");
    }
    throw new RerankCallError(`Rerank network error: ${msg}`, "network_error");
  }

  if (!response.ok) {
    const rawBody = await readBodyWithByteCap(response).catch(() => "");
    const safeBody = redactSensitiveText(redactErrorBody(rawBody), resolvedKey ? [resolvedKey] : []);
    throw new RerankCallError(
      `Rerank request failed (${response.status}) ${config.endpoint}: ${safeBody}`,
      "provider_error",
    );
  }

  const rawBody = await readBodyWithByteCap(response);
  let json: RerankResponseBody;
  try {
    json = JSON.parse(rawBody) as RerankResponseBody;
  } catch {
    throw new RerankCallError(
      `Rerank response was not valid JSON ${config.endpoint}: ${redactSensitiveText(redactErrorBody(rawBody), resolvedKey ? [resolvedKey] : [])}`,
      "parse_error",
    );
  }
  if (!Array.isArray(json.results)) {
    throw new RerankCallError(`Rerank response from ${config.endpoint} has no "results" array.`, "parse_error");
  }

  const scored = new Map<number, number>();
  for (const entry of json.results) {
    if (typeof entry.index !== "number") continue;
    const score = typeof entry.relevance_score === "number" ? entry.relevance_score : entry.score;
    if (typeof score === "number") scored.set(entry.index, score);
  }

  const rankedScored = [...scored.entries()]
    .map(([index, score]) => ({ index, score }))
    .sort((a, b) => b.score - a.score);
  const unscored = documents
    .map((_, index) => index)
    .filter((index) => !scored.has(index))
    .map((index) => ({ index, score: Number.NEGATIVE_INFINITY }));

  return [...rankedScored, ...unscored];
}
