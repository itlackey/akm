// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, test } from "bun:test";
import type { EmbeddingConnectionConfig } from "../src/core/config/config";
import { writeCredential } from "../src/core/config/credentials";
import { EmbeddingConnectionConfigSchema } from "../src/core/config/schema/embedding";
import { _setWarnSinkForTests } from "../src/core/warn";
import { deriveSemanticProviderFingerprint } from "../src/indexer/materialize-embeddings";
import { clearEmbeddingCache, getCachedEmbedding, setCachedEmbedding } from "../src/llm/embedders/cache";
import {
  applyEmbeddingTemplate,
  documentTemplateFingerprint,
  resolveEmbeddingProfile,
} from "../src/llm/embedders/profile";
import {
  _setEmbeddingTimeoutBackoffForTests,
  capEmbeddingText,
  DEFAULT_EMBEDDING_TIMEOUT_MS,
  DEFAULT_MAX_INPUT_TOKENS,
  DEFAULT_TOKEN_BUDGET,
  describeEmbeddingCredential,
  embeddingTimeoutRetryBackoffMs,
  estimateTokenCount,
  isContextExceededResponse,
  RemoteEmbedder,
  resolveEmbeddingConcurrency,
  resolveEmbeddingTimeoutMs,
} from "../src/llm/embedders/remote";
import type { EmbeddingVector } from "../src/llm/embedders/types";
import { clearCredentials } from "./_helpers/credentials";
import { withMockedFetch } from "./_helpers/sandbox";
import { overrideSeam } from "./_helpers/seams";

/**
 * #954: per-provider-batch commit, a bounded in-flight window (default 1 for
 * a loopback endpoint, 2 for a remote one; overridable via
 * `embedding.concurrency` per #954), and context-size
 * split-and-retry for RemoteEmbedder.embedBatch.
 *
 * All network I/O here is mocked via `withMockedFetch` (no real socket
 * opened), so this stays a pure unit test rather than an integration test.
 * The real-server
 * variants of the concurrency and context-split behavior live in
 * tests/integration/embedder.test.ts.
 */

/** A fetch mock that hangs until its request's abort signal fires, then rejects like real `fetch` does. */
function hungFetch(_url: string, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
  });
}

describe("isContextExceededResponse", () => {
  test("HTTP 413 is always a context-size rejection, regardless of body", () => {
    expect(isContextExceededResponse(413, "")).toBe(true);
    expect(isContextExceededResponse(413, "some unrelated body")).toBe(true);
  });

  test("recognises named context-size error bodies on other status codes", () => {
    expect(isContextExceededResponse(400, '{"error":"exceed_context_size_error"}')).toBe(true);
    expect(isContextExceededResponse(400, "Request exceeds the model's context size")).toBe(true);
    expect(isContextExceededResponse(400, "context length exceeded")).toBe(true);
    expect(isContextExceededResponse(500, "too many tokens in request")).toBe(true);
    expect(isContextExceededResponse(400, "EXCEED_CONTEXT_SIZE_ERROR")).toBe(true);
  });

  test("a generic failure is not a context-size rejection", () => {
    expect(isContextExceededResponse(500, "synthetic upstream failure")).toBe(false);
    expect(isContextExceededResponse(503, "service unavailable")).toBe(false);
    expect(isContextExceededResponse(400, "")).toBe(false);
  });

  test("recognises llama.cpp's physical-batch rejection (#954)", () => {
    // The exact message llama.cpp returns (HTTP 500) when a batch exceeds
    // its configured physical batch size.
    expect(isContextExceededResponse(500, "input is too large to process. increase the physical batch size")).toBe(
      true,
    );
    expect(isContextExceededResponse(500, "ubatch size exceeded")).toBe(true);
    expect(isContextExceededResponse(500, "INPUT IS TOO LARGE TO PROCESS")).toBe(true);
  });
});

describe("RemoteEmbedder.embedBatch: failed-batch visibility (#954, field-report follow-up)", () => {
  test("a failed provider batch is reported via onSkip/onBatch, not warn() — the materializer's per-batch line is the single default-level report, not a second one here", async () => {
    // Regression guard for a round-2 review finding: this used to ALSO
    // warn() the identical "batch of N document(s) failed and was skipped"
    // sentence, duplicating the default-level per-batch line
    // materialize-embeddings.ts's onBatch now prints for the same event —
    // the same class of double-print bug fixed for the truncation/re-embed-
    // reason lines (#954).
    const calls: Array<{ level: string; message: string }> = [];
    _setWarnSinkForTests((level, args) => {
      calls.push({ level, message: args.map(String).join(" ") });
    });
    try {
      const skips: Array<{ reason: string; message: string }> = [];
      const committed: Array<{ outcome?: string; reason?: string }> = [];
      await withMockedFetch(
        async () => {
          const embedder = new RemoteEmbedder({ endpoint: "http://localhost:9", model: "test" });
          await embedder.embedBatch(
            ["doc one", "doc two"],
            undefined,
            (skip) => skips.push(skip),
            (_indices, _embeddings, outcome) => committed.push({ outcome: outcome?.outcome, reason: outcome?.reason }),
          );
        },
        () => new Response("synthetic upstream failure", { status: 500 }),
      );
      expect(calls.some((c) => c.message.includes("document(s) failed and was skipped"))).toBe(false);
      expect(skips).toHaveLength(2);
      expect(skips[0]?.reason).toBe("batch-request-failed");
      expect(committed).toHaveLength(1);
      expect(committed[0]?.outcome).toBe("failed");
      expect(committed[0]?.reason).toContain("synthetic upstream failure");
    } finally {
      _setWarnSinkForTests(undefined);
    }
  });
});

describe("resolveEmbeddingTimeoutMs (#954)", () => {
  test("defaults to 120s when embedding.timeoutMs is unset", () => {
    expect(resolveEmbeddingTimeoutMs({})).toBe(DEFAULT_EMBEDDING_TIMEOUT_MS);
    expect(DEFAULT_EMBEDDING_TIMEOUT_MS).toBe(120_000);
  });

  test("uses the configured value when set", () => {
    expect(resolveEmbeddingTimeoutMs({ timeoutMs: 5_000 })).toBe(5_000);
  });

  test("the configured value reaches fetchWithTimeout for embed()", async () => {
    await withMockedFetch(async () => {
      const embedder = new RemoteEmbedder({ endpoint: "http://localhost:9", model: "test", timeoutMs: 30 });
      await expect(embedder.embed("hello")).rejects.toThrow(/timed out after 30ms/);
    }, hungFetch);
  });

  test("the configured value reaches fetchWithTimeout for embedBatch()/requestBatch()", async () => {
    await withMockedFetch(async () => {
      const embedder = new RemoteEmbedder({ endpoint: "http://localhost:9", model: "test", timeoutMs: 30 });
      const skips: Array<{ message: string }> = [];
      const results = await embedder.embedBatch(["doc one"], undefined, (skip) => skips.push(skip));
      expect(results).toEqual([undefined]);
      expect(skips[0]?.message).toContain("timed out after 30ms");
    }, hungFetch);
  });
});

describe("embeddingTimeoutRetryBackoffMs: grows with timeoutAttempt (#954, field-report follow-up)", () => {
  test("doubles per attempt off the 5s/60s default, floored at half the jittered value", () => {
    // backoffDelay's formula is baseMs * 2^attempt * (0.5 + random*0.5), so
    // the minimum possible value at one attempt is baseMs * 2^attempt * 0.5
    // — a strict, deterministic lower bound regardless of jitter.
    expect(embeddingTimeoutRetryBackoffMs(0)).toBeGreaterThanOrEqual(2_500);
    expect(embeddingTimeoutRetryBackoffMs(0)).toBeLessThan(5_000);
    expect(embeddingTimeoutRetryBackoffMs(1)).toBeGreaterThanOrEqual(5_000);
    expect(embeddingTimeoutRetryBackoffMs(1)).toBeLessThan(10_000);
    expect(embeddingTimeoutRetryBackoffMs(2)).toBeGreaterThanOrEqual(10_000);
    expect(embeddingTimeoutRetryBackoffMs(2)).toBeLessThan(20_000);
  });

  test("caps at 60s regardless of how deep the attempt count goes", () => {
    expect(embeddingTimeoutRetryBackoffMs(10)).toBe(60_000);
  });

  test("omitting timeoutAttempt behaves as attempt 0 (the original single-retry call site)", () => {
    expect(embeddingTimeoutRetryBackoffMs()).toBeGreaterThanOrEqual(2_500);
    expect(embeddingTimeoutRetryBackoffMs()).toBeLessThan(5_000);
  });

  test("the test-only base/max override lets a test shrink real wait time without changing the shape", () => {
    overrideSeam(_setEmbeddingTimeoutBackoffForTests, { baseMs: 100, maxMs: 1_000 });
    expect(embeddingTimeoutRetryBackoffMs(0)).toBeGreaterThanOrEqual(50);
    expect(embeddingTimeoutRetryBackoffMs(0)).toBeLessThan(100);
    expect(embeddingTimeoutRetryBackoffMs(1)).toBeGreaterThanOrEqual(100);
    expect(embeddingTimeoutRetryBackoffMs(1)).toBeLessThan(200);
    expect(embeddingTimeoutRetryBackoffMs(20)).toBe(1_000);
  });
});

describe("resolveEmbeddingConcurrency", () => {
  test("defaults to 1 for a loopback endpoint when embedding.concurrency is unset (#954)", () => {
    expect(resolveEmbeddingConcurrency({ endpoint: "http://localhost:8080" })).toBe(1);
    expect(resolveEmbeddingConcurrency({ endpoint: "http://127.0.0.1:8080" })).toBe(1);
  });

  test("defaults to 1 when no endpoint is configured (fails safe as local)", () => {
    expect(resolveEmbeddingConcurrency({})).toBe(1);
  });

  test("defaults to 2 for a remote endpoint", () => {
    expect(resolveEmbeddingConcurrency({ endpoint: "https://api.example.com/v1" })).toBe(2);
  });

  test("embedding.concurrency overrides the default in either direction (#954)", () => {
    expect(resolveEmbeddingConcurrency({ endpoint: "http://localhost:8080", concurrency: 8 })).toBe(8);
    expect(resolveEmbeddingConcurrency({ endpoint: "https://api.example.com/v1", concurrency: 1 })).toBe(1);
  });
});

describe("RemoteEmbedder.embedBatch: contextLength no longer affects the request token budget (#956)", () => {
  test("a batch is split by config.maxTokens, not config.contextLength", async () => {
    const requestSizes: number[] = [];
    await withMockedFetch(
      async () => {
        // contextLength set very low (would force single-document batches if
        // it still fed the token budget) and maxTokens left unset, so the
        // DEFAULT_TOKEN_BUDGET (6000 tokens, #954) is what actually governs
        // batching. Five short documents easily fit one 6000-token request.
        const embedder = new RemoteEmbedder({
          endpoint: "http://localhost:1/v1",
          model: "test-model",
          contextLength: 8,
        });
        const results = await embedder.embedBatch(["a", "bb", "ccc", "dddd", "eeeee"]);
        expect(results.every((r) => r !== undefined)).toBe(true);
      },
      async (_url, init) => {
        const body = JSON.parse(init?.body as string) as { input: string[] };
        requestSizes.push(body.input.length);
        const data = body.input.map((_t, i) => ({ embedding: [1, 0], index: i }));
        return jsonResponse({ data });
      },
    );
    // All 5 documents in a single request — proof contextLength: 8 did NOT
    // shrink the token budget down to single-document batches.
    expect(requestSizes).toEqual([5]);
  });

  test("config.maxTokens still governs the budget as before, even alongside a large contextLength", async () => {
    const requestSizes: number[] = [];
    await withMockedFetch(
      async () => {
        // contextLength set huge so it would rescue this document from the
        // oversized path if it still fed the token budget at all — proof
        // maxTokens alone decides this, unaffected by contextLength either way.
        const embedder = new RemoteEmbedder({
          endpoint: "http://localhost:1/v1",
          model: "test-model",
          maxTokens: 10,
          contextLength: 1_000_000,
        });
        const skips: Array<{ reason: string }> = [];
        const results = await embedder.embedBatch(["x".repeat(200)], undefined, (skip) => skips.push(skip));
        expect(results).toEqual([undefined]);
        expect(skips[0]?.reason).toBe("context-window-exceeded");
      },
      async (_url, init) => {
        const body = JSON.parse(init?.body as string) as { input: string[] };
        requestSizes.push(body.input.length);
        return jsonResponse({ data: [{ embedding: [1, 0], index: 0 }] });
      },
    );
    // No provider request at all — the oversized pre-flight skip never dispatches one.
    expect(requestSizes).toEqual([]);
  });

  test("contextLength still reaches Ollama's num_ctx (unchanged — #956 only touches the token budget)", async () => {
    let sentOptions: unknown;
    await withMockedFetch(
      async () => {
        const embedder = new RemoteEmbedder({
          endpoint: "http://localhost:11434/api/embed",
          model: "test-model",
          contextLength: 4096,
        });
        await embedder.embed("hello");
      },
      async (_url, init) => {
        const body = JSON.parse(init?.body as string) as { options?: unknown };
        sentOptions = body.options;
        return jsonResponse({ data: [{ embedding: [1, 0] }] });
      },
    );
    expect(sentOptions).toEqual({ num_ctx: 4096 });
  });
});

describe("EmbeddingConnectionConfigSchema: embedding.concurrency bounds (#954)", () => {
  test("accepts 1 and 16", () => {
    expect(EmbeddingConnectionConfigSchema.safeParse({ concurrency: 1 }).success).toBe(true);
    expect(EmbeddingConnectionConfigSchema.safeParse({ concurrency: 16 }).success).toBe(true);
  });

  test("rejects 0 and 17", () => {
    expect(EmbeddingConnectionConfigSchema.safeParse({ concurrency: 0 }).success).toBe(false);
    expect(EmbeddingConnectionConfigSchema.safeParse({ concurrency: 17 }).success).toBe(false);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("RemoteEmbedder.embedBatch: context-size split-and-retry", () => {
  test("a batch rejected as context-exceeded is split in half and retried until it fits", async () => {
    const requestSizes: number[] = [];
    await withMockedFetch(
      async () => {
        const embedder = new RemoteEmbedder({ endpoint: "http://localhost:1/v1", model: "test-model" });
        const committed: Array<{ indices: number[]; embeddings: (EmbeddingVector | undefined)[]; outcome?: string }> =
          [];
        const results = await embedder.embedBatch(
          ["a", "bb", "ccc", "dddd"],
          undefined,
          undefined,
          (indices, embeddings, outcome) => committed.push({ indices, embeddings, outcome: outcome?.outcome }),
        );

        // Every text ends up embedded; none skipped.
        expect(results).toHaveLength(4);
        expect(results.every((r) => r !== undefined)).toBe(true);
        // This batch's own rejection is also the run's FIRST context-size
        // rejection (#954), so it additionally fires one budget-lowered
        // notification commit alongside the 4 settled (one-per-text) ones —
        // see the adaptive-budget describe block below for that event's own
        // coverage; this test stays about the split-and-retry shape itself.
        const settled = committed.filter((c) => c.outcome !== "budget-lowered");
        expect(settled).toHaveLength(4);
        expect(settled.flatMap((c) => c.indices).sort()).toEqual([0, 1, 2, 3]);
        expect(committed.filter((c) => c.outcome === "budget-lowered")).toHaveLength(1);
        // Requests: size 4 (413) -> left half [0,1] size 2 (413) -> [0] then
        // [1] (200 each) -> right half [2,3] size 2 (413) -> [2] then [3]
        // (200 each). The left branch fully resolves before the right starts.
        expect(requestSizes).toEqual([4, 2, 1, 1, 2, 1, 1]);
      },
      async (_url, init) => {
        const body = JSON.parse(init?.body as string) as { input: string[] };
        requestSizes.push(body.input.length);
        if (body.input.length > 1) {
          return jsonResponse({ error: { message: "exceed_context_size_error: request too large" } }, 413);
        }
        return jsonResponse({ data: [{ embedding: [1, 0], index: 0 }] });
      },
    );
  });

  test("a size-1 batch that still fails as context-exceeded is skipped with the context-window-exceeded reason", async () => {
    await withMockedFetch(
      async () => {
        const embedder = new RemoteEmbedder({ endpoint: "http://localhost:1/v1", model: "test-model" });
        const skips: Array<{ index: number; reason: string }> = [];
        const results = await embedder.embedBatch(["a", "b"], undefined, (skip) => skips.push(skip));
        expect(results).toEqual([undefined, undefined]);
        expect(skips).toHaveLength(2);
        for (const skip of skips) expect(skip.reason).toBe("context-window-exceeded");
      },
      async () => jsonResponse({ error: { message: "context length exceeded" } }, 413),
    );
  });

  test("a non-context-size failure keeps skipping the whole batch, not splitting it (#874 behavior preserved)", async () => {
    let requestCount = 0;
    await withMockedFetch(
      async () => {
        const embedder = new RemoteEmbedder({ endpoint: "http://localhost:1/v1", model: "test-model" });
        const skips: Array<{ index: number; reason: string }> = [];
        const results = await embedder.embedBatch(["a", "b", "c"], undefined, (skip) => skips.push(skip));
        expect(results).toEqual([undefined, undefined, undefined]);
        expect(skips).toHaveLength(3);
        for (const skip of skips) expect(skip.reason).toBe("batch-request-failed");
      },
      async () => {
        requestCount++;
        return new Response("synthetic upstream failure", { status: 500 });
      },
    );
    // A single request for the whole batch — no splitting on a generic 500.
    expect(requestCount).toBe(1);
  });
});

describe("DEFAULT_TOKEN_BUDGET (#954, field report on beta.1)", () => {
  test("defaults to 6000, lowered from 8000 after the field's undercount evidence", () => {
    expect(DEFAULT_TOKEN_BUDGET).toBe(6000);
  });
});

describe("RemoteEmbedder.embedBatch: run-scoped adaptive request budget after a context-size rejection (#954)", () => {
  /** Provider's real tokenizer counts this much denser than akm's 4-chars-per-token estimate (field-measured 7-55% undercount on dense text). */
  const PROVIDER_DENSITY_FACTOR = 1.4;
  /** The field's llama.cpp embedder's real context window, in the provider's own (denser) token count. */
  const PROVIDER_CONTEXT_WINDOW = 8192;
  /** Uniform per-document size (chars) chosen so estimateTokenCount is exact: 2340 / 4 = 585 tokens. */
  const DOC_CHARS = 2340;

  function llamaCppRejection(): Response {
    return new Response(
      JSON.stringify({ error: { message: "input is too large to process. increase the physical batch size" } }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  test("shrinks the budget once on the first rejection, re-plans undispatched batches, and finishes with every vector stored", async () => {
    const docCount = 34;
    const texts = Array.from({ length: docCount }, () => "x".repeat(DOC_CHARS));
    const requestDocCounts: number[] = [];
    let rejections = 0;

    const committed: Array<{ indices: number[]; embeddings: unknown[]; outcome?: string; reason?: string }> = [];
    const skips: Array<{ index: number; reason: string }> = [];

    const results = await withMockedFetch(
      async () => {
        // maxTokens set explicitly to the OLD default (8000) — reproducing a
        // field config that has not adopted the new 6000 default — proves
        // the adaptive shrink rescues the run regardless of the starting
        // budget, not just the new default's own headroom.
        const embedder = new RemoteEmbedder({
          endpoint: "http://localhost:1/v1",
          model: "test-model",
          maxTokens: 8000,
        });
        return embedder.embedBatch(
          texts,
          undefined,
          (skip) => skips.push(skip),
          (indices, embeddings, outcome) =>
            committed.push({ indices, embeddings, outcome: outcome?.outcome, reason: outcome?.reason }),
        );
      },
      async (_url, init) => {
        const body = JSON.parse(init?.body as string) as { input: string[] };
        requestDocCounts.push(body.input.length);
        const estimatedTokens = body.input.reduce((sum, t) => sum + estimateTokenCount(t), 0);
        const providerTokens = Math.round(estimatedTokens * PROVIDER_DENSITY_FACTOR);
        if (providerTokens > PROVIDER_CONTEXT_WINDOW) {
          rejections++;
          return llamaCppRejection();
        }
        const data = body.input.map((_t, i) => ({ embedding: [1, 0], index: i }));
        return new Response(JSON.stringify({ data }), { headers: { "Content-Type": "application/json" } });
      },
    );

    // Every document ends up embedded — the shrink recovers the run rather
    // than letting the split-and-retry chain alone grind through it.
    expect(results).toHaveLength(docCount);
    expect(results.every((r) => r !== undefined)).toBe(true);
    expect(skips).toHaveLength(0);

    // The 8000-token budget really did overflow the provider's real (denser)
    // context window at least once — otherwise this test would not be
    // exercising the shrink at all.
    expect(rejections).toBe(1);

    // First request is the full un-shrunk batch (13 docs at 8000 tokens);
    // later requests are all sized against the shrunk 6000-token budget
    // (<=10 docs) or the mid-split halves of the rejected batch (<=7 docs).
    expect(requestDocCounts[0]).toBe(13);
    expect(requestDocCounts.every((n) => n <= 13)).toBe(true);
    expect(requestDocCounts.slice(1).every((n) => n <= 10)).toBe(true);

    // Exactly one "budget-lowered" notice, naming the rejected request's own
    // token count and the new (three-quarters, 8000 -> 6000) budget.
    const budgetLines = committed.filter((c) => c.outcome === "budget-lowered");
    expect(budgetLines).toHaveLength(1);
    expect(budgetLines[0]?.reason).toContain("request budget lowered to 6,000 for the rest of this run");
  });

  test("a second rejection after the shrink does not shrink the budget again", async () => {
    // Each 3000-token document fits both the original 5000-token budget and
    // the shrunk 3750-token one (round(5000 * 0.75)) on its own, but never
    // alongside a sibling (2x3000 > either budget) — so every batch is a
    // real single-document request, and a provider that rejects
    // unconditionally keeps producing genuine context-size rejections after
    // the shrink too, not pre-flight oversized skips.
    const docTokens = 3000;
    const texts = ["a", "b", "c"].map((c) => c.repeat(docTokens * 4));
    const committed: Array<{ outcome?: string; reason?: string }> = [];
    const skips: Array<{ index: number; reason: string }> = [];
    let requestCount = 0;

    await withMockedFetch(
      async () => {
        const embedder = new RemoteEmbedder({
          endpoint: "http://localhost:1/v1",
          model: "test-model",
          maxTokens: 5000,
        });
        await embedder.embedBatch(
          texts,
          undefined,
          (skip) => skips.push(skip),
          (_indices, _embeddings, outcome) => committed.push({ outcome: outcome?.outcome, reason: outcome?.reason }),
        );
      },
      async () => {
        requestCount++;
        return new Response("context length exceeded", { status: 413 });
      },
    );

    // Three real, genuinely-rejected requests (one per document) — proof the
    // second and third rejections are real provider round-trips, not
    // pre-flight oversized skips that would never call fetch at all.
    expect(requestCount).toBe(3);
    const budgetLines = committed.filter((c) => c.outcome === "budget-lowered");
    expect(budgetLines).toHaveLength(1);
    expect(skips.every((s) => s.reason === "context-window-exceeded")).toBe(true);
    expect(skips).toHaveLength(3);
  });
});

describe("RemoteEmbedder.embedBatch: bounded concurrency (default 1 loopback / 2 remote, unset override)", () => {
  test("a remote endpoint dispatches at most 2 requests at once and preserves result-to-index placement", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    // Each text gets a distinct, already-unit-length raw vector (a point on
    // the unit circle) so l2Normalize is a no-op and the returned vector
    // stays a reliable fingerprint of WHICH text the server answered for,
    // independent of completion order under concurrency. Fetch is fully
    // mocked, so this non-loopback hostname never actually resolves — it
    // only needs to classify as "remote" for resolveEmbeddingConcurrency.
    const texts = ["a", "bb", "ccc", "dddd", "eeeee", "ffffff"];
    const results = await withMockedFetch(
      async () => {
        const embedder = new RemoteEmbedder({
          endpoint: "https://embed.example.com/v1",
          model: "test-model",
          batchSize: 1,
        });
        return embedder.embedBatch(texts);
      },
      async (_url, init) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const body = JSON.parse(init?.body as string) as { input: string[] };
        await new Promise((resolve) => setTimeout(resolve, 15));
        inFlight--;
        const data = body.input.map((text) => {
          const i = texts.indexOf(text);
          return { embedding: [Math.cos(i), Math.sin(i)], index: 0 };
        });
        return jsonResponse({ data });
      },
    );

    results.forEach((vec, i) => {
      expect(vec).toBeDefined();
      expect((vec as EmbeddingVector)[0]).toBeCloseTo(Math.cos(i), 5);
      expect((vec as EmbeddingVector)[1]).toBeCloseTo(Math.sin(i), 5);
    });
    expect(maxInFlight).toBe(2); // fixed remote width — genuine overlap happened, never more than 2
  });

  test("a loopback endpoint never overlaps requests (fixed width 1)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await withMockedFetch(
      async () => {
        const embedder = new RemoteEmbedder({
          endpoint: "http://localhost:1/v1",
          model: "test-model",
          batchSize: 1,
        });
        return embedder.embedBatch(["a", "b", "c", "d"]);
      },
      async (_url, init) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const body = JSON.parse(init?.body as string) as { input: string[] };
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight--;
        const data = body.input.map(() => ({ embedding: [1, 0], index: 0 }));
        return jsonResponse({ data });
      },
    );
    expect(maxInFlight).toBe(1);
  });

  test("caller abort propagates as a rejection even through the pool", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop embedding"));
    await withMockedFetch(
      async () => {
        const embedder = new RemoteEmbedder({ endpoint: "http://localhost:1/v1", model: "test-model" });
        await expect(embedder.embedBatch(["a", "b", "c"], controller.signal)).rejects.toThrow(/stop embedding/);
      },
      async () => jsonResponse({ data: [{ embedding: [1, 0], index: 0 }] }),
    );
  });
});

describe("RemoteEmbedder.embedBatch: onBatch commit callback", () => {
  test("fires once per provider batch (including an oversized pre-flight skip), not once for the whole call", async () => {
    await withMockedFetch(
      async () => {
        const embedder = new RemoteEmbedder({ endpoint: "http://localhost:1/v1", model: "test-model", maxTokens: 10 });
        const committed: Array<{ indices: number[]; embeddings: (EmbeddingVector | undefined)[] }> = [];
        const results = await embedder.embedBatch(
          ["small", "x".repeat(200) /* oversized */],
          undefined,
          undefined,
          (indices, embeddings) => committed.push({ indices, embeddings }),
        );
        expect(results[0]).toBeDefined();
        expect(results[1]).toBeUndefined();
        // One commit for the small doc's real request, one for the oversized skip.
        expect(committed).toHaveLength(2);
        const oversizedCommit = committed.find((c) => c.indices[0] === 1);
        expect(oversizedCommit?.embeddings).toEqual([undefined]);
      },
      async () => jsonResponse({ data: [{ embedding: [1, 0], index: 0 }] }),
    );
  });

  test("a throw from onBatch propagates out of embedBatch, not swallowed or misreported as a provider failure", async () => {
    // Regression for a round-1 review finding: onBatch used to be invoked
    // from inside the same try/catch that classifies requestBatch's own
    // provider/network failures, so a persistence failure inside the
    // caller's onBatch (e.g. materialize-embeddings.ts's db.transaction()
    // throwing on a real competing-process SQLITE_BUSY lock) was
    // misclassified as a fabricated "batch-request-failed" skip and then
    // silently absorbed by concurrentMap's per-item catch — no error ever
    // reached the caller.
    await withMockedFetch(
      async () => {
        const embedder = new RemoteEmbedder({ endpoint: "http://localhost:1/v1", model: "test-model" });
        const skips: Array<{ reason: string }> = [];
        const persistError = new Error("simulated SQLITE_BUSY from a competing process");
        await expect(
          embedder.embedBatch(
            ["solo"],
            undefined,
            (skip) => skips.push(skip),
            () => {
              throw persistError;
            },
          ),
        ).rejects.toThrow(/simulated SQLITE_BUSY/);
        // The embedding request itself succeeded — onBatch's own failure
        // must never be reported as if the batch request had failed.
        expect(skips).toHaveLength(0);
      },
      async () => jsonResponse({ data: [{ embedding: [1, 0], index: 0 }] }),
    );
  });

  test("every provider batch commits, not just the last one", async () => {
    const config: EmbeddingConnectionConfig = {
      endpoint: "http://localhost:1/v1",
      model: "test-model",
      batchSize: 2,
    };
    await withMockedFetch(
      async () => {
        const embedder = new RemoteEmbedder(config);
        const committed: number[][] = [];
        await embedder.embedBatch(["a", "b", "c", "d"], undefined, undefined, (indices) => committed.push(indices));
        expect(committed.flatMap((i) => i).sort()).toEqual([0, 1, 2, 3]);
        expect(committed.length).toBe(2); // batchSize 2 → two provider batches
      },
      async (_url, init) => {
        const body = JSON.parse(init?.body as string) as { input: string[] };
        const data = body.input.map((_t, i) => ({ embedding: [1, 0], index: i }));
        return jsonResponse({ data });
      },
    );
  });
});

describe("RemoteEmbedder.embedBatch: stops dispatching after the first onBatch failure (#954 gap fix)", () => {
  test("no further provider request is made once onBatch throws, with several batches queued", async () => {
    let requestCount = 0;
    let onBatchCalls = 0;
    const persistError = new Error("simulated persistence failure");
    await withMockedFetch(
      async () => {
        // Loopback => fixed concurrency 1, so only ONE provider batch is ever
        // in flight — a completely deterministic way to prove the pool never
        // claims a next batch once dispatch has stopped, with no reliance on
        // fetch resolution order under concurrency 2.
        const embedder = new RemoteEmbedder({
          endpoint: "http://localhost:1/v1",
          model: "test-model",
          batchSize: 1,
        });
        await expect(
          embedder.embedBatch(["a", "b", "c", "d"], undefined, undefined, () => {
            onBatchCalls++;
            throw persistError;
          }),
        ).rejects.toThrow(/simulated persistence failure/);
      },
      async () => {
        requestCount++;
        return jsonResponse({ data: [{ embedding: [1, 0], index: 0 }] });
      },
    );
    // 4 texts, batchSize 1 => 4 possible provider batches queued. Only the
    // very first is ever requested; the pool must not claim (and therefore
    // never dispatches HTTP requests for) batches 2-4 once onBatch fails.
    expect(requestCount).toBe(1);
    expect(onBatchCalls).toBe(1);
  });
});

describe("describeEmbeddingCredential (#953)", () => {
  afterEach(() => {
    clearCredentials();
  });

  test("no apiKey with nothing stored reports 'none configured'", () => {
    expect(describeEmbeddingCredential({ endpoint: "http://embed.invalid/v1" })).toBe("none configured");
  });

  test("a stored key reports 'credentials.json', never the value", () => {
    writeCredential({ service: "embedding" }, "sk-super-secret-value-do-not-log", "http://embed.invalid/v1");
    const description = describeEmbeddingCredential({ endpoint: "http://embed.invalid/v1" });
    expect(description).toBe("credentials.json");
    expect(description).not.toContain("sk-super-secret-value-do-not-log");
  });

  test("an embedding on a connection reads the key stored under the connection's name", () => {
    writeCredential({ connection: "default" }, "connection-key", "http://embed.invalid/v1");
    const endpoint = "http://embed.invalid/v1";
    expect(describeEmbeddingCredential({ endpoint, credentialName: "default" })).toBe("credentials.json");
    expect(describeEmbeddingCredential({ endpoint })).toBe("none configured");
  });

  test("a $VAR-style reference names the reference and its source", () => {
    expect(describeEmbeddingCredential({ apiKey: "$LAB_API_KEY" })).toBe("$LAB_API_KEY (env)");
    const braced = "$" + "{LAB_API_KEY}";
    expect(describeEmbeddingCredential({ apiKey: braced })).toBe(`${braced} (env)`);
  });
});

/**
 * The embedding cache is a module-level LRU (capacity 100). These tests pin
 * the eviction contract, including the regression where overwriting an
 * already-present key at capacity evicted an unrelated oldest entry.
 */
describe("embedding cache LRU eviction", () => {
  const CAP = 100;

  afterEach(() => clearEmbeddingCache());

  function fill(n: number): void {
    for (let i = 0; i < n; i++) setCachedEmbedding(`k${i}`, [i]);
  }

  test("evicts the oldest entry when a NEW key is inserted at capacity", () => {
    fill(CAP); // k0..k99
    setCachedEmbedding("k100", [100]); // new key → oldest (k0) evicted
    expect(getCachedEmbedding("k0")).toBeUndefined();
    expect(getCachedEmbedding("k100")).toEqual([100]);
    expect(getCachedEmbedding("k99")).toEqual([99]);
  });

  test("overwriting an EXISTING key at capacity does NOT evict another entry", () => {
    fill(CAP); // k0..k99, k0 is the oldest
    // Overwrite an existing key. A Map.set on an existing key does not grow the
    // map, so nothing should be evicted — k0 must survive.
    setCachedEmbedding("k50", [500]);
    expect(getCachedEmbedding("k0")).toEqual([0]);
    expect(getCachedEmbedding("k50")).toEqual([500]);
  });

  test("re-inserting an existing key refreshes its LRU recency", () => {
    fill(CAP); // k0 oldest
    setCachedEmbedding("k0", [0]); // touch k0 → now most-recently-used
    setCachedEmbedding("k100", [100]); // new key evicts the now-oldest (k1)
    expect(getCachedEmbedding("k0")).toEqual([0]); // survived
    expect(getCachedEmbedding("k1")).toBeUndefined(); // evicted instead
  });

  test("getCachedEmbedding promotes an entry so it survives the next eviction", () => {
    fill(CAP); // k0 oldest
    getCachedEmbedding("k0"); // promote k0 to MRU
    setCachedEmbedding("k100", [100]); // evicts k1 (new oldest), not k0
    expect(getCachedEmbedding("k0")).toEqual([0]);
    expect(getCachedEmbedding("k1")).toBeUndefined();
  });
});

/**
 * #956: the per-document embedding cap (`embedding.maxInputTokens`,
 * default 512) truncates the embedded text to its head instead of skipping
 * the whole document — this pins the pure truncation helper in isolation
 * from the materializer that calls it (tests/integration/indexer/materialize-embeddings-cap.test.ts).
 */

describe("DEFAULT_MAX_INPUT_TOKENS", () => {
  test("is 512", () => {
    expect(DEFAULT_MAX_INPUT_TOKENS).toBe(512);
  });
});

describe("capEmbeddingText", () => {
  test("leaves text under the cap unchanged", () => {
    const result = capEmbeddingText("short text", 512);
    expect(result).toEqual({ text: "short text", truncated: false });
  });

  test("leaves text exactly at the cap unchanged", () => {
    const text = "x".repeat(2048); // estimateTokenCount = 512
    expect(estimateTokenCount(text)).toBe(512);
    const result = capEmbeddingText(text, 512);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe(text);
  });

  test("truncates a 2000-token entry to its head instead of skipping it", () => {
    const text = "x".repeat(8000); // estimateTokenCount = 2000
    const result = capEmbeddingText(text, 512);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.text.length).toBeLessThan(text.length);
    expect(result.text).toBe(text.slice(0, result.text.length));
    // The truncated head itself must fit the cap.
    expect(estimateTokenCount(result.text)).toBeLessThanOrEqual(512);
  });

  test("empty text stays empty and is not reported as truncated", () => {
    const result = capEmbeddingText("", 512);
    expect(result).toEqual({ text: "", truncated: false });
  });

  test("never splits a UTF-16 surrogate pair at the cut boundary", () => {
    // U+1F600 (😀) is a surrogate pair in UTF-16. Pad so the cut boundary
    // would otherwise land exactly between its two code units.
    const emoji = "\u{1F600}"; // 2 UTF-16 code units
    const padLen = 512 * 4 - 1; // cap's char budget minus 1, so the pair straddles the cut
    const text = "x".repeat(padLen) + emoji + "y".repeat(100);
    const result = capEmbeddingText(text, 512);
    expect(result.truncated).toBe(true);
    // A valid string never contains a lone surrogate.
    expect(result.text).toBe(Array.from(result.text).join(""));
    for (let i = 0; i < result.text.length; i++) {
      const code = result.text.charCodeAt(i);
      const isLowSurrogate = code >= 0xdc00 && code <= 0xdfff;
      if (isLowSurrogate) {
        // Must be paired with a preceding high surrogate, never dangling.
        const prev = result.text.charCodeAt(i - 1);
        expect(prev >= 0xd800 && prev <= 0xdbff).toBe(true);
      }
    }
  });
});

/**
 * Embedding profiles: query and document templates matched on the model
 * name, config overrides, template application, and the document template's
 * place in the embedding fingerprint.
 */

const remote = (model: string, extra: Record<string, unknown> = {}) => ({
  endpoint: "https://embed.example/v1/embeddings",
  model,
  ...extra,
});

const QWEN3_QUERY = "Instruct: Given a question or task, retrieve the knowledge asset that helps with it\nQuery:{text}";
const RETRIEVAL_QUERY = "Represent this sentence for searching relevant passages: {text}";

describe("resolveEmbeddingProfile presets", () => {
  test.each([
    ["embed/qwen3-embedding-0.6b", { queryTemplate: QWEN3_QUERY }],
    ["Qwen/Qwen3-Embedding-8B", { queryTemplate: QWEN3_QUERY }],
    ["nomic-embed-text:v1.5", { queryTemplate: "search_query: {text}", documentTemplate: "search_document: {text}" }],
    ["BAAI/bge-base-en-v1.5", { queryTemplate: RETRIEVAL_QUERY }],
    ["mxbai-embed-large", { queryTemplate: RETRIEVAL_QUERY }],
    ["Snowflake/snowflake-arctic-embed-m", { queryTemplate: RETRIEVAL_QUERY }],
    ["intfloat/e5-large-v2", { queryTemplate: "query: {text}", documentTemplate: "passage: {text}" }],
    ["intfloat/multilingual-e5-small", { queryTemplate: "query: {text}", documentTemplate: "passage: {text}" }],
    ["BAAI/bge-m3", {}],
    ["intfloat/multilingual-e5-large-instruct", {}],
    ["text-embedding-3-small", {}],
  ])("%s", (model, profile) => {
    expect(resolveEmbeddingProfile(remote(model))).toEqual(profile);
  });

  test("a local model matches on localModel, defaulting to bge-small-en-v1.5", () => {
    expect(resolveEmbeddingProfile(undefined)).toEqual({ queryTemplate: RETRIEVAL_QUERY });
    expect(resolveEmbeddingProfile({ localModel: "nomic-ai/nomic-embed-text-v1.5" }).documentTemplate).toBe(
      "search_document: {text}",
    );
  });
});

describe("resolveEmbeddingProfile overrides", () => {
  test("a configured template replaces the preset for its side only", () => {
    expect(resolveEmbeddingProfile(remote("nomic-embed-text", { queryTemplate: "find: {text}" }))).toEqual({
      queryTemplate: "find: {text}",
      documentTemplate: "search_document: {text}",
    });
  });

  test("an empty template turns the preset off", () => {
    expect(resolveEmbeddingProfile(remote("qwen3-embedding-0.6b", { queryTemplate: "" }))).toEqual({});
    expect(resolveEmbeddingProfile(remote("e5-base-v2", { documentTemplate: "" }))).toEqual({
      queryTemplate: "query: {text}",
    });
  });

  test("a model with no preset takes the configured templates", () => {
    expect(resolveEmbeddingProfile(remote("house-model", { documentTemplate: "doc: {text}" }))).toEqual({
      documentTemplate: "doc: {text}",
    });
  });
});

describe("applyEmbeddingTemplate", () => {
  test("puts the text where {text} is, keeping its case", () => {
    expect(applyEmbeddingTemplate(QWEN3_QUERY, "Docker HealthCheck")).toBe(
      "Instruct: Given a question or task, retrieve the knowledge asset that helps with it\nQuery:Docker HealthCheck",
    );
  });

  test("treats a template without {text} as a prefix, and no template as none", () => {
    expect(applyEmbeddingTemplate("search_query: ", "Kafka")).toBe("search_query: Kafka");
    expect(applyEmbeddingTemplate(undefined, "Kafka")).toBe("Kafka");
  });

  test("inserts replacement-pattern characters in the text literally", () => {
    expect(applyEmbeddingTemplate("query: {text}", "cost $& and $1")).toBe("query: cost $& and $1");
  });
});

describe("embedding fingerprint", () => {
  test("is unchanged for a model whose profile has no document template", () => {
    expect(documentTemplateFingerprint(remote("embed/qwen3-embedding-0.6b"))).toBe("");
    expect(deriveSemanticProviderFingerprint(remote("embed/qwen3-embedding-0.6b", { dimension: 1024 }))).toBe(
      "remote:embed/qwen3-embedding-0.6b|1024",
    );
    expect(deriveSemanticProviderFingerprint(undefined)).toBe("local:Xenova/bge-small-en-v1.5");
  });

  test("changes with the document template", () => {
    const preset = deriveSemanticProviderFingerprint(remote("nomic-embed-text"));
    const custom = deriveSemanticProviderFingerprint(remote("nomic-embed-text", { documentTemplate: "doc: {text}" }));
    const none = deriveSemanticProviderFingerprint(remote("nomic-embed-text", { documentTemplate: "" }));
    expect(preset).toStartWith("remote:nomic-embed-text|default|doc:");
    expect(custom).toStartWith("remote:nomic-embed-text|default|doc:");
    expect(custom).not.toBe(preset);
    expect(none).toBe("remote:nomic-embed-text|default");
  });

  test("ignores the query template", () => {
    expect(deriveSemanticProviderFingerprint(remote("house-model", { queryTemplate: "q: {text}" }))).toBe(
      deriveSemanticProviderFingerprint(remote("house-model")),
    );
  });
});
