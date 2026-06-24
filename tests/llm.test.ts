import { describe, expect, test } from "bun:test";
import type { HttpClient } from "../src/core/common";
import type { LlmConnectionConfig } from "../src/core/config/config";
import type { StashEntry } from "../src/indexer/passes/metadata";
import { enhanceMetadata } from "../src/llm/metadata-enhance";

// These tests verify the LLM module's response-parsing logic. #664 Seam 1:
// inject a fake HttpClient (chat-completion shaped) instead of standing up
// Bun.serve, so enhanceMetadata runs its real request/parse path with no socket.

const TEST_ENDPOINT = "http://llm.test";

/** Fake chat-completion fetch returning `responseBody` as the message content. */
function chatFetch(
  responseBody: string,
  statusCode = 200,
  onRequest?: (body: Record<string, unknown>) => void,
): HttpClient {
  return async (_input, init) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    onRequest?.(body);
    return new Response(JSON.stringify({ choices: [{ message: { content: responseBody } }] }), {
      status: statusCode,
      headers: { "Content-Type": "application/json" },
    });
  };
}

/** Fake fetch that returns a raw HTTP error (non-200, non-JSON body). */
function errorFetch(statusCode: number, body = "error"): HttpClient {
  return async () => new Response(body, { status: statusCode });
}

const CONFIG: LlmConnectionConfig = { endpoint: TEST_ENDPOINT, model: "test-model" };

describe("enhanceMetadata", () => {
  test("parses valid LLM JSON response", async () => {
    const fetch = chatFetch(
      JSON.stringify({
        description: "Builds Docker images from Dockerfiles",
        searchHints: ["build a docker image", "create container image", "package application"],
        tags: ["docker", "container", "build", "image"],
      }),
    );
    const entry: StashEntry = { name: "build-image", type: "script", description: "build image" };
    const result = await enhanceMetadata(CONFIG, entry, undefined, undefined, undefined, { fetch });
    expect(result.description).toBe("Builds Docker images from Dockerfiles");
    expect(result.searchHints).toHaveLength(3);
    expect(result.tags).toContain("docker");
  });

  test("handles markdown-fenced JSON response", async () => {
    const fetch = chatFetch('```json\n{"description":"test desc","searchHints":["do thing"],"tags":["tag1"]}\n```');
    const entry: StashEntry = { name: "test", type: "script" };
    const result = await enhanceMetadata(CONFIG, entry, undefined, undefined, undefined, { fetch });
    expect(result.description).toBe("test desc");
    expect(result.searchHints).toEqual(["do thing"]);
  });

  test("returns empty object on unparseable response", async () => {
    const fetch = chatFetch("This is not JSON at all");
    const entry: StashEntry = { name: "test", type: "script" };
    const result = await enhanceMetadata(CONFIG, entry, undefined, undefined, undefined, { fetch });
    expect(result).toEqual({});
  });

  test("throws on HTTP error", async () => {
    const fetch = errorFetch(500, "Internal Server Error");
    const entry: StashEntry = { name: "test", type: "script" };
    await expect(enhanceMetadata(CONFIG, entry, undefined, undefined, undefined, { fetch })).rejects.toThrow(
      "LLM provider error (500)",
    );
  });

  test("uses configured temperature and maxTokens", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const fetch = chatFetch(JSON.stringify({ description: "ok" }), 200, (body) => {
      requestBody = body;
    });
    const config: LlmConnectionConfig = {
      endpoint: TEST_ENDPOINT,
      model: "test-model",
      temperature: 0.7,
      maxTokens: 256,
    };
    const entry: StashEntry = { name: "test", type: "script" };
    await enhanceMetadata(config, entry, undefined, undefined, undefined, { fetch });
    expect(requestBody).toMatchObject({ model: "test-model", temperature: 0.7, max_tokens: 256 });
  });

  test("caps searchHints at 8 items", async () => {
    const fetch = chatFetch(JSON.stringify({ searchHints: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"] }));
    const entry: StashEntry = { name: "test", type: "script" };
    const result = await enhanceMetadata(CONFIG, entry, undefined, undefined, undefined, { fetch });
    expect(result.searchHints?.length).toBeLessThanOrEqual(8);
  });

  test("filters non-string values from searchHints and tags", async () => {
    const fetch = chatFetch(
      JSON.stringify({ searchHints: ["valid", 123, null, "also valid"], tags: ["good", false, "fine"] }),
    );
    const entry: StashEntry = { name: "test", type: "script" };
    const result = await enhanceMetadata(CONFIG, entry, undefined, undefined, undefined, { fetch });
    expect(result.searchHints).toEqual(["valid", "also valid"]);
    expect(result.tags).toEqual(["good", "fine"]);
  });
});
