import { describe, expect, jest, test } from "bun:test";
import type { LlmConnectionConfig } from "../src/core/config";
import { chatCompletion, parseEmbeddedJsonResponse, redactErrorBody } from "../src/llm/client";

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
      return new Response(body, { status: statusCode });
    },
  });
  return { url: `http://localhost:${server.port}`, server };
}

describe("chatCompletion error redaction", () => {
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
