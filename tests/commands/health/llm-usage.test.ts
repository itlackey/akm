// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure, in-memory tests for the `llm_usage` aggregators (#944): the
 * `failures` counter added to `summarizeLlmUsage`'s existing shape, and the
 * new `summarizeLlmUsageCrossTab` process x engine x model breakdown. No
 * database — `EventEnvelope[]` fixtures constructed directly, per the
 * ORG-03..06 classification rule (pure logic, mocked I/O -> `tests/`, not
 * `tests/integration/`).
 */

import { describe, expect, test } from "bun:test";
import {
  emptyLlmUsageAggregate,
  summarizeLlmUsage,
  summarizeLlmUsageCrossTab,
} from "../../../src/commands/health/llm-usage";
import type { EventEnvelope } from "../../../src/core/events-types";
import type { LlmUsageRecord } from "../../../src/llm/usage-telemetry";

let nextId = 1;

function usageEvent(
  record: Partial<LlmUsageRecord> & Pick<LlmUsageRecord, "durationMs">,
  ts = "2026-08-01T00:00:00.000Z",
): EventEnvelope {
  return {
    schemaVersion: 1,
    id: nextId++,
    ts,
    eventType: "llm_usage",
    metadata: { outcome: "success", modelSource: "configured", ...record } as Record<string, unknown>,
  };
}

describe("summarizeLlmUsage failures counter (#944)", () => {
  test("a do-nothing aggregator would fail this: failures only increments on outcome=error, on every dimension", () => {
    const events = [
      usageEvent({ durationMs: 10, process: "reflect", engine: "fast", stage: "reflect", outcome: "success" }),
      usageEvent({ durationMs: 5, process: "reflect", engine: "fast", stage: "reflect", outcome: "error" }),
      usageEvent({ durationMs: 7, process: "distill", engine: "fast", stage: "distill", outcome: "error" }),
    ];
    const aggregate = summarizeLlmUsage(events);
    expect(aggregate.calls).toBe(3);
    expect(aggregate.failures).toBe(2);
    expect(aggregate.byProcess.reflect?.calls).toBe(2);
    expect(aggregate.byProcess.reflect?.failures).toBe(1);
    expect(aggregate.byProcess.distill?.failures).toBe(1);
    expect(aggregate.byEngine.fast?.failures).toBe(2);
  });

  test("emptyLlmUsageAggregate starts every counter, including failures, at zero", () => {
    expect(emptyLlmUsageAggregate()).toMatchObject({ calls: 0, failures: 0 });
  });

  test("byStage/byProcess/byEngine shapes are unchanged by the additive failures field", () => {
    const events = [usageEvent({ durationMs: 1, stage: "reflect", process: "reflect", engine: "fast" })];
    const aggregate = summarizeLlmUsage(events);
    expect(Object.keys(aggregate.byStage)).toEqual(["reflect"]);
    expect(Object.keys(aggregate.byProcess)).toEqual(["reflect"]);
    expect(Object.keys(aggregate.byEngine)).toEqual(["fast"]);
  });
});

describe("summarizeLlmUsageCrossTab (#944)", () => {
  test("groups by the (process, engine, model) triple, summing calls/failures/tokens/duration", () => {
    const events = [
      usageEvent({
        durationMs: 100,
        process: "reflect",
        engine: "fast",
        model: "m1",
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        reasoningTokens: 1,
      }),
      usageEvent({
        durationMs: 50,
        process: "reflect",
        engine: "fast",
        model: "m1",
        outcome: "error",
        promptTokens: 2,
      }),
      usageEvent({ durationMs: 30, process: "distill", engine: "slow", model: "m2" }),
    ];
    const rows = summarizeLlmUsageCrossTab(events);
    expect(rows).toHaveLength(2);
    const reflectRow = rows.find((r) => r.process === "reflect");
    expect(reflectRow).toMatchObject({
      process: "reflect",
      engine: "fast",
      model: "m1",
      calls: 2,
      failures: 1,
      promptTokens: 12,
      completionTokens: 5,
      totalTokens: 15,
      reasoningTokens: 1,
      totalDurationMs: 150,
    });
    const distillRow = rows.find((r) => r.process === "distill");
    expect(distillRow).toMatchObject({ process: "distill", engine: "slow", model: "m2", calls: 1, failures: 0 });
  });

  test("a call missing a dimension is keyed unattributed for that dimension, never dropped", () => {
    const events = [usageEvent({ durationMs: 10 })];
    const rows = summarizeLlmUsageCrossTab(events);
    expect(rows).toEqual([
      expect.objectContaining({ process: "unattributed", engine: "unattributed", model: "unattributed", calls: 1 }),
    ]);
  });

  test("an undecodable event is skipped, not counted as a zero-duration call", () => {
    const events: EventEnvelope[] = [
      {
        schemaVersion: 1,
        id: nextId++,
        ts: "2026-08-01T00:00:00.000Z",
        eventType: "llm_usage",
        metadata: { not: "a usage record" },
      },
    ];
    expect(summarizeLlmUsageCrossTab(events)).toEqual([]);
  });

  test("does not fold into or change summarizeLlmUsage's byStage/byProcess/byEngine shape", () => {
    const events = [usageEvent({ durationMs: 10, process: "reflect", engine: "fast", stage: "reflect" })];
    const aggregate = summarizeLlmUsage(events);
    expect(aggregate).not.toHaveProperty("byProcessEngineModel");
    expect(summarizeLlmUsageCrossTab(events)).toHaveLength(1);
  });
});
