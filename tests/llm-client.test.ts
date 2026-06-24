import { describe, expect, jest, test } from "bun:test";
import type { HttpClient } from "../src/core/common";
import type { LlmConnectionConfig } from "../src/core/config/config";
import { chatCompletion, LlmCallError, parseEmbeddedJsonResponse, redactErrorBody } from "../src/llm/client";

// #664 Seam 1: inject a fake HttpClient via chatCompletion's `fetch` option
// instead of standing up Bun.serve or mutating globalThis.fetch. The code under
// test runs its real request/parse/retry path with no socket and no shared
// global state (so it is parallel-safe). `TEST_ENDPOINT` is non-routable; the
// injected fetch never connects, and the URL still appears in error messages.
const TEST_ENDPOINT = "http://llm.test/v1/chat/completions";

/** Fake fetch returning a fixed status + body (optionally with a content-type). */
function rawFetch(status: number, body: string, contentType?: string): HttpClient {
  return async () => new Response(body, { status, headers: contentType ? { "Content-Type": contentType } : undefined });
}

// ── redactErrorBody ─────────────────────────────────────────────────────────

describe("redactErrorBody", () => {
  test("redacts Bearer tokens", () => {
    const out = redactErrorBody("Authorization: Bearer abc123XYZ.token-value");
    expect(out).not.toContain("abc123XYZ");
    expect(out).toContain("Bearer [REDACTED]");
  });

  test("redacts sk-* style API keys", () => {
    const out = redactErrorBody('{"error":"bad key sk-proj-Abcdef1234567890ZZZ"}');
    expect(out).not.toContain("sk-proj-Abcdef");
    expect(out).toContain("[REDACTED]");
  });

  test("redacts JSON api_key fields", () => {
    const out = redactErrorBody('{"api_key":"super-secret-12345","other":"safe"}');
    expect(out).not.toContain("super-secret-12345");
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("other");
  });

  test("redacts JSON apiKey camelCase fields", () => {
    const out = redactErrorBody('{"apiKey": "topsecretvalue"}');
    expect(out).not.toContain("topsecretvalue");
    expect(out).toContain("[REDACTED]");
  });

  test("trims output to 200 chars", () => {
    const huge = "x".repeat(2000);
    const out = redactErrorBody(huge);
    expect(out.length).toBeLessThanOrEqual(201); // 200 + ellipsis char
  });

  test("returns empty for empty input", () => {
    expect(redactErrorBody("")).toBe("");
  });

  test("preserves non-secret content under cap", () => {
    expect(redactErrorBody("plain error message")).toBe("plain error message");
  });
});

// ── chatCompletion error path ───────────────────────────────────────────────

describe("chatCompletion error redaction", () => {
  test("redacts API key from 401 response body and keeps status + URL", async () => {
    const leakBody = '{"error":{"message":"Invalid API key sk-proj-LEAKYKEYABCDEF12345"}}';
    const config: LlmConnectionConfig = {
      endpoint: TEST_ENDPOINT,
      model: "test-model",
      apiKey: "sk-proj-LEAKYKEYABCDEF12345",
    };
    let caught: Error | undefined;
    try {
      await chatCompletion(config, [{ role: "user", content: "hi" }], { fetch: rawFetch(401, leakBody) });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toContain("(401)");
    expect(caught?.message).toContain(TEST_ENDPOINT);
    expect(caught?.message).not.toContain("sk-proj-LEAKYKEYABCDEF12345");
    expect(caught?.message).toContain("[REDACTED]");
  });

  test("trims oversized error body but keeps status code intact", async () => {
    const huge = "A".repeat(5000);
    const config: LlmConnectionConfig = { endpoint: TEST_ENDPOINT, model: "test-model" };
    let caught: Error | undefined;
    try {
      await chatCompletion(config, [{ role: "user", content: "hi" }], { fetch: rawFetch(503, huge) });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toContain("(503)");
    // Status + URL prefix should remain; the body portion is truncated.
    expect((caught?.message ?? "").length).toBeLessThan(huge.length);
  });

  test("redacts Bearer header echoed back by provider", async () => {
    const body = "Got header Authorization: Bearer abcXYZsupersecret999";
    const config: LlmConnectionConfig = {
      endpoint: TEST_ENDPOINT,
      model: "test-model",
      apiKey: "abcXYZsupersecret999",
    };
    let caught: Error | undefined;
    try {
      await chatCompletion(config, [{ role: "user", content: "hi" }], { fetch: rawFetch(403, body) });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).not.toContain("abcXYZsupersecret999");
    expect(caught?.message).toContain("Bearer [REDACTED]");
  });

  // The configured timeoutMs is honored via an AbortController whose abort
  // timer is scheduled for exactly that many milliseconds. These tests assert
  // that wiring deterministically with fake timers + a fetch stub that mirrors
  // real fetch semantics (resolve while the signal is live, reject with an
  // AbortError once it aborts). No real server, no wall-clock race — so the
  // result is identical regardless of how the parallel suite is scheduled.
  test("uses configured timeoutMs when provided (request faster than timeout succeeds)", async () => {
    jest.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    const fetch: HttpClient = async (_input, init) => {
      capturedSignal = init?.signal ?? undefined;
      // Resolve immediately: the request completes well before the 250ms abort
      // timer would fire, so the configured timeout must NOT cancel it.
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        headers: { "Content-Type": "application/json" },
      });
    };
    try {
      const config: LlmConnectionConfig = { endpoint: TEST_ENDPOINT, model: "test-model", timeoutMs: 250 };
      const out = await chatCompletion(config, [{ role: "user", content: "hi" }], { fetch });
      expect(out).toBe("ok");
      // The abort signal was wired in but never tripped for a fast response.
      expect(capturedSignal).toBeInstanceOf(AbortSignal);
      expect(capturedSignal?.aborted).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  test("aborts at the configured timeoutMs, not before", async () => {
    jest.useFakeTimers();
    const fetch: HttpClient = (_input, init) => {
      const signal = init?.signal;
      // Mirror real fetch: a pending request stays unresolved until its signal
      // aborts, at which point it rejects with an AbortError DOMException.
      return new Promise<Response>((_resolve, reject) => {
        if (!signal) return;
        signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), {
          once: true,
        });
      });
    };
    try {
      const config: LlmConnectionConfig = { endpoint: TEST_ENDPOINT, model: "test-model", timeoutMs: 250 };
      const pending = chatCompletion(config, [{ role: "user", content: "hi" }], { fetch });
      // Settle the rejection so the floating promise can't crash the run, and
      // capture whichever outcome occurs.
      let outcome: { ok: true } | { ok: false; err: unknown } | undefined;
      pending.then(
        () => {
          outcome = { ok: true };
        },
        (err) => {
          outcome = { ok: false, err };
        },
      );

      // Just before the configured timeout: still pending, no abort.
      jest.advanceTimersByTime(249);
      await Promise.resolve();
      expect(outcome).toBeUndefined();

      // Crossing 250ms fires the abort timer and rejects the request.
      jest.advanceTimersByTime(1);
      // Flush the microtask chain (abort -> fetch reject -> mapped error).
      await pending.catch(() => {});

      expect(outcome).toBeDefined();
      expect(outcome?.ok).toBe(false);
      const err = (outcome as { ok: false; err: unknown }).err;
      expect(err).toBeInstanceOf(LlmCallError);
      expect((err as LlmCallError).code).toBe("timeout");
      expect((err as LlmCallError).message).toContain("250ms");
    } finally {
      jest.useRealTimers();
    }
  });
});

// ── HTML / non-JSON response categorization (#497) ──────────────────────────

const LM_STUDIO_HTML =
  '<!DOCTYPE html>\n<html lang="en"><head><title>LM Studio</title></head>' +
  '<body><div id="app">Loading…</div></body></html>';

describe("chatCompletion HTML response categorization", () => {
  async function callExpectingError(fetch: HttpClient): Promise<LlmCallError> {
    let caught: unknown;
    try {
      await chatCompletion({ endpoint: TEST_ENDPOINT, model: "test-model" }, [{ role: "user", content: "hi" }], {
        fetch,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LlmCallError);
    return caught as LlmCallError;
  }

  test("HTML 500 body produces provider_html_error (not provider_error)", async () => {
    const err = await callExpectingError(rawFetch(500, LM_STUDIO_HTML, "text/html"));
    expect(err.code).toBe("provider_html_error");
    expect(err.statusCode).toBe(500);
    expect(err.message).toContain("(500)");
    expect(err.message).toContain(TEST_ENDPOINT);
    // Excerpt should be plain text (tags stripped).
    expect(err.message).not.toContain("<html");
    expect(err.message).toContain("LM Studio");
  });

  test("HTML 502 body also produces provider_html_error", async () => {
    const err = await callExpectingError(rawFetch(502, LM_STUDIO_HTML, "text/html"));
    expect(err.code).toBe("provider_html_error");
    expect(err.statusCode).toBe(502);
  });

  test("JSON 500 body still produces the generic provider_error path", async () => {
    const err = await callExpectingError(rawFetch(500, '{"error":"upstream exploded"}', "application/json"));
    expect(err.code).toBe("provider_error");
    expect(err.statusCode).toBe(500);
  });

  test("non-error HTML 200 (where JSON expected) surfaces provider_html_error, not a raw SyntaxError", async () => {
    const err = await callExpectingError(rawFetch(200, LM_STUDIO_HTML, "text/html"));
    expect(err.code).toBe("provider_html_error");
    expect(err.statusCode).toBe(200);
    expect(err.message).not.toContain("<html");
  });

  test("malformed (non-HTML) JSON 200 still maps to parse_error", async () => {
    const err = await callExpectingError(rawFetch(200, "this is not json {", "application/json"));
    expect(err.code).toBe("parse_error");
  });
});

// ── chatCompletion single bounded retry ─────────────────────────────────────

/**
 * Build a `globalThis.fetch` stub that yields the queued responses/errors in
 * order. Each entry is either a `Response` or a function producing one (so a
 * thrown network error can be simulated). Tracks how many times it was called.
 */
function queuedFetch(entries: Array<Response | (() => Response | never)>): {
  fetch: typeof fetch;
  calls: () => number;
} {
  let i = 0;
  const stub = (async () => {
    const entry = entries[Math.min(i, entries.length - 1)];
    i += 1;
    return typeof entry === "function" ? entry() : entry;
  }) as unknown as typeof fetch;
  return { fetch: stub, calls: () => i };
}

function jsonOk(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    headers: { "Content-Type": "application/json" },
  });
}

/** Internal options shape — `sleep` is injected to keep the suite fast. */
type RetryTestOptions = Parameters<typeof chatCompletion>[2] & { sleep?: (ms: number) => Promise<void> };

const fastSleep = async () => {};

describe("chatCompletion single bounded retry", () => {
  const baseConfig: LlmConnectionConfig = {
    endpoint: TEST_ENDPOINT,
    model: "test-model",
    timeoutMs: 5000,
  };

  test("500 then 200 returns the success body, fires onRetryAttempt once, does not throw", async () => {
    const { fetch: stub, calls } = queuedFetch([new Response("upstream boom", { status: 500 }), jsonOk("recovered")]);
    let retries = 0;
    const out = await chatCompletion(baseConfig, [{ role: "user", content: "hi" }], {
      sleep: fastSleep,
      fetch: stub,
      onRetryAttempt: () => {
        retries += 1;
      },
    } as RetryTestOptions);
    expect(out).toBe("recovered");
    expect(retries).toBe(1);
    expect(calls()).toBe(2);
  });

  test("500 then 500 throws the second provider_error and fires onRetryAttempt once", async () => {
    const { fetch: stub, calls } = queuedFetch([
      new Response("first", { status: 500 }),
      new Response("second", { status: 503 }),
    ]);
    let retries = 0;
    let caught: LlmCallError | undefined;
    try {
      await chatCompletion(baseConfig, [{ role: "user", content: "hi" }], {
        sleep: fastSleep,
        fetch: stub,
        onRetryAttempt: () => {
          retries += 1;
        },
      } as RetryTestOptions);
    } catch (err) {
      caught = err as LlmCallError;
    }
    expect(caught).toBeInstanceOf(LlmCallError);
    expect(caught?.code).toBe("provider_error");
    // The thrown error is the SECOND failure (503), not the first (500).
    expect(caught?.statusCode).toBe(503);
    expect(retries).toBe(1);
    expect(calls()).toBe(2);
  });

  test("4xx throws immediately with no retry and no callback", async () => {
    const { fetch: stub, calls } = queuedFetch([new Response("bad request", { status: 400 }), jsonOk("unreached")]);
    let retries = 0;
    let caught: LlmCallError | undefined;
    try {
      await chatCompletion(baseConfig, [{ role: "user", content: "hi" }], {
        sleep: fastSleep,
        fetch: stub,
        onRetryAttempt: () => {
          retries += 1;
        },
      } as RetryTestOptions);
    } catch (err) {
      caught = err as LlmCallError;
    }
    expect(caught?.code).toBe("provider_error");
    expect(caught?.statusCode).toBe(400);
    expect(retries).toBe(0);
    expect(calls()).toBe(1);
  });

  test("429 rate_limited is not retried", async () => {
    const { fetch: stub, calls } = queuedFetch([new Response("slow down", { status: 429 }), jsonOk("unreached")]);
    let retries = 0;
    let caught: LlmCallError | undefined;
    try {
      await chatCompletion(baseConfig, [{ role: "user", content: "hi" }], {
        sleep: fastSleep,
        fetch: stub,
        onRetryAttempt: () => {
          retries += 1;
        },
      } as RetryTestOptions);
    } catch (err) {
      caught = err as LlmCallError;
    }
    expect(caught?.code).toBe("rate_limited");
    expect(retries).toBe(0);
    expect(calls()).toBe(1);
  });

  test("timeout is not retried", async () => {
    let calls = 0;
    const fetch: HttpClient = (_input, init) => {
      calls += 1;
      // Mirror real fetch: reject with an AbortError once the timeout signal fires.
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    };
    let retries = 0;
    let caught: LlmCallError | undefined;
    try {
      await chatCompletion({ ...baseConfig, timeoutMs: 20 }, [{ role: "user", content: "hi" }], {
        sleep: fastSleep,
        fetch,
        onRetryAttempt: () => {
          retries += 1;
        },
      } as RetryTestOptions);
    } catch (err) {
      caught = err as LlmCallError;
    }
    expect(caught?.code).toBe("timeout");
    expect(retries).toBe(0);
    expect(calls).toBe(1);
  });

  test("ECONNRESET network_error is retried then succeeds", async () => {
    const { fetch: stub, calls } = queuedFetch([
      () => {
        throw new Error("read ECONNRESET");
      },
      jsonOk("recovered"),
    ]);
    let retries = 0;
    const out = await chatCompletion(baseConfig, [{ role: "user", content: "hi" }], {
      sleep: fastSleep,
      fetch: stub,
      onRetryAttempt: () => {
        retries += 1;
      },
    } as RetryTestOptions);
    expect(out).toBe("recovered");
    expect(retries).toBe(1);
    expect(calls()).toBe(2);
  });

  test("Bun 'socket connection was closed' network_error is retried then succeeds", async () => {
    const { fetch: stub, calls } = queuedFetch([
      () => {
        // Bun 1.3.x surfaces a mid-flight dropped connection with this exact
        // message; it contains no ECONNRESET/EPIPE/"fetch failed" substring.
        throw new Error("The socket connection was closed unexpectedly.");
      },
      jsonOk("recovered"),
    ]);
    let retries = 0;
    const out = await chatCompletion(baseConfig, [{ role: "user", content: "hi" }], {
      sleep: fastSleep,
      fetch: stub,
      onRetryAttempt: () => {
        retries += 1;
      },
    } as RetryTestOptions);
    expect(out).toBe("recovered");
    expect(retries).toBe(1);
    expect(calls()).toBe(2);
  });

  test("context-overflow-classified 5xx is not retried", async () => {
    const { fetch: stub, calls } = queuedFetch([
      new Response("the prompt exceeds the model context length", { status: 500 }),
      jsonOk("unreached"),
    ]);
    let retries = 0;
    let caught: LlmCallError | undefined;
    try {
      await chatCompletion(baseConfig, [{ role: "user", content: "hi" }], {
        sleep: fastSleep,
        fetch: stub,
        onRetryAttempt: () => {
          retries += 1;
        },
      } as RetryTestOptions);
    } catch (err) {
      caught = err as LlmCallError;
    }
    expect(caught?.code).toBe("provider_error");
    expect(retries).toBe(0);
    expect(calls()).toBe(1);
  });

  test("retry is skipped when the first attempt consumes >= 90% of timeoutMs", async () => {
    let calls = 0;
    // First attempt fails with a retryable 500. Rather than burn ~460ms of real
    // wall time, we inject a fake clock that reports the budget as ~95% spent by
    // the time the guard checks it — exercising the same suppression path with
    // zero sleep.
    const fetch: HttpClient = async () => {
      calls += 1;
      return new Response("boom", { status: 500 });
    };
    // started=0, elapsed-check=475 → 475 >= 0.9*500=450 → retry suppressed.
    const clockTicks = [0, 475];
    const now = () => clockTicks.shift() ?? 475;
    let retries = 0;
    let caught: LlmCallError | undefined;
    try {
      await chatCompletion({ ...baseConfig, timeoutMs: 500 }, [{ role: "user", content: "hi" }], {
        sleep: fastSleep,
        fetch,
        now,
        onRetryAttempt: () => {
          retries += 1;
        },
      } as RetryTestOptions);
    } catch (err) {
      caught = err as LlmCallError;
    }
    expect(caught?.code).toBe("provider_error");
    expect(retries).toBe(0);
    expect(calls).toBe(1);
  });

  test("backoff jitter stays within the 200-800ms window", async () => {
    const { fetch: stub } = queuedFetch([new Response("boom", { status: 500 }), jsonOk("recovered")]);
    let observedMs = -1;
    await chatCompletion(baseConfig, [{ role: "user", content: "hi" }], {
      fetch: stub,
      sleep: async (ms: number) => {
        observedMs = ms;
      },
    } as RetryTestOptions);
    expect(observedMs).toBeGreaterThanOrEqual(200);
    expect(observedMs).toBeLessThan(800);
  });
});

describe("parseEmbeddedJsonResponse", () => {
  test("parses direct JSON", () => {
    expect(parseEmbeddedJsonResponse<{ ok: boolean }>('{"ok":true}')).toEqual({ ok: true });
  });

  test("parses fenced JSON", () => {
    expect(parseEmbeddedJsonResponse<{ ok: boolean }>('```json\n{"ok":true}\n```')).toEqual({ ok: true });
  });

  test("parses prose-wrapped JSON object", () => {
    const raw = 'Here is the result:\n{"entities":["ServiceA"],"relations":[]}\nDone.';
    expect(parseEmbeddedJsonResponse<{ entities: string[]; relations: unknown[] }>(raw)).toEqual({
      entities: ["ServiceA"],
      relations: [],
    });
  });

  test("parses prose-wrapped graph payload with relations", () => {
    const raw =
      'Here is the graph:\n{"entities":["ServiceA","ServiceB"],"relations":[{"from":"ServiceA","to":"ServiceB","type":"uses"}]}\nDone.';
    expect(
      parseEmbeddedJsonResponse<{ entities: string[]; relations: Array<{ from: string; to: string; type: string }> }>(
        raw,
      ),
    ).toEqual({
      entities: ["ServiceA", "ServiceB"],
      relations: [{ from: "ServiceA", to: "ServiceB", type: "uses" }],
    });
  });

  test("parses JSON after a qwen think block", () => {
    const raw =
      '<think>I should return JSON with {"entities":[],"relations":[]}</think>\n{"entities":["ServiceA"],"relations":[]}';
    expect(parseEmbeddedJsonResponse<{ entities: string[]; relations: unknown[] }>(raw)).toEqual({
      entities: ["ServiceA"],
      relations: [],
    });
  });

  test("skips malformed leading candidate and parses later valid JSON", () => {
    const raw = 'Draft: {"entities":["A",],"relations":[]}\nFinal: {"entities":["ServiceA"],"relations":[]}';
    expect(parseEmbeddedJsonResponse<{ entities: string[]; relations: unknown[] }>(raw)).toEqual({
      entities: ["ServiceA"],
      relations: [],
    });
  });

  test("preserves escaped quotes while repairing literal newlines inside strings", () => {
    const raw = '{"content":"Line one\nLine two with \\"quoted\\" text"}';
    expect(parseEmbeddedJsonResponse<{ content: string }>(raw)).toEqual({
      content: 'Line one\nLine two with "quoted" text',
    });
  });

  test("returns undefined when no JSON object or array exists", () => {
    expect(parseEmbeddedJsonResponse("not json at all")).toBeUndefined();
  });
});

describe('parseEmbeddedJsonResponse({ expect: "array" })', () => {
  test("parses a direct top-level array", () => {
    expect(parseEmbeddedJsonResponse<number[]>("[1,2,3]", { expect: "array" })).toEqual([1, 2, 3]);
  });

  test("salvages a prose-wrapped array", () => {
    const raw = 'Here are the results:\n[{"entities":["A"],"relations":[]}]\nDone.';
    expect(parseEmbeddedJsonResponse<unknown[]>(raw, { expect: "array" })).toEqual([
      { entities: ["A"], relations: [] },
    ]);
  });

  test("salvages a fenced array", () => {
    const raw = '```json\n[{"entities":[],"relations":[]}]\n```';
    expect(parseEmbeddedJsonResponse<unknown[]>(raw, { expect: "array" })).toEqual([{ entities: [], relations: [] }]);
  });

  test("prefers the array even when a leading object precedes it (the #635 bug)", () => {
    // Default object-preferring mode returns the leading object — a false
    // "non-array" for the graph batch path. Array mode must return the array.
    const raw =
      'For example {"from":"A","to":"B"}.\nNow the answer:\n[{"entities":["A","B"],"relations":[{"from":"A","to":"B"}]}]';
    expect(parseEmbeddedJsonResponse<unknown[]>(raw, { expect: "array" })).toEqual([
      { entities: ["A", "B"], relations: [{ from: "A", to: "B" }] },
    ]);
  });

  test("skips a malformed leading array and parses the later valid array", () => {
    const raw = 'Draft: [{"entities":["A",]}]\nFinal: [{"entities":["ServiceA"],"relations":[]}]';
    expect(parseEmbeddedJsonResponse<unknown[]>(raw, { expect: "array" })).toEqual([
      { entities: ["ServiceA"], relations: [] },
    ]);
  });

  test("returns undefined when only an object is present (no array to salvage)", () => {
    const raw = 'Here is the result:\n{"entities":["A"],"relations":[]}';
    expect(parseEmbeddedJsonResponse<unknown[]>(raw, { expect: "array" })).toBeUndefined();
  });

  test('default ("any") mode still prefers a leading object — regression guard', () => {
    const raw = 'Note {"ok":true}\n[1,2,3]';
    expect(parseEmbeddedJsonResponse<{ ok: boolean }>(raw)).toEqual({ ok: true });
  });
});
