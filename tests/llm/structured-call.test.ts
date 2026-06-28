/**
 * Contract tests for the `callStructured<T>()` seam (X2).
 *
 * `callStructured` centralizes the replicated
 *   `tryLlmFeature -> chatCompletion -> classify(context/html/other) ->
 *    parse/validate -> fallback/telemetry`
 * scaffold shared by memory-infer / metadata-enhance / graph-extract.
 *
 * These tests pin the seam CONTRACT by injecting a fake chat (so no real
 * network call happens) and asserting the observable wiring:
 *   1. gated success    -> `parse` runs on the raw string, return value flows out
 *   2. gated bad/empty  -> `parse` returns the caller's fallback itself
 *   3. gated throw w/ context-size message -> onError("context_limit", err)
 *   4. gated throw LlmCallError("provider_html_error") -> onError("html", err)
 *   5. gated throw generic                  -> onError("other", err)
 *   6. UNGATED (akmConfig === undefined) throw -> error PROPAGATES (rejects)
 *   7. `onRetryAttempt` is forwarded into the chat call options
 *
 * Verifies the callStructured seam's observable wiring (gated success/failure,
 * context-size + html error handling, ungated propagation, retry forwarding).
 */

import { describe, expect, test } from "bun:test";
import type { AkmConfig, LlmProfileConfig } from "../../src/core/config/config";
import type { ChatMessage } from "../../src/llm/client";
import { LlmCallError } from "../../src/llm/client";
import { callStructured, type LlmErrorClass } from "../../src/llm/structured-call";

// Minimal LLM profile config. `chatCompletion` is replaced by the injected
// fake, so transport fields are irrelevant.
const PROFILE: LlmProfileConfig = { baseUrl: "http://x", model: "m" } as unknown as LlmProfileConfig;

const MESSAGES: ChatMessage[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "usr" },
];

// A config object whose mere existence enables the `memory_inference` gate
// (FEATURE_LOCATION default is `?? true`). Used as the GATED akmConfig.
const GATED: AkmConfig = {} as AkmConfig;

describe("callStructured contract", () => {
  test("(1) gated success -> parse runs on raw, returns T", async () => {
    let parsedRaw: string | undefined = "UNSET";
    const result = await callStructured<{ ok: boolean; raw?: string }>({
      feature: "memory_inference",
      akmConfig: GATED,
      config: PROFILE,
      messages: MESSAGES,
      request: { chat: async () => '{"value":42}' },
      parse: (raw) => {
        parsedRaw = raw;
        return { ok: true, raw };
      },
      onError: () => ({ ok: false }),
      fallback: { ok: false },
    });
    expect(parsedRaw).toBe('{"value":42}');
    expect(result).toEqual({ ok: true, raw: '{"value":42}' });
  });

  test("(2) gated empty/bad raw -> parse returns the caller fallback itself", async () => {
    const FALLBACK = { ok: false as const };
    const result = await callStructured<{ ok: boolean }>({
      feature: "memory_inference",
      akmConfig: GATED,
      config: PROFILE,
      messages: MESSAGES,
      // Fake chat yields an empty string; `parse` owns the `!raw` decision and
      // returns the fallback.
      request: { chat: async () => "" },
      parse: (raw) => (raw ? { ok: true } : FALLBACK),
      onError: () => ({ ok: true }), // must NOT be called on a parse-fallback
      fallback: FALLBACK,
    });
    expect(result).toBe(FALLBACK);
  });

  test("(3) gated throw w/ context-size message -> onError('context_limit')", async () => {
    let seen: LlmErrorClass | undefined;
    let seenErr: unknown;
    const result = await callStructured<string>({
      feature: "memory_inference",
      akmConfig: GATED,
      config: PROFILE,
      messages: MESSAGES,
      request: {
        chat: async () => {
          throw new Error("This model's maximum context length is 4096 tokens");
        },
      },
      parse: () => "PARSED",
      onError: (cls, err) => {
        seen = cls;
        seenErr = err;
        return "CTX";
      },
      fallback: "FB",
    });
    expect(seen).toBe("context_limit");
    expect(seenErr).toBeInstanceOf(Error);
    expect(result).toBe("CTX");
  });

  test("(4) gated throw LlmCallError(provider_html_error) -> onError('html')", async () => {
    let seen: LlmErrorClass | undefined;
    const htmlErr = new LlmCallError("provider returned HTML", "provider_html_error");
    const result = await callStructured<string>({
      feature: "memory_inference",
      akmConfig: GATED,
      config: PROFILE,
      messages: MESSAGES,
      request: {
        chat: async () => {
          throw htmlErr;
        },
      },
      parse: () => "PARSED",
      onError: (cls, err) => {
        seen = cls;
        expect(err).toBe(htmlErr);
        return "HTML";
      },
      fallback: "FB",
    });
    expect(seen).toBe("html");
    expect(result).toBe("HTML");
  });

  test("(5) gated throw generic -> onError('other')", async () => {
    let seen: LlmErrorClass | undefined;
    const result = await callStructured<string>({
      feature: "memory_inference",
      akmConfig: GATED,
      config: PROFILE,
      messages: MESSAGES,
      request: {
        chat: async () => {
          throw new Error("connection refused");
        },
      },
      parse: () => "PARSED",
      onError: (cls) => {
        seen = cls;
        return "OTHER";
      },
      fallback: "FB",
    });
    expect(seen).toBe("other");
    expect(result).toBe("OTHER");
  });

  test("(6) UNGATED (akmConfig undefined) throw -> error PROPAGATES", async () => {
    const boom = new Error("ungated propagation");
    const onErrorCalls: LlmErrorClass[] = [];
    const promise = callStructured<string>({
      feature: "metadata_enhance",
      akmConfig: undefined, // UNGATED: run directly, propagate errors
      config: PROFILE,
      messages: MESSAGES,
      request: {
        chat: async () => {
          throw boom;
        },
      },
      parse: () => "PARSED",
      onError: (cls) => {
        onErrorCalls.push(cls);
        return "SWALLOWED";
      },
      fallback: "FB",
    });
    await expect(promise).rejects.toThrow("ungated propagation");
    // The error must NOT be funneled through onError on the ungated path.
    expect(onErrorCalls).toEqual([]);
  });

  test("(7) onRetryAttempt is forwarded into the chat call options", async () => {
    let forwarded: (() => void) | undefined;
    const onRetryAttempt = () => {};
    await callStructured<string>({
      feature: "memory_inference",
      akmConfig: GATED,
      config: PROFILE,
      messages: MESSAGES,
      request: {
        onRetryAttempt,
        chat: async (_config, _messages, options) => {
          forwarded = options?.onRetryAttempt;
          return "ok";
        },
      },
      parse: () => "PARSED",
      onError: () => "ERR",
      fallback: "FB",
    });
    expect(forwarded).toBe(onRetryAttempt);
  });
});
