// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Unit tests for the GRAPH item (R12b + R20): bounded per-asset LLM output
 * cost and the `maxChunksPerAsset` chunk cap.
 *
 * The real `../src/llm/client` transport is exercised against a local Bun
 * HTTP server (same harness as `graph-extract-batch.test.ts`) so the actual
 * request shape sent over the wire can be inspected — it does real network
 * I/O against `localhost`, so per AGENTS.md's ORG-03..06 rule this lives
 * under tests/integration/, not tests/.
 *
 * Coverage:
 *   (1) The single-asset extraction request carries a `response_format`
 *       json_schema bounded by `maxItems` and no `max_tokens`.
 *   (2) A body chunked into 20 chunks with maxChunksPerAsset unset makes only
 *       8 calls (the default cap) and reports `truncatedChunks: 12`.
 *   (3) The same body with an explicit `maxChunksPerAsset: 3` makes only 3
 *       calls and reports `truncatedChunks: 17`.
 *   (4) `getGraphExtractorId` (the cache-key fingerprint) is unaffected by
 *       this item — same inputs, same id.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { AkmConfig, LlmConnectionConfig } from "../../../src/core/config/config";
import { getGraphExtractorId } from "../../../src/indexer/graph/graph-extraction";
import { testLlmRunner } from "../../_helpers/llm-runner";

// ── Local LLM server ─────────────────────────────────────────────────────────

let chatCallCount = 0;
/** Queue of raw response strings returned in call order. */
const rawQueue: string[] = [];
/** Every request body received, in call order, for shape assertions. */
const capturedRequests: Array<Record<string, unknown>> = [];

const llmServer = Bun.serve({
  port: 0,
  async fetch(request) {
    chatCallCount++;
    const body = (await request.json()) as Record<string, unknown>;
    capturedRequests.push(body);
    const content = rawQueue.shift() ?? JSON.stringify({ entities: [], relations: [] });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      headers: { "Content-Type": "application/json" },
    });
  },
});

const { extractGraphFromBody } = await import("../../../src/llm/graph-extract");

const SAMPLE_CONNECTION: LlmConnectionConfig = {
  endpoint: `http://localhost:${llmServer.port}/v1/chat/completions`,
  model: "llama3.2",
  // The execution-lowering layer only forwards responseSchema when this is
  // explicitly true (see memory-infer.ts's DERIVED_MEMORY_JSON_SCHEMA).
  supportsJsonSchema: true,
};
const SAMPLE_LLM = testLlmRunner(SAMPLE_CONNECTION, "test-graph-extraction-limits");

const AKM_CFG_WITH_GATE: AkmConfig = {
  configVersion: "0.9.0",
  semanticSearchMode: "auto" as const,
  engines: {
    test: { kind: "llm", ...SAMPLE_CONNECTION },
  },
  defaults: { engine: "test", llmEngine: "test" },
  index: { defaults: { engine: "test" } },
};

beforeEach(() => {
  chatCallCount = 0;
  rawQueue.length = 0;
  capturedRequests.length = 0;
});

afterAll(() => {
  llmServer.stop(true);
});

/**
 * A body that chunks into exactly `paragraphs` chunks at MAX_CHUNK_BODY_CHARS
 * (1600): each paragraph is a single ~1550-char line (under the 1600 cap, so
 * it survives as one fragment) separated by a blank line, and two adjacent
 * 1550-char fragments together (3102 chars) always exceed 1600 — so
 * `splitBodyIntoChunks`'s greedy packer emits exactly one chunk per paragraph.
 */
function makeChunkedBody(paragraphs: number): string {
  return Array.from({ length: paragraphs }, () => "x".repeat(1550)).join("\n\n");
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("extractGraphFromBody — bounded output (R12b + R20)", () => {
  test("(1) the request carries a json_schema response_format bounded by maxItems, and no maxTokens", async () => {
    rawQueue.push(JSON.stringify({ entities: ["Alpha", "Beta"], relations: [{ from: "Alpha", to: "Beta" }] }));

    await extractGraphFromBody(SAMPLE_LLM, "Alpha references Beta.", undefined, AKM_CFG_WITH_GATE);

    expect(capturedRequests).toHaveLength(1);
    const request = capturedRequests[0]!;
    expect(request.response_format).toMatchObject({
      type: "json_schema",
      json_schema: {
        schema: {
          type: "object",
          required: ["entities", "relations"],
          additionalProperties: false,
        },
      },
    });
    // `confidence` is explicitly allowed at both levels — parseGraphExtraction
    // reads rel.confidence (MIN_RELATION_CONFIDENCE filtering) and
    // item.confidence (merged extraction confidence), so a schema that
    // forbade it would make both silently dead on a supportsJsonSchema
    // provider. additionalProperties: false still forbids anything else.
    const schema = (request.response_format as { json_schema: { schema: Record<string, unknown> } }).json_schema.schema;
    expect(Object.keys(schema.properties as Record<string, unknown>)).toEqual(["entities", "relations", "confidence"]);
    const relationItemSchema = (schema.properties as { relations: { items: { properties: Record<string, unknown> } } })
      .relations.items;
    expect(Object.keys(relationItemSchema.properties)).toEqual(["from", "to", "type", "confidence"]);
    // Cost is bounded by the schema's maxItems caps (matching memory-infer's
    // pattern), not by a hardcoded maxTokens — see AGENTS.md "LLM Defaults".
    const properties = schema.properties as Record<string, { maxItems?: number }>;
    expect(properties.entities?.maxItems).toBe(32);
    expect(properties.relations?.maxItems).toBe(32);
    expect(request.max_tokens).toBeUndefined();
  });

  test("(2) 20 chunks with maxChunksPerAsset unset makes 8 calls (default cap) and reports truncatedChunks: 12", async () => {
    for (let i = 0; i < 8; i++) rawQueue.push(JSON.stringify({ entities: [], relations: [] }));

    const result = await extractGraphFromBody(SAMPLE_LLM, makeChunkedBody(20), undefined, AKM_CFG_WITH_GATE);

    expect(chatCallCount).toBe(8);
    expect(result.chunkCount).toBe(8);
    expect(result.truncatedChunks).toBe(12);
  });

  test("(3) 20 chunks with maxChunksPerAsset: 3 makes 3 calls and reports truncatedChunks: 17", async () => {
    for (let i = 0; i < 3; i++) rawQueue.push(JSON.stringify({ entities: [], relations: [] }));

    const result = await extractGraphFromBody(
      SAMPLE_LLM,
      makeChunkedBody(20),
      undefined,
      AKM_CFG_WITH_GATE,
      undefined,
      {
        maxChunksPerAsset: 3,
      },
    );

    expect(chatCallCount).toBe(3);
    expect(result.chunkCount).toBe(3);
    expect(result.truncatedChunks).toBe(17);
  });

  test("(4) a body within a single chunk is unaffected by the cap (existing merge/slice behaviour unchanged)", async () => {
    rawQueue.push(JSON.stringify({ entities: ["Alpha"], relations: [] }));

    const result = await extractGraphFromBody(
      SAMPLE_LLM,
      "Alpha references Beta.",
      undefined,
      AKM_CFG_WITH_GATE,
      undefined,
      {
        maxChunksPerAsset: 3,
      },
    );

    expect(chatCallCount).toBe(1);
    expect(result.truncatedChunks).toBeUndefined();
  });

  test("(5) a relation carrying confidence below MIN_RELATION_CONFIDENCE is filtered and counted", async () => {
    rawQueue.push(
      JSON.stringify({
        entities: ["Alpha", "Beta", "Gamma"],
        relations: [
          { from: "Alpha", to: "Beta", confidence: 0.2 },
          { from: "Alpha", to: "Gamma", confidence: 0.9 },
        ],
      }),
    );

    const result = await extractGraphFromBody(
      SAMPLE_LLM,
      "Alpha references Beta and Gamma.",
      undefined,
      AKM_CFG_WITH_GATE,
    );

    expect(result.relations).toEqual([{ from: "Alpha", to: "Gamma", confidence: 0.9 }]);
    expect(result.filteredLowConfidenceRelations).toBe(1);
  });
});

describe("getGraphExtractorId — unaffected by this item", () => {
  test("(6) is deterministic for the same inputs and does not depend on maxChunksPerAsset", () => {
    // getGraphExtractorId takes no maxChunksPerAsset parameter — the cache
    // key (and therefore the LLM cache) is unaffected by this item.
    expect(getGraphExtractorId({ model: "llama3.2", batchSize: 4, includeTypes: ["memory", "knowledge"] })).toBe(
      "graph-extraction:v2:llama3.2:fd95c873f8b72020",
    );
  });
});
