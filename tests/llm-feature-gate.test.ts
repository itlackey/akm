/**
 * Per-feature LLM gate seam (v1 spec §14, #227).
 *
 * Locks:
 *   - `isLlmFeatureEnabled` returns `true` only when the named flag is the
 *     literal boolean `true` in config (defaults are `false`).
 *   - `tryLlmFeature` returns the fallback on disablement, on any thrown
 *     error, and on hard-timeout — and never lets `fn`'s exception bubble.
 *   - The fallback may be a value or a thunk; the thunk is only invoked on
 *     the fallback path.
 *   - The wrapper notifies the optional `onFallback` sink with a structured
 *     `{ feature, reason, error? }` event, where `reason` is one of
 *     `"disabled" | "timeout" | "error"`.
 */
import { describe, expect, test } from "bun:test";
import type { AkmConfig } from "../src/core/config";
import { isLlmFeatureEnabled, LlmFeatureTimeoutError, tryLlmFeature } from "../src/llm/feature-gate";

const baseLlm: AkmConfig["llm"] = {
  endpoint: "http://example.invalid/v1/chat",
  model: "test-model",
};

function configWith(features: Record<string, boolean>): AkmConfig {
  return {
    stashDir: "/tmp/stash",
    llm: { ...baseLlm, features },
  } as AkmConfig;
}

describe("isLlmFeatureEnabled", () => {
  test("returns false when no llm config is present", () => {
    expect(isLlmFeatureEnabled(undefined, "curate_rerank")).toBe(false);
    expect(isLlmFeatureEnabled({} as AkmConfig, "curate_rerank")).toBe(false);
  });

  test("returns false when the features block is missing", () => {
    const cfg = { stashDir: "/tmp", llm: baseLlm } as AkmConfig;
    expect(isLlmFeatureEnabled(cfg, "tag_dedup")).toBe(false);
  });

  test("returns false when the key is absent (default-false)", () => {
    const cfg = configWith({});
    expect(isLlmFeatureEnabled(cfg, "memory_consolidation")).toBe(false);
  });

  test("returns true only on literal boolean true", () => {
    expect(isLlmFeatureEnabled(configWith({ feedback_distillation: true }), "feedback_distillation")).toBe(true);
    expect(isLlmFeatureEnabled(configWith({ feedback_distillation: false }), "feedback_distillation")).toBe(false);
  });
});

describe("tryLlmFeature", () => {
  test("returns the fallback (and never calls fn) when the gate is disabled", async () => {
    let called = false;
    const events: unknown[] = [];
    const result = await tryLlmFeature(
      "curate_rerank",
      configWith({}),
      async () => {
        called = true;
        return "real";
      },
      "fallback",
      { onFallback: (e) => events.push(e) },
    );
    expect(result).toBe("fallback");
    expect(called).toBe(false);
    expect(events).toEqual([{ feature: "curate_rerank", reason: "disabled" }]);
  });

  test("invokes a thunk fallback only on the fallback path", async () => {
    let fallbackInvocations = 0;
    const result = await tryLlmFeature(
      "tag_dedup",
      configWith({ tag_dedup: true }),
      async () => "real",
      () => {
        fallbackInvocations += 1;
        return "thunk-fallback";
      },
    );
    expect(result).toBe("real");
    expect(fallbackInvocations).toBe(0);
  });

  test("returns the fallback on a synchronous throw", async () => {
    const events: { reason: string; error?: Error }[] = [];
    const result = await tryLlmFeature(
      "curate_rerank",
      configWith({ curate_rerank: true }),
      () => {
        throw new Error("boom");
      },
      "fallback",
      { onFallback: (e) => events.push({ reason: e.reason, error: e.error }) },
    );
    expect(result).toBe("fallback");
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe("error");
    expect(events[0].error?.message).toBe("boom");
  });

  test("returns the fallback on an async rejection", async () => {
    const result = await tryLlmFeature(
      "embedding_fallback_score",
      configWith({ embedding_fallback_score: true }),
      async () => {
        throw new Error("kaboom");
      },
      42,
    );
    expect(result).toBe(42);
  });

  test("returns the fallback on hard timeout", async () => {
    const events: { reason: string; error?: Error }[] = [];
    const result = await tryLlmFeature(
      "memory_consolidation",
      configWith({ memory_consolidation: true }),
      () => new Promise<string>((resolve) => setTimeout(() => resolve("late"), 200)),
      "fallback",
      { timeoutMs: 25, onFallback: (e) => events.push({ reason: e.reason, error: e.error }) },
    );
    expect(result).toBe("fallback");
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe("timeout");
    expect(events[0].error).toBeInstanceOf(LlmFeatureTimeoutError);
  });

  test("returns fn's result when enabled and successful", async () => {
    const result = await tryLlmFeature(
      "feedback_distillation",
      configWith({ feedback_distillation: true }),
      async () => ({ ok: true }),
      { ok: false },
    );
    expect(result).toEqual({ ok: true });
  });
});
