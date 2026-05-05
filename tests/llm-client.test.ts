import { describe, expect, test } from "bun:test";
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
      server.stop();
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
      server.stop();
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
      server.stop();
    }
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

  test("returns undefined when no JSON object or array exists", () => {
    expect(parseEmbeddedJsonResponse("not json at all")).toBeUndefined();
  });
});
