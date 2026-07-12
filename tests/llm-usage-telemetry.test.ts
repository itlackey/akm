// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, test } from "bun:test";
import type { LlmConnectionConfig } from "../src/core/config/config";
import { chatCompletion } from "../src/llm/client";
import {
  clearLlmUsageSink,
  currentLlmStage,
  decodeLlmUsageRecord,
  emitLlmUsage,
  extractUsageTokens,
  hasLlmUsageSink,
  type LlmUsageRecord,
  setLlmUsageSink,
  withLlmStage,
} from "../src/llm/usage-telemetry";
import { withMockedFetch } from "./_helpers/sandbox";

const CONFIG: LlmConnectionConfig = {
  endpoint: "http://test.local/v1/chat/completions",
  model: "configured-model",
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function fullChatResponse(): Record<string, unknown> {
  return {
    model: "served-model-7b",
    choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 8,
      total_tokens: 20,
      completion_tokens_details: { reasoning_tokens: 5 },
    },
  };
}

// The preload harness restores globalThis.fetch and runs mock.restore() per
// test, but the usage sink is our own module-level singleton — clear it after
// every test so a leaked sink never bleeds into the next.
afterEach(() => {
  clearLlmUsageSink();
});

describe("usage-telemetry sink lifecycle", () => {
  test("no sink installed is a no-op (hasLlmUsageSink false)", () => {
    expect(hasLlmUsageSink()).toBe(false);
    // Must not throw when no sink is present.
    emitLlmUsage({ durationMs: 1 });
  });

  test("set then clear toggles hasLlmUsageSink and routing", () => {
    const records: LlmUsageRecord[] = [];
    setLlmUsageSink((r) => records.push(r));
    expect(hasLlmUsageSink()).toBe(true);
    emitLlmUsage({ durationMs: 3, model: "m" });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ durationMs: 3, model: "m" });

    clearLlmUsageSink();
    expect(hasLlmUsageSink()).toBe(false);
    emitLlmUsage({ durationMs: 4 });
    expect(records).toHaveLength(1); // cleared sink received nothing
  });

  test("a throwing sink never propagates to the caller", () => {
    setLlmUsageSink(() => {
      throw new Error("sink boom");
    });
    // Would throw if emitLlmUsage did not swallow sink errors.
    expect(() => emitLlmUsage({ durationMs: 1 })).not.toThrow();
  });
});

describe("withLlmStage ambient attribution", () => {
  test("currentLlmStage is undefined outside any scope", () => {
    expect(currentLlmStage()).toBeUndefined();
  });

  test("stamps the ambient stage on emitted records", () => {
    const records: LlmUsageRecord[] = [];
    setLlmUsageSink((r) => records.push(r));
    withLlmStage("reflect", () => {
      emitLlmUsage({ durationMs: 1 });
    });
    expect(records[0]?.stage).toBe("reflect");
  });

  test("attribution survives nested async calls; innermost stage wins", async () => {
    const records: LlmUsageRecord[] = [];
    setLlmUsageSink((r) => records.push(r));

    async function deepCall(): Promise<void> {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      emitLlmUsage({ durationMs: 2 });
    }

    await withLlmStage("memory-inference", async () => {
      await deepCall(); // attributed to memory-inference through awaits
      await withLlmStage("graph-extraction", async () => {
        await deepCall(); // innermost scope wins
      });
      await deepCall(); // back to memory-inference after the inner scope
    });

    expect(records.map((r) => r.stage)).toEqual(["memory-inference", "graph-extraction", "memory-inference"]);
  });

  test("an explicit stage on the record is not overwritten by the ambient one", () => {
    const records: LlmUsageRecord[] = [];
    setLlmUsageSink((r) => records.push(r));
    withLlmStage("reflect", () => {
      emitLlmUsage({ durationMs: 1, stage: "explicit" });
    });
    expect(records[0]?.stage).toBe("explicit");
  });

  test("stamps durable engine and process attribution", () => {
    const records: LlmUsageRecord[] = [];
    setLlmUsageSink((r) => records.push(r));
    withLlmStage("graph-extraction", () => emitLlmUsage({ durationMs: 7 }), {
      engine: "local-graph",
      process: "graphExtraction",
    });
    expect(records[0]).toMatchObject({
      stage: "graph-extraction",
      engine: "local-graph",
      process: "graphExtraction",
      durationMs: 7,
    });
  });
});

describe("extractUsageTokens", () => {
  test("projects a full usage block", () => {
    expect(
      extractUsageTokens({
        prompt_tokens: 10,
        completion_tokens: 4,
        total_tokens: 14,
        completion_tokens_details: { reasoning_tokens: 2 },
      }),
    ).toEqual({ promptTokens: 10, completionTokens: 4, totalTokens: 14, reasoningTokens: 2 });
  });

  test("omits missing / garbled fields rather than zeroing them", () => {
    expect(extractUsageTokens({ prompt_tokens: 10, completion_tokens: "nope", total_tokens: -1 })).toEqual({
      promptTokens: 10,
    });
  });

  test("returns empty object for null / undefined usage", () => {
    expect(extractUsageTokens(null)).toEqual({});
    expect(extractUsageTokens(undefined)).toEqual({});
  });
});

describe("decodeLlmUsageRecord", () => {
  test("decodes shared durable metadata and rejects records without a valid duration", () => {
    expect(
      decodeLlmUsageRecord({
        durationMs: 12,
        engine: "fast",
        process: "reflect",
        stage: "reflect",
        totalTokens: 9,
      }),
    ).toEqual({ durationMs: 12, engine: "fast", process: "reflect", stage: "reflect", totalTokens: 9 });
    expect(decodeLlmUsageRecord({ engine: "fast" })).toBeUndefined();
    expect(decodeLlmUsageRecord({ durationMs: -1 })).toBeUndefined();
  });
});

describe("chatCompletion usage capture", () => {
  test("captures usage + model + finish_reason + duration from a mocked response", async () => {
    const records: LlmUsageRecord[] = [];
    setLlmUsageSink((r) => records.push(r));

    const content = await withMockedFetch(
      () => withLlmStage("distill", () => chatCompletion(CONFIG, [{ role: "user", content: "hi" }])),
      () => jsonResponse(fullChatResponse()),
    );

    expect(content).toBe("hello");
    expect(records).toHaveLength(1);
    const rec = records[0];
    expect(rec.stage).toBe("distill");
    expect(rec.model).toBe("served-model-7b");
    expect(rec.finishReason).toBe("stop");
    expect(rec.promptTokens).toBe(12);
    expect(rec.completionTokens).toBe(8);
    expect(rec.totalTokens).toBe(20);
    expect(rec.reasoningTokens).toBe(5);
    expect(typeof rec.durationMs).toBe("number");
    expect(rec.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("absent usage block still records duration + model (token fields omitted)", async () => {
    const records: LlmUsageRecord[] = [];
    setLlmUsageSink((r) => records.push(r));

    await withMockedFetch(
      () => chatCompletion(CONFIG, [{ role: "user", content: "hi" }]),
      () => jsonResponse({ choices: [{ message: { content: "ok" } }] }),
    );

    expect(records).toHaveLength(1);
    const rec = records[0];
    expect(rec.durationMs).toBeGreaterThanOrEqual(0);
    // Provider omitted `model`, so we fall back to the configured model.
    expect(rec.model).toBe("configured-model");
    expect(rec.promptTokens).toBeUndefined();
    expect(rec.completionTokens).toBeUndefined();
    expect(rec.totalTokens).toBeUndefined();
    expect(rec.reasoningTokens).toBeUndefined();
    expect(rec.finishReason).toBeUndefined();
  });

  test("garbled usage block degrades to duration + model only", async () => {
    const records: LlmUsageRecord[] = [];
    setLlmUsageSink((r) => records.push(r));

    await withMockedFetch(
      () => chatCompletion(CONFIG, [{ role: "user", content: "hi" }]),
      () =>
        jsonResponse({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: "lots", completion_tokens: null },
        }),
    );

    expect(records).toHaveLength(1);
    expect(records[0].promptTokens).toBeUndefined();
    expect(records[0].completionTokens).toBeUndefined();
  });

  test("a throwing sink does not fail the LLM call", async () => {
    setLlmUsageSink(() => {
      throw new Error("persist failed");
    });

    const content = await withMockedFetch(
      () => chatCompletion(CONFIG, [{ role: "user", content: "hi" }]),
      () => jsonResponse(fullChatResponse()),
    );

    expect(content).toBe("hello");
  });
});
