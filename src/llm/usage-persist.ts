// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Bridge per-call LLM usage telemetry (#576) to the events stream.
 *
 * `usage-telemetry.ts` stays dependency-free of the events/db layer so the
 * low-level `client.ts` never imports persistence. This module is the wiring:
 * it installs a {@link LlmUsageSink} that persists each {@link LlmUsageRecord}
 * as one `llm_usage` event.
 *
 * Why reuse the events table (vs a dedicated table): volume is low (~100
 * calls/day), the records are append-only and time-windowed exactly like every
 * other event, and `akm health` already aggregates per-window event reads — a
 * separate table would duplicate retention (`purgeOldEvents`), reads, and
 * migration surface for no benefit. See the commit message for #576.
 *
 * Every record is written through `appendEvent`, which is itself best-effort
 * (a write failure logs once and never throws). Combined with the sink-error
 * swallowing in `emitLlmUsage`, telemetry can never break a real run.
 */

import { appendEvent, type EventsContext } from "../core/events";
import { clearLlmUsageSink, hasLlmUsageSink, type LlmUsageRecord, setLlmUsageSink } from "./usage-telemetry";

/** Event type for persisted per-call LLM usage telemetry. */
export const LLM_USAGE_EVENT = "llm_usage";

/**
 * Project a usage record into event metadata, dropping `undefined` token
 * fields so an absent-usage call records only `{stage, model, durationMs}`.
 */
function toEventMetadata(record: LlmUsageRecord): Record<string, unknown> {
  const metadata: Record<string, unknown> = { durationMs: record.durationMs };
  if (record.stage !== undefined) metadata.stage = record.stage;
  if (record.engine !== undefined) metadata.engine = record.engine;
  if (record.process !== undefined) metadata.process = record.process;
  if (record.model !== undefined) metadata.model = record.model;
  if (record.finishReason !== undefined) metadata.finishReason = record.finishReason;
  if (record.promptTokens !== undefined) metadata.promptTokens = record.promptTokens;
  if (record.completionTokens !== undefined) metadata.completionTokens = record.completionTokens;
  if (record.totalTokens !== undefined) metadata.totalTokens = record.totalTokens;
  if (record.reasoningTokens !== undefined) metadata.reasoningTokens = record.reasoningTokens;
  return metadata;
}

/**
 * Install a usage sink that persists each LLM call as an `llm_usage` event via
 * `appendEvent`. Returns a disposer that clears the sink — call it in a
 * `finally` block so per-run wiring does not leak across runs (and so the
 * test-isolation harness sees a clean sink between tests).
 *
 * `ctx` should carry the same long-lived `state.db` handle the caller already
 * opened for its other events; when omitted, `appendEvent` falls back to its
 * default open-insert-close path.
 */
export function installLlmUsagePersistence(ctx?: EventsContext): () => void {
  setLlmUsageSink((record) => {
    appendEvent({ eventType: LLM_USAGE_EVENT, metadata: toEventMetadata(record) }, ctx);
  });
  return () => {
    clearLlmUsageSink();
  };
}

/**
 * Like {@link installLlmUsagePersistence}, but a no-op when a sink is already
 * installed — used by standalone entry points (`akm consolidate`, `akm drain`)
 * that may also run as a sub-step of `akm improve`. When invoked inside an
 * enclosing run the existing per-run sink keeps ownership; the returned
 * disposer then does nothing, so the enclosing run's `finally` still clears it.
 */
export function installLlmUsagePersistenceIfAbsent(ctx?: EventsContext): () => void {
  if (hasLlmUsageSink()) return () => {};
  return installLlmUsagePersistence(ctx);
}
