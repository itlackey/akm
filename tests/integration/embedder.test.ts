import { beforeEach, describe, expect, test } from "bun:test";
import type { EmbeddingConnectionConfig } from "../../src/core/config/config";
import { writeCredential } from "../../src/core/config/credentials";
import {
  _setLocalPipelineLoaderForTests,
  checkEmbeddingAvailability,
  cosineSimilarity,
  DEFAULT_LOCAL_MODEL,
  embed,
  embedBatch,
  localEmbeddingRuntime,
  resetLocalEmbedder,
} from "../../src/llm/embedder";
import { LocalEmbedder, LocalRuntimeUnavailableError } from "../../src/llm/embedders/local";
import { buildTokenBoundedBatches, estimateTokenCount, RemoteEmbedder } from "../../src/llm/embedders/remote";
import { withIsolatedAkmStorage } from "../_helpers/sandbox";
import { overrideSeam } from "../_helpers/seams";

/** What the faked model loader hands out: the loaded model, one vector per text. */
let loadedModel: ((texts: string[]) => Promise<Float32Array[]>) | undefined;
let loadedModelNames: string[] = [];

function vectorOf(...values: number[]): Float32Array {
  return Float32Array.from(values);
}

beforeEach(() => {
  resetLocalEmbedder();
  loadedModel = undefined;
  loadedModelNames = [];
  overrideSeam(_setLocalPipelineLoaderForTests, async (modelName: string) => {
    loadedModelNames.push(modelName);
    if (!loadedModel) {
      throw new Error("loadedModel not configured");
    }
    return loadedModel;
  });
});

function createMockEmbeddingServer(
  embedding: number[] = [0.1, 0.2, 0.3],
  statusCode = 200,
  onRequest?: (body: Record<string, unknown>) => void,
): { url: string; server: ReturnType<typeof Bun.serve> } {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (statusCode !== 200) {
        return new Response("error", { status: statusCode, headers: { Connection: "close" } });
      }
      const body = (await request.json()) as Record<string, unknown>;
      onRequest?.(body);
      return new Response(
        JSON.stringify({
          data: [{ embedding }],
          model: "test",
          usage: { prompt_tokens: 5, total_tokens: 5 },
        }),
        { headers: { "Content-Type": "application/json", Connection: "close" } },
      );
    },
  });
  return { url: `http://localhost:${server.port}`, server };
}

describe("remote embed", () => {
  test("returns normalized embedding from OpenAI-compatible endpoint", async () => {
    const { url, server } = createMockEmbeddingServer([0.5, 0.6, 0.7]);
    try {
      const config: EmbeddingConnectionConfig = { endpoint: url, model: "test-model" };
      const result = await embed("hello world", config);
      // Vector is L2-normalized: norm of [0.5, 0.6, 0.7] = sqrt(1.1) ~ 1.0488
      const norm = Math.sqrt(result.reduce((sum, v) => sum + v * v, 0));
      expect(norm).toBeCloseTo(1.0, 5);
      // Direction is preserved
      expect(result[0]).toBeCloseTo(0.5 / Math.sqrt(1.1), 5);
      expect(result[1]).toBeCloseTo(0.6 / Math.sqrt(1.1), 5);
      expect(result[2]).toBeCloseTo(0.7 / Math.sqrt(1.1), 5);
    } finally {
      server.stop(true);
    }
  });

  test("appends /embeddings when remote endpoint is configured as a base URL", async () => {
    let requestedPath = "";
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requestedPath = new URL(request.url).pathname;
        return new Response(
          JSON.stringify({
            data: [{ embedding: [0.5, 0.6, 0.7] }],
            model: "test",
            usage: { prompt_tokens: 5, total_tokens: 5 },
          }),
          { headers: { "Content-Type": "application/json", Connection: "close" } },
        );
      },
    });

    try {
      const config: EmbeddingConnectionConfig = {
        endpoint: `http://localhost:${server.port}/v1`,
        model: "test-model",
      };
      await embed("hello world", config);
      expect(requestedPath).toBe("/v1/embeddings");
    } finally {
      server.stop(true);
    }
  });

  test("sends configured embedding dimensions when provided", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const { url, server } = createMockEmbeddingServer([0.5, 0.6, 0.7], 200, (body) => {
      requestBody = body;
    });
    try {
      const config: EmbeddingConnectionConfig = {
        endpoint: url,
        model: "text-embedding-3-small",
        dimension: 384,
      };
      await embed("hello world", config);
      expect(requestBody).toMatchObject({
        input: "hello world",
        model: "text-embedding-3-small",
        dimensions: 384,
      });
    } finally {
      server.stop(true);
    }
  });

  test("reads the key stored for the embedding at header-building time when config names none (#917)", async () => {
    const storage = withIsolatedAkmStorage();
    let capturedAuth = "";
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        capturedAuth = request.headers.get("authorization") ?? "";
        await request.json();
        return new Response(
          JSON.stringify({
            data: [{ embedding: [0.1, 0.2, 0.3] }],
            model: "test",
            usage: { prompt_tokens: 1, total_tokens: 1 },
          }),
          { headers: { "Content-Type": "application/json", Connection: "close" } },
        );
      },
    });
    try {
      const config: EmbeddingConnectionConfig = {
        endpoint: `http://localhost:${server.port}`,
        model: "test-model",
      };
      writeCredential({ service: "embedding" }, "store-secret-value", config.endpoint as string);
      await embed("stored credential header test", config);
      expect(capturedAuth).toBe("Bearer store-secret-value");
    } finally {
      server.stop(true);
      storage.cleanup();
    }
  });

  test("throws on HTTP error", async () => {
    const { url, server } = createMockEmbeddingServer([], 500);
    try {
      const config: EmbeddingConnectionConfig = { endpoint: url, model: "test-model" };
      await expect(embed("hello", config)).rejects.toThrow("Embedding request failed (500)");
    } finally {
      server.stop(true);
    }
  });

  test("caller abort while reading an HTTP error body is not swallowed", async () => {
    const controller = new AbortController();
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          new ReadableStream({
            start(stream) {
              stream.enqueue(new TextEncoder().encode("partial error"));
            },
          }),
          { status: 500 },
        );
      },
    });
    try {
      const config: EmbeddingConnectionConfig = {
        endpoint: `http://localhost:${server.port}`,
        model: "test-model",
      };
      const pending = embed("hello", config, controller.signal);
      setTimeout(() => controller.abort(), 5);
      await expect(pending).rejects.toThrow(/abort/i);
    } finally {
      server.stop(true);
    }
  });

  test("checkEmbeddingAvailability reports a valid remote endpoint available", async () => {
    const { url, server } = createMockEmbeddingServer([0.1, 0.2]);
    try {
      const config: EmbeddingConnectionConfig = { endpoint: url, model: "test-model" };
      const { available } = await checkEmbeddingAvailability(config);
      expect(available).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("checkEmbeddingAvailability reports an unreachable endpoint unavailable", async () => {
    const config: EmbeddingConnectionConfig = {
      endpoint: "http://localhost:1",
      model: "test-model",
    };
    const { available } = await checkEmbeddingAvailability(config);
    expect(available).toBe(false);
  });

  test("remote embed normalizes returned vectors to unit length", async () => {
    // Raw vector [3, 4] has norm 5, so normalized should be [0.6, 0.8]
    const { url, server } = createMockEmbeddingServer([3, 4]);
    try {
      const config: EmbeddingConnectionConfig = { endpoint: url, model: "test-model" };
      const result = await embed("hello", config);
      // Verify unit length
      const norm = Math.sqrt(result.reduce((sum, v) => sum + v * v, 0));
      expect(norm).toBeCloseTo(1.0, 5);
      // Verify correct direction
      expect(result[0]).toBeCloseTo(0.6, 5);
      expect(result[1]).toBeCloseTo(0.8, 5);
    } finally {
      server.stop(true);
    }
  });

  test("remote embedBatch normalizes returned vectors to unit length", async () => {
    // Mock server that returns batch embeddings
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { input: string[] };
        const data = body.input.map((_, i) => ({
          embedding: [3, 4], // non-normalized
          index: i,
        }));
        return new Response(JSON.stringify({ data, model: "test", usage: { prompt_tokens: 10, total_tokens: 10 } }), {
          headers: { "Content-Type": "application/json", Connection: "close" },
        });
      },
    });
    try {
      const config: EmbeddingConnectionConfig = {
        endpoint: `http://localhost:${server.port}`,
        model: "test-model",
      };
      const results = await embedBatch(["hello", "world"], config);
      expect(results).toHaveLength(2);
      for (const vec of results) {
        expect(vec).toBeDefined();
        const norm = Math.sqrt((vec as number[]).reduce((sum, v) => sum + v * v, 0));
        expect(norm).toBeCloseTo(1.0, 5);
      }
    } finally {
      server.stop(true);
    }
  });

  test("remote embedBatch preserves correct order when API returns shuffled indices", async () => {
    // Mock server that returns embeddings in shuffled order with index field
    const server = Bun.serve({
      port: 0,
      async fetch() {
        // Return index 1 first, then index 0 (reversed)
        const data = [
          { embedding: [0, 1], index: 1 }, // second input
          { embedding: [1, 0], index: 0 }, // first input
        ];
        return new Response(JSON.stringify({ data, model: "test", usage: { prompt_tokens: 10, total_tokens: 10 } }), {
          headers: { "Content-Type": "application/json", Connection: "close" },
        });
      },
    });
    try {
      const config: EmbeddingConnectionConfig = {
        endpoint: `http://localhost:${server.port}`,
        model: "test-model",
      };
      const results = await embedBatch(["first", "second"], config);
      expect(results).toHaveLength(2);
      // After sorting by index: index 0 -> [1,0], index 1 -> [0,1]
      // These are already unit vectors, so normalization preserves them
      expect(results[0]![0]).toBeCloseTo(1.0, 5); // first result is [1, 0]
      expect(results[0]![1]).toBeCloseTo(0.0, 5);
      expect(results[1]![0]).toBeCloseTo(0.0, 5); // second result is [0, 1]
      expect(results[1]![1]).toBeCloseTo(1.0, 5);
    } finally {
      server.stop(true);
    }
  });

  test("remote embedBatch appends /embeddings when endpoint is configured without the full path", async () => {
    let requestedPath = "";
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requestedPath = new URL(request.url).pathname;
        return new Response(
          JSON.stringify({
            data: [
              { embedding: [1, 0], index: 0 },
              { embedding: [0, 1], index: 1 },
            ],
            model: "test",
            usage: { prompt_tokens: 10, total_tokens: 10 },
          }),
          { headers: { "Content-Type": "application/json", Connection: "close" } },
        );
      },
    });
    try {
      const config: EmbeddingConnectionConfig = {
        endpoint: `http://localhost:${server.port}/v1`,
        model: "test-model",
      };
      await embedBatch(["hello", "world"], config);
      expect(requestedPath).toBe("/v1/embeddings");
    } finally {
      server.stop(true);
    }
  });

  test("remote embedBatch SKIPS (does not throw) a batch whose response is empty, and reports why (#874)", async () => {
    // #874: a malformed/failing batch response used to reject the entire
    // embedBatch call, discarding every OTHER batch's embeddings. It must
    // now be reported as a skip for just this batch's documents, with the
    // same diagnostic message the old thrown error carried.
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(JSON.stringify({ data: [] }), {
          headers: { "Content-Type": "application/json", Connection: "close" },
        });
      },
    });
    try {
      const port = server.port;
      const config: EmbeddingConnectionConfig = {
        endpoint: `http://localhost:${port}/v1`,
        model: "test-model",
      };
      const skips: Array<{ index: number; reason: string; message: string }> = [];
      const results = await embedBatch(["hello"], config, undefined, (skip) => skips.push(skip));
      expect(results).toEqual([undefined]);
      expect(skips).toHaveLength(1);
      expect(skips[0]?.index).toBe(0);
      expect(skips[0]?.reason).toBe("batch-request-failed");
      expect(skips[0]?.message).toContain(
        `Unexpected embedding batch response: expected 1 embeddings, got 0. Check that your endpoint includes the full embeddings path (for example "http://localhost:${port}/v1/embeddings", not just "http://localhost:${port}/v1").`,
      );
    } finally {
      server.stop(true);
    }
  });
});

describe("buildTokenBoundedBatches (#874 — batch by tokens, not document count)", () => {
  test("groups documents by an estimated token budget, not a fixed count", () => {
    // 10 docs, each ~25 tokens (100 chars). A 60-token budget fits 2 per batch.
    const texts = Array.from({ length: 10 }, (_, i) => "x".repeat(100) + i);
    const batches = buildTokenBoundedBatches(texts, 60, 100);
    expect(batches.every((b) => !b.oversized)).toBe(true);
    for (const batch of batches) {
      const tokens = batch.indices.reduce((sum, i) => sum + estimateTokenCount(texts[i] as string), 0);
      expect(tokens).toBeLessThanOrEqual(60);
    }
    // Every index appears exactly once, in order.
    expect(batches.flatMap((b) => b.indices)).toEqual(texts.map((_, i) => i));
  });

  test("a document-count cap still applies even when the token budget has room", () => {
    const texts = Array.from({ length: 5 }, () => "tiny");
    const batches = buildTokenBoundedBatches(texts, 100_000, 2);
    expect(batches.map((b) => b.indices.length)).toEqual([2, 2, 1]);
  });

  test("a single document whose own estimate exceeds the budget is flagged oversized and isolated", () => {
    const small = "short";
    const huge = "x".repeat(4000); // ~1000 estimated tokens
    const texts = [small, huge, small];
    const batches = buildTokenBoundedBatches(texts, 100, 100);
    const oversizedBatch = batches.find((b) => b.oversized);
    expect(oversizedBatch?.indices).toEqual([1]);
    // The two small docs are still batched together, not discarded.
    const normalBatches = batches.filter((b) => !b.oversized);
    expect(normalBatches.flatMap((b) => b.indices).sort()).toEqual([0, 2]);
  });
});

describe("RemoteEmbedder.embedBatch skip-and-report (#874)", () => {
  test("an oversized document is skipped with a named reason and never sent over HTTP", async () => {
    let requestCount = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requestCount++;
        const body = (await request.json()) as { input: string[] };
        const data = body.input.map(() => ({ embedding: [1, 0] }));
        return new Response(JSON.stringify({ data, model: "test", usage: { prompt_tokens: 1, total_tokens: 1 } }), {
          headers: { "Content-Type": "application/json", Connection: "close" },
        });
      },
    });
    try {
      const embedder = new RemoteEmbedder({
        endpoint: `http://localhost:${server.port}`,
        model: "test-model",
        maxTokens: 10,
      });
      const skips: Array<{ index: number; reason: string; message: string }> = [];
      const results = await embedder.embedBatch(["small", "x".repeat(200)], undefined, (skip) => skips.push(skip));

      expect(results[0]).toBeDefined();
      expect(results[1]).toBeUndefined();
      expect(skips).toHaveLength(1);
      expect(skips[0]?.index).toBe(1);
      expect(skips[0]?.reason).toBe("context-window-exceeded");
      expect(skips[0]?.message).toContain("exceeds the 10-token embedding budget");
      // Only the small document's batch went over HTTP — the oversized one never did.
      expect(requestCount).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("a mix of small and oversized docs: the failing/oversized ones are skipped, the rest still embed", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { input: string[] };
        if (body.input.some((t) => t.includes("FAIL"))) {
          return new Response("boom", { status: 500 });
        }
        const data = body.input.map(() => ({ embedding: [1, 0] }));
        return new Response(JSON.stringify({ data, model: "test", usage: { prompt_tokens: 1, total_tokens: 1 } }), {
          headers: { "Content-Type": "application/json", Connection: "close" },
        });
      },
    });
    try {
      const embedder = new RemoteEmbedder({
        endpoint: `http://localhost:${server.port}`,
        model: "test-model",
        maxTokens: 20,
        batchSize: 1,
      });
      const texts = ["ok-1", "FAIL-this-one", "ok-2", "x".repeat(400) /* oversized */, "ok-3"];
      const skips: Array<{ index: number; reason: string }> = [];
      const results = await embedder.embedBatch(texts, undefined, (skip) => skips.push(skip));

      expect(results[0]).toBeDefined();
      expect(results[1]).toBeUndefined();
      expect(results[2]).toBeDefined();
      expect(results[3]).toBeUndefined();
      expect(results[4]).toBeDefined();

      const reasonsByIndex = new Map(skips.map((s) => [s.index, s.reason]));
      expect(reasonsByIndex.get(1)).toBe("batch-request-failed");
      expect(reasonsByIndex.get(3)).toBe("context-window-exceeded");
    } finally {
      server.stop(true);
    }
  });
});

describe("cosineSimilarity", () => {
  test("returns 1 for identical normalized vectors", () => {
    const v = [0.5773, 0.5773, 0.5773];
    const sim = cosineSimilarity(v, v);
    expect(sim).toBeCloseTo(1, 2);
  });

  test("returns 0 for orthogonal vectors", () => {
    const sim = cosineSimilarity([1, 0], [0, 1]);
    expect(sim).toBe(0);
  });
});

describe("local embedder", () => {
  test("embeds one text with the default model", async () => {
    loadedModel = async (texts) => texts.map(() => vectorOf(0.1, 0.2, 0.3));

    const result = await embed("hello local");

    expect(result[0]).toBeCloseTo(0.1, 6);
    expect(result[1]).toBeCloseTo(0.2, 6);
    expect(result[2]).toBeCloseTo(0.3, 6);
    expect(loadedModelNames).toEqual([DEFAULT_LOCAL_MODEL]);
  });

  test("loads the model once for concurrent calls and reports the runtime it embedded with", async () => {
    loadedModel = async (texts) => texts.map(() => vectorOf(1, 0));
    expect(localEmbeddingRuntime()).toBeUndefined();

    await Promise.all([embed("one"), embed("two"), embed("three")]);

    expect(loadedModelNames).toEqual([DEFAULT_LOCAL_MODEL]);
    expect(localEmbeddingRuntime()).toBe("onnxruntime-node");
  });

  test("a model that fails to load is retried by the next call", async () => {
    await expect(embed("first")).rejects.toThrow("loadedModel not configured");
    expect(localEmbeddingRuntime()).toBeUndefined();

    loadedModel = async (texts) => texts.map(() => vectorOf(1, 0));
    expect(await embed("second")).toEqual([1, 0]);
    expect(loadedModelNames).toHaveLength(2);
  });

  test("checkEmbeddingAvailability names a runtime that cannot load, not a model download", async () => {
    overrideSeam(_setLocalPipelineLoaderForTests, async () => {
      throw new LocalRuntimeUnavailableError("no native library", "platform");
    });
    expect(await checkEmbeddingAvailability()).toEqual({
      available: false,
      reason: "runtime-unavailable",
      message: "no native library",
    });

    overrideSeam(_setLocalPipelineLoaderForTests, async () => {
      throw new Error("HTTP 503");
    });
    expect(await checkEmbeddingAvailability()).toEqual({
      available: false,
      reason: "model-download-failed",
      message: "HTTP 503",
    });
  });
});

describe("local embedder batching", () => {
  test("embedBatch returns one vector per text, in order — two texts, 4-dim", async () => {
    const row0 = [0.1, 0.2, 0.3, 0.4];
    const row1 = [0.5, 0.6, 0.7, 0.8];
    loadedModel = async () => [vectorOf(...row0), vectorOf(...row1)];

    const results = await new LocalEmbedder().embedBatch(["text-a", "text-b"]);

    expect(results).toHaveLength(2);
    expect(results[0]).toHaveLength(4);
    expect((results[0] as number[])[0]).toBeCloseTo(0.1, 6);
    expect((results[0] as number[])[3]).toBeCloseTo(0.4, 6);
    expect(results[1]).toHaveLength(4);
    expect((results[1] as number[])[0]).toBeCloseTo(0.5, 6);
    expect((results[1] as number[])[3]).toBeCloseTo(0.8, 6);
  });

  test("embedBatch runs 32 texts at a time and reports each chunk's indices", async () => {
    const chunkSizes: number[] = [];
    loadedModel = async (texts) => {
      chunkSizes.push(texts.length);
      return texts.map((text) => vectorOf(Number(text)));
    };
    const texts = Array.from({ length: 70 }, (_, i) => String(i));
    const committed: Array<{ indices: number[]; values: number[] }> = [];

    const results = await new LocalEmbedder().embedBatch(texts, undefined, (indices, embeddings) => {
      committed.push({ indices, values: embeddings.map((vector) => vector[0] as number) });
    });

    expect(chunkSizes).toEqual([32, 32, 6]);
    expect(results.map((vector) => vector[0])).toEqual(texts.map(Number));
    expect(committed.map((chunk) => chunk.indices.length)).toEqual([32, 32, 6]);
    expect(committed[2]?.indices).toEqual([64, 65, 66, 67, 68, 69]);
    expect(committed[2]?.values).toEqual([64, 65, 66, 67, 68, 69]);
  });

  test("embedBatch propagates a model failure without re-executing texts", async () => {
    let callCount = 0;
    const failure = new Error("batch inference failed");
    loadedModel = async () => {
      callCount++;
      throw failure;
    };

    await expect(new LocalEmbedder().embedBatch(["t1", "t2"])).rejects.toBe(failure);
    expect(callCount).toBe(1);
  });
});

describe("RemoteEmbedder.embedBatch against a real server: context-size split (#954)", () => {
  test("a server that 413s any batch with more than one input makes every document embed individually", async () => {
    const requestSizes: number[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { input: string[] };
        requestSizes.push(body.input.length);
        if (body.input.length > 1) {
          return new Response(JSON.stringify({ error: "exceed_context_size_error" }), {
            status: 413,
            headers: { "Content-Type": "application/json", Connection: "close" },
          });
        }
        return new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0], index: 0 }], model: "test", usage: {} }), {
          headers: { "Content-Type": "application/json", Connection: "close" },
        });
      },
    });
    try {
      const embedder = new RemoteEmbedder({ endpoint: `http://localhost:${server.port}`, model: "test-model" });
      const texts = ["doc-a", "doc-b", "doc-c", "doc-d"];
      const results = await embedder.embedBatch(texts);
      expect(results).toHaveLength(4);
      expect(results.every((r) => r !== undefined)).toBe(true);
      // Every request that ultimately succeeded carried exactly one document.
      expect(requestSizes.filter((size) => size === 1)).toHaveLength(4);
    } finally {
      server.stop(true);
    }
  });
});

describe("RemoteEmbedder.embedBatch against a real server: timeout back-off retry (#954)", () => {
  // A request timeout never drops its batch
  // outright any more — it backs off (so the server can drain the abandoned
  // request) and retries the SAME request once before ever splitting or
  // skipping. This test covers the first required case: a first request
  // that outlives the client's timeout, followed by a normal response,
  // must produce exactly one retry and no skipped documents.
  test("a first request that outlives the timeout retries once after a back-off and succeeds, with nothing skipped", async () => {
    const timeoutMs = 300;
    let requestCount = 0;
    const requestTimestamps: number[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requestCount++;
        requestTimestamps.push(Date.now());
        const thisRequest = requestCount;
        const body = (await request.json()) as { input: string[] };
        if (thisRequest === 1) {
          // Sleeps 3x the client's timeout: the client has already given up
          // and moved on well before this responds, exercising exactly the
          // field-report mechanism (akm abandons the request, the server
          // keeps computing it).
          await new Promise((resolve) => setTimeout(resolve, timeoutMs * 3));
        }
        const data = body.input.map((_t, i) => ({ embedding: [1, 0], index: i }));
        return new Response(JSON.stringify({ data, model: "test", usage: {} }), {
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    try {
      const embedder = new RemoteEmbedder({
        endpoint: `http://localhost:${server.port}`,
        model: "test-model",
        timeoutMs,
      });
      const skips: unknown[] = [];
      const results = await embedder.embedBatch(["doc-a", "doc-b"], undefined, (skip) => skips.push(skip));

      expect(results.every((r) => r !== undefined)).toBe(true);
      expect(skips).toHaveLength(0);
      // Exactly one retry: the sleeping first request, then a successful second.
      expect(requestCount).toBe(2);
      // Request-timing log proving a real back-off elapsed between the
      // client giving up on request 1 (at `timeoutMs`) and request 2 being
      // dispatched, rather than an immediate retry.
      const gapAfterClientTimeout = (requestTimestamps[1] as number) - ((requestTimestamps[0] as number) + timeoutMs);
      expect(gapAfterClientTimeout).toBeGreaterThanOrEqual(1_500);
    } finally {
      server.stop(true);
    }
  }, 30_000);
});

describe("RemoteEmbedder.embedBatch against a real server: bounded concurrency (#954)", () => {
  // The in-flight window defaults to 1 loopback / 2 remote when
  // `embedding.concurrency` is unset; #954 lets that config key
  // override the default in either direction. The real-server case that
  // matters is loopback, since a test server binds to localhost; the 2-wide
  // remote default is covered against a mocked fetch in
  // tests/embedder-batching.test.ts (a real, unresolvable "remote" hostname
  // would make this test flaky/offline-dependent for no added coverage).
  test("a loopback endpoint never overlaps requests against a real server", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const body = (await request.json()) as { input: string[] };
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight--;
        const data = body.input.map(() => ({ embedding: [1, 0], index: 0 }));
        return new Response(JSON.stringify({ data, model: "test", usage: {} }), {
          headers: { "Content-Type": "application/json", Connection: "close" },
        });
      },
    });
    try {
      const embedder = new RemoteEmbedder({
        endpoint: `http://localhost:${server.port}`,
        model: "test-model",
        batchSize: 1,
      });
      const texts = Array.from({ length: 4 }, (_, i) => `doc-${i}`);
      await embedder.embedBatch(texts);
      expect(maxInFlight).toBe(1);
    } finally {
      server.stop(true);
    }
  });
});
