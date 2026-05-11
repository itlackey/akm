/**
 * Unit tests for `extractGraphFromBodies` — the batched graph-extraction helper.
 *
 * The LLM transport layer (`chatCompletion` in `../src/llm/client`) is stubbed
 * at the module level so no real HTTP calls are made. The real implementation
 * of `extractGraphFromBodies` (and `extractGraphFromBody`) is exercised.
 *
 * Coverage:
 *   (a) Successful 3-asset batch returns 3 correctly-matched results.
 *   (b) Partial response (model returns fewer items than assets) falls back to
 *       individual `extractGraphFromBody` calls for the missing indices.
 *   (c) Batch size=1 (single body) delegates to the single-asset path and
 *       returns a 1-element array identical to `extractGraphFromBody`.
 *   (d) Empty bodies array returns an empty array without calling the LLM.
 *   (e) All-whitespace bodies return all-empty extractions without LLM calls.
 *   (f) LLM returns non-array JSON → falls back to individual calls for all assets.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { LlmConnectionConfig } from "../src/core/config";

// ── LLM transport stub ───────────────────────────────────────────────────────

/**
 * Call-count and response queues for the stubbed `chatCompletion`.
 *
 * Strategy: the user message in a batch call always contains "N=" (from the
 * buildBatchUserPrompt template). We use that to distinguish batch calls from
 * individual (single-asset) fallback calls and route to separate queues.
 */
let chatCallCount = 0;
/** First batch response to return. Consumed once. */
let batchRawOnce: string | null = null;
/** Queue of raw strings for individual (single-asset fallback) calls. */
const singleRawQueue: string[] = [];

mock.module("../src/llm/client", () => ({
  chatCompletion: async (_config: unknown, messages: Array<{ role: string; content: string }>) => {
    chatCallCount++;
    const userContent = messages.find((m) => m.role === "user")?.content ?? "";
    if (userContent.includes("N=") && batchRawOnce !== null) {
      const resp = batchRawOnce;
      batchRawOnce = null;
      return resp;
    }
    return singleRawQueue.shift() ?? "";
  },
  // Re-export the real parse utility so graph-extract.ts can use it.
  parseEmbeddedJsonResponse: <T>(raw: string): T | null => {
    if (!raw) return null;
    try {
      const stripped = raw
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();
      return JSON.parse(stripped) as T;
    } catch {
      return null;
    }
  },
}));

// Import AFTER mocks so graph-extract picks up the stub.
const { extractGraphFromBodies, extractGraphFromBody } = await import("../src/llm/graph-extract");

// ── Shared fixtures ──────────────────────────────────────────────────────────

const SAMPLE_LLM: LlmConnectionConfig = {
  endpoint: "http://localhost:11434/v1/chat/completions",
  model: "llama3.2",
};

const AKM_CFG_WITH_GATE = {
  semanticSearchMode: "auto" as const,
  llm: { ...SAMPLE_LLM, features: { graph_extraction: true } },
};

beforeEach(() => {
  chatCallCount = 0;
  batchRawOnce = null;
  singleRawQueue.length = 0;
});

afterEach(() => {
  // no-op — state is reset in beforeEach
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("extractGraphFromBodies — unit", () => {
  test("(a) successful 3-asset batch returns 3 correctly-matched results", async () => {
    const bodies = [
      "ServiceA integrates with ServiceB.",
      "Terraform provisions the ProdCluster.",
      "No graph content here.",
    ];

    batchRawOnce = JSON.stringify([
      {
        entities: ["ServiceA", "ServiceB"],
        relations: [{ from: "ServiceA", to: "ServiceB", type: "integrates with" }],
      },
      {
        entities: ["Terraform", "ProdCluster"],
        relations: [{ from: "Terraform", to: "ProdCluster", type: "provisions" }],
      },
      { entities: [], relations: [] },
    ]);

    const results = await extractGraphFromBodies(SAMPLE_LLM, bodies, undefined, AKM_CFG_WITH_GATE);

    expect(results).toHaveLength(3);
    expect(results[0]?.entities).toEqual(["ServiceA", "ServiceB"]);
    expect(results[0]?.relations).toHaveLength(1);
    expect(results[0]?.relations[0]).toMatchObject({ from: "ServiceA", to: "ServiceB" });
    expect(results[1]?.entities).toEqual(["Terraform", "ProdCluster"]);
    expect(results[2]?.entities).toEqual([]);
    expect(results[2]?.relations).toHaveLength(0);
    // Only one LLM call was made (the batch call).
    expect(chatCallCount).toBe(1);
  });

  test("(b) partial response falls back gracefully for missing indices", async () => {
    const bodies = ["Body A mentioning Alpha.", "Body B mentioning Beta.", "Body C mentioning Gamma."];

    // Batch returns only 2 items (missing index 2).
    batchRawOnce = JSON.stringify([
      { entities: ["Alpha"], relations: [] },
      { entities: ["Beta"], relations: [] },
      // index 2 is intentionally omitted — partial failure
    ]);

    // Individual fallback for index 2 (the single-asset prompt does NOT contain "N=").
    singleRawQueue.push(JSON.stringify({ entities: ["Gamma"], relations: [] }));

    const results = await extractGraphFromBodies(SAMPLE_LLM, bodies, undefined, AKM_CFG_WITH_GATE);

    expect(results).toHaveLength(3);
    expect(results[0]?.entities).toEqual(["Alpha"]);
    expect(results[1]?.entities).toEqual(["Beta"]);
    // Index 2 must have been filled by the fallback individual call.
    expect(results[2]?.entities).toEqual(["Gamma"]);
    // 1 batch call + 1 fallback individual call = 2 total.
    expect(chatCallCount).toBe(2);
  });

  test("(c) single body delegates to single-asset path and returns 1-element array", async () => {
    // When bodies.length === 1, extractGraphFromBodies delegates to extractGraphFromBody
    // which issues a NON-batch prompt (no "N=" prefix).
    singleRawQueue.push(
      JSON.stringify({
        entities: ["ServiceA", "ServiceB"],
        relations: [{ from: "ServiceA", to: "ServiceB", type: "uses" }],
      }),
    );

    const results = await extractGraphFromBodies(SAMPLE_LLM, ["ServiceA uses ServiceB."], undefined, AKM_CFG_WITH_GATE);

    expect(results).toHaveLength(1);
    expect(results[0]?.entities).toContain("ServiceA");
    expect(results[0]?.entities).toContain("ServiceB");
    expect(results[0]?.relations).toHaveLength(1);
    // Only one call was made, and it was NOT a batch call.
    expect(chatCallCount).toBe(1);
  });

  test("(c2) single-body result matches what extractGraphFromBody returns directly", async () => {
    const body = "Alpha depends on Beta.";
    const rawResp = JSON.stringify({
      entities: ["Alpha", "Beta"],
      relations: [{ from: "Alpha", to: "Beta", type: "depends on" }],
    });

    // Prime the queue twice — once for extractGraphFromBodies, once for extractGraphFromBody.
    singleRawQueue.push(rawResp);
    singleRawQueue.push(rawResp);

    const [batchResult] = await extractGraphFromBodies(SAMPLE_LLM, [body], undefined, AKM_CFG_WITH_GATE);
    const singleResult = await extractGraphFromBody(SAMPLE_LLM, body, undefined, AKM_CFG_WITH_GATE);

    expect(batchResult?.entities).toEqual(singleResult.entities);
    expect(batchResult?.relations).toHaveLength(singleResult.relations.length);
  });

  test("(d) empty bodies array returns empty array without LLM calls", async () => {
    const results = await extractGraphFromBodies(SAMPLE_LLM, [], undefined, AKM_CFG_WITH_GATE);
    expect(results).toHaveLength(0);
    expect(chatCallCount).toBe(0);
  });

  test("(e) all-whitespace bodies return all-empty extractions without LLM calls", async () => {
    const results = await extractGraphFromBodies(SAMPLE_LLM, ["   ", "\n\t\n", ""], undefined, AKM_CFG_WITH_GATE);
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r?.entities).toEqual([]);
      expect(r?.relations).toEqual([]);
    }
    // All bodies are empty so nonEmptyBodies.length === 0 → no LLM call.
    expect(chatCallCount).toBe(0);
  });

  test("(f) LLM returns non-array JSON falls back to individual calls for all assets", async () => {
    const bodies = ["Alpha body.", "Beta body."];
    // Batch call returns an object (not an array) — parse succeeds but not an array.
    batchRawOnce = JSON.stringify({ oops: true });
    // Individual fallback calls for both assets.
    singleRawQueue.push(JSON.stringify({ entities: ["Alpha"], relations: [] }));
    singleRawQueue.push(JSON.stringify({ entities: ["Beta"], relations: [] }));

    const results = await extractGraphFromBodies(SAMPLE_LLM, bodies, undefined, AKM_CFG_WITH_GATE);

    expect(results).toHaveLength(2);
    expect(results[0]?.entities).toEqual(["Alpha"]);
    expect(results[1]?.entities).toEqual(["Beta"]);
    // 1 batch call + 2 fallback individual calls = 3 total.
    expect(chatCallCount).toBe(3);
  });
});
