/**
 * Unit tests for `extractGraphFromBodies` — the batched graph-extraction helper.
 *
 * The real `../src/llm/client` transport is exercised against a local Bun HTTP
 * server so no module-level mocks leak across files under newer Bun versions.
 * The real implementation of `extractGraphFromBodies` (and
 * `extractGraphFromBody`) is exercised.
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

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { AkmConfig, LlmConnectionConfig } from "../../src/core/config/config";

// ── Local LLM server ─────────────────────────────────────────────────────────

/**
 * Call-count and response queues for the local OpenAI-compatible endpoint.
 *
 * Strategy: the user message in a batch call always contains "N=" (from the
 * buildBatchUserPrompt template). We use that to distinguish batch calls from
 * individual (single-asset) fallback calls and route to separate queues.
 */
let chatCallCount = 0;
/** Queue of raw strings for batch calls (the user prompt contains "N="). */
const batchRawQueue: string[] = [];
/** Queue of raw strings for individual (single-asset fallback) calls. */
const singleRawQueue: string[] = [];

const llmServer = Bun.serve({
  port: 0,
  async fetch(request) {
    chatCallCount++;
    const body = (await request.json()) as {
      messages?: Array<{ role?: string; content?: string }>;
    };
    const userContent = body.messages?.find((m) => m.role === "user")?.content ?? "";
    let content = "";
    if (userContent.includes("N=")) {
      content = batchRawQueue.shift() ?? "";
    } else {
      content = singleRawQueue.shift() ?? "";
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { content } }],
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  },
});

const { extractGraphFromBodies, extractGraphFromBody } = await import("../../src/llm/graph-extract");

// ── Shared fixtures ──────────────────────────────────────────────────────────

const SAMPLE_LLM: LlmConnectionConfig = {
  endpoint: `http://localhost:${llmServer.port}/v1/chat/completions`,
  model: "llama3.2",
};

const AKM_CFG_WITH_GATE: AkmConfig = {
  configVersion: "0.9.0",
  semanticSearchMode: "auto" as const,
  engines: {
    test: { kind: "llm", ...SAMPLE_LLM },
  },
  defaults: { engine: "test", llmEngine: "test" },
  index: { defaults: { engine: "test" } },
};

beforeEach(() => {
  chatCallCount = 0;
  batchRawQueue.length = 0;
  singleRawQueue.length = 0;
});

afterAll(() => {
  llmServer.stop(true);
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("extractGraphFromBodies — unit", () => {
  test("graph_extraction defaults enabled when feature key is absent", async () => {
    singleRawQueue.push(JSON.stringify({ entities: ["Alpha", "Beta"], relations: [{ from: "Alpha", to: "Beta" }] }));

    const result = await extractGraphFromBody(SAMPLE_LLM, "Alpha references Beta.", undefined, {
      ...AKM_CFG_WITH_GATE,
    });

    expect(result.entities).toEqual(["Alpha", "Beta"]);
    expect(result.relations).toHaveLength(1);
    expect(chatCallCount).toBe(1);
  });

  test("graph_extraction explicit false disables calls and emits onFallback", async () => {
    const fallbackEvents: Array<{ feature: string; reason: string }> = [];

    const result = await extractGraphFromBody(
      SAMPLE_LLM,
      "Alpha references Beta.",
      undefined,
      {
        ...AKM_CFG_WITH_GATE,
        index: { ...AKM_CFG_WITH_GATE.index, graph: { enabled: false } },
      },
      (evt) => fallbackEvents.push({ feature: evt.feature, reason: evt.reason }),
    );

    expect(result).toEqual({ entities: [], relations: [] });
    expect(chatCallCount).toBe(0);
    expect(fallbackEvents).toEqual([{ feature: "graph_extraction", reason: "disabled" }]);
  });

  test("(a) successful 3-asset batch returns 3 correctly-matched results", async () => {
    const bodies = [
      "ServiceA integrates with ServiceB.",
      "Terraform provisions the ProdCluster.",
      "No graph content here.",
    ];

    batchRawQueue.push(
      JSON.stringify([
        {
          entities: ["ServiceA", "ServiceB"],
          relations: [{ from: "ServiceA", to: "ServiceB", type: "integrates with" }],
        },
        {
          entities: ["Terraform", "ProdCluster"],
          relations: [{ from: "Terraform", to: "ProdCluster", type: "provisions" }],
        },
        { entities: [], relations: [] },
      ]),
    );

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
    batchRawQueue.push(
      JSON.stringify([
        { entities: ["Alpha"], relations: [] },
        { entities: ["Beta"], relations: [] },
        // index 2 is intentionally omitted — partial failure
      ]),
    );

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

  test("(f) genuinely non-array batch retries once, then falls back + surfaces the metric", async () => {
    const bodies = ["Alpha body.", "Beta body."];
    const telemetry: Record<string, number> = {};
    // First batch call AND the stricter retry both return a non-array object.
    batchRawQueue.push(JSON.stringify({ oops: true }));
    batchRawQueue.push(JSON.stringify({ still: "broken" }));
    // Individual fallback calls for both assets.
    singleRawQueue.push(JSON.stringify({ entities: ["Alpha"], relations: [] }));
    singleRawQueue.push(JSON.stringify({ entities: ["Beta"], relations: [] }));

    const results = await extractGraphFromBodies(SAMPLE_LLM, bodies, undefined, AKM_CFG_WITH_GATE, undefined, {
      telemetry,
    });

    expect(results).toHaveLength(2);
    expect(results[0]?.entities).toEqual(["Alpha"]);
    expect(results[1]?.entities).toEqual(["Beta"]);
    // 1 batch call + 1 stricter retry + 2 fallback individual calls = 4 total.
    expect(chatCallCount).toBe(4);
    // The failure (after the retry) is counted and observable (#635 item 3).
    expect(telemetry.nonArrayBatchFailures).toBe(1);
    expect(telemetry.retryAttempts).toBe(1);
  });

  test("(g) batch response wrapped in prose with a leading object is salvaged (#635) — no fallback", async () => {
    const bodies = ["Alpha references Beta.", "Gamma uses Delta."];
    // Model wraps the valid array in prose AND emits a stray example object
    // first. Array-preferring salvage must recover the array — no per-asset
    // fallback, no retry.
    const validArray = JSON.stringify([
      { entities: ["Alpha", "Beta"], relations: [{ from: "Alpha", to: "Beta" }] },
      { entities: ["Gamma", "Delta"], relations: [{ from: "Gamma", to: "Delta" }] },
    ]);
    batchRawQueue.push(
      `Sure! For example {"from":"X","to":"Y"}.\nHere is the result:\n${validArray}\nHope that helps.`,
    );

    const results = await extractGraphFromBodies(SAMPLE_LLM, bodies, undefined, AKM_CFG_WITH_GATE);

    expect(results).toHaveLength(2);
    expect(results[0]?.entities).toEqual(["Alpha", "Beta"]);
    expect(results[1]?.entities).toEqual(["Gamma", "Delta"]);
    // Only the single batch call — salvage avoided both the retry and fallback.
    expect(chatCallCount).toBe(1);
  });

  test("(h) non-array batch recovered by the stricter retry — no per-asset fallback", async () => {
    const bodies = ["Alpha body.", "Beta body."];
    const telemetry: Record<string, number> = {};
    // First batch is non-array prose; the stricter retry returns a clean array.
    batchRawQueue.push("I cannot produce JSON, sorry.");
    batchRawQueue.push(
      JSON.stringify([
        { entities: ["Alpha"], relations: [] },
        { entities: ["Beta"], relations: [] },
      ]),
    );

    const results = await extractGraphFromBodies(SAMPLE_LLM, bodies, undefined, AKM_CFG_WITH_GATE, undefined, {
      telemetry,
    });

    expect(results).toHaveLength(2);
    expect(results[0]?.entities).toEqual(["Alpha"]);
    expect(results[1]?.entities).toEqual(["Beta"]);
    // 1 batch + 1 stricter retry, no per-asset fallback.
    expect(chatCallCount).toBe(2);
    expect(telemetry.retryAttempts).toBe(1);
    // The retry recovered the batch → no surfaced non-array failure.
    expect(telemetry.nonArrayBatchFailures ?? 0).toBe(0);
  });

  test("normalizes entities/relation types and keeps confidence when provided", async () => {
    const body = "ServiceA uses ServiceB.";
    singleRawQueue.push(
      JSON.stringify({
        entities: ["  ServiceA  ", "serviceb", "ServiceA"],
        relations: [{ from: "ServiceA", to: "serviceb", type: "USE", confidence: 1.4 }],
        confidence: -0.2,
      }),
    );

    const [result] = await extractGraphFromBodies(SAMPLE_LLM, [body], undefined, AKM_CFG_WITH_GATE);

    expect(result?.entities).toEqual(["ServiceA", "serviceb"]);
    expect(result?.relations).toHaveLength(1);
    expect(result?.relations[0]).toMatchObject({ from: "ServiceA", to: "serviceb", type: "uses", confidence: 1 });
    expect(result?.confidence).toBe(0);
  });

  test("long bodies are chunked and merged instead of truncating to a fixed prefix", async () => {
    const longBody = `# One\n\n${"Alpha detail ".repeat(120)}\n\n# Two\n\n${"Gamma detail ".repeat(120)}`;
    singleRawQueue.push(
      JSON.stringify({ entities: ["Alpha", "Beta"], relations: [{ from: "Alpha", to: "Beta", type: "uses" }] }),
    );
    singleRawQueue.push(
      JSON.stringify({ entities: ["Gamma", "Delta"], relations: [{ from: "Gamma", to: "Delta", type: "depends on" }] }),
    );

    const result = await extractGraphFromBody(SAMPLE_LLM, longBody, undefined, AKM_CFG_WITH_GATE);

    expect(chatCallCount).toBe(2);
    expect(result.chunkCount).toBe(2);
    expect(result.entities).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);
    expect(result.relations).toHaveLength(2);
  });
});
