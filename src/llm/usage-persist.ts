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
import {
  clearLlmUsageSink,
  getLlmUsageSink,
  hasLlmUsageSink,
  type LlmUsageRecord,
  setLlmUsageSink,
} from "./usage-telemetry";

type EventsContextSource = EventsContext | (() => EventsContext);

/** Event type for persisted per-call LLM usage telemetry. */
export const LLM_USAGE_EVENT = "llm_usage";
/** Event type for the owning sink's terminal-record count marker. */
export const LLM_USAGE_SUMMARY_EVENT = "llm_usage_summary";

/**
 * Project a usage record into event metadata, dropping `undefined` token
 * fields so an absent-usage call records only `{stage, model, durationMs}`.
 */
function toEventMetadata(record: LlmUsageRecord): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    durationMs: record.durationMs,
    outcome: record.outcome,
    modelSource: record.modelSource,
  };
  if (record.stage !== undefined) metadata.stage = record.stage;
  if (record.engine !== undefined) metadata.engine = record.engine;
  if (record.process !== undefined) metadata.process = record.process;
  if (record.model !== undefined) metadata.model = record.model;
  if (record.finishReason !== undefined) metadata.finishReason = record.finishReason;
  if (record.promptTokens !== undefined) metadata.promptTokens = record.promptTokens;
  if (record.completionTokens !== undefined) metadata.completionTokens = record.completionTokens;
  if (record.totalTokens !== undefined) metadata.totalTokens = record.totalTokens;
  if (record.reasoningTokens !== undefined) metadata.reasoningTokens = record.reasoningTokens;
  if (record.errorCode !== undefined) metadata.errorCode = record.errorCode;
  return metadata;
}

/**
 * Install a usage sink that persists each LLM call as an `llm_usage` event via
 * `appendEvent`. Returns a disposer that restores the sink that was installed
 * before this one (clearing it when there was none) — call it in a `finally`
 * block so per-run wiring does not leak across runs (and so the test-isolation
 * harness sees a clean sink between tests). Restoring rather than clearing lets
 * a per-run sink (`akm improve`) sit on top of the process-wide one `runCli`
 * installs, which then resumes when the run ends.
 *
 * `ctx` should carry the same long-lived `state.db` handle the caller already
 * opened for its other events. A getter is resolved for every append so a
 * caller can replace its context binding without replacing this owning sink.
 * When omitted, `appendEvent` falls back to its default open-insert-close path.
 *
 * `onRecord`, when supplied, runs synchronously for every terminal record
 * BEFORE persistence — improve's first-engine-response heartbeat (#957) uses
 * it to know the run is no longer silent, without this module taking on any
 * dependency of its own on improve's lifecycle.
 */
export function installLlmUsagePersistence(
  ctx?: EventsContextSource,
  onRecord?: (record: LlmUsageRecord) => void,
  options: { skipEmptySummary?: boolean } = {},
): () => void {
  let expectedTerminalRecords = 0;
  let disposed = false;
  const previous = getLlmUsageSink();
  setLlmUsageSink((record) => {
    expectedTerminalRecords += 1;
    onRecord?.(record);
    appendEvent(
      { eventType: LLM_USAGE_EVENT, metadata: toEventMetadata(record) },
      typeof ctx === "function" ? ctx() : ctx,
    );
  });
  return () => {
    if (disposed) return;
    disposed = true;
    if (previous) setLlmUsageSink(previous);
    else clearLlmUsageSink();
    if (options.skipEmptySummary && expectedTerminalRecords === 0) return;
    try {
      appendEvent(
        { eventType: LLM_USAGE_SUMMARY_EVENT, metadata: { expectedTerminalRecords } },
        typeof ctx === "function" ? ctx() : ctx,
      );
    } catch {
      // Persistence remains best-effort even during run teardown.
    }
  };
}

/**
 * Like {@link installLlmUsagePersistence}, but a no-op when a sink is already
 * installed — used by `runCli` for the process-wide sink and by standalone
 * entry points (`akm proposal drain`) that may also run as a sub-step of
 * `akm improve`. When invoked inside an enclosing run the existing sink keeps
 * ownership; the returned disposer then does nothing. A sink installed here
 * writes no summary marker when it saw no call, so commands that never reach an
 * LLM leave no event behind.
 */
export function installLlmUsagePersistenceIfAbsent(ctx?: EventsContextSource): () => void {
  if (hasLlmUsageSink()) return () => {};
  return installLlmUsagePersistence(ctx, undefined, { skipEmptySummary: true });
}
