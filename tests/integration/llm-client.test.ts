import { describe, expect, jest, test } from "bun:test";
import type { LlmConnectionConfig } from "../../src/core/config/config";
import { chatCompletion, LlmCallError, parseEmbeddedJsonResponse, redactErrorBody } from "../../src/llm/client";

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

function createErrorServer(statusCode: number, body: string): { url: string; server: ReturnType<typeof Bun.serve> } {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(body, { status: statusCode, headers: { Connection: "close" } });
    },
  });
  return { url: `http://localhost:${server.port}`, server };
}

describe("chatCompletion error redaction", () => {
  test("redacts an exact API key echoed in a successful model response", async () => {
    const apiKey = "LLM-SUCCESS-ECHO-SENTINEL";
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ choices: [{ message: { content: `echo ${apiKey}` } }] });
      },
    });
    try {
      const output = await chatCompletion(
        { endpoint: `http://localhost:${server.port}`, model: "test-model", apiKey },
        [{ role: "user", content: "hi" }],
      );
      expect(output).toBe("echo [REDACTED]");
    } finally {
      server.stop(true);
    }
  });

  test("redacts API key from 401 response body and keeps status + URL", async () => {
    const leakBody = '{"error":{"message":"Invalid API key sk-proj-LEAKYKEYABCDEF12345"}}';
    const { url, server } = createErrorServer(401, leakBody);
    try {
      const config: LlmConnectionConfig = {
        endpoint: url,
        model: "test-model",
        apiKey: "sk-proj-LEAKYKEYABCDEF12345",
      };
      let caught: Error | undefined;
      try {
        await chatCompletion(config, [{ role: "user", content: "hi" }]);
      } catch (err) {
        caught = err as Error;
      }
      expect(caught).toBeDefined();
      expect(caught?.message).toContain("(401)");
      expect(caught?.message).toContain(url);
      expect(caught?.message).not.toContain("sk-proj-LEAKYKEYABCDEF12345");
      expect(caught?.message).toContain("[REDACTED]");
    } finally {
      server.stop(true);
    }
  });

  test("trims oversized error body but keeps status code intact", async () => {
    const huge = "A".repeat(5000);
    const { url, server } = createErrorServer(503, huge);
    try {
      const config: LlmConnectionConfig = { endpoint: url, model: "test-model" };
      let caught: Error | undefined;
      try {
        await chatCompletion(config, [{ role: "user", content: "hi" }]);
      } catch (err) {
        caught = err as Error;
      }
      expect(caught).toBeDefined();
      expect(caught?.message).toContain("(503)");
      // Status + URL prefix should remain; the body portion is truncated.
      expect((caught?.message ?? "").length).toBeLessThan(huge.length);
    } finally {
      server.stop(true);
    }
  });

  test("redacts Bearer header echoed back by provider", async () => {
    const body = "Got header Authorization: Bearer abcXYZsupersecret999";
    const { url, server } = createErrorServer(403, body);
    try {
      const config: LlmConnectionConfig = { endpoint: url, model: "test-model", apiKey: "abcXYZsupersecret999" };
      let caught: Error | undefined;
      try {
        await chatCompletion(config, [{ role: "user", content: "hi" }]);
      } catch (err) {
        caught = err as Error;
      }
      expect(caught?.message).not.toContain("abcXYZsupersecret999");
      expect(caught?.message).toContain("Bearer [REDACTED]");
    } finally {
      server.stop(true);
    }
  });

  // The configured timeoutMs is honored via an AbortController whose abort
  // timer is scheduled for exactly that many milliseconds. These tests assert
  // that wiring deterministically with fake timers + a fetch stub that mirrors
  // real fetch semantics (resolve while the signal is live, reject with an
  // AbortError once it aborts). No real server, no wall-clock race — so the
  // result is identical regardless of how the parallel suite is scheduled.
  test("uses configured timeoutMs when provided (request faster than timeout succeeds)", async () => {
    jest.useFakeTimers();
    const originalFetch = globalThis.fetch;
    let capturedSignal: AbortSignal | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      // Resolve immediately: the request completes well before the 250ms abort
      // timer would fire, so the configured timeout must NOT cancel it.
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const config: LlmConnectionConfig = {
        endpoint: "http://localhost:0/v1/chat/completions",
        model: "test-model",
        timeoutMs: 250,
      };
      const out = await chatCompletion(config, [{ role: "user", content: "hi" }]);
      expect(out).toBe("ok");
      // The abort signal was wired in but never tripped for a fast response.
      expect(capturedSignal).toBeInstanceOf(AbortSignal);
      expect(capturedSignal?.aborted).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      jest.useRealTimers();
    }
  });

  test("aborts at the configured timeoutMs, not before", async () => {
    jest.useFakeTimers();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      // Mirror real fetch: a pending request stays unresolved until its signal
      // aborts, at which point it rejects with an AbortError DOMException.
      return new Promise<Response>((_resolve, reject) => {
        if (!signal) return;
        signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), {
          once: true,
        });
      });
    }) as typeof fetch;
    try {
      const config: LlmConnectionConfig = {
        endpoint: "http://localhost:0/v1/chat/completions",
        model: "test-model",
        timeoutMs: 250,
      };
      const pending = chatCompletion(config, [{ role: "user", content: "hi" }]);
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
      globalThis.fetch = originalFetch;
      jest.useRealTimers();
    }
  });
});

// ── HTML / non-JSON response categorization (#497) ──────────────────────────

function createResponseServer(
  statusCode: number,
  body: string,
  contentType = "text/html",
): { url: string; server: ReturnType<typeof Bun.serve> } {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(body, { status: statusCode, headers: { "Content-Type": contentType, Connection: "close" } });
    },
  });
  return { url: `http://localhost:${server.port}`, server };
}

const LM_STUDIO_HTML =
  '<!DOCTYPE html>\n<html lang="en"><head><title>LM Studio</title></head>' +
  '<body><div id="app">Loading…</div></body></html>';

describe("chatCompletion HTML response categorization", () => {
  async function callExpectingError(config: LlmConnectionConfig): Promise<LlmCallError> {
    let caught: unknown;
    try {
      await chatCompletion(config, [{ role: "user", content: "hi" }]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LlmCallError);
    return caught as LlmCallError;
  }

  test("HTML 500 body produces provider_html_error (not provider_error)", async () => {
    const { url, server } = createResponseServer(500, LM_STUDIO_HTML);
    try {
      const err = await callExpectingError({ endpoint: url, model: "test-model" });
      expect(err.code).toBe("provider_html_error");
      expect(err.statusCode).toBe(500);
      expect(err.message).toContain("(500)");
      expect(err.message).toContain(url);
      // Excerpt should be plain text (tags stripped).
      expect(err.message).not.toContain("<html");
      expect(err.message).toContain("LM Studio");
    } finally {
      server.stop(true);
    }
  });

  test("HTML 502 body also produces provider_html_error", async () => {
    const { url, server } = createResponseServer(502, LM_STUDIO_HTML);
    try {
      const err = await callExpectingError({ endpoint: url, model: "test-model" });
      expect(err.code).toBe("provider_html_error");
      expect(err.statusCode).toBe(502);
    } finally {
      server.stop(true);
    }
  });

  test("JSON 500 body still produces the generic provider_error path", async () => {
    const { url, server } = createResponseServer(500, '{"error":"upstream exploded"}', "application/json");
    try {
      const err = await callExpectingError({ endpoint: url, model: "test-model" });
      expect(err.code).toBe("provider_error");
      expect(err.statusCode).toBe(500);
    } finally {
      server.stop(true);
    }
  });

  test("non-error HTML 200 (where JSON expected) surfaces provider_html_error, not a raw SyntaxError", async () => {
    const { url, server } = createResponseServer(200, LM_STUDIO_HTML);
    try {
      const err = await callExpectingError({ endpoint: url, model: "test-model" });
      expect(err.code).toBe("provider_html_error");
      expect(err.statusCode).toBe(200);
      expect(err.message).not.toContain("<html");
    } finally {
      server.stop(true);
    }
  });

  test("malformed (non-HTML) JSON 200 still maps to parse_error", async () => {
    const { url, server } = createResponseServer(200, "this is not json {", "application/json");
    try {
      const err = await callExpectingError({ endpoint: url, model: "test-model" });
      expect(err.code).toBe("parse_error");
    } finally {
      server.stop(true);
    }
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
    endpoint: "http://localhost:0/v1/chat/completions",
    model: "test-model",
    timeoutMs: 5000,
  };

  test("500 then 200 returns the success body, fires onRetryAttempt once, does not throw", async () => {
    const originalFetch = globalThis.fetch;
    const { fetch: stub, calls } = queuedFetch([new Response("upstream boom", { status: 500 }), jsonOk("recovered")]);
    globalThis.fetch = stub;
    let retries = 0;
    try {
      const out = await chatCompletion(baseConfig, [{ role: "user", content: "hi" }], {
        sleep: fastSleep,
        onRetryAttempt: () => {
          retries += 1;
        },
      } as RetryTestOptions);
      expect(out).toBe("recovered");
      expect(retries).toBe(1);
      expect(calls()).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("500 then 500 throws the second provider_error and fires onRetryAttempt once", async () => {
    const originalFetch = globalThis.fetch;
    const { fetch: stub, calls } = queuedFetch([
      new Response("first", { status: 500 }),
      new Response("second", { status: 503 }),
    ]);
    globalThis.fetch = stub;
    let retries = 0;
    let caught: LlmCallError | undefined;
    try {
      await chatCompletion(baseConfig, [{ role: "user", content: "hi" }], {
        sleep: fastSleep,
        onRetryAttempt: () => {
          retries += 1;
        },
      } as RetryTestOptions);
    } catch (err) {
      caught = err as LlmCallError;
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(caught).toBeInstanceOf(LlmCallError);
    expect(caught?.code).toBe("provider_error");
    // The thrown error is the SECOND failure (503), not the first (500).
    expect(caught?.statusCode).toBe(503);
    expect(retries).toBe(1);
    expect(calls()).toBe(2);
  });

  test("4xx throws immediately with no retry and no callback", async () => {
    const originalFetch = globalThis.fetch;
    const { fetch: stub, calls } = queuedFetch([new Response("bad request", { status: 400 }), jsonOk("unreached")]);
    globalThis.fetch = stub;
    let retries = 0;
    let caught: LlmCallError | undefined;
    try {
      await chatCompletion(baseConfig, [{ role: "user", content: "hi" }], {
        sleep: fastSleep,
        onRetryAttempt: () => {
          retries += 1;
        },
      } as RetryTestOptions);
    } catch (err) {
      caught = err as LlmCallError;
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(caught?.code).toBe("provider_error");
    expect(caught?.statusCode).toBe(400);
    expect(retries).toBe(0);
    expect(calls()).toBe(1);
  });

  test("429 rate_limited is not retried", async () => {
    const originalFetch = globalThis.fetch;
    const { fetch: stub, calls } = queuedFetch([new Response("slow down", { status: 429 }), jsonOk("unreached")]);
    globalThis.fetch = stub;
    let retries = 0;
    let caught: LlmCallError | undefined;
    try {
      await chatCompletion(baseConfig, [{ role: "user", content: "hi" }], {
        sleep: fastSleep,
        onRetryAttempt: () => {
          retries += 1;
        },
      } as RetryTestOptions);
    } catch (err) {
      caught = err as LlmCallError;
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(caught?.code).toBe("rate_limited");
    expect(retries).toBe(0);
    expect(calls()).toBe(1);
  });

  test("timeout is not retried", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      // Mirror real fetch: reject with an AbortError once the timeout signal fires.
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }) as typeof fetch;
    let retries = 0;
    let caught: LlmCallError | undefined;
    try {
      await chatCompletion({ ...baseConfig, timeoutMs: 20 }, [{ role: "user", content: "hi" }], {
        sleep: fastSleep,
        onRetryAttempt: () => {
          retries += 1;
        },
      } as RetryTestOptions);
    } catch (err) {
      caught = err as LlmCallError;
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(caught?.code).toBe("timeout");
    expect(retries).toBe(0);
    expect(calls).toBe(1);
  });

  test("ECONNRESET network_error is retried then succeeds", async () => {
    const originalFetch = globalThis.fetch;
    const { fetch: stub, calls } = queuedFetch([
      () => {
        throw new Error("read ECONNRESET");
      },
      jsonOk("recovered"),
    ]);
    globalThis.fetch = stub;
    let retries = 0;
    try {
      const out = await chatCompletion(baseConfig, [{ role: "user", content: "hi" }], {
        sleep: fastSleep,
        onRetryAttempt: () => {
          retries += 1;
        },
      } as RetryTestOptions);
      expect(out).toBe("recovered");
      expect(retries).toBe(1);
      expect(calls()).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("Bun 'socket connection was closed' network_error is retried then succeeds", async () => {
    const originalFetch = globalThis.fetch;
    const { fetch: stub, calls } = queuedFetch([
      () => {
        // Bun 1.3.x surfaces a mid-flight dropped connection with this exact
        // message; it contains no ECONNRESET/EPIPE/"fetch failed" substring.
        throw new Error("The socket connection was closed unexpectedly.");
      },
      jsonOk("recovered"),
    ]);
    globalThis.fetch = stub;
    let retries = 0;
    try {
      const out = await chatCompletion(baseConfig, [{ role: "user", content: "hi" }], {
        sleep: fastSleep,
        onRetryAttempt: () => {
          retries += 1;
        },
      } as RetryTestOptions);
      expect(out).toBe("recovered");
      expect(retries).toBe(1);
      expect(calls()).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("context-overflow-classified 5xx is not retried", async () => {
    const originalFetch = globalThis.fetch;
    const { fetch: stub, calls } = queuedFetch([
      // Strict classifier: a context keyword PLUS token-count evidence. Bare
      // prose like "exceeds the context length" (no token count / "exceeded")
      // is intentionally NOT classified as overflow and IS retried (#496).
      new Response("This model's maximum context length is 8192 tokens, however you requested 9000 tokens", {
        status: 500,
      }),
      jsonOk("unreached"),
    ]);
    globalThis.fetch = stub;
    let retries = 0;
    let caught: LlmCallError | undefined;
    try {
      await chatCompletion(baseConfig, [{ role: "user", content: "hi" }], {
        sleep: fastSleep,
        onRetryAttempt: () => {
          retries += 1;
        },
      } as RetryTestOptions);
    } catch (err) {
      caught = err as LlmCallError;
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(caught?.code).toBe("provider_error");
    expect(retries).toBe(0);
    expect(calls()).toBe(1);
  });

  test("retry is skipped when the first attempt consumes >= 90% of timeoutMs", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    // First attempt fails with a retryable 500 but only after burning ~95% of
    // the budget, so the budget guard must suppress the retry.
    globalThis.fetch = (async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 460));
      return new Response("boom", { status: 500 });
    }) as unknown as typeof fetch;
    let retries = 0;
    let caught: LlmCallError | undefined;
    try {
      await chatCompletion({ ...baseConfig, timeoutMs: 500 }, [{ role: "user", content: "hi" }], {
        sleep: fastSleep,
        onRetryAttempt: () => {
          retries += 1;
        },
      } as RetryTestOptions);
    } catch (err) {
      caught = err as LlmCallError;
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(caught?.code).toBe("provider_error");
    expect(retries).toBe(0);
    expect(calls).toBe(1);
  });

  test("backoff jitter stays within the 200-800ms window", async () => {
    const originalFetch = globalThis.fetch;
    const { fetch: stub } = queuedFetch([new Response("boom", { status: 500 }), jsonOk("recovered")]);
    globalThis.fetch = stub;
    let observedMs = -1;
    try {
      await chatCompletion(baseConfig, [{ role: "user", content: "hi" }], {
        sleep: async (ms: number) => {
          observedMs = ms;
        },
      } as RetryTestOptions);
    } finally {
      globalThis.fetch = originalFetch;
    }
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
