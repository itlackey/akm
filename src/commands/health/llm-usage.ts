// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Aggregate `llm_usage` events (#576) into the window total + per-stage
 * breakdown reported by `akm health`.
 */

import { readEvents } from "../../core/events";
import { LLM_USAGE_EVENT } from "../../llm/usage-persist";
import { decodeLlmUsageRecord } from "../../llm/usage-telemetry";
import type { LlmUsageAggregate, LlmUsageCrossTabRow, LlmUsageStageAggregate } from "./types";

/** Stage/process/engine/model key used for `llm_usage` events recorded with no value for that dimension. */
const UNATTRIBUTED_STAGE = "unattributed";

function emptyLlmUsageStageAggregate(): LlmUsageStageAggregate {
  return {
    calls: 0,
    totalDurationMs: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
    failures: 0,
  };
}

/** A zeroed aggregate — also the value health reports when it could not read state.db at all (#791). */
export function emptyLlmUsageAggregate(): LlmUsageAggregate {
  return { ...emptyLlmUsageStageAggregate(), byStage: {}, byProcess: {}, byEngine: {} };
}

/**
 * Aggregate `llm_usage` events (#576) into a window total plus a per-stage
 * breakdown of call count, wall-time, and token usage. Token fields absent from
 * a best-effort record contribute 0. Calls with no `stage` land under
 * {@link UNATTRIBUTED_STAGE}.
 */
export function summarizeLlmUsage(events: ReturnType<typeof readEvents>["events"]): LlmUsageAggregate {
  const aggregate = emptyLlmUsageAggregate();
  for (const event of events) {
    const record = decodeLlmUsageRecord(event.metadata);
    if (!record) continue;
    const dimensions: LlmUsageStageAggregate[] = [];
    for (const [groups, key] of [
      [aggregate.byStage, record.stage ?? UNATTRIBUTED_STAGE],
      [aggregate.byProcess, record.process ?? UNATTRIBUTED_STAGE],
      [aggregate.byEngine, record.engine ?? UNATTRIBUTED_STAGE],
    ] as const) {
      groups[key] ??= emptyLlmUsageStageAggregate();
      dimensions.push(groups[key]);
    }
    for (const target of [aggregate, ...dimensions]) {
      target.calls += 1;
      target.totalDurationMs += record.durationMs;
      target.promptTokens += record.promptTokens ?? 0;
      target.completionTokens += record.completionTokens ?? 0;
      target.totalTokens += record.totalTokens ?? 0;
      target.reasoningTokens += record.reasoningTokens ?? 0;
      if (record.outcome === "error") target.failures += 1;
    }
  }
  return aggregate;
}

export function readLlmUsageAggregate(stateDbPath: string, since: string, until?: string): LlmUsageAggregate {
  const events = readEvents({ since, type: LLM_USAGE_EVENT }, { dbPath: stateDbPath }).events.filter((event) => {
    if (until === undefined) return true;
    return new Date(event.ts ?? since).getTime() < new Date(until).getTime();
  });
  return summarizeLlmUsage(events);
}

/**
 * Aggregate `llm_usage` events (#576) into a process x engine x model
 * cross-tab (#944) — one row per distinct `(process, engine, model)` triple
 * seen, each carrying the same call/failure/token/duration totals as
 * {@link LlmUsageStageAggregate}. A call missing any one of the three
 * dimensions is keyed under {@link UNATTRIBUTED_STAGE} for that dimension
 * (never dropped). Does not fold into, or change the shape of,
 * {@link summarizeLlmUsage}'s existing `byStage`/`byProcess`/`byEngine`
 * breakdowns — `akm health`'s existing consumers of those stay untouched.
 * Row order is insertion order (first `(process, engine, model)` triple seen).
 */
export function summarizeLlmUsageCrossTab(events: ReturnType<typeof readEvents>["events"]): LlmUsageCrossTabRow[] {
  const rows = new Map<string, LlmUsageCrossTabRow>();
  for (const event of events) {
    const record = decodeLlmUsageRecord(event.metadata);
    if (!record) continue;
    const process = record.process ?? UNATTRIBUTED_STAGE;
    const engine = record.engine ?? UNATTRIBUTED_STAGE;
    const model = record.model ?? UNATTRIBUTED_STAGE;
    const key = `${process}:${engine}:${model}`;
    let row = rows.get(key);
    if (!row) {
      row = { process, engine, model, ...emptyLlmUsageStageAggregate() };
      rows.set(key, row);
    }
    row.calls += 1;
    row.totalDurationMs += record.durationMs;
    row.promptTokens += record.promptTokens ?? 0;
    row.completionTokens += record.completionTokens ?? 0;
    row.totalTokens += record.totalTokens ?? 0;
    row.reasoningTokens += record.reasoningTokens ?? 0;
    if (record.outcome === "error") row.failures += 1;
  }
  return [...rows.values()];
}
