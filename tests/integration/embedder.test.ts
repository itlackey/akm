import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import path from "node:path";
import { setSecret } from "../../src/commands/env/secret";
import type { EmbeddingConnectionConfig } from "../../src/core/config/config";
import { setQuiet } from "../../src/core/warn";
import {
  _setTransformersLoaderForTests,
  cosineSimilarity,
  embed,
  embedBatch,
  isEmbeddingAvailable,
  resetLocalEmbedder,
} from "../../src/llm/embedder";
import { LocalEmbedder } from "../../src/llm/embedders/local";
import { buildTokenBoundedBatches, estimateTokenCount, RemoteEmbedder } from "../../src/llm/embedders/remote";
import { withEnv, withIsolatedAkmStorage } from "../_helpers/sandbox";
import { overrideSeam } from "../_helpers/seams";

let pipelineImpl: ((task: string, model: string, options?: { dtype?: string }) => Promise<unknown>) | undefined;

function createLocalVector(values: number[] = [0.1, 0.2, 0.3], dimension = 384): Float32Array {
  const vector = new Float32Array(dimension);
  values.forEach((value, index) => {
    vector[index] = value;
  });
  return vector;
}

beforeEach(() => {
  resetLocalEmbedder();
  pipelineImpl = undefined;
  overrideSeam(_setTransformersLoaderForTests, async () => ({
    env: { backends: { onnx: { wasm: {} } } },
    pipeline: async (task: string, model: string, options?: { dtype?: string }) => {
      if (!pipelineImpl) {
        throw new Error("pipelineImpl not configured");
      }
      return pipelineImpl(task, model, options);
    },
  }));
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

  test("resolves a secret:// apiKey from the store at header-building time (#917)", async () => {
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
      setSecret(path.join(storage.stashDir, "secrets", "embed-key"), Buffer.from("store-secret-value"));
      const config: EmbeddingConnectionConfig = {
        endpoint: `http://localhost:${server.port}`,
        model: "test-model",
        apiKey: "secret://embed-key",
      };
      await embed("secret store apiKey header test", config);
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

  test("isEmbeddingAvailable returns true for valid remote endpoint", async () => {
    const { url, server } = createMockEmbeddingServer([0.1, 0.2]);
    try {
      const config: EmbeddingConnectionConfig = { endpoint: url, model: "test-model" };
      const available = await isEmbeddingAvailable(config);
      expect(available).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("isEmbeddingAvailable returns false for unreachable endpoint", async () => {
    const config: EmbeddingConnectionConfig = {
      endpoint: "http://localhost:1",
      model: "test-model",
    };
    const available = await isEmbeddingAvailable(config);
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

describe("local embedder pipeline setup", () => {
  test("routes Transformers.js file caching through the stable HF_HOME", async () => {
    const transformersEnv = {
      backends: { onnx: { wasm: {} } },
      cacheDir: "node_modules/@huggingface/transformers/.cache",
    };
    const stableHfHome = path.join("stable", "huggingface");
    const fakeModule = {
      env: transformersEnv,
      pipeline: async () => async () => ({ data: createLocalVector() }),
    };
    overrideSeam(_setTransformersLoaderForTests, async () => fakeModule);

    await withEnv({ HF_HOME: stableHfHome }, async () => {
      await embed("cache me");
      expect(transformersEnv.cacheDir).toBe(stableHfHome);
    });
  });

  test("disables remote model loading when HF_HUB_OFFLINE is enabled", async () => {
    const transformersEnv: {
      allowRemoteModels?: boolean;
      backends: { onnx: { wasm: Record<string, never> } };
    } = {
      backends: { onnx: { wasm: {} } },
    };
    overrideSeam(_setTransformersLoaderForTests, async () => ({
      env: transformersEnv,
      pipeline: async () => async () => ({ data: createLocalVector() }),
    }));

    await withEnv({ HF_HUB_OFFLINE: "1" }, async () => {
      await embed("offline model");
      expect(transformersEnv.allowRemoteModels).toBe(false);
    });
  });

  test("requests fp32 dtype for local embeddings", async () => {
    const pipelineMock = mock(async (_task: string, _model: string, options?: { dtype?: string }) => {
      expect(options?.dtype).toBe("fp32");
      return async () => ({ data: createLocalVector([0.1, 0.2, 0.3]) });
    });

    pipelineImpl = pipelineMock;

    const result = await embed("hello local");
    expect(result[0]).toBeCloseTo(0.1, 6);
    expect(result[1]).toBeCloseTo(0.2, 6);
    expect(result[2]).toBeCloseTo(0.3, 6);
    expect(pipelineMock).toHaveBeenCalledTimes(1);
  });

  test("falls back to default pipeline options when dtype is rejected", async () => {
    const pipelineMock = mock(async (_task: string, _model: string, options?: { dtype?: string }) => {
      if (options?.dtype === "fp32") {
        throw new Error('Unsupported dtype "fp32"');
      }
      expect(options?.dtype).toBe("auto");
      return async () => ({ data: createLocalVector([0.4, 0.5, 0.6]) });
    });

    pipelineImpl = pipelineMock;

    // setQuiet(false): harness defaults to quiet=true; opt into noisy mode so
    // warn() calls from production code reach the warnSpy.
    setQuiet(false);
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    try {
      const result = await embed("hello fallback");
      expect(result[0]).toBeCloseTo(0.4, 6);
      expect(result[1]).toBeCloseTo(0.5, 6);
      expect(result[2]).toBeCloseTo(0.6, 6);
      expect(pipelineMock).toHaveBeenCalledTimes(2);
      expect(pipelineMock.mock.calls[0]?.[2]).toEqual({ dtype: "fp32" });
      expect(pipelineMock.mock.calls[1]?.[2]).toEqual({ dtype: "auto" });
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
      setQuiet(true); // restore harness default
    }
  });

  test("never retries without a dtype option after fp32 rejection", async () => {
    const pipelineMock = mock(async (_task: string, _model: string, options?: { dtype?: string }) => {
      if (options?.dtype === "fp32") {
        throw new Error('Unsupported dtype "fp32"');
      }
      if (!options || options.dtype === undefined) {
        throw new Error("pipeline retried without dtype");
      }
      return async () => ({ data: createLocalVector([0.7, 0.8, 0.9]) });
    });

    pipelineImpl = pipelineMock;

    // setQuiet(false): harness defaults to quiet=true; opt into noisy mode so
    // warn() calls from production code reach the warnSpy.
    setQuiet(false);
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    try {
      const result = await embed("hello fallback auto");
      expect(result[0]).toBeCloseTo(0.7, 6);
      expect(result[1]).toBeCloseTo(0.8, 6);
      expect(result[2]).toBeCloseTo(0.9, 6);
      expect(pipelineMock).toHaveBeenCalledTimes(2);
      expect(pipelineMock.mock.calls[0]?.[2]).toEqual({ dtype: "fp32" });
      expect(pipelineMock.mock.calls[1]?.[2]).toEqual({ dtype: "auto" });
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
      setQuiet(true); // restore harness default
    }
  });
});

describe("local embedder batching — Tensor return shape (WS-3a blocker fix)", () => {
  // The @huggingface/transformers feature-extraction pipeline returns a single
  // Tensor for batch string[] input — NOT an Array<{data}>. The Tensor has:
  //   .data: Float32Array of length (batch * dim)
  //   .dims: [batch, dim]
  // These tests lock the fix so a future regression does not silently revert
  // to one-at-a-time fallback.

  function makeBatchTensor(rows: number[][]): { data: Float32Array; dims: number[] } {
    const batch = rows.length;
    const dim = rows[0]?.length ?? 0;
    const flat = new Float32Array(batch * dim);
    for (let r = 0; r < batch; r++) {
      for (let c = 0; c < dim; c++) {
        flat[r * dim + c] = (rows[r] as number[])[c] as number;
      }
    }
    return { data: flat, dims: [batch, dim] };
  }

  test("embedBatch slices a batch Tensor correctly — two texts, 4-dim", async () => {
    // Pipeline returns a Tensor for the string[] call, single {data} for string.
    const row0 = [0.1, 0.2, 0.3, 0.4];
    const row1 = [0.5, 0.6, 0.7, 0.8];

    pipelineImpl = async () => {
      // Return a function (the "pipeline") that returns the batch Tensor.
      return async (input: unknown) => {
        if (Array.isArray(input)) {
          return makeBatchTensor([row0, row1]);
        }
        // Single string → single result.
        return { data: new Float32Array(row0) };
      };
    };

    const embedder = new LocalEmbedder();
    const results = await embedder.embedBatch(["text-a", "text-b"]);

    expect(results).toHaveLength(2);
    // Row 0
    expect(results[0]).toHaveLength(4);
    expect((results[0] as number[])[0]).toBeCloseTo(0.1, 6);
    expect((results[0] as number[])[3]).toBeCloseTo(0.4, 6);
    // Row 1
    expect(results[1]).toHaveLength(4);
    expect((results[1] as number[])[0]).toBeCloseTo(0.5, 6);
    expect((results[1] as number[])[3]).toBeCloseTo(0.8, 6);
  });

  test("embedBatch handles a single-item batch via Tensor shape", async () => {
    const row0 = [1.0, 0.0, -0.5];

    pipelineImpl = async () => {
      return async (input: unknown) => {
        if (Array.isArray(input)) {
          return makeBatchTensor([row0]);
        }
        return { data: new Float32Array(row0) };
      };
    };

    const embedder = new LocalEmbedder();
    const results = await embedder.embedBatch(["only-text"]);

    expect(results).toHaveLength(1);
    expect((results[0] as number[])[0]).toBeCloseTo(1.0, 6);
    expect((results[0] as number[])[1]).toBeCloseTo(0.0, 6);
    expect((results[0] as number[])[2]).toBeCloseTo(-0.5, 6);
  });

  test("embedBatch rejects the retired Array<{data}> shape without re-executing texts", async () => {
    const row0 = [0.3, 0.4];
    const row1 = [0.7, 0.8];
    let callCount = 0;

    pipelineImpl = async () => {
      return async (input: unknown) => {
        callCount++;
        if (Array.isArray(input)) {
          return [{ data: new Float32Array(row0) }, { data: new Float32Array(row1) }];
        }
        return { data: new Float32Array(row0) };
      };
    };

    const embedder = new LocalEmbedder();
    await expect(embedder.embedBatch(["text-a", "text-b"])).rejects.toThrow(
      "unexpected pipeline return shape for batch input",
    );
    expect(callCount).toBe(1);
  });

  test("embedBatch propagates a current pipeline failure without re-executing texts", async () => {
    let callCount = 0;
    const failure = new Error("batch inference failed");

    pipelineImpl = async () => {
      return async (_input: unknown) => {
        callCount++;
        throw failure;
      };
    };

    const embedder = new LocalEmbedder();
    await expect(embedder.embedBatch(["t1", "t2"])).rejects.toBe(failure);
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
