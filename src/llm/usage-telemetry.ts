// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Per-call LLM usage telemetry (#576).
 *
 * `chatCompletion` captures usage + model + finish_reason + wall-time for
 * EVERY OpenAI-compatible call and emits one {@link LlmUsageRecord} through a
 * module-level sink. The sink indirection keeps `client.ts` free of any
 * dependency on the events/db layer: the application wires the sink to
 * persistence at startup / per improve run, and tests can inspect records in
 * memory.
 *
 * The pipeline *stage* that made the call is ambient, not threaded through
 * call sites. A param-threading prototype was deliberately discarded in 0.8.5
 * (every call site would have to forward a `stage` argument it does not care
 * about). Instead callers wrap a well-delimited phase once with
 * {@link withLlmStage}; any `chatCompletion` invoked inside that async region —
 * however deeply nested — is attributed to that stage via `AsyncLocalStorage`.
 *
 * EVERYTHING here is best-effort. Telemetry must NEVER break a real LLM call:
 * a sink that throws, an unset stage, or a malformed usage block all degrade
 * silently. `emitLlmUsage` swallows sink errors; `currentLlmStage` returns
 * `undefined` outside any `withLlmStage` scope.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * One record per `chatCompletion` call. Token fields are omitted (not zeroed)
 * when the provider response carried no usable usage block — a best-effort
 * record still captures `durationMs`, `model`, and `finishReason` so the call
 * is never invisible.
 */
export interface LlmUsageRecord {
  /** Ambient pipeline stage, e.g. `"memory-inference"`. `undefined` outside any stage scope. */
  stage?: string;
  /** Model id echoed by the provider response, falling back to the request's configured model. */
  model?: string;
  /** Wall-clock duration of the HTTP request/response cycle, in milliseconds. */
  durationMs: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Reasoning/thinking tokens from `completion_tokens_details.reasoning_tokens`, when present. */
  reasoningTokens?: number;
  /** OpenAI `finish_reason` (`stop`, `length`, `content_filter`, …), when present. */
  finishReason?: string;
}

/** Receives one {@link LlmUsageRecord} per LLM call. Must not throw to callers (errors are swallowed). */
export type LlmUsageSink = (record: LlmUsageRecord) => void;

const stageStorage = new AsyncLocalStorage<string>();

let usageSink: LlmUsageSink | undefined;

/**
 * Run `fn` with `stage` as the ambient LLM stage. Any `chatCompletion` call
 * made synchronously or asynchronously within `fn` (including through awaited
 * helpers and nested `withLlmStage` calls — the innermost wins) is attributed
 * to `stage`. Returns whatever `fn` returns; never alters control flow.
 */
export function withLlmStage<T>(stage: string, fn: () => T): T {
  return stageStorage.run(stage, fn);
}

/** The ambient LLM stage for the current async context, or `undefined` outside any {@link withLlmStage} scope. */
export function currentLlmStage(): string | undefined {
  return stageStorage.getStore();
}

/**
 * Install the process-wide usage sink. Replaces any previously installed sink.
 * The application wires this to persistence; tests install an in-memory
 * collector. Pair with {@link clearLlmUsageSink} in a `finally` block.
 */
export function setLlmUsageSink(sink: LlmUsageSink): void {
  usageSink = sink;
}

/** Remove the installed sink so subsequent calls emit nowhere. Idempotent. */
export function clearLlmUsageSink(): void {
  usageSink = undefined;
}

/**
 * Whether a usage sink is currently installed. Standalone entry points use
 * this to avoid clobbering a sink an enclosing run (e.g. `akm improve`) already
 * installed: they install their own only when none is active.
 */
export function hasLlmUsageSink(): boolean {
  return usageSink !== undefined;
}

/**
 * Emit one usage record to the installed sink, stamping the ambient stage.
 * Best-effort: no sink is a no-op, and a sink that throws is swallowed so
 * telemetry can never fail the LLM call that produced it.
 */
export function emitLlmUsage(record: LlmUsageRecord): void {
  const sink = usageSink;
  if (!sink) return;
  try {
    sink({ ...record, stage: record.stage ?? currentLlmStage() });
  } catch {
    // Telemetry must never break a real run.
  }
}

/** Raw OpenAI-compatible `usage` block shape (all fields optional / best-effort). */
export interface RawUsage {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  total_tokens?: unknown;
  completion_tokens_details?: { reasoning_tokens?: unknown } | null;
}

function asFiniteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Project a provider `usage` block into the token fields of an
 * {@link LlmUsageRecord}. Missing or garbled values are omitted (not zeroed)
 * so a best-effort record still distinguishes "0 tokens" from "unknown".
 */
export function extractUsageTokens(
  usage: RawUsage | null | undefined,
): Pick<LlmUsageRecord, "promptTokens" | "completionTokens" | "totalTokens" | "reasoningTokens"> {
  if (!usage || typeof usage !== "object") return {};
  const out: Pick<LlmUsageRecord, "promptTokens" | "completionTokens" | "totalTokens" | "reasoningTokens"> = {};
  const prompt = asFiniteNonNegative(usage.prompt_tokens);
  const completion = asFiniteNonNegative(usage.completion_tokens);
  const total = asFiniteNonNegative(usage.total_tokens);
  const reasoning = asFiniteNonNegative(usage.completion_tokens_details?.reasoning_tokens);
  if (prompt !== undefined) out.promptTokens = prompt;
  if (completion !== undefined) out.completionTokens = completion;
  if (total !== undefined) out.totalTokens = total;
  if (reasoning !== undefined) out.reasoningTokens = reasoning;
  return out;
}
