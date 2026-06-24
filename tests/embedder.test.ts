import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { HttpClient } from "../src/core/common";
import type { EmbeddingConnectionConfig } from "../src/core/config/config";
import { setQuiet } from "../src/core/warn";
import { cosineSimilarity, embed, embedBatch, isEmbeddingAvailable, resetLocalEmbedder } from "../src/llm/embedder";
import { LocalEmbedder } from "../src/llm/embedders/local";

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

// #664 Seam 1: inject a fake HttpClient instead of standing up Bun.serve. The
// fake runs the real RemoteEmbedder request/parse/L2-normalize path with no
// socket. `capture` records the request URL + parsed body for assertions.
function makeEmbedFetch(opts: {
  embedding?: number[];
  data?: Array<{ embedding: number[]; index?: number }>;
  batchEmbedding?: number[];
  statusCode?: number;
  capture?: (info: { path: string; body: Record<string, unknown> }) => void;
}): HttpClient {
  return async (input, init) => {
    if (opts.statusCode && opts.statusCode !== 200) {
      return new Response("error", { status: opts.statusCode });
    }
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    opts.capture?.({ path: new URL(String(input)).pathname, body });
    let data = opts.data;
    if (!data) {
      const input2 = body.input;
      data = Array.isArray(input2)
        ? input2.map((_, i) => ({ embedding: opts.batchEmbedding ?? [3, 4], index: i }))
        : [{ embedding: opts.embedding ?? [0.1, 0.2, 0.3] }];
    }
    return new Response(JSON.stringify({ data, model: "test", usage: { prompt_tokens: 5, total_tokens: 5 } }), {
      headers: { "Content-Type": "application/json" },
    });
  };
}

// A non-routable endpoint string; the injected fetch never connects to it.
const TEST_ENDPOINT = "http://embed.test";

describe("remote embed", () => {
  test("returns normalized embedding from OpenAI-compatible endpoint", async () => {
    const config: EmbeddingConnectionConfig = { endpoint: TEST_ENDPOINT, model: "test-model" };
    const result = await embed("hello world", config, undefined, {
      fetch: makeEmbedFetch({ embedding: [0.5, 0.6, 0.7] }),
    });
    // Vector is L2-normalized: norm of [0.5, 0.6, 0.7] = sqrt(1.1) ~ 1.0488
    const norm = Math.sqrt(result.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 5);
    // Direction is preserved
    expect(result[0]).toBeCloseTo(0.5 / Math.sqrt(1.1), 5);
    expect(result[1]).toBeCloseTo(0.6 / Math.sqrt(1.1), 5);
    expect(result[2]).toBeCloseTo(0.7 / Math.sqrt(1.1), 5);
  });

  test("appends /embeddings when remote endpoint is configured as a base URL", async () => {
    let requestedPath = "";
    const config: EmbeddingConnectionConfig = { endpoint: `${TEST_ENDPOINT}/v1`, model: "test-model" };
    await embed("hello world", config, undefined, {
      fetch: makeEmbedFetch({
        embedding: [0.5, 0.6, 0.7],
        capture: ({ path }) => {
          requestedPath = path;
        },
      }),
    });
    expect(requestedPath).toBe("/v1/embeddings");
  });

  test("sends configured embedding dimensions when provided", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const config: EmbeddingConnectionConfig = {
      endpoint: TEST_ENDPOINT,
      model: "text-embedding-3-small",
      dimension: 384,
    };
    await embed("hello world", config, undefined, {
      fetch: makeEmbedFetch({
        embedding: [0.5, 0.6, 0.7],
        capture: ({ body }) => {
          requestBody = body;
        },
      }),
    });
    expect(requestBody).toMatchObject({
      input: "hello world",
      model: "text-embedding-3-small",
      dimensions: 384,
    });
  });

  test("throws on HTTP error", async () => {
    const config: EmbeddingConnectionConfig = { endpoint: TEST_ENDPOINT, model: "test-model" };
    await expect(embed("hello", config, undefined, { fetch: makeEmbedFetch({ statusCode: 500 }) })).rejects.toThrow(
      "Embedding request failed (500)",
    );
  });

  test("isEmbeddingAvailable returns true for valid remote endpoint", async () => {
    const config: EmbeddingConnectionConfig = { endpoint: TEST_ENDPOINT, model: "test-model" };
    const available = await isEmbeddingAvailable(config, { fetch: makeEmbedFetch({ embedding: [0.1, 0.2] }) });
    expect(available).toBe(true);
  });

  test("isEmbeddingAvailable returns false for unreachable endpoint", async () => {
    const config: EmbeddingConnectionConfig = { endpoint: TEST_ENDPOINT, model: "test-model" };
    // Injected fetch that rejects like a real connection failure.
    const available = await isEmbeddingAvailable(config, {
      fetch: async () => {
        throw new Error("connection refused");
      },
    });
    expect(available).toBe(false);
  });

  test("remote embed normalizes returned vectors to unit length", async () => {
    // Raw vector [3, 4] has norm 5, so normalized should be [0.6, 0.8]
    const config: EmbeddingConnectionConfig = { endpoint: TEST_ENDPOINT, model: "test-model" };
    const result = await embed("hello", config, undefined, { fetch: makeEmbedFetch({ embedding: [3, 4] }) });
    // Verify unit length
    const norm = Math.sqrt(result.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 5);
    // Verify correct direction
    expect(result[0]).toBeCloseTo(0.6, 5);
    expect(result[1]).toBeCloseTo(0.8, 5);
  });

  test("remote embedBatch normalizes returned vectors to unit length", async () => {
    const config: EmbeddingConnectionConfig = { endpoint: TEST_ENDPOINT, model: "test-model" };
    // Fake derives one [3,4] vector per input (non-normalized).
    const results = await embedBatch(["hello", "world"], config, undefined, {
      fetch: makeEmbedFetch({ batchEmbedding: [3, 4] }),
    });
    expect(results).toHaveLength(2);
    for (const vec of results) {
      const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
      expect(norm).toBeCloseTo(1.0, 5);
    }
  });

  test("remote embedBatch preserves correct order when API returns shuffled indices", async () => {
    const config: EmbeddingConnectionConfig = { endpoint: TEST_ENDPOINT, model: "test-model" };
    // Return index 1 first, then index 0 (reversed) — already unit vectors.
    const results = await embedBatch(["first", "second"], config, undefined, {
      fetch: makeEmbedFetch({
        data: [
          { embedding: [0, 1], index: 1 },
          { embedding: [1, 0], index: 0 },
        ],
      }),
    });
    expect(results).toHaveLength(2);
    // After sorting by index: index 0 -> [1,0], index 1 -> [0,1]
    expect(results[0][0]).toBeCloseTo(1.0, 5); // first result is [1, 0]
    expect(results[0][1]).toBeCloseTo(0.0, 5);
    expect(results[1][0]).toBeCloseTo(0.0, 5); // second result is [0, 1]
    expect(results[1][1]).toBeCloseTo(1.0, 5);
  });

  test("remote embedBatch appends /embeddings when endpoint is configured without the full path", async () => {
    let requestedPath = "";
    const config: EmbeddingConnectionConfig = { endpoint: `${TEST_ENDPOINT}/v1`, model: "test-model" };
    await embedBatch(["hello", "world"], config, undefined, {
      fetch: makeEmbedFetch({
        data: [
          { embedding: [1, 0], index: 0 },
          { embedding: [0, 1], index: 1 },
        ],
        capture: ({ path }) => {
          requestedPath = path;
        },
      }),
    });
    expect(requestedPath).toBe("/v1/embeddings");
  });

  test("remote embedBatch error mentions the full embeddings endpoint path when response is empty", async () => {
    const config: EmbeddingConnectionConfig = { endpoint: `${TEST_ENDPOINT}/v1`, model: "test-model" };
    await expect(embedBatch(["hello"], config, undefined, { fetch: makeEmbedFetch({ data: [] }) })).rejects.toThrow(
      `Unexpected embedding batch response: expected 1 embeddings, got 0. Check that your endpoint includes the full embeddings path (for example "${TEST_ENDPOINT}/v1/embeddings", not just "${TEST_ENDPOINT}/v1").`,
    );
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

  test("embedBatch still handles Array<{data}> shape for older pipeline versions", async () => {
    // Older versions returned an array of {data} objects, not a Tensor.
    const row0 = [0.3, 0.4];
    const row1 = [0.7, 0.8];

    pipelineImpl = async () => {
      return async (input: unknown) => {
        if (Array.isArray(input)) {
          // Return old Array<{data}> shape.
          return [{ data: new Float32Array(row0) }, { data: new Float32Array(row1) }];
        }
        return { data: new Float32Array(row0) };
      };
    };

    const embedder = new LocalEmbedder();
    const results = await embedder.embedBatch(["text-a", "text-b"]);

    expect(results).toHaveLength(2);
    expect((results[0] as number[])[0]).toBeCloseTo(0.3, 6);
    expect((results[1] as number[])[0]).toBeCloseTo(0.7, 6);
  });

  test("embedBatch falls back to one-at-a-time if pipeline returns unexpected shape", async () => {
    // The pipeline returns a non-standard shape — should fall through to
    // per-text fallback and still produce correct results.
    const vector = [0.9, 0.1];
    let callCount = 0;

    pipelineImpl = async () => {
      return async (_input: unknown) => {
        callCount++;
        // Always return single-result shape (even for arrays).
        return { data: new Float32Array(vector) };
      };
    };

    const embedder = new LocalEmbedder();
    const results = await embedder.embedBatch(["t1", "t2"]);

    expect(results).toHaveLength(2);
    // Fallback path: called once for the batch attempt + once per text.
    // callCount: 1 (batch attempt → throws or unknown shape) + 2 (fallback t1/t2) = 3.
    expect(callCount).toBeGreaterThanOrEqual(2);
  });
});
