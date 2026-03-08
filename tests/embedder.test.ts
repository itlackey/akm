import { test, expect, describe } from "bun:test"
import { embed, cosineSimilarity, isEmbeddingAvailable } from "../src/embedder"
import type { EmbeddingConnectionConfig } from "../src/config"

function createMockEmbeddingServer(
  embedding: number[] = [0.1, 0.2, 0.3],
  statusCode = 200,
  onRequest?: (body: Record<string, unknown>) => void,
): { url: string; server: ReturnType<typeof Bun.serve> } {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (statusCode !== 200) {
        return new Response("error", { status: statusCode })
      }
      const body = await request.json() as Record<string, unknown>
      onRequest?.(body)
      return new Response(
        JSON.stringify({
          data: [{ embedding }],
          model: "test",
          usage: { prompt_tokens: 5, total_tokens: 5 },
        }),
        { headers: { "Content-Type": "application/json" } },
      )
    },
  })
  return { url: `http://localhost:${server.port}`, server }
}

describe("remote embed", () => {
  test("returns embedding from OpenAI-compatible endpoint", async () => {
    const { url, server } = createMockEmbeddingServer([0.5, 0.6, 0.7])
    try {
      const config: EmbeddingConnectionConfig = { endpoint: url, model: "test-model" }
      const result = await embed("hello world", config)
      expect(result).toEqual([0.5, 0.6, 0.7])
    } finally {
      server.stop()
    }
  })

  test("sends configured embedding dimensions when provided", async () => {
    let requestBody: Record<string, unknown> | undefined
    const { url, server } = createMockEmbeddingServer([0.5, 0.6, 0.7], 200, (body) => {
      requestBody = body
    })
    try {
      const config: EmbeddingConnectionConfig = {
        endpoint: url,
        model: "text-embedding-3-small",
        dimension: 384,
      }
      await embed("hello world", config)
      expect(requestBody).toMatchObject({
        input: "hello world",
        model: "text-embedding-3-small",
        dimensions: 384,
      })
    } finally {
      server.stop()
    }
  })

  test("throws on HTTP error", async () => {
    const { url, server } = createMockEmbeddingServer([], 500)
    try {
      const config: EmbeddingConnectionConfig = { endpoint: url, model: "test-model" }
      await expect(embed("hello", config)).rejects.toThrow("Embedding request failed (500)")
    } finally {
      server.stop()
    }
  })

  test("isEmbeddingAvailable returns true for valid remote endpoint", async () => {
    const { url, server } = createMockEmbeddingServer([0.1, 0.2])
    try {
      const config: EmbeddingConnectionConfig = { endpoint: url, model: "test-model" }
      const available = await isEmbeddingAvailable(config)
      expect(available).toBe(true)
    } finally {
      server.stop()
    }
  })

  test("isEmbeddingAvailable returns false for unreachable endpoint", async () => {
    const config: EmbeddingConnectionConfig = {
      endpoint: "http://localhost:1",
      model: "test-model",
    }
    const available = await isEmbeddingAvailable(config)
    expect(available).toBe(false)
  })
})

describe("cosineSimilarity", () => {
  test("returns 1 for identical normalized vectors", () => {
    const v = [0.5773, 0.5773, 0.5773]
    const sim = cosineSimilarity(v, v)
    expect(sim).toBeCloseTo(1, 2)
  })

  test("returns 0 for orthogonal vectors", () => {
    const sim = cosineSimilarity([1, 0], [0, 1])
    expect(sim).toBe(0)
  })
})
