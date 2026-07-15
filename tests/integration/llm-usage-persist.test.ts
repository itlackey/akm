// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { akmHealth } from "../../src/commands/health";
import { readEvents } from "../../src/core/events";
import {
  installLlmUsagePersistence,
  installLlmUsagePersistenceIfAbsent,
  LLM_USAGE_EVENT,
} from "../../src/llm/usage-persist";
import {
  clearLlmUsageSink,
  emitLlmUsage,
  hasLlmUsageSink,
  setLlmUsageSink,
  withLlmStage,
} from "../../src/llm/usage-telemetry";
import { type Cleanup, type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let cleanup: Cleanup = () => {};

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  cleanup = storage.cleanup;
});

afterEach(() => {
  // Our module-level sink is not owned by the preload harness — clear it so a
  // leak cannot write through the next test's (different) isolated state.db.
  clearLlmUsageSink();
  cleanup();
  cleanup = () => {};
});

describe("installLlmUsagePersistence", () => {
  test("persists each record as an llm_usage event and the disposer clears the sink", () => {
    const dispose = installLlmUsagePersistence();
    expect(hasLlmUsageSink()).toBe(true);

    withLlmStage(
      "reflect",
      () => {
        emitLlmUsage({
          durationMs: 100,
          model: "m",
          finishReason: "stop",
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
        });
      },
      { engine: "fast", process: "reflect" },
    );
    emitLlmUsage({ durationMs: 50, model: "m" }); // unattributed, absent tokens

    dispose();
    expect(hasLlmUsageSink()).toBe(false);

    const events = readEvents({ type: LLM_USAGE_EVENT }).events;
    expect(events).toHaveLength(2);

    const reflect = events.find((e) => e.metadata?.stage === "reflect");
    expect(reflect?.metadata).toMatchObject({
      stage: "reflect",
      engine: "fast",
      process: "reflect",
      durationMs: 100,
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });

    const unattributed = events.find((e) => e.metadata?.stage === undefined);
    expect(unattributed?.metadata).toMatchObject({ durationMs: 50, model: "m" });
    // Absent token fields are dropped, not zeroed.
    expect(unattributed?.metadata?.promptTokens).toBeUndefined();
  });
});

describe("installLlmUsagePersistenceIfAbsent", () => {
  test("does not clobber an already-installed sink and returns a no-op disposer", () => {
    let outerCalls = 0;
    setLlmUsageSink(() => {
      outerCalls += 1;
    });

    const dispose = installLlmUsagePersistenceIfAbsent();
    emitLlmUsage({ durationMs: 1 });
    expect(outerCalls).toBe(1); // still the outer sink

    dispose(); // no-op: must NOT clear the outer sink
    expect(hasLlmUsageSink()).toBe(true);
    emitLlmUsage({ durationMs: 1 });
    expect(outerCalls).toBe(2);
  });

  test("installs when no sink is present", () => {
    expect(hasLlmUsageSink()).toBe(false);
    const dispose = installLlmUsagePersistenceIfAbsent();
    expect(hasLlmUsageSink()).toBe(true);
    emitLlmUsage({ durationMs: 7, model: "m" });
    dispose();
    expect(readEvents({ type: LLM_USAGE_EVENT }).events).toHaveLength(1);
  });
});

describe("akmHealth llmUsage aggregate", () => {
  test("aggregates per-stage token + time totals from llm_usage events", () => {
    const dispose = installLlmUsagePersistence();
    withLlmStage(
      "reflect",
      () => {
        emitLlmUsage({ durationMs: 100, promptTokens: 10, completionTokens: 5, totalTokens: 15, reasoningTokens: 2 });
        emitLlmUsage({ durationMs: 200, promptTokens: 20, completionTokens: 10, totalTokens: 30, reasoningTokens: 3 });
      },
      { engine: "fast", process: "reflect" },
    );
    withLlmStage(
      "distill",
      () => {
        emitLlmUsage({ durationMs: 40, promptTokens: 4, completionTokens: 2, totalTokens: 6 });
      },
      { engine: "careful", process: "distill" },
    );
    emitLlmUsage({ durationMs: 10 }); // unattributed, no tokens
    dispose();

    // Seam out the real session-log scan (it walks the host filesystem and is
    // unrelated to this assertion) so the test exercises only the llm_usage
    // aggregation path.
    const result = akmHealth({ since: "7d", getExecutionLogCandidatesFn: () => [] });
    const usage = result.metrics.llmUsage;

    expect(usage.calls).toBe(4);
    expect(usage.totalDurationMs).toBe(350);
    expect(usage.promptTokens).toBe(34);
    expect(usage.completionTokens).toBe(17);
    expect(usage.totalTokens).toBe(51);
    expect(usage.reasoningTokens).toBe(5);

    expect(usage.byStage.reflect).toMatchObject({
      calls: 2,
      totalDurationMs: 300,
      promptTokens: 30,
      completionTokens: 15,
      totalTokens: 45,
      reasoningTokens: 5,
    });
    expect(usage.byStage.distill).toMatchObject({ calls: 1, totalDurationMs: 40, totalTokens: 6 });
    expect(usage.byStage.unattributed).toMatchObject({ calls: 1, totalDurationMs: 10, totalTokens: 0 });
    expect(usage.byProcess.reflect).toMatchObject({ calls: 2, totalDurationMs: 300, totalTokens: 45 });
    expect(usage.byProcess.distill).toMatchObject({ calls: 1, totalDurationMs: 40, totalTokens: 6 });
    expect(usage.byEngine.fast).toMatchObject({ calls: 2, totalDurationMs: 300, totalTokens: 45 });
    expect(usage.byEngine.careful).toMatchObject({ calls: 1, totalDurationMs: 40, totalTokens: 6 });
  });

  test("reports an empty aggregate when no llm_usage events exist", () => {
    const result = akmHealth({ since: "7d", getExecutionLogCandidatesFn: () => [] });
    expect(result.metrics.llmUsage.calls).toBe(0);
    expect(result.metrics.llmUsage.byStage).toEqual({});
  });
});
