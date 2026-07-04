// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Aggregate `llm_usage` events (#576) into the window total + per-stage
 * breakdown reported by `akm health`.
 */

import { readEvents } from "../../core/events";
import { LLM_USAGE_EVENT } from "../../llm/usage-persist";
import { toFiniteNumber } from "./improve-metrics";
import type { LlmUsageAggregate, LlmUsageStageAggregate } from "./types";

/** Stage key used for `llm_usage` events recorded outside any stage scope. */
const UNATTRIBUTED_STAGE = "unattributed";

function emptyLlmUsageStageAggregate(): LlmUsageStageAggregate {
  return {
    calls: 0,
    totalDurationMs: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
  };
}

function emptyLlmUsageAggregate(): LlmUsageAggregate {
  return { ...emptyLlmUsageStageAggregate(), byStage: {} };
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
    const meta = event.metadata ?? {};
    const stageKey = typeof meta.stage === "string" && meta.stage ? meta.stage : UNATTRIBUTED_STAGE;
    let stage = aggregate.byStage[stageKey];
    if (!stage) {
      stage = emptyLlmUsageStageAggregate();
      aggregate.byStage[stageKey] = stage;
    }

    const durationMs = toFiniteNumber(meta.durationMs);
    const promptTokens = toFiniteNumber(meta.promptTokens);
    const completionTokens = toFiniteNumber(meta.completionTokens);
    const totalTokens = toFiniteNumber(meta.totalTokens);
    const reasoningTokens = toFiniteNumber(meta.reasoningTokens);

    for (const target of [aggregate, stage]) {
      target.calls += 1;
      target.totalDurationMs += durationMs;
      target.promptTokens += promptTokens;
      target.completionTokens += completionTokens;
      target.totalTokens += totalTokens;
      target.reasoningTokens += reasoningTokens;
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
