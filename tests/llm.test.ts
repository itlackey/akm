import { test, expect, describe } from "bun:test"
import { enhanceMetadata } from "../src/llm"
import type { LlmConnectionConfig } from "../src/config"
import type { StashEntry } from "../src/metadata"

// These tests verify the LLM module's response parsing logic.
// They use a mock server to simulate an OpenAI-compatible endpoint.

function createMockServer(
  responseBody: string,
  statusCode = 200,
  onRequest?: (body: Record<string, unknown>) => void,
): { url: string; server: ReturnType<typeof Bun.serve> } {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.json() as Record<string, unknown>
      onRequest?.(body)
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: responseBody } }],
        }),
        {
          status: statusCode,
          headers: { "Content-Type": "application/json" },
        },
      )
    },
  })
  return { url: `http://localhost:${server.port}`, server }
}

function createErrorServer(statusCode: number, body = "error"): { url: string; server: ReturnType<typeof Bun.serve> } {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(body, { status: statusCode })
    },
  })
  return { url: `http://localhost:${server.port}`, server }
}

describe("enhanceMetadata", () => {
  test("parses valid LLM JSON response", async () => {
    const { url, server } = createMockServer(
      JSON.stringify({
        description: "Builds Docker images from Dockerfiles",
        intents: ["build a docker image", "create container image", "package application"],
        tags: ["docker", "container", "build", "image"],
      }),
    )
    try {
      const config: LlmConnectionConfig = { endpoint: url, model: "test-model" }
      const entry: StashEntry = { name: "build-image", type: "tool", description: "build image" }
      const result = await enhanceMetadata(config, entry)
      expect(result.description).toBe("Builds Docker images from Dockerfiles")
      expect(result.intents).toHaveLength(3)
      expect(result.tags).toContain("docker")
    } finally {
      server.stop()
    }
  })

  test("handles markdown-fenced JSON response", async () => {
    const { url, server } = createMockServer(
      '```json\n{"description":"test desc","intents":["do thing"],"tags":["tag1"]}\n```',
    )
    try {
      const config: LlmConnectionConfig = { endpoint: url, model: "test-model" }
      const entry: StashEntry = { name: "test", type: "tool" }
      const result = await enhanceMetadata(config, entry)
      expect(result.description).toBe("test desc")
      expect(result.intents).toEqual(["do thing"])
    } finally {
      server.stop()
    }
  })

  test("returns empty object on unparseable response", async () => {
    const { url, server } = createMockServer("This is not JSON at all")
    try {
      const config: LlmConnectionConfig = { endpoint: url, model: "test-model" }
      const entry: StashEntry = { name: "test", type: "tool" }
      const result = await enhanceMetadata(config, entry)
      expect(result).toEqual({})
    } finally {
      server.stop()
    }
  })

  test("throws on HTTP error", async () => {
    const { url, server } = createErrorServer(500, "Internal Server Error")
    try {
      const config: LlmConnectionConfig = { endpoint: url, model: "test-model" }
      const entry: StashEntry = { name: "test", type: "tool" }
      await expect(enhanceMetadata(config, entry)).rejects.toThrow("LLM request failed (500)")
    } finally {
      server.stop()
    }
  })

  test("uses configured temperature and maxTokens", async () => {
    let requestBody: Record<string, unknown> | undefined
    const { url, server } = createMockServer(
      JSON.stringify({ description: "ok" }),
      200,
      (body) => {
        requestBody = body
      },
    )
    try {
      const config: LlmConnectionConfig = {
        endpoint: url,
        model: "test-model",
        temperature: 0.7,
        maxTokens: 256,
      }
      const entry: StashEntry = { name: "test", type: "tool" }
      await enhanceMetadata(config, entry)
      expect(requestBody).toMatchObject({
        model: "test-model",
        temperature: 0.7,
        max_tokens: 256,
      })
    } finally {
      server.stop()
    }
  })

  test("caps intents at 8 items", async () => {
    const { url, server } = createMockServer(
      JSON.stringify({
        intents: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
      }),
    )
    try {
      const config: LlmConnectionConfig = { endpoint: url, model: "test-model" }
      const entry: StashEntry = { name: "test", type: "tool" }
      const result = await enhanceMetadata(config, entry)
      expect(result.intents!.length).toBeLessThanOrEqual(8)
    } finally {
      server.stop()
    }
  })

  test("filters non-string values from intents and tags", async () => {
    const { url, server } = createMockServer(
      JSON.stringify({
        intents: ["valid", 123, null, "also valid"],
        tags: ["good", false, "fine"],
      }),
    )
    try {
      const config: LlmConnectionConfig = { endpoint: url, model: "test-model" }
      const entry: StashEntry = { name: "test", type: "tool" }
      const result = await enhanceMetadata(config, entry)
      expect(result.intents).toEqual(["valid", "also valid"])
      expect(result.tags).toEqual(["good", "fine"])
    } finally {
      server.stop()
    }
  })
})
