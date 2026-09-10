// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * OpenAI-compatible remote embedder.
 *
 * Calls the configured `/embeddings` endpoint and L2-normalizes the returned
 * vectors so the scoring pipeline's L2-to-cosine conversion is correct.
 */

import { abortableDelay, backoffDelay, fetchWithTimeout, isHttpUrl, readBodyWithByteCap } from "../../core/common";
import { concurrentMap } from "../../core/concurrent";
import { type EmbeddingConnectionConfig, resolveSecret } from "../../core/config/config";
import { ENV_REFERENCE_PATTERN, SECRET_STORE_REFERENCE_PATTERN } from "../../core/config/schema/primitives";
import { defaultConcurrencyForEndpoint } from "../../core/loopback";
import { redactErrorBody, redactSensitiveText } from "../../core/redaction";
import { warnVerbose } from "../../core/warn";
import { resolveSecretFromStore } from "../../sources/snapshot-fetchers/secret-seam";
import type { Embedder, EmbeddingVector } from "./types";

/**
 * Upper bound on the number of documents in one HTTP request, independent of
 * the token budget below. Overridable via `config.batchSize`. Purely a
 * safety cap (very many tiny documents could otherwise pack one request) —
 * the token budget is what actually keeps a request inside the endpoint's
 * context window and inside the timeout (#874).
 */
export const DEFAULT_REMOTE_BATCH_SIZE = 100;

/**
 * Conservative default token budget per HTTP request when the config gives
 * no better number (`maxTokens` — see #956 for why `contextLength`
 * no longer feeds this). #874's measurements:
 * a batch of 100 small docs (~400 KB, ~100K tokens) took 14.8s against a
 * healthy local endpoint — half the 30s request timeout — and a single
 * 128 KB (~24K token) document alone was rejected by the endpoint as
 * exceeding its context size.
 *
 * Lowered from 8000 to 6000 (#954, field report on beta.1): the 4-chars-
 * per-token estimator undercounts dense technical text by 7-55%, so 8000
 * against an 8192-token llama.cpp embedder regularly landed real requests
 * over the endpoint's context window. 6000 is the value the field confirmed
 * stops that steady trickle of rejections; `embedBatch`'s run-scoped
 * adaptive budget below still shrinks further, for an endpoint where even
 * this is not enough.
 */
export const DEFAULT_TOKEN_BUDGET = 6000;

/** Cheap token estimator: 4 chars ≈ 1 token. Used in verbose logging and error messages. */
export function estimateTokenCount(text: string): number {
  return Math.round(text.length / 4);
}

/**
 * Default per-document embedding cap (`embedding.maxInputTokens`, #956)
 * — the materializer truncates a document's embedded text to
 * this cap (head only) instead of skipping it outright, so one oversized
 * entry can no longer fail a whole batch. Fragments are not embedded at all
 * (only the entry's own search text is), so this is the only lever on how
 * much of a large document contributes to its vector.
 */
export const DEFAULT_MAX_INPUT_TOKENS = 512;

/**
 * Truncate `text` to at most `maxTokens` (estimated via
 * {@link estimateTokenCount}, the same 4-chars≈1-token rule the batching
 * budget uses), keeping only its head. The cut never splits a UTF-16
 * surrogate pair. Text already at or under the cap is returned unchanged
 * (`truncated: false`) — including empty text, which is never itself
 * "truncated".
 */
export function capEmbeddingText(text: string, maxTokens: number): { text: string; truncated: boolean } {
  if (estimateTokenCount(text) <= maxTokens) return { text, truncated: false };
  const charBudget = Math.max(0, maxTokens * 4);
  let cut = Math.min(charBudget, text.length);
  if (cut > 0 && cut < text.length) {
    const code = text.charCodeAt(cut);
    // A low surrogate (0xDC00-0xDFFF) at the cut point means its high
    // surrogate is the character just before it — back off one position so
    // the pair stays together rather than yielding a lone surrogate.
    if (code >= 0xdc00 && code <= 0xdfff) cut -= 1;
  }
  return { text: text.slice(0, cut), truncated: true };
}

/**
 * Default per-request timeout when `embedding.timeoutMs` is unset (#954).
 * The prior fixed 30s cut off exactly the field-report case: a
 * local model server on an 8000-token (`DEFAULT_TOKEN_BUDGET`) batch
 * legitimately takes longer than that, and the timeout fired mid-response
 * with no retry — every batch it hit was silently dropped for the rest of
 * an hours-long run. 120s comfortably covers a slow local batch while still
 * bounding a genuinely dead endpoint to a few minutes, not forever.
 */
export const DEFAULT_EMBEDDING_TIMEOUT_MS = 120_000;

/** Resolve the effective per-request timeout: `embedding.timeoutMs` when set, else the default above. */
export function resolveEmbeddingTimeoutMs(config: EmbeddingConnectionConfig): number {
  return config.timeoutMs ?? DEFAULT_EMBEDDING_TIMEOUT_MS;
}

/**
 * Scale the per-request timeout down for a smaller-than-budget request
 * (#954, field-report follow-up): `embedding.timeoutMs` /
 * {@link resolveEmbeddingTimeoutMs} is the budget for a request at the FULL
 * token budget; a batch using only a fraction of it gets a proportionally
 * smaller timeout, floored at 30s and never above the configured
 * `timeoutMs` itself, so a dead server is detected in seconds on the common
 * case of small documents instead of always waiting out the full configured
 * budget.
 */
export function scaleEmbeddingTimeoutMs(timeoutMs: number, requestTokens: number, tokenBudget: number): number {
  const scaled = tokenBudget > 0 ? timeoutMs * (requestTokens / tokenBudget) : timeoutMs;
  return Math.min(Math.max(scaled, 30_000), timeoutMs);
}

/**
 * True when `err` is a request- or body-read timeout (#954) —
 * `fetchWithTimeout`'s connection/header timeout ("Request timed out
 * after...") or `readBodyWithByteCap`'s body-phase `BodyReadTimeoutError`.
 * Only this failure mode gets the back-off-and-retry treatment:
 * the field evidence was specifically that a timed-out request keeps
 * computing server-side, so abandoning it immediately (the prior
 * behavior) just grows the provider's queue further. A genuine network/HTTP
 * failure (connection refused, malformed response, a real error response)
 * has no such still-in-flight hazard and keeps the original
 * skip-immediately behavior.
 */
export function isEmbeddingTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "BodyReadTimeoutError") return true;
  return err.message.startsWith("Request timed out after ");
}

/** TEST-ONLY seam: override the backoff base/max so retry-backoff tests run fast without waiting real seconds. */
let embeddingTimeoutBackoffOverrideForTests: { baseMs: number; maxMs: number } | undefined;

/** TEST-ONLY. Pass undefined to restore the real 5s/60s backoff. */
export function _setEmbeddingTimeoutBackoffForTests(config?: { baseMs: number; maxMs: number }): void {
  embeddingTimeoutBackoffOverrideForTests = config;
}

/**
 * Backoff before the single same-size retry on a request timeout
 * (#954) — reuses the same jittered
 * exponential formula {@link backoffDelay} uses for the rest of the
 * codebase's retry paths, at a base of "5s, doubling, capped at 60s".
 *
 * `timeoutAttempt` (#954, field-report follow-up) is how many times the
 * SAME-SIZE-retry-then-split chain has already split before reaching this
 * size — 0 at the top level. The first-timeout backoff for each successive,
 * smaller size after a split grows with it (5s, then doubling, capped at
 * 60s) instead of every split resetting to a flat ~5s: the field evidence
 * was that an abandoned request keeps computing server-side, so a server
 * already draining a whole chain of abandoned requests needs progressively
 * more room, not the same fixed pause at every size.
 */
export function embeddingTimeoutRetryBackoffMs(timeoutAttempt = 0): number {
  const { baseMs, maxMs } = embeddingTimeoutBackoffOverrideForTests ?? { baseMs: 5_000, maxMs: 60_000 };
  return backoffDelay(timeoutAttempt, baseMs, maxMs);
}

/** Why a document was skipped rather than embedded. */
export type EmbeddingSkipReason = "context-window-exceeded" | "batch-request-failed";

/**
 * Only meaningful when `reason === "batch-request-failed"` (#954):
 * whether the failed request timed out or failed some
 * other way (network error, malformed response, a non-timeout HTTP
 * failure). The materializer's circuit breaker treats a run of network
 * errors as fatal at ANY request size, but only trusts a run of timeouts
 * once retries have already narrowed them down to single documents — a
 * multi-document timeout might still succeed once split smaller, so it is
 * not by itself evidence the endpoint is dead.
 */
export type EmbeddingFailureKind = "timeout" | "network-error";

export interface EmbeddingBatchSkip {
  /** Index into the `texts` array passed to `embedBatch`. */
  index: number;
  reason: EmbeddingSkipReason;
  message: string;
  /**
   * True on the FIRST skip event of a failed provider batch (#954). One
   * failing request skips every document it covered — one `onSkip` call per
   * document, all sharing this batch's outcome and `reason`/`message` — so a
   * caller implementing a consecutive-failure policy (the circuit breaker,
   * `src/indexer/materialize-embeddings.ts`) must count BATCHES, not
   * documents: a 100-document batch failing once must not look like 100
   * consecutive failures.
   */
  batchStart: boolean;
  /** Number of documents covered by the failed request (#954). */
  batchSize: number;
  /** See {@link EmbeddingFailureKind}. Undefined for a `context-window-exceeded` skip. */
  failureKind?: EmbeddingFailureKind;
}

/**
 * Report one skipped document. Return the literal value `false` to stop
 * `RemoteEmbedder` from dispatching any FURTHER provider batch (#954)
 * — used by the materializer's circuit breaker after too many
 * consecutive transport failures. Any other return value (including
 * `undefined`/`void`, and deliberately typed `unknown` rather than
 * `boolean | void` so an ordinary `(skip) => skips.push(skip)` callback
 * stays valid) keeps dispatching normally. A caller should never return
 * `false` for a `context-window-exceeded` skip: it is not a transport
 * failure, and split-and-retry already handles it.
 */
export type EmbeddingSkipHandler = (skip: EmbeddingBatchSkip) => unknown;

/**
 * Batch/doc/token/timing/outcome metadata for the default-level per-batch
 * progress line (#954, field-report follow-up) —
 * `[embed] batch 3/1483: 16 docs, 5,900 tokens → 16 stored (0.8 s)`. Only
 * `RemoteEmbedder.embedBatch` produces this (token-bounded batching against
 * an HTTP provider is the thing being reported on); local/deterministic
 * embedding never populates it, and the materializer prints the line only
 * when it is present.
 */
export interface EmbeddingBatchOutcome {
  /** 1-based ordinal of the top-level planned batch (`buildTokenBoundedBatches`) this event descends from. */
  batchIndex: number;
  /** Total number of top-level planned batches for this `embedBatch` call. */
  batchCount: number;
  /** Documents covered by THIS specific event — may be smaller than the planned batch after a context-size or timeout split. */
  docCount: number;
  /** Estimated token count of THIS specific event's request. */
  requestTokens: number;
  /** Milliseconds: request latency for "stored"/"failed", the back-off delay about to be waited for "retrying". */
  elapsedMs: number;
  /**
   * "stored": the request succeeded and its embeddings are in `embeddings`.
   * "failed": the request/document is being given up on (skipped) —
   * `embeddings` are all `undefined`.
   * "retrying": a request timeout is about to back off and retry the SAME
   * request once (#954) — nothing has failed or succeeded yet;
   * `embeddings` are all `undefined` and there is nothing to commit.
   * "budget-lowered" (#954, field report on beta.1): a one-time notice,
   * fired at most once per `embedBatch` call, that the FIRST context-size
   * rejection of the run has shrunk the effective request budget for every
   * batch not yet dispatched — see {@link RemoteEmbedder.embedBatch}.
   * Nothing has failed or succeeded for `indices` itself; `embeddings` are
   * all `undefined` and there is nothing to commit.
   */
  outcome: "stored" | "failed" | "retrying" | "budget-lowered";
  /** Present for "failed" (the failure reason), "retrying" (why it is retrying), and "budget-lowered" (the new budget). Absent for "stored". */
  reason?: string;
}

/**
 * Fired once per provider request (success OR skip-with-undefined-slots),
 * before the next request starts (#954), and once more before a timeout
 * retry's back-off delay (`outcome.outcome === "retrying"`, #954 field-report
 * follow-up) — that call carries nothing to commit, only the notice.
 * `indices` are positions into the `texts` array passed to `embedBatch`;
 * `embeddings` is the same length, `undefined` at any index that failed,
 * was skipped, or (for a "retrying" event) has not been requested yet.
 * Lets the caller commit each batch to durable storage as it lands rather
 * than buffering the whole run in memory for one final write — completion
 * order is irrelevant to a caller that commits per call, so this fires
 * under concurrency too.
 *
 * `model`, when the provider's response body carried one, is the server-
 * reported model id for that request (#955) — undefined for a skipped
 * batch, a local/deterministic run, or a provider that omits the field.
 * The embedding-fingerprint canary uses it to tell a same-model config
 * rename (e.g. a gateway prefixing `provider/model`) apart from a genuine
 * model change without guessing from the config string alone.
 *
 * `outcome` (#954 field-report follow-up) is the extended event data the
 * default-level per-batch progress line needs — see
 * {@link EmbeddingBatchOutcome}. Optional so every existing caller/fake that
 * only ever passed `indices`/`embeddings`/`model` remains valid; a caller
 * that omits it simply gets no per-batch line.
 */
export type EmbeddingBatchCommit = (
  indices: number[],
  embeddings: (EmbeddingVector | undefined)[],
  model?: string,
  outcome?: EmbeddingBatchOutcome,
) => void;

/**
 * Distinguishes a batch rejected because it exceeded the endpoint's context
 * window from every other failure mode (network error, 5xx, malformed
 * response). Only this error class triggers the split-in-half retry in
 * {@link RemoteEmbedder.embedBatch} (#954) — anything else keeps the
 * original skip-the-whole-batch behavior pinned by
 * tests/integration/embedding-batch-partial-failure.test.ts.
 */
export class ContextExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextExceededError";
  }
}

/**
 * Patterns providers use to report a request too large for the model's
 * context window. `input is too large to process`/`physical batch size`/
 * `ubatch` (#954) cover llama.cpp's own physical-batch
 * rejection (HTTP 500, e.g. "input is too large to process. increase the
 * physical batch size"), which was previously an unrecognized generic
 * failure — the whole batch was dropped instead of split and retried.
 */
const CONTEXT_EXCEEDED_PATTERN =
  /exceed_context_size_error|context size|context length|too many tokens|input is too large to process|physical batch size|ubatch/i;

/**
 * True when an HTTP failure means "this request's input is too large for the
 * endpoint's context window" rather than some other failure. HTTP 413
 * (Payload Too Large) is always treated this way regardless of body; other
 * status codes are checked against known provider error-body phrasing.
 */
export function isContextExceededResponse(status: number, body: string): boolean {
  if (status === 413) return true;
  return CONTEXT_EXCEEDED_PATTERN.test(body);
}

/**
 * Resolve the effective in-flight request window for `RemoteEmbedder.embedBatch`.
 * Default (unset `embedding.concurrency`): 1 for a loopback endpoint, 2 for a
 * remote one, via the shared `defaultConcurrencyForEndpoint`
 * (`src/core/loopback.ts`), the same lowest-common-denominator rule
 * `getDefaultLlmConcurrency` (`src/indexer/indexer.ts`) uses.
 *
 * `embedding.concurrency` (#954) overrides this default in
 * either direction, bounded 1-16 at the config schema — added after field
 * evidence that a multi-slot local server (llama.cpp `--parallel N`, vLLM)
 * genuinely serves parallel requests and was left idle by the fixed default.
 * Request SIZE remains the first throughput lever regardless:
 * `embedding.batchSize` (document cap) and `embedding.maxTokens` (request
 * token budget — see #956; `contextLength` no longer feeds it)
 * reach a larger batch per request, which is where most of the win is for a
 * single-slot server — a 32-input batch takes about the same wall time as
 * one input against a healthy endpoint.
 */
export function resolveEmbeddingConcurrency(config: EmbeddingConnectionConfig): number {
  if (typeof config.concurrency === "number") return config.concurrency;
  return defaultConcurrencyForEndpoint(config.endpoint);
}

interface TextBatch {
  /** Indices into the original `texts` array. */
  indices: number[];
  /** True when this "batch" is a single document too large to ever fit the token budget. */
  oversized: boolean;
}

/**
 * Group `texts` into request-sized batches bounded by BOTH an estimated
 * token budget and a document-count cap, so one large document does not
 * silently blow the batch past the endpoint's context window (#874).
 *
 * A single document whose own estimate exceeds `tokenBudget` can never fit
 * any batch — it is reported as its own oversized "batch" so the caller can
 * skip it without ever making an HTTP request for it.
 */
export function buildTokenBoundedBatches(texts: readonly string[], tokenBudget: number, maxCount: number): TextBatch[] {
  const batches: TextBatch[] = [];
  let current: number[] = [];
  let currentTokens = 0;

  const flush = (): void => {
    if (current.length > 0) {
      batches.push({ indices: current, oversized: false });
      current = [];
      currentTokens = 0;
    }
  };

  for (let i = 0; i < texts.length; i++) {
    const tokens = estimateTokenCount(texts[i] as string);
    if (tokens > tokenBudget) {
      flush();
      batches.push({ indices: [i], oversized: true });
      continue;
    }
    if (current.length > 0 && (currentTokens + tokens > tokenBudget || current.length >= maxCount)) {
      flush();
    }
    current.push(i);
    currentTokens += tokens;
  }
  flush();
  return batches;
}

/**
 * Shrink factor applied to the effective request budget on the first
 * context-size rejection of an `embedBatch` run (#954, field report on
 * beta.1): one 25% cut absorbs the estimator's measured undercount without
 * repeatedly re-shrinking mid-run — see the "shrink at most once" rule on
 * {@link RemoteEmbedder.embedBatch}.
 */
const ADAPTIVE_BUDGET_SHRINK_FACTOR = 0.75;

/**
 * Floor on the adaptive-budget shrink above, as a multiple of
 * `maxInputTokens` (#954): a request budget below twice the per-document cap
 * could no longer batch more than one document per request, defeating the
 * point of batching at all.
 */
const ADAPTIVE_BUDGET_FLOOR_MULTIPLIER = 2;

export class RemoteEmbedder implements Embedder {
  private readonly endpoint: string;
  private readonly model: string;

  constructor(private readonly config: EmbeddingConnectionConfig) {
    if (!config.endpoint || !config.model) {
      throw new Error("RemoteEmbedder requires both endpoint and model on the embedding config.");
    }
    this.endpoint = config.endpoint;
    this.model = config.model;
  }

  async embed(text: string, signal?: AbortSignal): Promise<EmbeddingVector> {
    const headers = this.buildHeaders();
    const body: { input: string; model: string; dimensions?: number; options?: { num_ctx?: number } } = {
      input: text,
      model: this.model,
    };
    if (this.config.dimension) {
      body.dimensions = this.config.dimension;
    }
    const ollamaOpts = resolveOllamaOptions(this.config);
    if (ollamaOpts) {
      body.options = ollamaOpts;
    }
    const timeoutMs = resolveEmbeddingTimeoutMs(this.config);

    // `signal` MUST go through fetchWithTimeout's dedicated 4th parameter, not
    // the RequestInit: fetchWithTimeout replaces `opts.signal` with its own
    // controller (`{ ...opts, signal: controller.signal }`), so a signal passed
    // inside `opts` is silently dropped and caller cancellation never fires.
    const response = await fetchWithTimeout(
      normalizeEmbeddingEndpoint(this.endpoint),
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      },
      timeoutMs,
      signal,
    );

    if (!response.ok) {
      const errBody = await readBodyWithByteCap(response, undefined, { bodyTimeoutMs: timeoutMs, signal }).catch(
        (err) => {
          if (signal?.aborted) throw err;
          return "";
        },
      );
      throw new Error(`Embedding request failed (${response.status}): ${this.safeErrorBody(errBody)}`);
    }

    const json = JSON.parse(await readBodyWithByteCap(response, undefined, { bodyTimeoutMs: timeoutMs, signal })) as {
      data: Array<{ embedding: number[] }>;
    };

    if (!json.data?.[0]?.embedding) {
      throw new Error(
        `Unexpected embedding response format: missing data[0].embedding.${embeddingEndpointPathHint(this.endpoint)}`,
      );
    }

    return l2Normalize(json.data[0].embedding);
  }

  /**
   * Embed every text, batched by an estimated token budget (not a fixed
   * document count) and bounded by `config.batchSize` as a document-count
   * safety cap. Batching by count alone let a batch of ordinary-sized
   * documents balloon past the endpoint's context window and the 30s
   * request timeout (#874).
   *
   * A failing sub-batch or an oversized single document is SKIPPED, not
   * thrown — the rest of `texts` still gets embedded. Skips are reported via
   * `onSkip` (index into `texts` + a named reason) rather than silently
   * dropped; the returned array holds `undefined` at every skipped index.
   * A caller abort (`signal.aborted`) still propagates as a rejection.
   *
   * Provider batches are dispatched through a bounded pool sized by
   * `resolveEmbeddingConcurrency` (#954) instead of strictly sequentially, so
   * request latency overlaps. `onBatch`, when given, fires once per provider
   * batch (success or skip) as it completes, only after that batch's own
   * outcome has already been classified — pass it to commit each batch's
   * rows durably as they land rather than buffering the whole call.
   * Completion order does not matter to `results` placement, which is always
   * written by index regardless of dispatch order. A throw from `onBatch`
   * itself (e.g. the caller's own commit failing) is never mistaken for a
   * provider/network failure; it is captured and rethrown once every batch
   * has been dispatched, alongside the `signal.aborted` check. The FIRST
   * `onBatch` throw also stops the pool from dispatching any further
   * provider request (#954 gap fix) — a persistence failure means every
   * later batch's result can never be committed either, so there is no
   * point paying for more HTTP requests; a batch already in flight when this
   * happens is left to finish (never network-aborted) but its result is
   * discarded rather than committed.
   *
   * A batch rejected specifically for exceeding the endpoint's context window
   * (HTTP 413, or a recognised context-size error body — see
   * {@link isContextExceededResponse}) is split in half and retried
   * recursively rather than skipped outright, down to individual documents; a
   * single document that still fails this way becomes a genuine
   * `context-window-exceeded` skip.
   *
   * A request TIMEOUT (see {@link isEmbeddingTimeoutError}) never drops the
   * batch outright (#954): the field evidence
   * was that akm abandoning a timed-out request does not stop the server
   * from still computing it, so immediately skipping (or immediately
   * splitting, the prior behavior) just let the provider's queue grow
   * while every following batch died the same way. Instead, on a timeout,
   * this backs off ({@link embeddingTimeoutRetryBackoffMs}) and retries the
   * SAME request once; a second timeout splits it in half (like a
   * context-size rejection) and retries each half the same way, down to
   * single documents — a single document that times out twice is finally
   * skipped. Every other failure (network error, malformed response, a
   * non-timeout HTTP failure) keeps the original skip-the-whole-batch-
   * immediately behavior, at any size. The per-request timeout itself also
   * scales down with the request's estimated size via
   * {@link scaleEmbeddingTimeoutMs}, so a dead server is detected in seconds
   * on a small batch rather than always waiting out the full configured
   * `embedding.timeoutMs`.
   *
   * Run-scoped adaptive budget (#954, field report on beta.1): the FIRST
   * context-size rejection of the run shrinks the effective request budget
   * by {@link ADAPTIVE_BUDGET_SHRINK_FACTOR} (floored at
   * {@link ADAPTIVE_BUDGET_FLOOR_MULTIPLIER} times `maxInputTokens`) for
   * every batch not yet dispatched — the still-planned tail of `texts` is
   * re-batched with `buildTokenBoundedBatches` at the smaller budget, and a
   * `budget-lowered` `onBatch` event reports it once. This never touches the
   * split-and-retry of the rejected batch itself (above), and never fires a
   * second time in the same run even if a later batch is also rejected — a
   * static configured budget that is simply too big for the endpoint should
   * self-correct once, not ratchet down forever.
   */
  async embedBatch(
    texts: string[],
    signal?: AbortSignal,
    onSkip?: EmbeddingSkipHandler,
    onBatch?: EmbeddingBatchCommit,
  ): Promise<(EmbeddingVector | undefined)[]> {
    if (texts.length === 0) return [];
    const results: (EmbeddingVector | undefined)[] = new Array(texts.length).fill(undefined);
    const headers = this.buildHeaders();
    const ollamaOpts = resolveOllamaOptions(this.config);

    // #956: `contextLength` is Ollama's `num_ctx` ONLY (see
    // resolveOllamaOptions below) — it used to double as this client-side
    // request budget too, so a config author setting it for one purpose
    // silently changed the other. `maxTokens` is the sole knob for the
    // request budget now; unset falls back to DEFAULT_TOKEN_BUDGET.
    //
    // `effectiveTokenBudget` (#954) starts at the configured/default value
    // and MAY shrink once, on the run's first context-size rejection — see
    // `maybeShrinkBudget` below. `textBatches` is mutated in place (spliced)
    // by that shrink rather than reassigned, so the in-flight
    // `concurrentMap` pool below (which reads this same array by reference)
    // picks up the re-planned tail without restarting.
    let effectiveTokenBudget = this.config.maxTokens ?? DEFAULT_TOKEN_BUDGET;
    const maxCount = this.config.batchSize ?? DEFAULT_REMOTE_BATCH_SIZE;
    const maxInputTokens = this.config.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;
    const textBatches = buildTokenBoundedBatches(texts, effectiveTokenBudget, maxCount);
    const configuredTimeoutMs = resolveEmbeddingTimeoutMs(this.config);
    // How many of `textBatches` concurrentMap has already claimed (its own
    // `nextIndex`, mirrored here so a budget shrink knows where the
    // not-yet-dispatched tail begins). Assigned, not incremented, at the top
    // of `runProviderBatch` — batches are claimed in strictly increasing
    // order, so the highest `batchIndex` seen so far IS the claimed count.
    let dispatchedBatchCount = 0;
    // Set once the run's first context-size rejection has shrunk the budget
    // (#954) — guards `maybeShrinkBudget` so it never fires twice.
    let budgetShrunk = false;

    // On the FIRST context-size rejection of this `embedBatch` call, shrink
    // `effectiveTokenBudget` and re-plan every batch `concurrentMap` has not
    // yet claimed from the smaller budget. Never touches `rejectedIndices`
    // itself — the caller's own split-and-retry handles that batch — and is
    // a no-op after the first call (`budgetShrunk`).
    const maybeShrinkBudget = (
      rejectedIndices: number[],
      rejectedBatchIndex: number,
      rejectedRequestTokens: number,
    ): void => {
      if (budgetShrunk) return;
      budgetShrunk = true;
      const floor = ADAPTIVE_BUDGET_FLOOR_MULTIPLIER * maxInputTokens;
      effectiveTokenBudget = Math.max(Math.round(effectiveTokenBudget * ADAPTIVE_BUDGET_SHRINK_FACTOR), floor);

      const notYetDispatched = textBatches.slice(dispatchedBatchCount);
      const remainingIndices = notYetDispatched.flatMap((batch) => batch.indices);
      if (remainingIndices.length > 0) {
        const remainingTexts = remainingIndices.map((i) => texts[i] as string);
        const replanned = buildTokenBoundedBatches(remainingTexts, effectiveTokenBudget, maxCount).map((batch) => ({
          indices: batch.indices.map((localIndex) => remainingIndices[localIndex] as number),
          oversized: batch.oversized,
        }));
        textBatches.splice(dispatchedBatchCount, textBatches.length - dispatchedBatchCount, ...replanned);
      }

      warnVerbose(
        `[embed] provider rejected a ${rejectedRequestTokens}-token request as over its context; request budget lowered to ${effectiveTokenBudget.toLocaleString()} for the rest of this run`,
      );
      commitBatch(
        rejectedIndices,
        rejectedIndices.map(() => undefined),
        undefined,
        {
          batchIndex: rejectedBatchIndex,
          batchCount: textBatches.length,
          docCount: rejectedIndices.length,
          requestTokens: rejectedRequestTokens,
          elapsedMs: 0,
          outcome: "budget-lowered",
          reason: `provider rejected ${rejectedRequestTokens.toLocaleString()} tokens as over its context; request budget lowered to ${effectiveTokenBudget.toLocaleString()} for the rest of this run`,
        },
      );
    };

    // Stops the pool from claiming any FURTHER provider batch once the
    // caller's onBatch has failed once (the materializer's transaction
    // failed, so a subsequent commit would just fail again) — dispatching
    // real HTTP requests whose results can never be persisted is pure waste.
    // Deliberately a SEPARATE controller from the caller's own `signal`,
    // chained one-way to it: aborting this one must never cancel an
    // in-flight request's own network call (it is left to finish and its
    // result is discarded, not persisted), and a genuine caller abort must
    // still surface below as the caller's own abort reason, not this
    // internal one.
    const dispatchAbort = new AbortController();
    const stopDispatch = (reason?: unknown): void => {
      if (!dispatchAbort.signal.aborted) dispatchAbort.abort(reason);
    };
    let callerAbortListener: (() => void) | undefined;
    if (signal) {
      if (signal.aborted) stopDispatch(signal.reason);
      else {
        callerAbortListener = () => stopDispatch(signal.reason);
        signal.addEventListener("abort", callerAbortListener, { once: true });
      }
    }

    // First error thrown BY the caller's onBatch callback (e.g. a real
    // competing-process SQLITE_BUSY from the materializer's db.transaction())
    // rather than by requestBatch itself. Captured here instead of being left
    // to reach requestAndCommit's try/catch below, which exists solely to
    // classify requestBatch's own provider/network failures — a persistence
    // failure must never be caught by that block and misreported as a
    // fabricated "batch-request-failed" skip (#954). Checked (and rethrown)
    // once the pool drains, the same way `signal?.aborted` is today.
    let firstOnBatchError: unknown;
    const commitBatch = (
      indices: number[],
      embeddings: (EmbeddingVector | undefined)[],
      model?: string,
      outcome?: EmbeddingBatchOutcome,
    ): void => {
      if (!onBatch) return;
      // Once persistence has failed once, an already in-flight batch that
      // finishes afterward has nowhere safe to land — its result is
      // discarded rather than retried into a transaction that will fail
      // again (see the dispatch-stop comment above).
      if (firstOnBatchError !== undefined) return;
      try {
        onBatch(indices, embeddings, model, outcome);
      } catch (err) {
        firstOnBatchError = err;
        stopDispatch(err);
      }
    };

    // Requests a single provider batch (by index list), recursing on a
    // context-size rejection OR a repeated timeout (#954). Never
    // throws except to propagate a genuine caller abort — every other
    // outcome (success or a non-abort failure) resolves normally after
    // reporting via onSkip/onBatch. `onBatch` fires only once this
    // try/catch has already settled success vs. failure, so a throw from it
    // is never caught and reclassified by this block.
    //
    // `isTimeoutRetry` marks the SECOND attempt at this exact `indices`
    // (after the one same-size backoff-and-retry) — a second
    // timeout at that point splits or terminally skips rather than backing
    // off again.
    //
    // `timeoutAttempt` (#954, field-report follow-up) counts how many splits
    // down the timeout-retry chain this call is: 0 at the top level, then
    // +1 each time a second timeout at one size splits into two smaller
    // requests. It is the `attempt` fed to {@link embeddingTimeoutRetryBackoffMs}
    // so each successive size's first-timeout backoff is longer than the
    // last (5s, doubling, capped at 60s) instead of every split restarting
    // at the same ~5s delay — a server still draining a whole run of
    // abandoned requests needs more room the deeper the chain goes, not the
    // same fixed pause every time.
    const requestAndCommit = async (
      indices: number[],
      batchIndex: number,
      isTimeoutRetry = false,
      timeoutAttempt = 0,
    ): Promise<void> => {
      // A concurrent batch may have tripped the circuit breaker (or failed
      // onBatch) while this call was queued behind a split or a backoff —
      // never let a deeper recursive call make a request that can no longer
      // be reported, mirroring how the pool below never claims a
      // not-yet-started textBatch once dispatch has stopped.
      if (dispatchAbort.signal.aborted) return;

      const batch = indices.map((i) => texts[i] as string);
      const requestTokens = batch.reduce((sum, text) => sum + estimateTokenCount(text), 0);
      const requestTimeoutMs = scaleEmbeddingTimeoutMs(configuredTimeoutMs, requestTokens, effectiveTokenBudget);
      const requestStart = Date.now();
      let batchEmbeddings: (EmbeddingVector | undefined)[];
      let responseModel: string | undefined;
      let outcome: "stored" | "failed";
      let failureReason: string | undefined;
      try {
        const { vectors, model } = await this.requestBatch(batch, headers, ollamaOpts, requestTimeoutMs, signal);
        for (let k = 0; k < indices.length; k++) {
          results[indices[k] as number] = vectors[k];
        }
        batchEmbeddings = indices.map((i) => results[i]);
        responseModel = model;
        outcome = "stored";
      } catch (err) {
        // A caller abort must still propagate — it is not a "this batch
        // failed" condition, it means stop entirely.
        if (signal?.aborted) throw err;
        if (err instanceof ContextExceededError) {
          // #954: the run's FIRST context-size rejection (any size) shrinks
          // the budget for everything not yet dispatched; a no-op after the
          // first call. Deliberately BEFORE the split below — it must fire
          // for a single-document rejection too (which never reaches the
          // `indices.length > 1` split branch), and it never touches this
          // batch's own split-and-retry.
          maybeShrinkBudget(indices, batchIndex, requestTokens);
        }
        if (err instanceof ContextExceededError && indices.length > 1) {
          const mid = Math.ceil(indices.length / 2);
          await requestAndCommit(indices.slice(0, mid), batchIndex, false, timeoutAttempt);
          await requestAndCommit(indices.slice(mid), batchIndex, false, timeoutAttempt);
          return;
        }
        const timedOut = isEmbeddingTimeoutError(err);
        if (timedOut && !isTimeoutRetry) {
          // First timeout at this size: back off so the provider can drain
          // the abandoned request, then retry the SAME request once before
          // ever splitting or skipping (#954). The backoff grows with
          // `timeoutAttempt`, not a flat ~5s every time, so a chain of
          // splits down to smaller and smaller requests gives the provider
          // proportionally more room to drain each time.
          const backoffMs = embeddingTimeoutRetryBackoffMs(timeoutAttempt);
          warnVerbose(
            `[embed] batch of ${batch.length} document(s) timed out after ${requestTimeoutMs}ms; retrying once after a ${Math.round(backoffMs)}ms backoff`,
          );
          // Default-level notice (#954 field-report follow-up), not just the
          // verbose line above — a run silently waiting out a multi-minute
          // back-off looked identical to a hang otherwise. Nothing has
          // failed or succeeded yet, so there is nothing to persist:
          // `embeddings` are all `undefined` and the materializer's onBatch
          // must not touch storage for this event.
          commitBatch(
            indices,
            indices.map(() => undefined),
            undefined,
            {
              batchIndex,
              batchCount: textBatches.length,
              docCount: indices.length,
              requestTokens,
              elapsedMs: backoffMs,
              outcome: "retrying",
              reason: "timed out",
            },
          );
          await abortableDelay(backoffMs, signal, "embedding interrupted during retry backoff");
          if (!dispatchAbort.signal.aborted) {
            return requestAndCommit(indices, batchIndex, true, timeoutAttempt);
          }
          // Dispatch was stopped (by another batch's circuit-breaker trip)
          // while this one was backing off — fall through and skip below
          // instead of issuing a request that can no longer be reported.
        } else if (timedOut && indices.length > 1) {
          // Timed out again on the retry: split rather than skip outright —
          // the provider may still fit it once it is smaller (#954),
          // the same treatment a context-size rejection gets.
          // Each half's OWN first-timeout backoff (#954 follow-up) starts
          // one attempt further down the chain than this size's did.
          const mid = Math.ceil(indices.length / 2);
          await requestAndCommit(indices.slice(0, mid), batchIndex, false, timeoutAttempt + 1);
          await requestAndCommit(indices.slice(mid), batchIndex, false, timeoutAttempt + 1);
          return;
        }

        const message = err instanceof Error ? err.message : String(err);
        const reason: EmbeddingSkipReason =
          err instanceof ContextExceededError ? "context-window-exceeded" : "batch-request-failed";
        const failureKind: EmbeddingFailureKind | undefined =
          reason === "batch-request-failed" ? (timedOut ? "timeout" : "network-error") : undefined;
        // Default-level visibility for a failed batch (not verbose-only) is
        // still guaranteed here — just not via warn(). The `commitBatch` call
        // below carries `outcome: "failed"` and this `message` as `reason`
        // through `onBatch`, and materialize-embeddings.ts's per-batch line
        // (also default-level) prints it from there. A warn() call here used
        // to print the identical event a second time on stderr — the same
        // class of double-print bug fixed for the truncation/re-embed-reason
        // lines in materialize-embeddings.ts (#954, field-report follow-up).
        // Per-entry batch-mapping detail stays verbose-only
        // (materialize-embeddings.ts).
        let stopRequested = false;
        for (const [k, idx] of indices.entries()) {
          if (
            onSkip?.({
              index: idx,
              reason,
              message,
              batchStart: k === 0,
              batchSize: indices.length,
              failureKind,
            }) === false
          )
            stopRequested = true;
        }
        // #954: the caller's circuit breaker asked to stop —
        // gate further dispatch through the SAME dispatchAbort controller
        // the onBatch-throw path above uses, but resolve this call normally
        // (never reject) with whatever results already landed, since this is
        // a policy decision, not a persistence failure.
        if (stopRequested) stopDispatch();
        batchEmbeddings = indices.map(() => undefined);
        outcome = "failed";
        failureReason = message;
      }
      commitBatch(indices, batchEmbeddings, responseModel, {
        batchIndex,
        batchCount: textBatches.length,
        docCount: indices.length,
        requestTokens,
        elapsedMs: Date.now() - requestStart,
        outcome,
        reason: failureReason,
      });
    };

    const runProviderBatch = async (textBatch: TextBatch, batchIndex: number): Promise<void> => {
      // Claimed in strictly increasing order by `concurrentMap` below, so
      // the highest `batchIndex` seen so far is exactly how many batches it
      // has claimed (#954) — see `maybeShrinkBudget`'s doc comment above.
      // Assigned synchronously at entry, before any `await`, so this always
      // matches `concurrentMap`'s own `nextIndex` at the moment of claim.
      dispatchedBatchCount = batchIndex;
      if (textBatch.oversized) {
        const idx = textBatch.indices[0] as number;
        const estTokens = estimateTokenCount(texts[idx] as string);
        onSkip?.({
          index: idx,
          reason: "context-window-exceeded",
          message: `Document estimated at ${estTokens} tokens exceeds the ${effectiveTokenBudget}-token embedding budget; skipped.`,
          batchStart: true,
          batchSize: 1,
        });
        // Never made a request — excluded from the default-level per-batch
        // line (there is no request outcome to report), but still counted
        // in the run's oversized-skip total via `onSkip` above.
        commitBatch([idx], [undefined], undefined, {
          batchIndex,
          batchCount: textBatches.length,
          docCount: 1,
          requestTokens: estTokens,
          elapsedMs: 0,
          outcome: "failed",
          reason: "oversized",
        });
        return;
      }
      await requestAndCommit(textBatch.indices, batchIndex);
    };

    const concurrency = resolveEmbeddingConcurrency(this.config);
    // concurrentMap swallows a thrown fn (per-item, results discarded here —
    // requestAndCommit only throws to signal a caller abort), so abort must
    // be re-checked once the pool has drained rather than relying on the
    // throw itself to escape. Dispatch is gated on `dispatchAbort`, not the
    // caller's `signal` directly — see the comment above. `batchIndex` is
    // 1-based (matches the human-readable "batch N/Total" line) and comes
    // from `concurrentMap`'s own 0-based item index, not a separately
    // tracked counter, so it stays correct under concurrency.
    await concurrentMap(textBatches, (textBatch, i) => runProviderBatch(textBatch, i + 1), concurrency, {
      signal: dispatchAbort.signal,
    });
    if (callerAbortListener) signal?.removeEventListener("abort", callerAbortListener);
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("embedding interrupted");
    }
    if (firstOnBatchError !== undefined) {
      throw firstOnBatchError instanceof Error ? firstOnBatchError : new Error(String(firstOnBatchError));
    }

    return results;
  }

  /**
   * Send one batch request and return its embeddings in input order, plus the
   * server-reported `model` id when the response body carried one (#955) —
   * used by the embedding-fingerprint canary to verify a config-string
   * rename against what the endpoint actually served, not just re-assert the
   * configured string. Throws on any failure.
   *
   * `timeoutMs` is the caller's ALREADY-SCALED per-request timeout (#954
   * — see {@link scaleEmbeddingTimeoutMs}), not re-resolved here:
   * `embedBatch` computes it per request from that request's own size so a
   * split-down retry gets a smaller, size-appropriate timeout rather than
   * always the full configured `embedding.timeoutMs`.
   */
  private async requestBatch(
    batch: string[],
    headers: Record<string, string>,
    ollamaOpts: { num_ctx?: number } | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ vectors: EmbeddingVector[]; model?: string }> {
    const body: { input: string[]; model: string; dimensions?: number; options?: { num_ctx?: number } } = {
      input: batch,
      model: this.model,
    };
    if (this.config.dimension) {
      body.dimensions = this.config.dimension;
    }
    if (ollamaOpts) {
      body.options = ollamaOpts;
    }

    // See embed(): `signal` goes through the 4th parameter, not the
    // RequestInit, or fetchWithTimeout drops it.
    const response = await fetchWithTimeout(
      normalizeEmbeddingEndpoint(this.endpoint),
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      },
      timeoutMs,
      signal,
    );

    if (!response.ok) {
      const respBody = await readBodyWithByteCap(response, undefined, { bodyTimeoutMs: timeoutMs, signal }).catch(
        (err) => {
          if (signal?.aborted) throw err;
          return "";
        },
      );
      const message = `Embedding batch request failed (${response.status}): ${this.safeErrorBody(respBody)}`;
      if (isContextExceededResponse(response.status, respBody)) {
        throw new ContextExceededError(message);
      }
      throw new Error(message);
    }

    const json = JSON.parse(await readBodyWithByteCap(response, undefined, { bodyTimeoutMs: timeoutMs, signal })) as {
      data: Array<{ embedding: number[]; index: number }>;
      model?: string;
    };

    if (!json.data || json.data.length !== batch.length) {
      throw new Error(
        `Unexpected embedding batch response: expected ${batch.length} embeddings, got ${json.data?.length ?? 0}.${embeddingEndpointPathHint(this.endpoint)}`,
      );
    }

    // Sort by index to guarantee correct order (OpenAI API doesn't guarantee order)
    const sorted = [...json.data].sort((a, b) => a.index - b.index);

    const results: EmbeddingVector[] = [];
    for (const [idx, d] of sorted.entries()) {
      if (!Array.isArray(d.embedding)) {
        throw new Error(`Unexpected embedding at batch index ${idx}: missing or invalid`);
      }
      results.push(l2Normalize(d.embedding));
    }
    return { vectors: results, model: typeof json.model === "string" && json.model ? json.model : undefined };
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const resolvedKey = resolveSecret(this.config.apiKey, resolveSecretFromStore);
    if (resolvedKey) {
      headers.Authorization = `Bearer ${resolvedKey}`;
    }
    return headers;
  }

  /**
   * Make a provider error body safe to embed in a thrown Error, matching the
   * hardening llm/client.ts applies on the identical path: pattern-redact
   * credential shapes, exact-scrub this connection's own key, and clip.
   *
   * These messages surface via generateEmbeddingsForDb's `EmbeddingGenerationResult.message`
   * and are printed on every vector-search attempt. Raw bodies reached that
   * far unredacted and uncapped, at readBodyWithByteCap's 10 MB default.
   */
  private safeErrorBody(body: string): string {
    const resolvedKey = resolveSecret(this.config.apiKey, resolveSecretFromStore);
    return redactSensitiveText(redactErrorBody(body), resolvedKey ? [resolvedKey] : []);
  }
}

/**
 * L2-normalize a vector to unit length.
 * Required for remote embeddings because the scoring pipeline's L2-to-cosine
 * conversion formula (1 - distance^2/2) is only correct for unit vectors.
 * The local embedder already normalizes via `normalize: true`.
 */
function l2Normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

export function normalizeEmbeddingEndpoint(endpoint: string): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return endpoint;
  }

  const normalizedPath = parsed.pathname.replace(/\/+$/, "");
  if (normalizedPath.endsWith("/embeddings")) {
    return parsed.toString();
  }
  // Ollama's NATIVE embedding route is `/api/embed` (and the older
  // `/api/embeddings`). Appending "/embeddings" to it produced
  // `/api/embed/embeddings`, a 404 — so pointing akm at the native endpoint,
  // which is what its own options like ollamaOptions and contextLength are
  // for, could never work. An explicit path that is already an embedding route
  // is left alone.
  if (normalizedPath.endsWith("/embed")) {
    return parsed.toString();
  }

  parsed.pathname = normalizedPath ? `${normalizedPath}/embeddings` : "/embeddings";
  return parsed.toString();
}

function embeddingEndpointPathHint(endpoint: string): string {
  const normalizedEndpoint = normalizeEmbeddingEndpoint(endpoint);
  if (normalizedEndpoint !== endpoint) {
    return ` Check that your endpoint includes the full embeddings path (for example "${normalizedEndpoint}", not just "${endpoint}").`;
  }
  return "";
}

/**
 * Resolve Ollama-native `options` from the embedding config.
 *
 * Resolution order:
 *   1. `ollamaOptions` — forwarded verbatim (explicit opt-in, takes precedence).
 *   2. `contextLength` — wrapped as `{ num_ctx: contextLength }`.
 *   3. Neither set → returns `undefined` (no `options` field in the request body).
 *
 * These options are only meaningful for Ollama's native `/api/embed` endpoint.
 * OpenAI-compatible endpoints ignore unknown request fields, so passing them to
 * other providers is harmless but has no effect.
 */
function resolveOllamaOptions(config: EmbeddingConnectionConfig): { num_ctx?: number } | undefined {
  if (config.ollamaOptions && Object.keys(config.ollamaOptions).length > 0) {
    return config.ollamaOptions;
  }
  if (config.contextLength) {
    return { num_ctx: config.contextLength };
  }
  return undefined;
}

/** Check whether an EmbeddingConnectionConfig has a valid remote endpoint. */
export function hasRemoteEndpoint(config: EmbeddingConnectionConfig): boolean {
  return isHttpUrl(config.endpoint);
}

/**
 * Describe WHERE an `embedding.apiKey` came from, never its value — the
 * actionable outcome of the #953 field gap: `resolveSecret` throws on an
 * unresolvable `secret://` reference, so a keyless request can only mean
 * `embedding.apiKey` was absent from the config the run actually loaded (a
 * different config root, scope, or a config edited after the run started).
 * A default-level progress line naming the credential's SOURCE (this
 * helper), printed once before the first provider request, lets a field run
 * self-diagnose that without ever surfacing the secret itself.
 */
export function describeEmbeddingCredential(apiKey: string | undefined): string {
  if (!apiKey) return "none configured";
  if (SECRET_STORE_REFERENCE_PATTERN.test(apiKey)) return `${apiKey} (store)`;
  if (ENV_REFERENCE_PATTERN.test(apiKey)) return `${apiKey} (env)`;
  return "literal apiKey";
}
