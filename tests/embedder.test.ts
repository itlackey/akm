import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { EmbeddingConnectionConfig } from "../src/config";
import { cosineSimilarity, embed, embedBatch, isEmbeddingAvailable, resetLocalEmbedder } from "../src/embedder";

let pipelineImpl: ((task: string, model: string, options?: { dtype?: string }) => Promise<unknown>) | undefined;

function createLocalVector(values: number[] = [0.1, 0.2, 0.3], dimension = 384): Float32Array {
  const vector = new Float32Array(dimension);
  values.forEach((value, index) => {
    vector[index] = value;
  });
  return vector;
}

mock.module("@huggingface/transformers", () => ({
  pipeline: async (task: string, model: string, options?: { dtype?: string }) => {
    if (!pipelineImpl) {
      throw new Error("pipelineImpl not configured");
    }
    return pipelineImpl(task, model, options);
  },
}));

beforeEach(() => {
  resetLocalEmbedder();
  pipelineImpl = undefined;
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
        return new Response("error", { status: statusCode });
      }
      const body = (await request.json()) as Record<string, unknown>;
      onRequest?.(body);
      return new Response(
        JSON.stringify({
          data: [{ embedding }],
          model: "test",
          usage: { prompt_tokens: 5, total_tokens: 5 },
        }),
        { headers: { "Content-Type": "application/json" } },
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
      server.stop();
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
          { headers: { "Content-Type": "application/json" } },
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
      server.stop();
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
      server.stop();
    }
  });

  test("throws on HTTP error", async () => {
    const { url, server } = createMockEmbeddingServer([], 500);
    try {
      const config: EmbeddingConnectionConfig = { endpoint: url, model: "test-model" };
      await expect(embed("hello", config)).rejects.toThrow("Embedding request failed (500)");
    } finally {
      server.stop();
    }
  });

  test("isEmbeddingAvailable returns true for valid remote endpoint", async () => {
    const { url, server } = createMockEmbeddingServer([0.1, 0.2]);
    try {
      const config: EmbeddingConnectionConfig = { endpoint: url, model: "test-model" };
      const available = await isEmbeddingAvailable(config);
      expect(available).toBe(true);
    } finally {
      server.stop();
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
      server.stop();
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
          headers: { "Content-Type": "application/json" },
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
        const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
        expect(norm).toBeCloseTo(1.0, 5);
      }
    } finally {
      server.stop();
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
          headers: { "Content-Type": "application/json" },
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
      expect(results[0][0]).toBeCloseTo(1.0, 5); // first result is [1, 0]
      expect(results[0][1]).toBeCloseTo(0.0, 5);
      expect(results[1][0]).toBeCloseTo(0.0, 5); // second result is [0, 1]
      expect(results[1][1]).toBeCloseTo(1.0, 5);
    } finally {
      server.stop();
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
          { headers: { "Content-Type": "application/json" } },
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
      server.stop();
    }
  });

  test("remote embedBatch error mentions the full embeddings endpoint path when response is empty", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(JSON.stringify({ data: [] }), {
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    try {
      const port = server.port;
      const config: EmbeddingConnectionConfig = {
        endpoint: `http://localhost:${port}/v1`,
        model: "test-model",
      };
      await expect(embedBatch(["hello"], config)).rejects.toThrow(
        `Unexpected embedding batch response: expected 1 embeddings, got 0. Check that your endpoint includes the full embeddings path (for example "http://localhost:${port}/v1/embeddings", not just "http://localhost:${port}/v1").`,
      );
    } finally {
      server.stop();
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
    }
  });
});
