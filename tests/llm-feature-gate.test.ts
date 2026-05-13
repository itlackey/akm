/**
 * Per-feature LLM gate seam (v1 spec §14, #227).
 *
 * Locks:
 *   - `isLlmFeatureEnabled` honours per-feature defaults: currently
 *     `memory_inference` and `graph_extraction` default to enabled while
 *     other stable keys default to disabled unless explicitly `true`.
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
  } as unknown as AkmConfig;
}

describe("isLlmFeatureEnabled", () => {
  test("returns false when no llm config is present", () => {
    expect(isLlmFeatureEnabled(undefined, "curate_rerank")).toBe(false);
    expect(isLlmFeatureEnabled({} as AkmConfig, "curate_rerank")).toBe(false);
  });

  test("returns feature defaults when the features block is missing", () => {
    const cfg = { stashDir: "/tmp", llm: baseLlm } as AkmConfig;
    expect(isLlmFeatureEnabled(cfg, "feedback_distillation")).toBe(false);
    expect(isLlmFeatureEnabled(cfg, "graph_extraction")).toBe(true);
  });

  test("returns true when graph_extraction key is absent (default-true)", () => {
    const cfg = configWith({});
    expect(isLlmFeatureEnabled(cfg, "graph_extraction")).toBe(true);
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
      "memory_inference",
      configWith({ memory_inference: true }),
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
      "graph_extraction",
      configWith({ graph_extraction: true }),
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
      "memory_inference",
      configWith({ memory_inference: true }),
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

// ── timeoutMs override tests ──────────────────────────────────────────

test("timeoutMs in opts overrides DEFAULT_TIMEOUT_MS (25 ms gate, 200 ms fn)", async () => {
  // When timeoutMs is smaller than the fn's delay, the wrapper must time out
  // and return the fallback — proving the per-call override works.
  const events: { reason: string; error?: Error }[] = [];
  const result = await tryLlmFeature(
    "memory_inference",
    configWith({ memory_inference: true }),
    () => new Promise<string>((resolve) => setTimeout(() => resolve("late"), 200)),
    "fallback-from-gate-timeout",
    {
      timeoutMs: 25,
      onFallback: (e) => events.push({ reason: e.reason, error: e.error }),
    },
  );
  expect(result).toBe("fallback-from-gate-timeout");
  expect(events).toHaveLength(1);
  expect(events[0].reason).toBe("timeout");
  expect(events[0].error).toBeInstanceOf(LlmFeatureTimeoutError);
});

test("when timeoutMs is absent, DEFAULT_TIMEOUT_MS of 600 s is used (fast calls succeed)", async () => {
  // A fn that resolves quickly (10 ms) should succeed without timing out
  // when no timeoutMs is set, confirming the 600 s default does not
  // prematurely expire fast calls.
  const events: { reason: string }[] = [];
  const result = await tryLlmFeature(
    "graph_extraction",
    configWith({ graph_extraction: true }),
    () => new Promise<string>((resolve) => setTimeout(() => resolve("fast"), 10)),
    "should-not-be-returned",
    { onFallback: (e) => events.push({ reason: e.reason }) },
  );
  // No timeout should have fired; the fn result is returned.
  expect(result).toBe("fast");
  expect(events).toHaveLength(0);
});

// ── #284 GAP-LOW: parametrise over the stable feature keys ─────────────────
//
// Wave B may drop `tag_dedup` / `memory_consolidation` / `embedding_fallback_score`
// — we restrict this parametrised sweep to the 4 keys that are
// definitely actually-implemented and used by the current code.
const STABLE_FEATURE_KEYS = ["feedback_distillation", "memory_inference", "graph_extraction", "curate_rerank"] as const;
const DEFAULT_ENABLED_KEYS = new Set(["memory_inference", "graph_extraction"]);

describe("isLlmFeatureEnabled — parametrised over stable feature keys (#284)", () => {
  for (const key of STABLE_FEATURE_KEYS) {
    test(`${key}: defaults correctly when features block is missing`, () => {
      const cfg = { stashDir: "/tmp", llm: baseLlm } as AkmConfig;
      // biome-ignore lint/suspicious/noExplicitAny: gate accepts any LlmFeatureKey
      expect(isLlmFeatureEnabled(cfg, key as any)).toBe(DEFAULT_ENABLED_KEYS.has(key));
    });

    test(`${key}: defaults correctly when key is absent`, () => {
      const cfg = configWith({});
      // biome-ignore lint/suspicious/noExplicitAny: gate accepts any LlmFeatureKey
      expect(isLlmFeatureEnabled(cfg, key as any)).toBe(DEFAULT_ENABLED_KEYS.has(key));
    });

    test(`${key}: literal true → enabled`, () => {
      // biome-ignore lint/suspicious/noExplicitAny: gate accepts any LlmFeatureKey
      expect(isLlmFeatureEnabled(configWith({ [key]: true }), key as any)).toBe(true);
    });

    test(`${key}: literal false → disabled`, () => {
      // biome-ignore lint/suspicious/noExplicitAny: gate accepts any LlmFeatureKey
      expect(isLlmFeatureEnabled(configWith({ [key]: false }), key as any)).toBe(false);
    });
  }
});

describe("tryLlmFeature — parametrised over stable feature keys (#284)", () => {
  for (const key of STABLE_FEATURE_KEYS) {
    test(`${key}: disabled → returns fallback, never calls fn`, async () => {
      let called = false;
      const result = await tryLlmFeature(
        // biome-ignore lint/suspicious/noExplicitAny: gate accepts any LlmFeatureKey
        key as any,
        configWith({}),
        async () => {
          called = true;
          return "real";
        },
        "fallback",
      );
      if (DEFAULT_ENABLED_KEYS.has(key)) {
        expect(result).toBe("real");
        expect(called).toBe(true);
      } else {
        expect(result).toBe("fallback");
        expect(called).toBe(false);
      }
    });

    test(`${key}: enabled + happy → returns fn's result`, async () => {
      const result = await tryLlmFeature(
        // biome-ignore lint/suspicious/noExplicitAny: gate accepts any LlmFeatureKey
        key as any,
        configWith({ [key]: true }),
        async () => "real",
        "fallback",
      );
      expect(result).toBe("real");
    });

    test(`${key}: enabled + throw → returns fallback`, async () => {
      const result = await tryLlmFeature(
        // biome-ignore lint/suspicious/noExplicitAny: gate accepts any LlmFeatureKey
        key as any,
        configWith({ [key]: true }),
        async () => {
          throw new Error("boom");
        },
        "fallback",
      );
      expect(result).toBe("fallback");
    });
  }
});
