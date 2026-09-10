// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #951 — the rerank engine kind's HTTP client. Locks:
 *   - the wire request shape (model/query/documents POSTed as JSON)
 *   - `rerankDocuments` sorts by `relevance_score` descending
 *   - a document the endpoint didn't score keeps its relative order, appended
 *     after every scored document (never dropped)
 *   - non-2xx, malformed JSON, and a missing `results` array all throw
 *     `RerankCallError` rather than resolving
 */
import { afterEach, describe, expect, test } from "bun:test";
import { RerankCallError, rerankDocuments } from "../../../src/llm/rerank-client";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("rerankDocuments", () => {
  test("posts model/query/documents and returns results sorted by score descending", async () => {
    let capturedBody: string | undefined;
    let capturedUrl: string | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedBody = String(init?.body);
      return new Response(
        JSON.stringify({
          results: [
            { index: 0, relevance_score: 0.2 },
            { index: 1, relevance_score: 0.9 },
          ],
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const out = await rerankDocuments({ endpoint: "http://localhost:9/rerank", model: "reranker-1" }, "what is akm", [
      "doc a",
      "doc b",
    ]);

    expect(capturedUrl).toBe("http://localhost:9/rerank");
    expect(JSON.parse(capturedBody ?? "{}")).toEqual({
      model: "reranker-1",
      query: "what is akm",
      documents: ["doc a", "doc b"],
    });
    expect(out).toEqual([
      { index: 1, score: 0.9 },
      { index: 0, score: 0.2 },
    ]);
  });

  test("a document missing from results keeps its relative order, appended after scored documents", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ results: [{ index: 2, relevance_score: 0.5 }] }), {
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    const out = await rerankDocuments({ endpoint: "http://localhost:9/rerank" }, "q", ["a", "b", "c"]);

    expect(out).toEqual([
      { index: 2, score: 0.5 },
      { index: 0, score: Number.NEGATIVE_INFINITY },
      { index: 1, score: Number.NEGATIVE_INFINITY },
    ]);
  });

  test("empty documents array short-circuits without a request", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;

    const out = await rerankDocuments({ endpoint: "http://localhost:9/rerank" }, "q", []);
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  test("throws RerankCallError when endpoint is not configured", async () => {
    await expect(rerankDocuments({}, "q", ["a"])).rejects.toThrow(RerankCallError);
  });

  test("a non-2xx response throws RerankCallError with the status in the message", async () => {
    globalThis.fetch = (async () => new Response("server exploded", { status: 500 })) as unknown as typeof fetch;

    await expect(rerankDocuments({ endpoint: "http://localhost:9/rerank" }, "q", ["a"])).rejects.toThrow(
      /Rerank request failed \(500\)/,
    );
  });

  test("malformed JSON throws RerankCallError", async () => {
    globalThis.fetch = (async () => new Response("not json")) as unknown as typeof fetch;

    await expect(rerankDocuments({ endpoint: "http://localhost:9/rerank" }, "q", ["a"])).rejects.toThrow(
      RerankCallError,
    );
  });

  test("a response with no results array throws RerankCallError", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }))) as unknown as typeof fetch;

    await expect(rerankDocuments({ endpoint: "http://localhost:9/rerank" }, "q", ["a"])).rejects.toThrow(
      /no "results" array/,
    );
  });
});
